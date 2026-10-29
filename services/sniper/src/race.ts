/**
 * Race measurement: where did our tx land relative to the FIRST block of second T+1 (the target of
 * every burst), and how many buyers of the same curve were ahead of us in that block?
 *
 *  - probe mode (probe.ts): one 0-value self-transfer per planned burst, sent at the burst's first
 *    slot — the race is measured without buying anything;
 *  - live mode (sniper.ts): the member that bought (the fill), or — when no member bought — the
 *    first member that landed, with its revert reason (a lost race is measured too).
 *
 * The record is persisted as `decision.race` (and summarised in `notes`); `hoodctl race` prints it.
 * `blockOffset` = landed block − first T+1 block as the feed showed it: 0 = target block,
 * < 0 = early (second T: a real buy pays the 99 % snipe tax), > 0 = late.
 */
import type { FeedBlock } from '@hood/core';
import type { Address, Hex } from 'viem';
import type { ChainClient, ReceiptLite } from './chain.js';
import type { Logger } from './log.js';

export type RaceSource = 'probe' | 'live';

export interface RaceRecord {
  source: RaceSource;
  /**
   * skipped / blocked / cancelled: nothing was sent (gate, no funded key, kill switch, run aborted);
   * send_failed: no endpoint accepted it; not_mined: no receipt within the timeout;
   * mined / reverted: landed (a live member that reverted still tells where it landed).
   */
  status: 'planned' | 'skipped' | 'blocked' | 'cancelled' | 'send_failed' | 'not_mined' | 'mined' | 'reverted';
  reason?: string;
  hash?: Hex;
  key?: Address;
  nonce?: number;
  /** live: index of the measured burst member; whether it was the buy */
  member?: number;
  bought?: boolean;
  /** local ms (scheduler clock) */
  scheduledAt?: number;
  sentAt?: number;
  /** predicted local arrival of the first T+1 block (clock.planBurst) and the RTT the plan used */
  boundaryMs?: number;
  rttMs?: number;
  /** sentAt − boundaryMs (the plan aims at −rtt − 120 ms) */
  sendVsBoundaryMs?: number;
  /** per-endpoint send results */
  sends?: { endpoint: string; sentAt: number; doneAt?: number; ok?: boolean; error?: string }[];
  block?: number;
  txIndex?: number | null;
  landedTs?: number | null;
  /** first block of second T+1 as the feed showed it */
  targetBlock?: number | null;
  blockOffset?: number | null;
  /** CurveBuy logs of the launch's curve in the landed block before / after our tx index */
  buysAhead?: number | null;
  buysAfter?: number | null;
  /** CurveBuy logs of the curve in the whole first T+1 block (a live fill's own buy included) */
  buysInBlock?: number | null;
  /** feed arrival (local ms) of the landed block, and relative to the predicted boundary / our send */
  landedArrivalMs?: number | null;
  landedArrivalVsBoundaryMs?: number | null;
  landedArrivalVsSendMs?: number | null;
  /** live: why the measured member reverted (eth_call replay at its block, best effort) */
  revertReason?: string | null;
}

/** The counter family on /healthz (`race_*`): one set for probe and live measurements. */
export const RACE_COUNTERS = [
  'race_planned',
  'race_skipped',
  'race_send_failed',
  'race_sent',
  'race_mined',
  'race_not_mined',
  'race_reverted',
  'race_target_block',
  'race_first_in_block',
  'race_early',
  'race_late',
] as const;
export type RaceCounter = (typeof RACE_COUNTERS)[number];

