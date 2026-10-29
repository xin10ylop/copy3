/**
 * Live executor (ARCHITECTURE §3): pre-signs a burst of `PonsSniper.snipe` txs with consecutive
 * nonces (EIP-1559, chainId 4663), fires each at its scheduled local time to every
 * SEND_ENDPOINT over keep-alive connections, then reconciles by polling receipts (Sniped /
 * SnipeTaxCharged logs). Reconciliation is idempotent; the fill resolves as soon as it is
 * seen, statuses + nonce settlement complete in the background.
 *
 * Keys (reviewer M1). Every key is a PonsSniper operator with its own nonce sequence:
 *  - `accounts[0 .. exitKeys-1]` are EXIT keys (EXIT_KEYS, default 1): exits never queue behind
 *    a burst's nonces. One exit key serves exits strictly FIFO (each exit holds it until its
 *    receipt or its timeout, ≤ EXIT_RECEIPT_TIMEOUT_MS); with n exit keys concurrent exits go to
 *    a free key first, else round-robin (NEW-9);
 *  - the remaining accounts are BURST slots: one concurrent burst per slot (a burst holds its slot
 *    from signing until its nonces are settled), so concurrent bursts never share a sequence;
 *  - a single account is shared by exits and bursts (serialised; not recommended for live).
 * A member that no endpoint accepted is re-sent once (same raw tx, same nonce) to every endpoint;
 * after the burst (or an exit) every nonce the key broadcast but the chain did not consume is
 * consumed with a 0-value self-transfer (21k gas), then the key resyncs from the chain.
 *
 * Kill switch (L2): `order.guard` runs right before the first member leaves.
 * Balances (L8): `preflight` checks the cached contract / key balances before a burst.
 */
import { sniperAbi } from '@hood/contracts';
import { TOPICS, type FeedBlock, type RawLog } from '@hood/core';
import { decodeEventLog, encodeFunctionData, formatEther, keccak256, parseEther, parseGwei, type Address, type Hex, type LocalAccount } from 'viem';
import type { ChainClient, ReceiptLite } from './chain.js';
import type { Logger } from './log.js';
import type { RawSender } from './rpc.js';
import type { Scheduler } from './scheduler.js';
import type { BurstMember, Fill, SnipeRun } from './types.js';

export interface SnipeOrder {
  run: SnipeRun;
  token: Address;
  curve: Address;
  /** absolute local send times */
  times: number[];
  gasLimit: number;
  maxFeeGwei: number;
  priorityFeeGwei: number;
  /** L2: memory-only check right before the first member is sent; a reason blocks the whole burst */
  guard?: () => string | null;
}

export interface ExitOrder {
  key: string;
  curve: Address;
  token: Address;
  /** tokens to sell (> 0 unless `all`) */
  tokensIn: bigint;
  /** sell the contract's whole balance (`exitAll`): no dust, no mismatch with the chain */
  all: boolean;
  minQuoteOut: bigint;
  reason: string;
  gasLimit: number;
  maxFeeGwei: number;
  /**
   * The latest feed block when the exit was decided (the block that carried the trigger, e.g. the
   * operator's sell). A live sell lands AFTER that block; paper prices the exit on its post-state.
   */
  atBlock?: number;
}

export interface ExitResult {
  ok: boolean;
  tokensIn: bigint;
  quoteOut: bigint;
  txHash?: Hex;
  block?: number;
  error?: string;
  /** broadcast, but no receipt in time: the outcome must be read from the chain */
  unknown?: boolean;
  /** mined and reverted on chain (a verdict; everything else failed before the chain decided) */
  reverted?: boolean;
  /** R4-4: the result of an EARLIER receipt-less exit of this position that has now landed (re-sent as is) */
  replayed?: boolean;
  /** the landed tx was an `exitAll` (a replayed result may differ from the current order's `all`) */
  all?: boolean;
}

/** R4-4: an exit broadcast without a receipt in time — re-sent as is (same key, nonce, raw) until final. */
interface PendingExit {
  key: ExecutorKey;
  nonce: number;
  raw: Hex;
  hash: Hex;
  tokensIn: bigint;
  all: boolean;
  /** mined (its receipt is read by the position's next exit call); no longer holds the key */
  landed?: boolean;
}

export interface PreflightInput {
  quoteIn: bigint;
  gasLimit: number;
  maxFeeGwei: number;
}

