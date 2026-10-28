/**
 * Live executor (ARCHITECTURE §3): pre-signs a burst of `PonsSniper.snipe` txs with consecutive
 * nonces (EIP-1559, chainId 4663), fires each at its scheduled local time to every
 * SEND_ENDPOINT over keep-alive connections, then reconciles by polling receipts (Sniped /
 * SnipeTaxCharged logs). Reconciliation is idempotent; the fill resolves as soon as it is
 * seen, statuses + nonce resync complete in the background.
 */
import { sniperAbi } from '@hood/contracts';
import { TOPICS, type FeedBlock, type RawLog } from '@hood/core';
import { decodeEventLog, encodeFunctionData, keccak256, parseGwei, type Address, type Hex, type LocalAccount } from 'viem';
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
}

export interface ExitOrder {
  key: string;
  curve: Address;
  token: Address;
  tokensIn: bigint;
  minQuoteOut: bigint;
  reason: string;
  gasLimit: number;
  maxFeeGwei: number;
}

export interface ExitResult {
  ok: boolean;
  tokensIn: bigint;
  quoteOut: bigint;
  txHash?: Hex;
  block?: number;
  error?: string;
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
}

export class NonceManager {
  private nextNonce: number | null = null;
  private inflight = 0;

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

export interface LiveExecutorOptions {
  account: LocalAccount;
  sniper: Address;
  chainId: number;
  senders: RawSender[];
  chain: ChainClient;
  scheduler: Scheduler;
  logger: Logger;
  /** block → timestamp from the feed (avoids an RPC) */
  blockTs?: (block: number) => number | undefined;
  receiptPollMs?: number;
  reconcileTimeoutMs?: number;
  /** called when every member has a final status */
  onFinal?: (run: SnipeRun) => void;
  onSend?: (run: SnipeRun, m: BurstMember) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

export function snipeTaxFromLogs(logs: RawLog[], curve: Address): bigint {
  for (const l of logs) {
    if (l.address.toLowerCase() === curve.toLowerCase() && l.topics[0] === TOPICS.SnipeTaxCharged) return BigInt(l.data);
  }
  return 0n;
}

export class LiveExecutor implements ExecutionBackend {
  readonly mode = 'live' as const;
  readonly nonces = new NonceManager();
  private readonly cancels = new Map<string, (() => void)[]>();
  readonly stats = { bursts: 0, members: 0, sends: 0, sendErrors: 0, fills: 0, exits: 0 };

  constructor(private readonly o: LiveExecutorOptions) {}

  get address(): Address {
    return this.o.account.address;
  }

  async init(): Promise<void> {
    this.nonces.set(await this.o.chain.getTransactionCount(this.o.account.address, 'pending'));
  }