export interface RaceTrackerOptions {
  chain: ChainClient;
  logger: Logger;
  /** wait this long for the feed to show the T+1 / landed block after the receipt. Default 3000 ms. */
  feedWaitMs?: number;
  /** feed blocks kept (block → ts, arrival). Default 3000 (~5 min). */
  keepBlocks?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RaceTracker {
  readonly counters: Record<RaceCounter, number> = Object.fromEntries(RACE_COUNTERS.map((k) => [k, 0])) as Record<RaceCounter, number>;
  private readonly blocks = new Map<number, { ts: number; at: number }>();

  constructor(private readonly o: RaceTrackerOptions) {}

  onFeedBlock(b: FeedBlock): void {
    if (!this.blocks.has(b.block)) this.blocks.set(b.block, { ts: b.timestamp, at: b.receivedAt });
    const keep = this.o.keepBlocks ?? 3000;
    while (this.blocks.size > keep) this.blocks.delete(this.blocks.keys().next().value!);
  }

  /** First feed block after `afterBlock` whose timestamp is ≥ `ts` (null until the feed showed one). */
  firstBlockOf(ts: number, afterBlock: number): number | null {
    let best: number | null = null;
    for (const [n, b] of this.blocks) if (n > afterBlock && b.ts >= ts && (best === null || n < best)) best = n;
    return best;
  }

  count(k: RaceCounter): void {
    this.counters[k]++;
  }

  /**
   * Fill `rec` from the landed receipt: block offset vs the first T+1 block, tx index, CurveBuy logs
   * of `curve` ahead of / after us (one eth_getLogs over the landed..target range) and the timings.
   * Counts `race_mined` / `race_reverted` and the position counters. Never throws.
   */
  async measure(rec: RaceRecord, i: { curve: Address; launchBlock: number; launchTs: number; receipt: ReceiptLite }): Promise<RaceRecord> {
    const r = i.receipt;
    rec.status = r.status === 'success' ? 'mined' : 'reverted';
    rec.block = r.blockNumber;
    rec.txIndex = r.transactionIndex ?? null;
    const target = (): number | null => this.firstBlockOf(i.launchTs + 1, i.launchBlock);
    const deadline = Date.now() + (this.o.feedWaitMs ?? 3000);
    while ((target() === null || !this.blocks.has(r.blockNumber)) && Date.now() < deadline) await sleep(20);
    const tb = target();
    const landed = this.blocks.get(r.blockNumber);
    rec.targetBlock = tb;
    rec.blockOffset = tb === null ? null : r.blockNumber - tb;
    rec.landedTs = landed?.ts ?? (await this.o.chain.getBlockTimestamp(r.blockNumber).catch(() => null));
    rec.landedArrivalMs = landed?.at ?? null;
    rec.landedArrivalVsBoundaryMs = landed && rec.boundaryMs !== undefined ? round(landed.at - rec.boundaryMs) : null;
    rec.landedArrivalVsSendMs = landed && rec.sentAt !== undefined ? round(landed.at - rec.sentAt) : null;
    const lo = tb === null ? r.blockNumber : Math.min(tb, r.blockNumber);
    const hi = tb === null ? r.blockNumber : Math.max(tb, r.blockNumber);
    let buys: { block: number; txIndex: number }[] | null = null;
    try {
      buys = this.o.chain.curveBuyLogs ? await this.o.chain.curveBuyLogs(i.curve, lo, hi) : null;
    } catch (e) {
      this.o.logger.warn({ err: e, curve: i.curve, lo, hi }, 'race: CurveBuy logs not readable');
    }
    const idx = rec.txIndex;
    rec.buysAhead = buys && idx !== null ? buys.filter((b) => b.block === r.blockNumber && b.txIndex < idx).length : null;
    rec.buysAfter = buys && idx !== null ? buys.filter((b) => b.block === r.blockNumber && b.txIndex > idx).length : null;
    rec.buysInBlock = buys && tb !== null ? buys.filter((b) => b.block === tb).length : null;
    this.count(rec.status === 'mined' ? 'race_mined' : 'race_reverted');
    if (rec.blockOffset !== null) {
      if (rec.blockOffset === 0) {
        this.count('race_target_block');
        if (rec.buysAhead === 0) this.count('race_first_in_block');
      } else this.count(rec.blockOffset < 0 ? 'race_early' : 'race_late');
    }
    return rec;
  }
}

const round = (x: number): number => Math.round(x * 10) / 10;
const signed = (x: number): string => (x >= 0 ? `+${x}` : String(x));

/** One-line summary for `snipes.notes`. */
export function raceNote(r: RaceRecord): string {
  const what = r.source === 'probe' ? 'probe' : `race (member ${r.member ?? '?'}${r.bought ? ', the buy' : ''})`;
  if (r.status === 'not_mined') return `${what}: not mined`;
  if (r.status !== 'mined' && r.status !== 'reverted') return `${what}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`;
  const parts = [
    `block ${r.blockOffset === null || r.blockOffset === undefined ? `${r.block} (T+1 block unknown)` : `${signed(r.blockOffset)} vs the first T+1 block ${r.targetBlock}`}`,
    `txIndex ${r.txIndex ?? '?'}`,
    `${r.buysAhead ?? '?'} buy(s) ahead, ${r.buysAfter ?? '?'} after`,
    `${r.buysInBlock ?? '?'} buy(s) in the T+1 block`,
  ];
  if (r.sendVsBoundaryMs !== undefined) parts.push(`sent ${signed(r.sendVsBoundaryMs)} ms vs boundary`);
  if (r.status === 'reverted') parts.push(`reverted${r.revertReason ? `: ${r.revertReason}` : ''}`);
  return `${what}: ${parts.join(', ')}`;
}

export { round as roundMs };