/** What the orchestrator needs from live or paper execution. */
export interface ExecutionBackend {
  readonly mode: 'live' | 'paper';
  /** Resolves with the fill as soon as it is known, or null (no member bought). */
  execute(order: SnipeOrder): Promise<Fill | null>;
  /** Cancel members not yet sent; returns how many were cancelled. */
  abort(runKey: string): number;
  exit(order: ExitOrder): Promise<ExitResult>;
  onFeedBlock(b: FeedBlock): void;
  /** L8: reasons the next burst must not be sent (cached balances, free slot); [] = ok. Memory-only. */
  preflight?(o: PreflightInput): string[];
  /** Bankroll for `sizing.mode = 'bankroll'` (live: the cached contract ETH balance). Memory-only. */
  bankrollWei?(): bigint | null;
  /** /healthz mode label when it differs from `mode` (probe = paper fills + a real probe tx per burst) */
  readonly label?: 'probe';
}

export class NonceManager {
  private nextNonce: number | null = null;
  private inflight = 0;
  /** highest nonce this key broadcast that at least one endpoint accepted (gap detection) */
  maxSent = -1;

  get value(): number | null {
    return this.nextNonce;
  }

  get busy(): boolean {
    return this.inflight > 0;
  }

  set(n: number): void {
    this.nextNonce = n;
  }

  /** Reserve `k` consecutive nonces. */
  take(k: number): number[] {
    if (this.nextNonce === null) throw new Error('nonce not initialised');
    const start = this.nextNonce;
    this.nextNonce += k;
    this.inflight++;
    return Array.from({ length: k }, (_, i) => start + i);
  }

  markSent(n: number): void {
    if (n > this.maxSent) this.maxSent = n;
  }

  release(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  /** Adopt the chain's view when nothing is in flight (dropped members leave gaps). */
  resync(chainNonce: number): boolean {
    if (this.inflight > 0) return false;
    this.nextNonce = chainNonce;
    return true;
  }
}

/** One operator key: own nonce sequence, serialised use, cached gas balance. */
export class ExecutorKey {
  readonly nonces = new NonceManager();
  /** a burst holds the slot from signing until its nonces are settled */
  inBurst = false;
  /** exits queued on / running with this key (NEW-9: pick a free exit key first) */
  pendingExits = 0;
  balanceWei: bigint | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly account: LocalAccount,
    readonly role: 'exit' | 'burst' | 'shared',
  ) {}

  get address(): Address {
    return this.account.address.toLowerCase() as Address;
  }

