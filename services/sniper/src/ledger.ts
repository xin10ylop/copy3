/**
 * Launch-second ledger: what happened on one launch's curve during its launch second `T` (blocks
 * whose timestamp equals the launch block's). Fed from three sources, all memory-only here:
 *
 *  - feed txs (fastest, before execution): direct `curve.buy(quoteIn, minOut, recipient)` calls
 *    with `msg.value == quoteIn` become *hints*; `curve.sell` / `token.transfer(From)` by an
 *    exempt wallet become exempt outflows (the caller recovers the sender off the decide path);
 *  - CurveBuy / CurveSell / Transfer logs (node ws, or receipts): *confirmed* buys (this also
 *    catches buys routed through contracts, which the feed decoder cannot see);
 *  - the launch receipt: token, curve and the exempt set (SnipeTaxExempted logs), plus the
 *    launchAndBuy dev buy;
 *  - SnipeTaxExempted logs of the curve AFTER the launch tx but inside the launch second: the
 *    deployer can exempt more wallets (`exemptFromSnipeTax`) while the team buys; they count as
 *    team wallets too.
 *
 * Classification (same as the indexer / backtest): a buy in the launch tx itself or to the
 * deployer is a *dev* buy; a buy to another exempt wallet (deployer ∪ creatorFeeRecipient ∪
 * SnipeTaxExempted) is a *team* buy; anything else is a taxed buy (99 % tax, ignored).
 * A hint is replaced by the logs of its tx once seen; a hint whose receipt failed (or shows no
 * CurveBuy from the curve) is refuted and never counts again.
 *
 * NEW-1 (reviewer round 3): feed hints are UNCONFIRMED — anyone can put a feed-visible
 * `curve.buy(3 ETH, minOut = max)` that reverts (gas only). Hints therefore only ever WAKE the
 * confirmation and drive the µs hint-stage match; they never price: `reservesAfter` and
 * `priceMovingBuys` use confirmed CurveBuy logs only (their exact quoteIn / tokensOut / fee /
 * creator tax). A confirmed buy is classified taxed vs untaxed by `CurveBuy.fee` (which includes
 * the snipe tax: ≈ 1 % of quoteIn untaxed, ≈ 100 % in the launch second) — a wallet exempted
 * AFTER it bought (`exemptFromSnipeTax` later in the second) is not a team buy for that buy. A log
 * without a fee word falls back to the exemption order (block, logIndex).
 */
import { CURVE_FEE_BPS, SELECTORS, TOPICS, quoteBuy, snipeTaxWeiFor, type DecodedTx, type RawLog, type Reserves } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { ReceiptLite } from './chain.js';
import type { DetectedLaunch, LaunchConfirmation, LaunchSecondStats, LaunchSecondTotals } from './types.js';

export const SEL_BUY = SELECTORS.curveBuy;
export const SEL_SELL = SELECTORS.curveSell;
export const SEL_TRANSFER = '0xa9059cbb';
export const SEL_TRANSFER_FROM = '0x23b872dd';
/**
 * The team-buy helper contract (0x14b9a544…, 973 of ~1 300 helper-bought team launches in the
 * 30-day backtest): one tx, `msg.value` split over several recipients, one CurveBuy log each.
 * Calldata: (address curve, uint256, uint256, uint256, address[] recipients, uint256[] amounts,
 * uint256[] minOut, uint256). Decoded from the feed it is a team-buy hint ~500 ms before the
 * node's logs (31 Oct 2026: the decision fired on 2 of 6 logs with 200 ms left to the send).
 */
export const SEL_HELPER_BUY = '0x6f49227e';
/**
 * A proxy buy (0xc0bba43f…, 102 team launches in the 30-day data; META 31 Oct 2026): one tx per
 * wallet, `(address curve, uint256 minOut, address recipient)` with `msg.value` = quoteIn.
 */
export const SEL_PROXY_BUY = '0x240acbf8';
/** selectors the ledger cares about (buffered per second by the sniper) */
export const LEDGER_SELECTORS: ReadonlySet<string> = new Set([SEL_BUY, SEL_SELL, SEL_TRANSFER, SEL_TRANSFER_FROM, SEL_HELPER_BUY, SEL_PROXY_BUY]);

