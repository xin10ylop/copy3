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
 *    launchAndBuy dev buy.
 *
 * Classification (same as the indexer / backtest): a buy in the launch tx itself or to the
 * deployer is a *dev* buy; a buy to another exempt wallet (deployer ∪ creatorFeeRecipient ∪
 * SnipeTaxExempted) is a *team* buy; anything else is a taxed buy (99 % tax, ignored).
 * A hint is replaced by the logs of its tx once seen; a hint whose receipt failed (or shows no
 * CurveBuy from the curve) is refuted and never counts again.
 */
import { CURVE_FEE_BPS, SELECTORS, TOPICS, quoteBuy, snipeTaxWeiFor, type DecodedTx, type RawLog, type Reserves } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { ReceiptLite } from './chain.js';
import type { DetectedLaunch, LaunchConfirmation, LaunchSecondStats, LaunchSecondTotals } from './types.js';

export const SEL_BUY = SELECTORS.curveBuy;
export const SEL_SELL = SELECTORS.curveSell;
export const SEL_TRANSFER = '0xa9059cbb';
export const SEL_TRANSFER_FROM = '0x23b872dd';
/** selectors the ledger cares about (buffered per second by the sniper) */
export const LEDGER_SELECTORS: ReadonlySet<string> = new Set([SEL_BUY, SEL_SELL, SEL_TRANSFER, SEL_TRANSFER_FROM]);

const ZERO = '0x0000000000000000000000000000000000000000';
const word = (input: string, i: number): string => input.slice(10 + i * 64, 10 + (i + 1) * 64);
const wordAddr = (input: string, i: number): string => `0x${word(input, i).slice(24)}`.toLowerCase();
const topicAddr = (t: string | undefined): string => `0x${(t ?? '').slice(26)}`.toLowerCase();
const wei = (x: bigint): number => Number(x) / 1e18;

type BuyStatus = 'seen' | 'confirmed' | 'refuted';

export interface LedgerBuy {
  txHash: string;
  recipient: string;
  quoteIn: bigint;
  block: number;
  logIndex: number;
  source: 'feed' | 'log' | 'calldata';
  status: BuyStatus;
}

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
  /** feed hints by tx hash (one direct buy per tx) */
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
      // launchAndBuy: the dev buy is in the launch tx; confirmed by the launch receipt's CurveBuy
      this.hints.set(this.launchTx, { txHash: this.launchTx, recipient: this.deployer, quoteIn: dev, block: launch.block, logIndex: -1, source: 'calldata', status: 'seen' });
    }
  }

  get ts(): number {
    return this.launch.ts;
  }

  private exemptSet(list: readonly string[]): Set<string> {
    const s = new Set<string>([this.deployer, this.launch.event.creatorFeeRecipient.toLowerCase(), ...list.map((x) => x.toLowerCase())]);
    s.delete(ZERO);
    return s;
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
      const quoteIn = BigInt(`0x${log.data.slice(2, 66) || '0'}`);
      return this.confirmBuy(hash, topicAddr(log.topics[2]), quoteIn, block, logIndex);
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

  private confirmBuy(hash: string, recipient: string, quoteIn: bigint, block: number, logIndex: number): boolean {
    const key = `${hash}:${logIndex}`;
    if (this.logs.has(key)) return false;
    this.loggedTx.add(hash);
    this.hints.delete(hash);
    this.logs.set(key, { txHash: hash, recipient, quoteIn, block, logIndex, source: 'log', status: 'confirmed' });
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
      for (const l of r.logs) {
        if (l.address.toLowerCase() !== this.curve || l.topics[0] !== TOPICS.CurveBuy) continue;
        changed = this.ingestLog({ ...l, transactionHash: l.transactionHash ?? hash, blockNumber: l.blockNumber ?? r.blockNumber }) || changed;
      }
    }
    const h = this.hints.get(hash);
    if (h && h.status === 'seen') {
      h.status = 'refuted';
      changed = true;
    }
    this.loggedTx.add(hash);
    return changed;
  }

  /** Team / dev feed hints (tx hashes) neither confirmed nor refuted yet; taxed buys do not matter. */
  pendingHints(): Hex[] {
    return [...this.hints.values()].filter((h) => h.status === 'seen' && this.kindOf(h) !== 'other').map((h) => h.txHash as Hex);
  }

  private kindOf(b: LedgerBuy): 'dev' | 'team' | 'other' {
    if (b.txHash === this.launchTx || b.recipient === this.deployer) return 'dev';
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

  /**
   * Curve reserves after the launch second as far as the ledger knows: `afterLaunch` (config start
   * + the launchAndBuy dev buy) plus every other seen buy in block order — exempt buys untaxed,
   * other buys at the 99 % launch-second snipe tax. This is the price our +1 s buy meets, so
   * minTokensOut is computed against it (team buys move the price; AMLIL +49 %).
   */
  reservesAfter(afterLaunch: Reserves, creatorTaxBps: number, feeBps = CURVE_FEE_BPS): Reserves {
    let r = afterLaunch;
    const buys = this.all()
      .filter((b) => b.txHash !== this.launchTx && (b.status === 'confirmed' || this.kindOf(b) !== 'other'))
      .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    for (const b of buys) {
      const exempt = this.kindOf(b) !== 'other';
      const snipeTax = exempt ? 0n : snipeTaxWeiFor(b.quoteIn, 9900);
      const out = quoteBuy(r, b.quoteIn, feeBps, creatorTaxBps, snipeTax);
      const net = b.quoteIn - (b.quoteIn * BigInt(feeBps)) / 10_000n - (b.quoteIn * BigInt(creatorTaxBps)) / 10_000n - snipeTax;
      if (net <= 0n || out <= 0n) continue;
      r = { quote: r.quote + net, token: r.token - out };
    }
    return r;
  }

  /** Buys other than the launch tx's own that `reservesAfter` applies; 0 = nothing moved the price yet. */
  get priceMovingBuys(): number {
    return this.all().filter((b) => b.txHash !== this.launchTx && (b.status === 'confirmed' || this.kindOf(b) !== 'other')).length;
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