  /** Run `fn` after every earlier holder of this key finished. */
  lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export interface LiveExecutorOptions {
  /** operator accounts: [0 .. exitKeys-1] = exit keys, the rest = one burst slot each; a single account is shared */
  accounts?: LocalAccount[];
  /** EXIT_KEYS: how many of the first accounts serve exits (round-robin). Default 1; at least one burst key remains. */
  exitKeys?: number;
  /** legacy single account (= `accounts: [account]`) */
  account?: LocalAccount;
  sniper: Address;
  chainId: number;
  senders: RawSender[];
  chain: ChainClient;
  scheduler: Scheduler;
  logger: Logger;
  /** block → timestamp from the feed (avoids an RPC) */
  blockTs?: (block: number) => number | undefined;
  /** burst / exit receipt polling (nonce-gated). Default 200 ms. */
  receiptPollMs?: number;
  reconcileTimeoutMs?: number;
  exitReceiptTimeoutMs?: number;
  /** wait this long for gap fillers to land before trusting them. Default 3000 ms. */
  settleTimeoutMs?: number;
  /** maxFeePerGas of gap-filling self-transfers. Default 1 gwei. */
  fillerMaxFeeGwei?: number;
  /** minimum gas balance per key (L8). Default 0.001 ETH. */
  minGasBalanceWei?: bigint;
  /** called when every member has a final status */
  onFinal?: (run: SnipeRun) => void;
  onSend?: (run: SnipeRun, m: BurstMember) => void;
  /** operational alerts (low_balance, nonce_gap); rate-limited per type+subject */
  onAlert?: (type: string, payload: Record<string, unknown>) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** endpoint already has the tx: counts as accepted */
const KNOWN_RE = /already known|known transaction|already imported|already exists/i;
/** re-sending cannot help */
const PERMANENT_RE = /nonce too low|insufficient funds|intrinsic gas|invalid sender|exceeds block gas|invalid chain/i;
const ALERT_EVERY_MS = 10 * 60_000;

export function decodeSniped(
  logs: RawLog[],
  sniper: Address,
): { token: Address; curve: Address; quoteIn: bigint; tokensOut: bigint; taxBps: number } | null {
  for (const l of logs) {
    if (l.address.toLowerCase() !== sniper.toLowerCase()) continue;
    try {
      const d = decodeEventLog({ abi: sniperAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === 'Sniped') {
        return {
          token: d.args.token.toLowerCase() as Address,
          curve: d.args.curve.toLowerCase() as Address,
          quoteIn: d.args.quoteIn,
          tokensOut: d.args.tokensOut,
          taxBps: Number(d.args.taxBps),
        };
      }
    } catch {
      /* other event */
    }
  }
  return null;
}

/** Seconds after the launch second a burst member may still buy (tax is 0 from T+3). NEW-3. */
export const SNIPE_DEADLINE_SECONDS = 3;

/** `snipe(…, deadlineTs)`: the latest block timestamp a member may buy in (launch ts + 3). */
export function snipeDeadlineTs(run: Pick<SnipeRun, 'launch' | 'deadlineTs'>): number {
  return run.deadlineTs ?? run.launch.ts + SNIPE_DEADLINE_SECONDS;
}

export function snipeTaxFromLogs(logs: RawLog[], curve: Address): bigint {
  for (const l of logs) {
    if (l.address.toLowerCase() === curve.toLowerCase() && l.topics[0] === TOPICS.SnipeTaxCharged) return BigInt(l.data);
  }
  return 0n;
}

/**
 * Fan a raw tx out to every endpoint; if none accepted it (and no error is permanent), re-send
 * once — same raw tx, same nonce. Shared by the live burst / exits and the probe tx.
 */
export async function broadcastRaw(
  senders: readonly RawSender[],
  raw: Hex,
  log: BurstMember['sends'],
  stats: { sends: number; sendErrors: number; resends: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await Promise.all(senders.map((s) => s.sendRaw(raw)));
    let accepted = false;
    let permanent = false;
    for (const r of res) {
      stats.sends++;
      const known = !r.ok && r.error !== undefined && KNOWN_RE.test(r.error);
      if (!r.ok && !known) stats.sendErrors++;
      if (r.ok || known) accepted = true;
      if (!r.ok && r.error !== undefined && PERMANENT_RE.test(r.error)) permanent = true;
      log.push({ endpoint: r.endpoint, sentAt: r.sentAt, doneAt: r.doneAt, ok: r.ok || known, ...(r.error ? { error: attempt ? `resend: ${r.error}` : r.error } : {}) });
    }
    if (accepted || permanent) return accepted;
    if (attempt === 0) stats.resends++;
  }
  return false;
}

export class LiveExecutor implements ExecutionBackend {
  readonly mode = 'live' as const;
  readonly keys: ExecutorKey[];
  /** the first exit key (health, gate estimates) */
  readonly exitKey: ExecutorKey;
  /** NEW-9: every exit key (EXIT_KEYS) */
  readonly exitKeys: ExecutorKey[];
  readonly burstKeys: ExecutorKey[];
  private nextExit = 0;
  /** R4-4: receipt-less exits by position key */
  readonly pendingExits = new Map<string, PendingExit>();
  /** PonsSniper ETH balance (cached, refreshed off the hot path) */
  contractBalanceWei: bigint | null = null;
  private readonly cancels = new Map<string, (() => void)[]>();
  private readonly lastAlert = new Map<string, number>();
  readonly stats = { bursts: 0, members: 0, sends: 0, sendErrors: 0, resends: 0, fills: 0, exits: 0, fillers: 0, noFreeKey: 0, guardBlocked: 0 };

  constructor(private readonly o: LiveExecutorOptions) {
    const accts = o.accounts && o.accounts.length ? o.accounts : o.account ? [o.account] : [];
    if (accts.length === 0) throw new Error('LiveExecutor: at least one operator account required');
    if (new Set(accts.map((a) => a.address.toLowerCase())).size !== accts.length) throw new Error('LiveExecutor: duplicate operator account');
    if (accts.length === 1) {
      const k = new ExecutorKey(accts[0]!, 'shared');
      this.keys = [k];
      this.exitKey = k;
      this.exitKeys = [k];
      this.burstKeys = [k];
    } else {
      const n = Math.max(1, Math.min(accts.length - 1, Math.floor(o.exitKeys ?? 1)));
      this.keys = accts.map((a, i) => new ExecutorKey(a, i < n ? 'exit' : 'burst'));
      this.exitKeys = this.keys.slice(0, n);
      this.exitKey = this.exitKeys[0]!;
      this.burstKeys = this.keys.slice(n);
    }
  }

  /** First burst key (health / legacy single-key callers). */
  get address(): Address {
    return this.burstKeys[0]!.address;
  }

  get nonces(): NonceManager {
    return this.burstKeys[0]!.nonces;
  }

  private get poll(): number {
    return this.o.receiptPollMs ?? 200;
  }

  async init(): Promise<void> {
    for (const k of this.keys) k.nonces.set(await this.o.chain.getTransactionCount(k.address, 'pending'));
    await this.refreshBalances();
  }

  private alert(type: string, subject: string, payload: Record<string, unknown>): void {
    const id = `${type}:${subject}`;
    const now = Date.now();
    if ((this.lastAlert.get(id) ?? -Infinity) + ALERT_EVERY_MS > now) return;
    this.lastAlert.set(id, now);
    this.o.logger.warn({ type, ...payload }, 'executor alert');
    try {
      this.o.onAlert?.(type, payload);
    } catch {
      /* alert sink must not break execution */
    }
  }

  private get minGas(): bigint {
    return this.o.minGasBalanceWei ?? parseEther('0.001');
  }

  /** L8: contract ETH and every key's gas balance (off the hot path; errors keep the last value). */
  async refreshBalances(): Promise<void> {
    const res = await Promise.allSettled([this.o.chain.getBalance(this.o.sniper), ...this.keys.map((k) => this.o.chain.getBalance(k.address))]);
    if (res[0]!.status === 'fulfilled') this.contractBalanceWei = res[0]!.value;
    this.keys.forEach((k, i) => {
      const r = res[i + 1]!;
      if (r.status === 'fulfilled') k.balanceWei = r.value;
    });
    for (const k of this.keys) {
      if (k.balanceWei !== null && k.balanceWei < this.minGas)
        this.alert('low_balance', k.address, { key: k.address, role: k.role, balanceEth: formatEther(k.balanceWei), minEth: formatEther(this.minGas) });
    }
  }

  private freeBurstKey(): ExecutorKey | undefined {
    return this.burstKeys.find((k) => !k.inBurst);
  }

  /**
   * NEW-9: the exit key for the next exit — a key with no exit queued or running (and gas, when
   * another one has it), scanning round-robin from the last pick; all busy → plain round-robin.
   * With one exit key every exit queues behind the previous one (FIFO).
   */
  pickExitKey(): ExecutorKey {
    const ks = this.exitKeys;
    const funded = ks.filter((k) => k.balanceWei === null || k.balanceWei >= this.minGas);
    const pool = funded.length ? funded : ks;
    for (let i = 0; i < ks.length; i++) {
      const k = ks[(this.nextExit + i) % ks.length]!;
      if (pool.includes(k) && k.pendingExits === 0 && !this.hasPendingExit(k)) {
        this.nextExit = (this.nextExit + i + 1) % ks.length;
        return k;
      }
    }
    for (let i = 0; i < ks.length; i++) {
      const k = ks[(this.nextExit + i) % ks.length]!;
      if (pool.includes(k)) {
        this.nextExit = (this.nextExit + i + 1) % ks.length;
        return k;
      }
    }
    return ks[0]!;
  }

  /** Sizing: the same cached contract balance the L8 pre-check uses (null until the first read). */
  bankrollWei(): bigint | null {
    return this.contractBalanceWei;
  }

  preflight(o: PreflightInput): string[] {
    const reasons: string[] = [];
    const lowBalance: string[] = [];
    if (this.contractBalanceWei !== null && this.contractBalanceWei < o.quoteIn)
      lowBalance.push(`contract balance ${formatEther(this.contractBalanceWei)} ETH < quoteIn ${formatEther(o.quoteIn)} ETH`);
    const perTx = BigInt(o.gasLimit) * parseGwei(String(o.maxFeeGwei));
    const need = perTx > this.minGas ? perTx : this.minGas;
    const key = this.freeBurstKey();
    if (!key) reasons.push(`no free burst key (${this.burstKeys.length} slot(s) busy)`);
    else if (key.balanceWei !== null && key.balanceWei < need)
      lowBalance.push(`burst key ${key.address} gas balance ${formatEther(key.balanceWei)} ETH < ${formatEther(need)} ETH`);
    // positions must stay exitable: refuse the burst when NO exit key has the gas for an exit
    const exitKeys = this.exitKeys.filter((k) => k !== key);
    const lowExit = exitKeys.filter((k) => k.balanceWei !== null && k.balanceWei < need);
    if (exitKeys.length > 0 && lowExit.length === exitKeys.length)
      lowBalance.push(
        ...lowExit.map((k) => `exit key ${k.address} gas balance ${formatEther(k.balanceWei!)} ETH < ${formatEther(need)} ETH (positions could not be exited)`),
      );
    if (lowBalance.length) this.alert('low_balance', 'preflight', { reasons: lowBalance });
    return [...reasons, ...lowBalance];
  }

  private async signMember(key: ExecutorKey, order: SnipeOrder, data: Hex, nonce: number, i: number): Promise<BurstMember> {
    const maxFeePerGas = parseGwei(String(order.maxFeeGwei));
    const maxPriorityFeePerGas = parseGwei(String(Math.min(order.priorityFeeGwei, order.maxFeeGwei)));
    const raw = await key.account.signTransaction({
      chainId: this.o.chainId,
      type: 'eip1559',
      to: this.o.sniper,
      data,
      value: 0n,
      nonce,
      gas: BigInt(order.gasLimit),
      maxFeePerGas,
      maxPriorityFeePerGas,
    });
    return { index: i, nonce, hash: keccak256(raw), raw, scheduledAt: order.times[i]!, sends: [], status: 'planned' };
  }

  private snipeData(order: SnipeOrder): Hex {
    const { run } = order;
    return encodeFunctionData({
      abi: sniperAbi,
      functionName: 'snipe',
      // NEW-3: wall-clock deadline next to the block deadline (a stalled sequencer advances time, not blocks)
      args: [order.curve, order.token, run.quoteIn, run.minTokensOut, run.maxTaxBps, BigInt(run.deadlineBlock), BigInt(snipeDeadlineTs(run))],
    });
  }

  /** Pre-sign one member per send time with consecutive nonces of the first burst key (benchmarks). */
  async sign(order: SnipeOrder): Promise<BurstMember[]> {
    const key = this.burstKeys[0]!;
    const data = this.snipeData(order);
    const nonces = key.nonces.take(order.times.length);
    const members: BurstMember[] = [];
    for (let i = 0; i < order.times.length; i++) members.push(await this.signMember(key, order, data, nonces[i]!, i));
    return members;
  }

  /**
   * Fan a raw tx out to every endpoint. If no endpoint accepted it (and the errors are not
   * permanent), re-send once — same raw tx, same nonce — so later members are not stranded
   * behind a nonce hole. Returns whether any endpoint accepted it.
   */
  private broadcast(raw: Hex, log: BurstMember['sends']): Promise<boolean> {
    return broadcastRaw(this.o.senders, raw, log, this.stats);
  }

  /** Schedule one member; resolves when its fan-out completed (or it was cancelled / blocked). */
  private schedule(key: ExecutorKey, order: SnipeOrder, m: BurstMember): Promise<void> {
    const { run } = order;
    let cancels = this.cancels.get(run.key);
    if (!cancels) this.cancels.set(run.key, (cancels = []));
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      const cancel = this.o.scheduler.at(m.scheduledAt, () => {
        if (m.status !== 'planned') return finish();
        if (!run.sendCleared) {
          let why: string | null;
          try {
            why = order.guard?.() ?? null;
          } catch (e) {
            why = `guard failed: ${(e as Error).message}`;
          }
          if (why) {
            this.stats.guardBlocked++;
            run.notes.push(`send blocked before the first member: ${why}`);
            m.status = 'skipped';
            this.abort(run.key);
            return finish();
          }
          run.sendCleared = true;
        }
        m.sentAt = this.o.scheduler.now();
        m.status = 'sent';
        this.stats.members++;
        try {
          this.o.onSend?.(run, m);
        } catch {
          /* observer only */
        }
        void this.broadcast(m.raw, m.sends).then(
          (ok) => {
            if (ok) key.nonces.markSent(m.nonce);
            else {
              m.status = 'dropped';
              m.revertReason = 'rejected by every endpoint (after one re-send)';
            }
            finish();
          },
          () => finish(),
        );
      });
      cancels.push(() => {
        cancel();
        if (m.status === 'planned') m.status = 'skipped';
        finish();
      });
    });
  }

  abort(runKey: string): number {
    const c = this.cancels.get(runKey);
    if (!c) return 0;
    this.cancels.delete(runKey);
    let n = 0;
    for (const f of c) {
      f();
      n++;
    }
    return n;
  }

  /** Apply one receipt to a member (idempotent). Returns a fill when this receipt is the buy. */
  async mergeReceipt(run: SnipeRun, m: BurstMember, r: ReceiptLite, curve: Address): Promise<Fill | null> {
    if (m.status === 'mined' || m.status === 'reverted') return null;
    m.status = r.status === 'success' ? 'mined' : 'reverted';
    m.block = r.blockNumber;
    if (r.status !== 'success' || run.fill) return null;
    const s = decodeSniped(r.logs, this.o.sniper);
    if (!s) return null;
    const ts = this.o.blockTs?.(r.blockNumber) ?? (await this.o.chain.getBlockTimestamp(r.blockNumber).catch(() => 0));
    const fill: Fill = {
      block: r.blockNumber,
      ts,
      quoteIn: s.quoteIn,
      tokensOut: s.tokensOut,
      taxBps: s.taxBps,
      taxPaid: snipeTaxFromLogs(r.logs, curve),
      entryPrice: s.tokensOut > 0n ? Number(s.quoteIn) / Number(s.tokensOut) : 0,
      txHash: r.transactionHash,
    };
    run.fill = fill;
    this.stats.fills++;
    return fill;
  }

  /**
   * Poll until every sent member is final; `onFill` fires as soon as the buy is seen. Gentle:
   * one `getTransactionCount(latest)` per tick, and a receipt only for members whose nonce the
   * chain has consumed (each fetched until found). Falls back to polling every open member when
   * the nonce read fails.
   */
  async reconcile(run: SnipeRun, curve: Address, onFill: (f: Fill | null) => void, keyAddr?: Address): Promise<void> {
    const deadline = Date.now() + (this.o.reconcileTimeoutMs ?? 15_000);
    const addr = keyAddr ?? run.signer ?? this.address;
    let reported = false;
    const report = (f: Fill | null): void => {
      if (!reported) {
        reported = true;
        onFill(f);
      }
    };
    while (Date.now() < deadline) {
      const open = run.burst.filter((m) => m.status === 'sent');
      if (open.length === 0) break;
      const landed = await this.o.chain.getTransactionCount(addr, 'latest').catch(() => null);
      const due = landed === null ? open : open.filter((m) => m.nonce < landed);
      await Promise.all(
        due.map(async (m) => {
          const r = await this.o.chain.getReceipt(m.hash).catch(() => null);
          if (r) {
            const f = await this.mergeReceipt(run, m, r, curve);
            if (f) report(f);
          }
        }),
      );
      if (run.fill) report(run.fill);
      await sleep(this.poll);
    }
    for (const m of run.burst) if (m.status === 'sent') m.status = 'dropped';
    report(run.fill ?? null);
  }

  /**
   * M1: after a burst / exit, make the key's sequence contiguous again. Nonces in
   * [chain count, highest broadcast] were sent but never consumed (a hole in front of them):
   * consume each with a 0-value self-transfer so nothing stale can execute later, then resync.
   */
  private hasPendingExit(key: ExecutorKey): boolean {
    for (const p of this.pendingExits.values()) if (p.key === key && !p.landed) return true;
    return false;
  }

  async settle(key: ExecutorKey): Promise<void> {
    if (key.nonces.busy) return;
    const latest = await this.o.chain.getTransactionCount(key.address, 'latest').catch(() => null);
    if (latest === null) return;
    // R4-4: a receipt-less exit on this key keeps its nonce: never fill it with a self-transfer or
    // resync below it; re-send it (same raw) so the queue behind it keeps moving. Final once the
    // chain consumed its nonce (mined — the next exit call reads its receipt — or replaced).
    let holding = false;
    for (const [k, p] of this.pendingExits) {
      if (p.key !== key) continue;
      if (latest > p.nonce) {
        if (await this.o.chain.getReceipt(p.hash).catch(() => null)) p.landed = true;
        else this.pendingExits.delete(k); // replaced: nothing to wait for
      } else {
        holding = true;
        await this.broadcast(p.raw, []).catch(() => false);
      }
    }
    if (holding) return;
    const maxSent = key.nonces.maxSent;
    if (latest > maxSent) {
      key.nonces.resync(latest);
      return;
    }
    let allAccepted = true;
    const filled: number[] = [];
    for (let n = latest; n <= maxSent; n++) {
      try {
        const raw = await key.account.signTransaction({
          chainId: this.o.chainId,
          type: 'eip1559',
          to: key.account.address,
          value: 0n,
          nonce: n,
          gas: 21_000n,
          maxFeePerGas: parseGwei(String(this.o.fillerMaxFeeGwei ?? 1)),
          maxPriorityFeePerGas: 0n,
        });
        this.stats.fillers++;
        filled.push(n);
        if (!(await this.broadcast(raw, []))) allAccepted = false;
      } catch {
        allAccepted = false;
      }
    }
    this.alert('nonce_gap', `${key.address}:${latest}`, { key: key.address, filled, allAccepted });
    const deadline = Date.now() + (this.o.settleTimeoutMs ?? 3000);
    while (Date.now() < deadline) {
      const n = await this.o.chain.getTransactionCount(key.address, 'latest').catch(() => null);
      if (n !== null && n > maxSent) {
        key.nonces.resync(n);
        return;
      }
      await sleep(this.poll);
    }
    // fillers accepted but not yet visible: skip past them; otherwise trust the chain
    key.nonces.resync(allAccepted ? maxSent + 1 : latest);
  }

  async execute(order: SnipeOrder): Promise<Fill | null> {
    const { run } = order;
    const key = this.freeBurstKey();
    if (!key) {
      this.stats.noFreeKey++;
      run.notes.push(`no free burst key (${this.burstKeys.length} slot(s) busy)`);
      return null;
    }
    key.inBurst = true;
    run.signer = key.address;
    this.stats.bursts++;
    let resolveFill!: (f: Fill | null) => void;
    const fillP = new Promise<Fill | null>((r) => (resolveFill = r));
    let reported = false;
    const report = (f: Fill | null): void => {
      if (!reported) {
        reported = true;
        resolveFill(f);
      }
    };
    void key
      .lock(async () => {
        try {
          await this.burst(key, order, report);
        } catch (e) {
          run.notes.push(`burst error: ${(e as Error).message}`);
          this.o.logger.error({ err: e, key: run.key }, 'burst failed');
        } finally {
          report(run.fill ?? null);
          key.inBurst = false;
          try {
            this.o.onFinal?.(run);
          } catch (e) {
            this.o.logger.warn({ err: e }, 'onFinal threw');
          }
          void this.refreshBalances().catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return fillP;
  }

  /** sign + schedule member by member (the first send never waits for the rest), reconcile, settle */
  private async burst(key: ExecutorKey, order: SnipeOrder, report: (f: Fill | null) => void): Promise<void> {
    const { run } = order;
    if (key.nonces.value === null) key.nonces.set(await this.o.chain.getTransactionCount(key.address, 'pending'));
    const data = this.snipeData(order);
    const nonces = key.nonces.take(order.times.length);
    try {
      run.burst = [];
      const done: Promise<void>[] = [];
      try {
        for (let i = 0; i < order.times.length; i++) {
          if (run.status !== 'pending') break; // aborted while signing
          const m = await this.signMember(key, order, data, nonces[i]!, i);
          run.burst.push(m);
          done.push(this.schedule(key, order, m));
        }
      } catch (e) {
        run.notes.push(`sign failed: ${(e as Error).message}`);
      }
      await Promise.all(done);
      this.cancels.delete(run.key);
      if (run.burst.some((m) => m.status === 'sent')) await this.reconcile(run, order.curve, report, key.address);
      else report(null);
    } finally {
      key.nonces.release();
      await this.settle(key).catch((e: unknown) => this.o.logger.warn({ err: e, key: key.address }, 'nonce settle failed'));
    }
  }

  /** A mined exit receipt → ExitResult (Exited event: tokens sold, proceeds). */
  private exitResult(r: ReceiptLite, hash: Hex, tokensIn: bigint): ExitResult {
    if (r.status !== 'success') return { ok: false, tokensIn, quoteOut: 0n, txHash: hash, block: r.blockNumber, error: 'exit reverted', reverted: true };
    let quoteOut = 0n;
    let sold = tokensIn;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== this.o.sniper.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: sniperAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
        if (d.eventName === 'Exited') {
          quoteOut = d.args.quoteOut;
          sold = d.args.tokensIn;
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true, tokensIn: sold, quoteOut, txHash: hash, block: r.blockNumber };
  }

  private async waitReceipt(hash: Hex): Promise<ReceiptLite | null> {
    const deadline = Date.now() + (this.o.exitReceiptTimeoutMs ?? 10_000);
    while (Date.now() < deadline) {
      const r = await this.o.chain.getReceipt(hash).catch(() => null);
      if (r) return r;
      await sleep(this.poll);
    }
    return null;
  }

  /**
   * R4-4: the position's previous exit had no receipt in time. Re-signing on another key (or a new
   * nonce) could make BOTH sells execute when the first one lands late, so the SAME raw tx is
   * re-sent on its key and nonce until it is final: mined (its result is returned, `replayed`) or
   * its nonce consumed by another tx (then nothing was sold by it and a fresh exit may follow).
   */
  private resumeExit(posKey: string, p: PendingExit): Promise<ExitResult> {
    p.key.pendingExits++;
    return p.key
      .lock(async (): Promise<ExitResult> => {
        const done = (r: ReceiptLite): ExitResult => {
          this.pendingExits.delete(posKey);
          return { ...this.exitResult(r, p.hash, p.tokensIn), replayed: true, all: p.all };
        };
        const r0 = await this.o.chain.getReceipt(p.hash).catch(() => null);
        if (r0) return done(r0);
        const latest = await this.o.chain.getTransactionCount(p.key.address, 'latest').catch(() => null);
        if (latest !== null && latest > p.nonce) {
          const r1 = await this.o.chain.getReceipt(p.hash).catch(() => null);
          if (r1) return done(r1);
          this.pendingExits.delete(posKey);
          await this.settle(p.key).catch(() => undefined);
          return { ok: false, tokensIn: p.tokensIn, quoteOut: 0n, txHash: p.hash, error: 'the earlier receipt-less exit was dropped (its nonce went to another tx): nothing sold by it' };
        }
        this.stats.exits++;
        await this.broadcast(p.raw, []);
        const r = await this.waitReceipt(p.hash);
        if (r) return done(r);
        return { ok: false, tokensIn: p.tokensIn, quoteOut: 0n, txHash: p.hash, error: 'exit receipt timeout (same tx re-sent)', unknown: true };
      })
      .finally(() => {
        p.key.pendingExits--;
      });
  }

  async exit(order: ExitOrder): Promise<ExitResult> {
    this.stats.exits++;
    if (!order.all && order.tokensIn <= 0n) return { ok: false, tokensIn: 0n, quoteOut: 0n, error: 'zero-size exit refused (L1)' };
    const pending = this.pendingExits.get(order.key);
    if (pending) return this.resumeExit(order.key, pending);
    const key = this.pickExitKey();
    key.pendingExits++;
    return key.lock(async () => {
      if (key.nonces.value === null) key.nonces.set(await this.o.chain.getTransactionCount(key.address, 'pending'));
      const [nonce] = key.nonces.take(1);
      try {
        const data = order.all
          ? encodeFunctionData({ abi: sniperAbi, functionName: 'exitAll', args: [order.curve, order.token, order.minQuoteOut] })
          : encodeFunctionData({ abi: sniperAbi, functionName: 'exit', args: [order.curve, order.token, order.tokensIn, order.minQuoteOut] });
        const raw = await key.account.signTransaction({
          chainId: this.o.chainId,
          type: 'eip1559',
          to: this.o.sniper,
          data,
          value: 0n,
          nonce: nonce!,
          gas: BigInt(order.gasLimit),
          maxFeePerGas: parseGwei(String(order.maxFeeGwei)),
          maxPriorityFeePerGas: 0n,
        });
        const hash = keccak256(raw);
        const sends: BurstMember['sends'] = [];
        if (!(await this.broadcast(raw, sends)))
          return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, txHash: hash, error: sends.map((s) => s.error).filter(Boolean).join('; ') || 'not accepted' };
        key.nonces.markSent(nonce!);
        const r = await this.waitReceipt(hash);
        if (r) return this.exitResult(r, hash, order.tokensIn);
        // R4-4: keep key + nonce + raw: the next attempt for this position re-sends this very tx
        this.pendingExits.set(order.key, { key, nonce: nonce!, raw, hash, tokensIn: order.tokensIn, all: order.all });
        return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, txHash: hash, error: 'exit receipt timeout', unknown: true };
      } finally {
        key.nonces.release();
        await this.settle(key).catch(() => undefined);
        void this.refreshBalances().catch(() => undefined);
      }
    }).finally(() => {
      key.pendingExits--;
    });
  }

  onFeedBlock(): void {
    /* live mode learns fills from receipts */
  }
}