const ZERO = '0x0000000000000000000000000000000000000000';
const word = (input: string, i: number): string => input.slice(10 + i * 64, 10 + (i + 1) * 64);
const wordAddr = (input: string, i: number): string => `0x${word(input, i).slice(24)}`.toLowerCase();
const topicAddr = (t: string | undefined): string => `0x${(t ?? '').slice(26)}`.toLowerCase();
const wei = (x: bigint): number => Number(x) / 1e18;
const wordInt = (input: string, i: number): bigint => BigInt(`0x${word(input, i)}`);

/**
 * Recipients and amounts of a helper-contract team buy (`SEL_HELPER_BUY`) for `curve`, or null
 * when the calldata is not that shape, names another curve, or the amounts do not add up to the
 * tx value (a native-quote buy with value ≠ Σ amounts reverts).
 */
export function decodeHelperBuy(input: string, value: bigint, curve: string): { recipient: string; quoteIn: bigint }[] | null {
  const words = Math.floor((input.length - 10) / 64);
  if (words < 8 || wordAddr(input, 0) !== curve) return null;
  const arr = (i: number): bigint[] | null => {
    const off = wordInt(input, i);
    if (off % 32n !== 0n) return null;
    const at = Number(off / 32n);
    if (at + 1 > words) return null;
    const n = Number(wordInt(input, at));
    if (n <= 0 || n > 256 || at + 1 + n > words) return null;
    return Array.from({ length: n }, (_, k) => wordInt(input, at + 1 + k));
  };
  const recipients = arr(4);
  const amounts = arr(5);
  if (!recipients || !amounts || recipients.length !== amounts.length) return null;
  let sum = 0n;
  for (const a of amounts) sum += a;
  if (sum !== value || sum === 0n) return null;
  return recipients.map((r, k) => ({ recipient: `0x${r.toString(16).padStart(40, '0')}`, quoteIn: amounts[k]! })).filter((x) => x.quoteIn > 0n);
}

type BuyStatus = 'seen' | 'confirmed' | 'refuted';

export interface LedgerBuy {
  txHash: string;
  recipient: string;
  quoteIn: bigint;
  block: number;
  logIndex: number;
  source: 'feed' | 'log' | 'calldata';
  status: BuyStatus;
  /** CurveBuy data (confirmed logs with all four words): exact pool deltas and the tax verdict */
  tokensOut?: bigint;
  /** CurveBuy.fee: curve fee + snipe tax (RESEARCH §8) */
  fee?: bigint;
  /** CurveBuy.tax: creator tax */
  creatorTax?: bigint;
}

/**
 * A confirmed buy whose fee exceeds this share of quoteIn paid a snipe tax (the curve fee is 1 %;
 * the launch-second tax 99 %, +1 s 6.18 %). NEW-1.
 */
export const TAXED_FEE_BPS = 500n;

export interface LedgerOut {
  txHash: string;
  from: string;
  kind: 'sell' | 'transfer';
}

/** What `ingestTx` found: a buy hint, an outflow whose sender must be recovered first, or nothing. */
export type IngestResult = 'buy' | 'out' | 'out-needs-sender' | null;

export class LaunchSecondLedger {
  readonly launch: DetectedLaunch;
  token: string | null = null;
  curve: string | null = null;
  private readonly deployer: string;
  private readonly launchTx: string;
  private exempt: Set<string>;
  /** wallets exempted after the launch tx (SnipeTaxExempted in a later block of the second) */
  private readonly addedExempt = new Set<string>();
  /** NEW-1: where (block, logIndex) each later exemption landed — a buy before it was taxed */
  private readonly exemptedAt = new Map<string, { block: number; logIndex: number }>();
  /** waiters woken on every change (confirmation loops plan the burst the moment a log lands) */
  private waiters: (() => void)[] = [];
  /** feed hints by `txHash` (a direct buy) or `txHash#i` (the i-th recipient of a helper-contract buy) */
  private readonly hints = new Map<string, LedgerBuy>();
  /** confirmed buys by `txHash:logIndex` */
  private readonly logs = new Map<string, LedgerBuy>();
  /** txs whose logs are known (hints for them are dropped) */
  private readonly loggedTx = new Set<string>();
  private readonly outs = new Map<string, LedgerOut>();
  private readonly ingested = new Set<string>();
  /** a run was created for this launch (or a match was refused): never decide again */
  decided = false;
  /** the launch receipt refuted the launch (spoof / revert) */
  dead = false;
  /** a block with timestamp > T was seen */
  secondOver = false;
  /** first block of second T+1 (logs below it and at/after the launch block belong to T) */
  firstBlockAfter: number | null = null;
  /** ws unsubscribe for the token/curve logs */
  unwatch: (() => void) | null = null;

