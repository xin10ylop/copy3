/**
 * Recorder: async persistence of snipes, events and feed-block calibration rows. Never awaited
 * on the hot path; writes per snipe are serialised (insert → updates) and failures only logged.
 */
import type { FeedBlock } from '@hood/core';
import { bigintReplacer, type Logger } from './log.js';
import type { PositionEntry } from './positions.js';
import type { EventRecord, FeedBlockRow, SnipeRecord, SniperStore } from './store.js';
import type { SnipeRun } from './types.js';

export function snipeRecord(run: SnipeRun, p?: PositionEntry): SnipeRecord {
  const l = run.launch;
  const closed = run.status === 'closed';
  return {
    playId: run.playId,
    token: l.token ?? '',
    curve: l.curve ?? '',
    decidedAt: new Date(run.decidedAt),
    decision: JSON.parse(
      JSON.stringify(
        {
          play: { id: run.decision.play.id, name: run.decision.play.name },
          reasons: run.decision.reasons,
          preset: run.decision.preset,
          launch: { event: l.event, block: l.block, ts: l.ts, txHash: l.txHash, receivedAt: l.receivedAt, addressSource: l.addressSource, source: l.source },
          plan: run.plan,
          minTokensOut: run.minTokensOut,
          maxTaxBps: run.maxTaxBps,
          deadlineBlock: run.deadlineBlock,
        },
        bigintReplacer,
      ),
    ) as unknown,
    mode: run.mode,
    burst: run.burst.map((m) => ({
      nonce: m.nonce,
      hash: m.hash === '0x' ? undefined : m.hash,
      sentAt: Math.round(m.sentAt ?? m.scheduledAt),
      scheduledAt: m.scheduledAt,
      endpoint: m.sends[0]?.endpoint ?? (run.mode === 'paper' ? 'paper' : ''),
      status: m.status === 'planned' ? 'skipped' : m.status,
      block: m.block,
      sends: m.sends,
    })),
    buyBlock: run.fill?.block ?? null,
    buyTs: run.fill ? new Date(run.fill.ts * 1000) : null,
    quoteIn: run.fill?.quoteIn ?? run.quoteIn,
    tokensOut: run.fill?.tokensOut ?? null,
    taxPaid: run.fill?.taxPaid ?? null,
    entryPrice: run.fill?.entryPrice ?? null,
    status: run.status,
    sells: JSON.parse(JSON.stringify(p?.sales ?? [], bigintReplacer)) as unknown,
    realizedPnlEth: closed && p ? (Number(p.realizedQuote) - Number(p.costBasis)) / 1e18 : null,
    closedAt: closed ? new Date() : null,
    notes: run.notes.length ? run.notes.join('; ') : null,
  };
}

export class Recorder {
  private readonly chains = new Map<string, Promise<number | null>>();
  private feedBuf: FeedBlockRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  readonly stats = { writes: 0, errors: 0 };

  constructor(
    private readonly store: SniperStore,
    private readonly logger: Logger,
    private readonly opts: { feedFlushMs?: number; recordFeedBlocks?: boolean } = {},
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flushFeed(), this.opts.feedFlushMs ?? 1000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.flushFeed();
    await this.idle();
  }

  /** Wait for all queued snipe writes. */
  async idle(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  /** Insert on first call, update afterwards (serialised per run). */
  snipe(run: SnipeRun, p?: PositionEntry, type = 'snipe_update'): void {
    const prev = this.chains.get(run.key) ?? Promise.resolve<number | null>(null);
    const rec = snipeRecord(run, p);
    const next = prev.then(async (id) => {
      try {
        if (id === null) {
          const newId = await this.store.insertSnipe(rec);
          run.id = newId;
          this.stats.writes++;
          await this.notify({ id: newId, type, status: run.status, playId: run.playId, token: rec.token, mode: run.mode });
          return newId;
        }
        await this.store.updateSnipe(id, rec);
        this.stats.writes++;
        await this.notify({ id, type, status: run.status, playId: run.playId, token: rec.token, mode: run.mode });
        return id;
      } catch (e) {
        this.stats.errors++;
        this.logger.error({ err: e, key: run.key }, 'snipe write failed');
        return id;
      }
    });
    this.chains.set(run.key, next);
    if (run.status === 'closed' || run.status === 'failed' || run.status === 'aborted') {
      void next.then(() => {
        if (this.chains.get(run.key) === next) this.chains.delete(run.key);
      });
    }
  }

  private async notify(payload: Record<string, unknown>): Promise<void> {
    try {
      await this.store.notifySnipeEvent(JSON.stringify(payload));
    } catch (e) {
      this.logger.warn({ err: e }, 'notify snipe_events failed');
    }
  }

  event(level: EventRecord['level'], type: string, payload: unknown): void {
    const safe = JSON.parse(JSON.stringify(payload ?? null, bigintReplacer)) as unknown;
    this.store.insertEvent({ level, source: 'sniper', type, payload: safe }).catch((e: unknown) => {
      this.stats.errors++;
      this.logger.warn({ err: e, type }, 'event write failed');
    });
  }

  feedBlock(b: FeedBlock): void {
    if (this.opts.recordFeedBlocks === false) return;
    this.feedBuf.push({ block: b.block, ts: b.timestamp, arrivalMs: b.receivedAt, nTxs: b.txs.length });
  }

  async flushFeed(): Promise<void> {
    if (this.feedBuf.length === 0) return;
    const rows = this.feedBuf;
    this.feedBuf = [];
    try {
      await this.store.insertFeedBlocks(rows);
    } catch (e) {
      this.stats.errors++;
      this.logger.warn({ err: e, n: rows.length }, 'feed_blocks write failed');
    }
  }
}