  private signer(order: SnipeOrder): { nonces: number[]; signOne: (i: number) => Promise<BurstMember> } {
    const { run } = order;
    const data = encodeFunctionData({
      abi: sniperAbi,
      functionName: 'snipe',
      args: [order.curve, order.token, run.quoteIn, run.minTokensOut, run.maxTaxBps, BigInt(run.deadlineBlock)],
    });
    const nonces = this.nonces.take(order.times.length);
    const maxFeePerGas = parseGwei(String(order.maxFeeGwei));
    const maxPriorityFeePerGas = parseGwei(String(Math.min(order.priorityFeeGwei, order.maxFeeGwei)));
    const signOne = async (i: number): Promise<BurstMember> => {
      const raw = await this.o.account.signTransaction({
        chainId: this.o.chainId,
        type: 'eip1559',
        to: this.o.sniper,
        data,
        value: 0n,
        nonce: nonces[i]!,
        gas: BigInt(order.gasLimit),
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      return { index: i, nonce: nonces[i]!, hash: keccak256(raw), raw, scheduledAt: order.times[i]!, sends: [], status: 'planned' };
    };
    return { nonces, signOne };
  }

  /** Pre-sign one member per send time with consecutive nonces (reserves the nonces). */
  async sign(order: SnipeOrder): Promise<BurstMember[]> {
    const { signOne } = this.signer(order);
    const members: BurstMember[] = [];
    for (let i = 0; i < order.times.length; i++) members.push(await signOne(i));
    return members;
  }

  /** Schedule one member; resolves when its fan-out completed (or it was cancelled). */
  private schedule(run: SnipeRun, m: BurstMember): Promise<void> {
    let cancels = this.cancels.get(run.key);
    if (!cancels) this.cancels.set(run.key, (cancels = []));
    return new Promise<void>((resolve) => {
      const cancel = this.o.scheduler.at(m.scheduledAt, () => {
        m.sentAt = this.o.scheduler.now();
        m.status = 'sent';
        this.stats.members++;
        const sends = this.o.senders.map((s) =>
          s.sendRaw(m.raw).then((r) => {
            this.stats.sends++;
            if (!r.ok) this.stats.sendErrors++;
            m.sends.push({ endpoint: r.endpoint, sentAt: r.sentAt, doneAt: r.doneAt, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
          }),
        );
        this.o.onSend?.(run, m);
        void Promise.all(sends).then(() => resolve());
      });
      cancels.push(() => {
        cancel();
        if (m.status === 'planned') m.status = 'skipped';
        resolve();
      });
    });
  }

  /** Schedule every member; resolves when all scheduled sends have completed (or were cancelled). */
  fire(run: SnipeRun, members: BurstMember[]): Promise<void> {
    return Promise.all(members.map((m) => this.schedule(run, m))).then(() => {
      this.cancels.delete(run.key);
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

  /** Poll receipts until every sent member is final; `onFill` fires as soon as the buy is seen. */
  async reconcile(run: SnipeRun, curve: Address, onFill: (f: Fill | null) => void): Promise<void> {
    const poll = this.o.receiptPollMs ?? 100;
    const deadline = Date.now() + (this.o.reconcileTimeoutMs ?? 15_000);
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
      await Promise.all(
        open.map(async (m) => {
          const r = await this.o.chain.getReceipt(m.hash).catch(() => null);
          if (r) {
            const f = await this.mergeReceipt(run, m, r, curve);
            if (f) report(f);
          }
        }),
      );
      if (run.fill) report(run.fill);
      await sleep(run.fill ? poll * 3 : poll);
    }
    for (const m of run.burst) if (m.status === 'sent') m.status = 'dropped';
    report(run.fill ?? null);
  }

  async execute(order: SnipeOrder): Promise<Fill | null> {
    const { run } = order;
    this.stats.bursts++;
    // sign + schedule member by member: the first send is not held up by signing the rest
    const { signOne } = this.signer(order);
    run.burst = [];
    const done: Promise<void>[] = [];
    try {
      for (let i = 0; i < order.times.length; i++) {
        if (run.status !== 'pending') break; // aborted while signing
        const m = await signOne(i);
        run.burst.push(m);
        done.push(this.schedule(run, m));
      }
    } catch (e) {
      run.notes.push(`sign failed: ${(e as Error).message}`);
      if (run.burst.length === 0) {
        this.nonces.release();
        return null;
      }
    }
    const sent = Promise.all(done).then(() => {
      this.cancels.delete(run.key);
    });
    return new Promise<Fill | null>((resolve) => {
      void (async () => {
        await sent;
        await this.reconcile(run, order.curve, resolve);
        this.nonces.release();
        try {
          const n = await this.o.chain.getTransactionCount(this.o.account.address, 'latest');
          if (this.nonces.resync(n)) this.o.logger.debug({ nonce: n }, 'nonce resynced');
        } catch (e) {
          this.o.logger.warn({ err: e }, 'nonce resync failed');
        }
        this.o.onFinal?.(run);
      })();
    });
  }

  async exit(order: ExitOrder): Promise<ExitResult> {
    this.stats.exits++;
    const [nonce] = this.nonces.take(1);
    try {
      const raw = await this.o.account.signTransaction({
        chainId: this.o.chainId,
        type: 'eip1559',
        to: this.o.sniper,
        data: encodeFunctionData({ abi: sniperAbi, functionName: 'exit', args: [order.curve, order.token, order.tokensIn, order.minQuoteOut] }),
        value: 0n,
        nonce: nonce!,
        gas: BigInt(order.gasLimit),
        maxFeePerGas: parseGwei(String(order.maxFeeGwei)),
        maxPriorityFeePerGas: 0n,
      });
      const hash = keccak256(raw);
      const results = await Promise.all(this.o.senders.map((s) => s.sendRaw(raw)));
      if (!results.some((r) => r.ok)) return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, txHash: hash, error: results.map((r) => r.error).join('; ') };
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const r = await this.o.chain.getReceipt(hash).catch(() => null);
        if (r) {
          if (r.status !== 'success') return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, txHash: hash, block: r.blockNumber, error: 'exit reverted' };
          let quoteOut = 0n;
          let tokensIn = order.tokensIn;
          for (const l of r.logs) {
            if (l.address.toLowerCase() !== this.o.sniper.toLowerCase()) continue;
            try {
              const d = decodeEventLog({ abi: sniperAbi, data: l.data as Hex, topics: l.topics as [Hex, ...Hex[]] });
              if (d.eventName === 'Exited') {
                quoteOut = d.args.quoteOut;
                tokensIn = d.args.tokensIn;
              }
            } catch {
              /* ignore */
            }
          }
          return { ok: true, tokensIn, quoteOut, txHash: hash, block: r.blockNumber };
        }
        await sleep(this.o.receiptPollMs ?? 100);
      }
      return { ok: false, tokensIn: order.tokensIn, quoteOut: 0n, txHash: hash, error: 'exit receipt timeout' };
    } finally {
      this.nonces.release();
      try {
        this.nonces.resync(await this.o.chain.getTransactionCount(this.o.account.address, 'latest'));
      } catch {
        /* next resync */
      }
    }
  }

  onFeedBlock(): void {
    /* live mode learns fills from receipts */
  }
}
