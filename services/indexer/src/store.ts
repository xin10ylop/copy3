/**
 * Persistence boundary of the indexer. The pipeline and backfill only talk to
 * this interface; `PgStore` (pg-store.ts) implements it on @hood/db and
 * `MemoryStore` (memory-store.ts) in memory for tests / dry runs.
 */
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

export interface Batch {
  launches: LaunchRow[];
  trades: TradeRow[];
  tokenTransfers: TokenTransferRow[];
  transfers: TransferRow[];
  wallets: WalletRow[];
  metrics: TokenMetricsRow[];
  /** token -> full exemptions list (post-launch SnipeTaxExempted) */
  exemptionUpdates: Map<Address, Address[]>;
  graduated: Set<Address>;
  /** written in the same transaction as the rows (live pipeline only) */
  checkpoint?: Checkpoint;
}

export function emptyBatch(): Batch {
  return {
    launches: [],
    trades: [],
    tokenTransfers: [],
    transfers: [],
    wallets: [],
    metrics: [],
    exemptionUpdates: new Map(),
    graduated: new Set(),
  };
}

export interface StoredCurve {
  launch: LaunchRow | null;
  token: Address;
  trades: TradeRow[];
  tokenTransfers: TokenTransferRow[];
}

export interface DirectoryEntry {
  token: Address;
  curve: Address;
  ts: number;
}

export const CHECKPOINT_KEY = 'indexer.checkpoint';
export const TRANSFERS_CHANNEL = 'transfers_block';

export interface IndexerStore {
  /** Persist one block (or one backfill chunk) atomically and idempotently. */
  writeBatch(batch: Batch): Promise<void>;
  getCheckpoint(): Promise<Checkpoint | null>;
  /** token/curve/ts of every known launch (to recognise curves and launched tokens). */
  loadDirectory(): Promise<DirectoryEntry[]>;
  /** launch + trades + token transfers of one curve, or null if nothing is stored. */
  loadCurve(curve: Address): Promise<StoredCurve | null>;
  /** subset of `addresses` that already have a wallets row */
  knownWallets(addresses: readonly Address[]): Promise<Set<Address>>;
  /** delete everything at block >= `block`; returns the tokens whose metrics are now stale */
  rollbackFrom(block: number): Promise<Address[]>;
  /** NOTIFY transfers_block '<block>' (tracker wake-up) */
  notifyTransfers(block: number): Promise<void>;
}
