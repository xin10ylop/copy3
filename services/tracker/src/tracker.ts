/**
 * Tracker service: turns new eth_transfers into armed candidates.
 *
 * Wake-ups: LISTEN transfers_block (the indexer NOTIFYs the block number after it
 * committed a block with ETH transfers) plus a polling fallback on
 * max(eth_transfers.block). Blocks are processed in order from the tracker's own
 * checkpoint (settings 'tracker.checkpoint'), so missed notifications are caught up.
 * Every `sweepIntervalMs`: expire candidates past expires_at, mark candidates whose
 * wallet launched as 'fired', disarm the rest of a play once stopAfter fired.
 */
import { errMsg, weiToEth, type Address, type Log } from '@hood/indexer';
import { armedKey, funderMatch, matchTransfer, type ContractOrigin, type TransferEvent, type WatchPlay } from './match.js';
import type { CandidateChange, TrackerStore } from './store.js';

export interface TrackerConfig {
  contractMaxAgeBlocks: number;
  sweepIntervalMs: number;
  pollMs: number;
  /** max blocks per eth_transfers query while catching up */
  catchUpBatch: number;
  /** first run without checkpoint: start this many blocks behind the newest transfer */
  initialLookbackBlocks: number;
  unknownNonceIsFresh: boolean;
  fundingPathDepth: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  contractMaxAgeBlocks: 36_000,
  sweepIntervalMs: 60_000,
  pollMs: 5_000,
  catchUpBatch: 5_000,
  initialLookbackBlocks: 0,
  unknownNonceIsFresh: false,
  fundingPathDepth: 3,
};

export interface TrackerStats {
  checkpoint: number | null;
  plays: number;
  armedTotal: number;
  transfersSeen: number;
  lastBlockAt: number | null;
  lastSweepAt: number | null;
  errors: number;
  listening: boolean;
}

export class Tracker {
  readonly cfg: TrackerConfig;
  plays: WatchPlay[] = [];
  readonly stats: TrackerStats = {
    checkpoint: null,
    plays: 0,
    armedTotal: 0,
    transfersSeen: 0,
    lastBlockAt: null,
    lastSweepAt: null,
    errors: 0,
    listening: false,
  };
  private chain: Promise<void> = Promise.resolve();
  private notifyExplicitly = true;

  constructor(
    private readonly store: TrackerStore,
    private readonly log: Log,
    cfg: Partial<TrackerConfig> = {},
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cfg = { ...DEFAULT_TRACKER_CONFIG, ...cfg };
  }

  async init(): Promise<void> {
    await this.reloadPlays();
    this.notifyExplicitly = !(await this.store.armedTriggerInstalled());
    this.stats.checkpoint = await this.store.getCheckpoint();
    if (this.stats.checkpoint === null) {
      const max = await this.store.maxTransferBlock();
      if (max !== null) {
        this.stats.checkpoint = Math.max(0, max - this.cfg.initialLookbackBlocks);
        await this.store.setCheckpoint(this.stats.checkpoint);
      }
    }
    this.log.info({ plays: this.plays.length, checkpoint: this.stats.checkpoint, explicitNotify: this.notifyExplicitly }, 'tracker init');
  }

  async reloadPlays(): Promise<void> {
    this.plays = await this.store.watchPlays((id, err) => this.log.warn({ playId: id, err }, 'invalid play trigger; skipped'));
    this.stats.plays = this.plays.length;
  }

  /** Serialised entry point for `transfers_block` notifications and polls. */
  onBlock(block: number): Promise<void> {
    this.chain = this.chain
      .then(() => this.processUpTo(block))
      .catch((err: unknown) => {
        this.stats.errors++;
        this.log.error({ block, err: errMsg(err) }, 'tracker block processing failed');
      });
    return this.chain;
  }

  async poll(): Promise<void> {
    const max = await this.store.maxTransferBlock();
    if (max !== null && (this.stats.checkpoint === null || max > this.stats.checkpoint)) await this.onBlock(max);
  }

  async processUpTo(block: number): Promise<void> {
    let from = this.stats.checkpoint === null ? block : this.stats.checkpoint + 1;
    while (from <= block) {
      const to = Math.min(block, from + this.cfg.catchUpBatch - 1);
      const transfers = await this.store.transfersBetween(from, to);
      this.stats.transfersSeen += transfers.length;
      await this.handleTransfers(transfers);
      await this.store.setCheckpoint(to);
      this.stats.checkpoint = to;
      this.stats.lastBlockAt = Date.now();
      from = to + 1;
    }
  }

