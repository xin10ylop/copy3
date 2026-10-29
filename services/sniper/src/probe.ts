/**
 * EXECUTION_MODE=probe: paper mode (paper fills, paper PnL, nothing bought) plus, for every run
 * whose burst is planned, ONE real harmless tx — a 0-value self-transfer (21 000 gas) from an
 * executor key — sent at the burst's FIRST slot (`boundary(T+1) − rtt + startMs`, the same
 * `clock.planBurst` times live uses) through the same send path (every SEND_ENDPOINT, one re-send)
 * with the live gas settings (preset maxFee clamped to MAX_GAS_PRICE_GWEI, preset priority fee).
 * Its receipt then tells where a real buy sent at that instant would have landed (race.ts):
 * block offset vs the first T+1 block, tx index, CurveBuy logs of the curve ahead of / after it.
 *
 * Safety: the probe never calls any contract and never moves value; the key only pays gas
 * (~21 000 × 0.02 gwei per probe). The kill switch / daily-loss guard (`order.guard`) runs right
 * before the probe leaves, as before a live burst; the paper fill keeps its own guard check at the
 * T+1 block (paper semantics untouched). A run aborted before the slot cancels its probe.
 */
import type { FeedBlock } from '@hood/core';
import { formatEther, keccak256, parseEther, parseGwei, type LocalAccount } from 'viem';
import type { ChainClient } from './chain.js';
import { ExecutorKey, broadcastRaw, type ExecutionBackend, type ExitOrder, type ExitResult, type SnipeOrder } from './executor.js';
import type { Logger } from './log.js';
import { raceNote, roundMs, type RaceRecord, type RaceTracker } from './race.js';
import type { RawSender } from './rpc.js';
import type { Scheduler } from './scheduler.js';
import type { Fill, SnipeRun } from './types.js';

/** gas of a plain ETH transfer */
export const PROBE_GAS = 21_000n;