  constructor(launch: DetectedLaunch) {
    this.launch = launch;
    this.deployer = launch.event.deployer.toLowerCase();
    this.launchTx = launch.txHash.toLowerCase();
    this.exempt = this.exemptSet(launch.event.exemptions);
    const dev = launch.event.devBuyQuoteIn ?? 0n;
    if (dev > 0n) {
      // launchAndBuy / launcher bundle: the launch tx's own buy; confirmed (and re-attributed by
      // recipient) by the launch receipt's CurveBuy
      const recipient = (launch.event.devBuyRecipient ?? this.deployer).toLowerCase();
      this.hints.set(this.launchTx, { txHash: this.launchTx, recipient, quoteIn: dev, block: launch.block, logIndex: -1, source: 'calldata', status: 'seen' });
    }
  }

  get ts(): number {
    return this.launch.ts;
  }

  private exemptSet(list: readonly string[]): Set<string> {
    const s = new Set<string>([this.deployer, this.launch.event.creatorFeeRecipient.toLowerCase(), ...list.map((x) => x.toLowerCase()), ...(this.addedExempt ?? [])]);
    s.delete(ZERO);
    return s;
  }

  /** Every wallet the ledger treats as team (exempt) right now. */
  get exemptions(): string[] {
    return [...this.exempt];
  }