  /** Match a batch of transfers (ordered by block, id) against the watch plays. */
  async handleTransfers(transfers: readonly TransferEvent[]): Promise<number> {
    if (this.plays.length === 0 || transfers.length === 0) return 0;
    const funders = new Set<Address>(this.plays.flatMap((p) => p.rule.funders.map((f) => f.toLowerCase() as Address)));
    const txSender = new Map<string, Address>();
    for (const t of transfers) if (t.traceAddr === '') txSender.set(t.txHash, t.from);

    // contracts that sent ETH and might have been created by a funder (contract mode)
    let origins: ContractOrigin[] = [];
    if (this.plays.some((p) => p.rule.contractMode)) {
      const senders = [...new Set(transfers.filter((t) => t.kind !== 'create' && !funders.has(t.from)).map((t) => t.from))];
      origins = await this.store.contractOrigins(senders, [...funders]);
      // creations inside this very batch (same tx or a few blocks earlier)
      for (const t of transfers) {
        if (t.kind === 'create' && funders.has(t.from)) origins.push({ contract: t.to, creator: t.from, block: t.block, txHash: t.txHash });
      }
    }

    let armed = 0;
    const batchArmed = new Set<string>();
    for (const t of transfers) {
      if (t.kind === 'create') continue;
      const ctx = {
        origins: origins.filter((o) => o.contract === t.from),
        txSender: txSender.get(t.txHash) ?? null,
        contractMaxAgeBlocks: this.cfg.contractMaxAgeBlocks,
      };
      const candidates = this.plays.filter((p) => funderMatch(t, p.rule, ctx) !== null);
      if (candidates.length === 0) continue;
      const recipient = await this.store.recipientFacts(t);
      const already = await this.store.armedPlays(t.to, candidates.map((p) => p.id));
      const armedSet = new Set<string>([...batchArmed, ...[...already].map((id) => armedKey(id, t.to))]);
      const res = matchTransfer(t, candidates, { recipient, origins: ctx.origins, txSender: ctx.txSender, armed: armedSet }, {
        now: this.now(),
        contractMaxAgeBlocks: this.cfg.contractMaxAgeBlocks,
        unknownNonceIsFresh: this.cfg.unknownNonceIsFresh,
      });
      for (const r of res.rejections) {
        this.log.debug({ playId: r.playId, reason: r.reason, wallet: t.to, tx: t.txHash }, 'transfer not armed');
      }
      for (const d of res.arms) {
        const id = await this.store.arm(d);
        batchArmed.add(armedKey(d.playId, d.wallet));
        if (id === null) continue;
        armed++;
        this.stats.armedTotal++;
        const path = await this.store.fundingPath(d.wallet, this.cfg.fundingPathDepth).catch(() => []);
        const payload = {
          id,
          playId: d.playId,
          play: d.playName,
          wallet: d.wallet,
          funder: d.sourceFunder,
          via: d.via,
          valueEth: weiToEth(d.value),
          txHash: d.txHash,
          block: d.block,
          expiresAt: d.expiresAt.toISOString(),
          fundingPath: path.map((h) => ({ wallet: h.wallet, funder: h.funder, kind: h.kind, valueEth: weiToEth(h.value) })),
        };
        await this.store.insertEvent('armed', payload);
        if (this.notifyExplicitly) await this.store.notifyArmed({ op: 'ARMED', ...payload });
        this.log.info(payload, 'candidate armed');
      }
    }
    return armed;
  }

  async sweep(): Promise<CandidateChange[]> {
    const expired = await this.store.expire(this.now());
    const fired = await this.store.markFired();
    const disarmed = await this.store.disarmExhausted(this.plays);
    const changes = [...expired, ...fired, ...disarmed];
    for (const c of changes) {
      await this.store.insertEvent(`candidate_${c.status}`, c);
      if (this.notifyExplicitly) await this.store.notifyArmed({ op: c.status.toUpperCase(), ...c });
    }
    if (changes.length) this.log.info({ expired: expired.length, fired: fired.length, disarmed: disarmed.length }, 'sweep');
    this.stats.lastSweepAt = Date.now();
    return changes;
  }
}