export interface ProbeExecutorOptions {
  /** the paper backend that simulates fills and exits (unchanged) */
  paper: ExecutionBackend;
  /** probe keys (EXECUTOR_PRIVATE_KEYS): gas only, never an operator of anything */
  accounts: LocalAccount[];
  chainId: number;
  senders: RawSender[];
  chain: ChainClient;
  scheduler: Scheduler;
  logger: Logger;
  race: RaceTracker;
  /** receipt polling (BURST_RECEIPT_POLL_MS). Default 200 ms. */
  receiptPollMs?: number;
  /** give up on the receipt after this long (`not mined`). Default 5000 ms. */
  receiptTimeoutMs?: number;
  /** minimum gas balance per key (MIN_GAS_BALANCE_ETH). Default 0.001 ETH. */
  minGasBalanceWei?: bigint;
  /** the run's race record changed to a final state (persist it) */
  onProbe?: (run: SnipeRun) => void;
  onAlert?: (type: string, payload: Record<string, unknown>) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class ProbeExecutor implements ExecutionBackend {
  readonly mode = 'paper' as const;
  readonly label = 'probe' as const;
  readonly keys: ExecutorKey[];
  readonly stats = { sends: 0, sendErrors: 0, resends: 0 };
  /** why probes are not sent right now (probe gate: unfunded key …); null = send */
  private gateReason: string | null = null;
  private readonly cancels = new Map<string, () => void>();
  private readonly inflight = new Map<ExecutorKey, number>();
  private next = 0;
  private lastLowAlert = -Infinity;

  constructor(private readonly o: ProbeExecutorOptions) {
    if (o.accounts.length === 0) throw new Error('ProbeExecutor: at least one executor key required');
    this.keys = o.accounts.map((a) => new ExecutorKey(a, 'shared'));
  }

  async init(): Promise<void> {
    for (const k of this.keys) k.nonces.set(await this.o.chain.getTransactionCount(k.address, 'pending'));
    await this.refreshBalances();
  }

  /** Probe gate result: a reason stops new probes (paper runs continue), null resumes them. */
  setGate(reason: string | null): void {
    this.gateReason = reason;
  }

  private get minGas(): bigint {
    return this.o.minGasBalanceWei ?? parseEther('0.001');
  }

  async refreshBalances(): Promise<void> {
    const res = await Promise.allSettled(this.keys.map((k) => this.o.chain.getBalance(k.address)));
    res.forEach((r, i) => {
      if (r.status === 'fulfilled') this.keys[i]!.balanceWei = r.value;
    });
  }

  /** a funded key, preferring one without a probe in flight (round-robin) */
  private pickKey(needWei: bigint): ExecutorKey | null {
    const n = this.keys.length;
    const funded = (k: ExecutorKey): boolean => k.balanceWei === null || k.balanceWei >= needWei;
    for (const free of [true, false]) {
      for (let i = 0; i < n; i++) {
        const k = this.keys[(this.next + i) % n]!;
        if (funded(k) && (!free || !this.inflight.get(k))) {
          this.next = (this.next + i + 1) % n;
          return k;
        }
      }
    }
    return null;
  }

  execute(order: SnipeOrder): Promise<Fill | null> {
    const fill = this.o.paper.execute(order);
    try {
      this.arm(order);
    } catch (e) {
      this.o.logger.error({ err: e, key: order.run.key }, 'probe: arm failed');
    }
    return fill;
  }

  private finish(run: SnipeRun): void {
    run.notes.push(raceNote(run.race!));
    try {
      this.o.onProbe?.(run);
    } catch (e) {
      this.o.logger.warn({ err: e }, 'onProbe threw');
    }
  }

  private skip(run: SnipeRun, status: RaceRecord['status'], reason: string): void {
    run.race!.status = status;
    run.race!.reason = reason;
    this.o.race.count('race_skipped');
    this.finish(run);
  }

  private arm(order: SnipeOrder): void {
    const { run } = order;
    const at = order.times[0];
    if (at === undefined) return;
    this.o.race.count('race_planned');
    const rec: RaceRecord = {
      source: 'probe',
      status: 'planned',
      scheduledAt: at,
      ...(run.plan ? { boundaryMs: run.plan.boundaryMs, rttMs: run.plan.rttMs } : {}),
    };
    run.race = rec;
    if (this.gateReason) return this.skip(run, 'skipped', `probe gate: ${this.gateReason}`);
    const maxFeeGwei = order.maxFeeGwei;
    const maxFeePerGas = parseGwei(String(maxFeeGwei));
    const maxPriorityFeePerGas = parseGwei(String(Math.min(order.priorityFeeGwei, maxFeeGwei)));
    const need = PROBE_GAS * maxFeePerGas > this.minGas ? PROBE_GAS * maxFeePerGas : this.minGas;
    const key = this.pickKey(need);
    if (!key) {
      const reason = `no probe key with ≥ ${formatEther(need)} ETH gas`;
      if (Date.now() - this.lastLowAlert > 10 * 60_000) {
        this.lastLowAlert = Date.now();
        this.o.onAlert?.('low_balance', { reasons: [reason], keys: this.keys.map((k) => ({ key: k.address, balanceEth: k.balanceWei === null ? null : formatEther(k.balanceWei) })) });
      }
      return this.skip(run, 'skipped', reason);
    }
    rec.key = key.address;
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    void this.probe(key, order, rec, maxFeePerGas, maxPriorityFeePerGas)
      .catch((e: unknown) => {
        rec.status = 'send_failed';
        rec.reason = `probe error: ${(e as Error).message}`;
        this.o.race.count('race_send_failed');
        this.finish(run);
      })
      .finally(() => {
        this.inflight.set(key, Math.max(0, (this.inflight.get(key) ?? 1) - 1));
        void this.refreshBalances().catch(() => undefined);
      });
  }

  /** pre-sign (nonce from the key's sequence), fire at the first slot, wait for the receipt, measure */
  private async probe(key: ExecutorKey, order: SnipeOrder, rec: RaceRecord, maxFeePerGas: bigint, maxPriorityFeePerGas: bigint): Promise<void> {
    const { run } = order;
    const { scheduler } = this.o;
    if (key.nonces.value === null) key.nonces.set(await this.o.chain.getTransactionCount(key.address, 'pending'));
    const [nonce] = key.nonces.take(1);
    let sent = false;
    try {
      const raw = await key.account.signTransaction({
        chainId: this.o.chainId,
        type: 'eip1559',
        to: key.account.address,
        value: 0n,
        nonce: nonce!,
        gas: PROBE_GAS,
        maxFeePerGas,
        maxPriorityFeePerGas,
      });
      const hash = keccak256(raw);
      rec.nonce = nonce!;
      rec.hash = hash;
      rec.sends = [];
      // resolves with the broadcast (started inside the scheduler callback, like a live member) or null
      const fired = await new Promise<{ ok: Promise<boolean> } | null>((resolve) => {
        let done = false;
        const cancel = scheduler.at(rec.scheduledAt!, () => {
          if (done) return;
          done = true;
          this.cancels.delete(run.key);
          // L2: the same last-moment kill-switch / daily-loss check a live burst runs (read-only here)
          let why: string | null;
          try {
            why = order.guard?.() ?? null;
          } catch (e) {
            why = `guard failed: ${(e as Error).message}`;
          }
          if (why) {
            rec.status = 'blocked';
            rec.reason = why;
            return resolve(null);
          }
          rec.sentAt = scheduler.now();
          if (rec.boundaryMs !== undefined) rec.sendVsBoundaryMs = roundMs(rec.sentAt - rec.boundaryMs);
          resolve({ ok: broadcastRaw(this.o.senders, raw, rec.sends!, this.stats) });
        });
        this.cancels.set(run.key, () => {
          if (done) return;
          done = true;
          cancel();
          rec.status = 'cancelled';
          rec.reason = `run aborted before the probe slot${run.abortReason ? `: ${run.abortReason}` : ''}`;
          resolve(null);
        });
      });
      if (!fired) {
        this.o.race.count('race_skipped');
        this.finish(run);
        return;
      }
      if (!(await fired.ok)) {
        rec.status = 'send_failed';
        rec.reason = rec.sends.map((s) => s.error).filter(Boolean).join('; ') || 'not accepted';
        this.o.race.count('race_send_failed');
        this.finish(run);
        return;
      }
      sent = true;
      key.nonces.markSent(nonce!);
      this.o.race.count('race_sent');
      const deadline = Date.now() + (this.o.receiptTimeoutMs ?? 5000);
      let receipt = null;
      while (Date.now() < deadline) {
        receipt = await this.o.chain.getReceipt(hash).catch(() => null);
        if (receipt) break;
        await sleep(this.o.receiptPollMs ?? 200);
      }
      if (!receipt) {
        rec.status = 'not_mined';
        this.o.race.count('race_not_mined');
        this.finish(run);
        return;
      }
      await this.o.race.measure(rec, { curve: order.curve, launchBlock: run.launch.block, launchTs: run.launch.ts, receipt });
      this.o.logger.info({ key: run.key, race: rec }, 'probe landed');
      this.finish(run);
    } finally {
      key.nonces.release();
      // a probe that was not sent leaves its nonce unused; one not mined may have been dropped:
      // adopt the chain's view (nothing in flight on this key)
      if (!sent || rec.status !== 'mined') {
        const n = await this.o.chain.getTransactionCount(key.address, 'pending').catch(() => null);
        if (n !== null) key.nonces.resync(n);
      }
    }
  }

  abort(runKey: string): number {
    this.cancels.get(runKey)?.();
    this.cancels.delete(runKey);
    return this.o.paper.abort(runKey);
  }

  exit(order: ExitOrder): Promise<ExitResult> {
    return this.o.paper.exit(order);
  }

  onFeedBlock(b: FeedBlock): void {
    this.o.paper.onFeedBlock(b);
  }
}

