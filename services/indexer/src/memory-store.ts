/** In-memory IndexerStore with the same idempotency rules as the SQL store. */
import type { Batch, DirectoryEntry, IndexerStore, StoredCurve } from './store.js';
import type {
  Address,
  Checkpoint,
  LaunchRow,
  TokenMetricsRow,
  TokenTransferRow,
  TradeRow,
  TransferRow,
  WalletRow,
} from './types.js';

export class MemoryStore implements IndexerStore {
  readonly launches = new Map<Address, LaunchRow>();
  readonly trades = new Map<string, TradeRow>();
  readonly tokenTransfers = new Map<string, TokenTransferRow>();
  readonly transfers = new Map<string, TransferRow>();
  readonly wallets = new Map<Address, WalletRow>();
  readonly metrics = new Map<Address, TokenMetricsRow>();
  readonly notifications: number[] = [];
  checkpoint: Checkpoint | null = null;
  writes = 0;

  async writeBatch(b: Batch): Promise<void> {
    this.writes++;
    for (const l of b.launches) if (!this.launches.has(l.token)) this.launches.set(l.token, structuredClone(l));
    for (const t of b.trades) {
      const k = `${t.txHash}:${t.logIndex}`;
      if (!this.trades.has(k)) this.trades.set(k, t);
    }
    for (const t of b.tokenTransfers) {
      const k = `${t.txHash}:${t.logIndex}`;
      if (!this.tokenTransfers.has(k)) this.tokenTransfers.set(k, t);
    }
    for (const t of b.transfers) {
      const k = `${t.txHash}:${t.traceAddr}`;
      if (!this.transfers.has(k)) this.transfers.set(k, t);
    }
    for (const w of b.wallets) if (!this.wallets.has(w.address)) this.wallets.set(w.address, w);
    for (const m of b.metrics) this.metrics.set(m.token, m);
    for (const [token, ex] of b.exemptionUpdates) {
      const l = this.launches.get(token);
      if (l) l.exemptions = [...ex];
    }
    for (const token of b.graduated) {
      const l = this.launches.get(token);
      if (l) l.graduated = true;
    }
    if (b.checkpoint) this.checkpoint = b.checkpoint;
  }

  async getCheckpoint(): Promise<Checkpoint | null> {
    return this.checkpoint;
  }

  async loadDirectory(): Promise<DirectoryEntry[]> {
    return [...this.launches.values()].map((l) => ({ token: l.token, curve: l.curve, ts: l.ts }));
  }

  async loadCurve(curve: Address): Promise<StoredCurve | null> {
    const launch = [...this.launches.values()].find((l) => l.curve === curve) ?? null;
    const trades = [...this.trades.values()].filter((t) => t.curve === curve);
    const token = launch?.token ?? trades[0]?.token;
    if (!token) return null;
    return {
      launch: launch ? structuredClone(launch) : null,
      token,
      trades: trades.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex),
      tokenTransfers: [...this.tokenTransfers.values()].filter((t) => t.token === token),
    };
  }

  async knownWallets(addresses: readonly Address[]): Promise<Set<Address>> {
    return new Set(addresses.filter((a) => this.wallets.has(a)));
  }

  async rollbackFrom(block: number): Promise<Address[]> {
    const stale = new Set<Address>();
    for (const [k, t] of this.trades) if (t.block >= block) (stale.add(t.token), this.trades.delete(k));
    for (const [k, t] of this.tokenTransfers) if (t.block >= block) (stale.add(t.token), this.tokenTransfers.delete(k));
    for (const [k, t] of this.launches) if (t.block >= block) (this.launches.delete(k), this.metrics.delete(k), stale.delete(k));
    for (const [k, t] of this.transfers) if (t.block >= block) this.transfers.delete(k);
    for (const [k, w] of this.wallets) if (w.firstSeenBlock >= block) this.wallets.delete(k);
    if (this.checkpoint && this.checkpoint.block >= block) this.checkpoint = null;
    return [...stale];
  }

  async notifyTransfers(block: number): Promise<void> {
    this.notifications.push(block);
  }
}