  /** Wake every `changed()` waiter (the caller saw the ledger change). */
  wake(): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }

  /** Resolves on the next `wake()` or after `ms`. */
  changed(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const fire = (): void => {
        if (done) return;
        done = true;
        clearTimeout(t);
        resolve();
      };
      const t = setTimeout(fire, Math.max(0, ms));
      t.unref?.();
      this.waiters.push(fire);
    });
  }

  isExempt(a: string): boolean {
    return this.exempt.has(a.toLowerCase());
  }

  /** Token/curve from a trusted source (TokenLaunched log or the launch receipt). True when newly set. */
  setAddresses(token: string, curve: string): boolean {
    if (this.curve) return false;
    this.token = token.toLowerCase();
    this.curve = curve.toLowerCase();
    return true;
  }

  /** The exempt set from the launch receipt (SnipeTaxExempted logs) ∪ deployer ∪ creatorFeeRecipient. */
  setExemptions(list: readonly string[]): void {
    this.exempt = this.exemptSet(list);
  }

  /** Apply the verified launch receipt: addresses, exempt set and the launch tx's own buys. */
  applyLaunchReceipt(c: LaunchConfirmation, r: ReceiptLite): void {
    this.setAddresses(c.token, c.curve);
    this.setExemptions(c.exemptions);
    this.applyReceipt(r);
  }

  /** Is block `b` (whose timestamp may be unknown) part of the launch second? */
  inSecond(b: number, ts: number | undefined): boolean {
    if (ts !== undefined) return ts === this.launch.ts && b >= this.launch.block;
    return b >= this.launch.block && (this.firstBlockAfter === null || b < this.firstBlockAfter);
  }

  /**
   * A feed tx from a block of second T (after the launch block). Buys to the curve become hints;
   * sells / transfers that may be exempt outflows are reported so the caller can recover the
   * sender (`addOut`). Idempotent per tx hash.
   */
  ingestTx(tx: DecodedTx, block: number): IngestResult {
    if (!this.curve || !this.token || !tx.selector || !tx.to) return null;
    const hash = tx.hash.toLowerCase();
    if (this.ingested.has(hash)) return null;
    const input = tx.input;
    if (tx.to === this.curve && tx.selector === SEL_BUY) {
      this.ingested.add(hash);
      if (input.length < 10 + 3 * 64 || this.loggedTx.has(hash)) return null;
      const quoteIn = BigInt(`0x${word(input, 0)}`);
      if (quoteIn === 0n || tx.value !== quoteIn) return null; // a native-quote buy with value ≠ quoteIn reverts
      this.hints.set(hash, { txHash: hash, recipient: wordAddr(input, 2), quoteIn, block, logIndex: -1, source: 'feed', status: 'seen' });
      return 'buy';
    }
    if (tx.selector === SEL_PROXY_BUY && input.length >= 10 + 3 * 64 && wordAddr(input, 0) === this.curve) {
      // proxy buy: like curve.buy but through a contract (the CurveBuy log names the contract as buyer)
      this.ingested.add(hash);
      if (tx.value === 0n || this.loggedTx.has(hash)) return null;
      this.hints.set(hash, { txHash: hash, recipient: wordAddr(input, 2), quoteIn: tx.value, block, logIndex: -1, source: 'feed', status: 'seen' });
      return 'buy';
    }
    if (tx.selector === SEL_HELPER_BUY) {
      // helper-contract team buy: one hint per recipient, all confirmed or refuted by the tx's receipt
      const buys = decodeHelperBuy(input, tx.value, this.curve);
      if (!buys) return null;
      this.ingested.add(hash);
      if (this.loggedTx.has(hash)) return null;
      buys.forEach((b, i) => this.hints.set(`${hash}#${i}`, { txHash: hash, recipient: b.recipient, quoteIn: b.quoteIn, block, logIndex: -1, source: 'feed', status: 'seen' }));
      return 'buy';
    }
    if (tx.to === this.curve && tx.selector === SEL_SELL) {
      this.ingested.add(hash);
      return 'out-needs-sender';
    }
    if (tx.to === this.token && tx.selector === SEL_TRANSFER_FROM && input.length >= 10 + 2 * 64) {
      this.ingested.add(hash);
      const from = wordAddr(input, 0);
      const to = wordAddr(input, 1);
      if (!this.exempt.has(from) || this.exempt.has(to) || to === this.curve) return null;
      this.outs.set(hash, { txHash: hash, from, kind: 'transfer' });
      return 'out';
    }
    if (tx.to === this.token && tx.selector === SEL_TRANSFER && input.length >= 10 + 64) {
      this.ingested.add(hash);
      const to = wordAddr(input, 0);
      if (this.exempt.has(to) || to === this.curve) return null;
      return 'out-needs-sender';
    }
    return null;
  }

  /** Record an outflow once its sender is known (no-op unless the sender is exempt). True when recorded. */
  addOut(txHash: string, from: string, kind: LedgerOut['kind']): boolean {
    const f = from.toLowerCase();
    if (!this.exempt.has(f)) return false;
    const key = txHash.toLowerCase();
    if (this.outs.has(key)) return false;
    this.outs.set(key, { txHash: key, from: f, kind });
    return true;
  }

  /** A node log (CurveBuy / CurveSell on the curve, Transfer on the token) from block `block` of second T. */
  ingestLog(log: RawLog): boolean {
    if (!this.curve || !this.token) return false;
    const addr = log.address.toLowerCase();
    const t0 = log.topics[0];
    const hash = (log.transactionHash ?? '').toLowerCase();
    const block = log.blockNumber === null || log.blockNumber === undefined ? this.launch.block : Number(log.blockNumber);
    const logIndex = log.logIndex === null || log.logIndex === undefined ? 0 : Number(log.logIndex);
    if (addr === this.curve && t0 === TOPICS.CurveBuy) {
      const w = (i: number): bigint | undefined => {
        const hex = log.data.slice(2 + i * 64, 2 + (i + 1) * 64);
        return hex.length === 64 ? BigInt(`0x${hex}`) : undefined;
      };
      const full = w(3) !== undefined;
      return this.confirmBuy(hash, topicAddr(log.topics[2]), w(0) ?? 0n, block, logIndex, full ? { tokensOut: w(1)!, fee: w(2)!, creatorTax: w(3)! } : undefined);
    }
    if (addr === this.curve && t0 === TOPICS.SnipeTaxExempted) {
      // exemptFromSnipeTax during the launch second (deployer-only on the curve): a team wallet
      // for the buys AFTER this log (NEW-1: an earlier buy paid the tax)
      const account = topicAddr(log.topics[1]);
      if (account === ZERO || this.exempt.has(account)) return false;
      this.addedExempt.add(account);
      this.exemptedAt.set(account, { block, logIndex });
      this.exempt.add(account);
      return true;
    }
    if (addr === this.curve && t0 === TOPICS.CurveSell) {
      const seller = topicAddr(log.topics[1]);
      return this.addOut(`${hash}:${logIndex}`, seller, 'sell');
    }
    if (addr === this.token && t0 === TOPICS.Erc20Transfer) {
      const from = topicAddr(log.topics[1]);
      const to = topicAddr(log.topics[2]);
      if (!this.exempt.has(from) || this.exempt.has(to) || to === this.curve || to === ZERO) return false;
      return this.addOut(`${hash}:${logIndex}`, from, 'transfer');
    }
    return false;
  }

  private confirmBuy(
    hash: string,
    recipient: string,
    quoteIn: bigint,
    block: number,
    logIndex: number,
    data?: { tokensOut: bigint; fee: bigint; creatorTax: bigint },
  ): boolean {
    const key = `${hash}:${logIndex}`;
    if (this.logs.has(key)) return false;
    this.loggedTx.add(hash);
    this.dropHints(hash);
    this.logs.set(key, { txHash: hash, recipient, quoteIn, block, logIndex, source: 'log', status: 'confirmed', ...(data ?? {}) });
    return true;
  }

  /**
   * A receipt of a hinted tx (or of the launch tx): its CurveBuy logs from the curve confirm the
   * buys; a failed tx, or one without a CurveBuy from this curve, refutes the hint. True when changed.
   */
  applyReceipt(r: ReceiptLite): boolean {
    if (!this.curve) return false;
    const hash = r.transactionHash.toLowerCase();
    let changed = false;
    if (r.status === 'success') {
      // exemptions first: a tx that exempts a wallet and then buys for it is a team buy
      const ordered = [...r.logs].sort((a, b) => Number(b.topics[0] === TOPICS.SnipeTaxExempted) - Number(a.topics[0] === TOPICS.SnipeTaxExempted));
      for (const l of ordered) {
        if (l.address.toLowerCase() !== this.curve || (l.topics[0] !== TOPICS.CurveBuy && l.topics[0] !== TOPICS.SnipeTaxExempted)) continue;
        if (l.topics[0] === TOPICS.SnipeTaxExempted && hash === this.launchTx) continue; // the launch's own set: setExemptions
        changed = this.ingestLog({ ...l, transactionHash: l.transactionHash ?? hash, blockNumber: l.blockNumber ?? r.blockNumber }) || changed;
      }
    }
    for (const h of this.hintsOf(hash)) {
      if (h.status === 'seen') {
        h.status = 'refuted';
        changed = true;
      }
    }
    this.loggedTx.add(hash);
    return changed;
  }

  /** The hints of one tx: a direct buy (`hash`) or every recipient of a helper buy (`hash#i`). */
  private hintsOf(hash: string): LedgerBuy[] {
    return [...this.hints.values()].filter((h) => h.txHash === hash);
  }

  private dropHints(hash: string): void {
    for (const [k, h] of this.hints) if (h.txHash === hash) this.hints.delete(k);
  }

  /** Team / dev feed hints (tx hashes) neither confirmed nor refuted yet; taxed buys do not matter. */
  pendingHints(): Hex[] {
    return [...new Set([...this.hints.values()].filter((h) => h.status === 'seen' && this.kindOf(h) !== 'other').map((h) => h.txHash as Hex))];
  }

  /**
   * NEW-1: did this buy pay a snipe tax? Confirmed logs: by `CurveBuy.fee` (it includes the snipe
   * tax). Without a fee word: by exemption order — a recipient exempted later in the second (at a
   * later (block, logIndex)) was still taxed for this buy. Hints: unknown (false; they never price).
   */
  private paidSnipeTax(b: LedgerBuy): boolean {
    if (b.status !== 'confirmed') return false;
    if (b.fee !== undefined) return b.fee * 10_000n > b.quoteIn * TAXED_FEE_BPS;
    const at = this.exemptedAt.get(b.recipient);
    return at !== undefined && (b.block < at.block || (b.block === at.block && b.logIndex < at.logIndex));
  }

  /**
   * By recipient, the backtest's definition (scripts/backtest/bt_month.py): to the deployer → dev;
   * to another exempt wallet → team; taxed → other. The launch tx's own buy is NOT dev by
   * construction: launcher contracts (0x6319…) launch for a fresh deployer wallet while the tx
   * sender (exempted in the same tx) buys 0.2–0.8 ETH — that is the team buy the
   * `team-buy-0.1` play is for (23 of 290 launches in one night, all missed before this).
   */
  private kindOf(b: LedgerBuy): 'dev' | 'team' | 'other' {
    if (this.paidSnipeTax(b)) return 'other';
    if (b.recipient === this.deployer) return 'dev';
    return this.exempt.has(b.recipient) ? 'team' : 'other';
  }

  private totals(buys: readonly LedgerBuy[]): LaunchSecondTotals {
    let team = 0n;
    let dev = 0n;
    const buyers = new Set<string>();
    for (const b of buys) {
      const k = this.kindOf(b);
      if (k === 'dev') dev += b.quoteIn;
      else if (k === 'team') {
        team += b.quoteIn;
        buyers.add(b.recipient);
      }
    }
    return { teamBuyEth: wei(team), teamBuyers: buyers.size, devBuyEth: wei(dev) };
  }

  private all(): LedgerBuy[] {
    return [...this.logs.values(), ...[...this.hints.values()].filter((h) => h.status !== 'refuted')];
  }

  stats(): LaunchSecondStats {
    const all = this.all();
    return {
      confirmed: this.totals(all.filter((b) => b.status === 'confirmed')),
      seen: this.totals(all),
      exemptOut: this.outs.size,
      pending: this.pendingHints().length,
    };
  }

  /** Exempt outflows seen so far (for notes / the snipe record). */
  get outflows(): LedgerOut[] {
    return [...this.outs.values()];
  }

  /** NEW-1: the buys that price — CONFIRMED CurveBuy logs other than the launch tx's own, in chain order. */
  private pricedBuys(): LedgerBuy[] {
    return [...this.logs.values()].filter((b) => b.txHash !== this.launchTx).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
  }

  /**
   * Curve reserves after the launch second as far as the CHAIN has shown: `afterLaunch` (config
   * start + the launchAndBuy dev buy) plus every CONFIRMED CurveBuy log of the second in chain
   * order, applied with its exact numbers (quote += quoteIn − fee − creator tax, tokens −=
   * tokensOut; fee includes the snipe tax). A log without the full data is applied by the curve
   * formula, taxed (99 %) or not by `paidSnipeTax`. Feed hints never count (NEW-1): a reverting
   * fake buy cannot loosen minTokensOut. This is the price our +1 s buy meets (team buys move the
   * price; AMLIL +49 %).
   */
  reservesAfter(afterLaunch: Reserves, creatorTaxBps: number, feeBps = CURVE_FEE_BPS): Reserves {
    let r = afterLaunch;
    for (const b of this.pricedBuys()) {
      let net: bigint;
      let out: bigint;
      if (b.tokensOut !== undefined && b.fee !== undefined && b.creatorTax !== undefined) {
        net = b.quoteIn - b.fee - b.creatorTax;
        out = b.tokensOut;
      } else {
        const snipeTax = this.paidSnipeTax(b) || this.kindOf(b) === 'other' ? snipeTaxWeiFor(b.quoteIn, 9900) : 0n;
        out = quoteBuy(r, b.quoteIn, feeBps, creatorTaxBps, snipeTax);
        net = b.quoteIn - (b.quoteIn * BigInt(feeBps)) / 10_000n - (b.quoteIn * BigInt(creatorTaxBps)) / 10_000n - snipeTax;
      }
      if (net <= 0n || out <= 0n || out >= r.token) continue;
      r = { quote: r.quote + net, token: r.token - out };
    }
    return r;
  }

  /** Confirmed buys (other than the launch tx's own) that `reservesAfter` applies; 0 = nothing proven moved the price. */
  get priceMovingBuys(): number {
    return this.pricedBuys().length;
  }

  /** Compact JSON for the snipe record. */
  snapshot(): Record<string, unknown> {
    return {
      ...this.stats(),
      curve: this.curve,
      buys: this.all().map((b) => ({ tx: b.txHash, recipient: b.recipient, eth: wei(b.quoteIn), kind: this.kindOf(b), status: b.status, block: b.block })),
      outflows: this.outflows,
    };
  }
}

/** The address of a feed tx sender, without recovery when calldata already names it. */
export function outflowFrom(tx: DecodedTx): Address | null {
  if (tx.selector === SEL_TRANSFER_FROM && tx.input.length >= 10 + 64) return wordAddr(tx.input, 0) as Address;
  return tx.from ?? null;
}
