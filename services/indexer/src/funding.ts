/**
 * Funder-graph queries over eth_transfers (used by the tracker and the agent).
 *
 * "Funding" of an address = an incoming eth_transfers row with value > 0, or its
 * creation row (kind 'create', value may be 0: the creator is the lineage of a
 * disperse contract). The *first* such row is the address's first funder.
 */
import type { Sql } from '@hood/db';
import type { Address, Hex, TransferKind } from './types.js';

export interface FundingHop {
  /** 1 = the direct funder of the queried wallet */
  depth: number;
  /** the funded address at this hop */
  wallet: Address;
  funder: Address;
  value: bigint;
  kind: TransferKind;
  txHash: Hex;
  traceAddr: string;
  block: number;
  ts: number;
}

interface TransferDbRow {
  from_addr: string;
  to_addr: string;
  value: string;
  kind: string;
  tx_hash: string;
  trace_addr: string;
  block: number;
  ts: number;
}

const toSec = (since: Date | number): number => (since instanceof Date ? since.getTime() / 1000 : since);

async function firstIncoming(sql: Sql, wallet: Address): Promise<TransferDbRow | null> {
  const rows = await sql.query<TransferDbRow>(
    `select from_addr, to_addr, value::text as value, kind, tx_hash, trace_addr, block::float8 as block,
       extract(epoch from ts)::float8 as ts
     from eth_transfers
     where to_addr = $1 and (value > 0 or kind = 'create') and from_addr <> to_addr
     order by block, id
     limit 1`,
    [wallet],
  );
  return rows[0] ?? null;
}

/**
 * wallet <- funder <- funder ... following each address's FIRST funding transfer
 * (any kind: tx, internal, create), up to `depth` hops; stops on cycles.
 */
export async function fundingPath(sql: Sql, wallet: string, depth = 5): Promise<FundingHop[]> {
  const out: FundingHop[] = [];
  const seen = new Set<string>();
  let cur = wallet.toLowerCase() as Address;
  for (let d = 1; d <= depth; d++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const r = await firstIncoming(sql, cur);
    if (!r) break;
    out.push({
      depth: d,
      wallet: cur,
      funder: r.from_addr as Address,
      value: BigInt(r.value),
      kind: r.kind as TransferKind,
      txHash: r.tx_hash as Hex,
      traceAddr: r.trace_addr,
      block: Number(r.block),
      ts: Number(r.ts),
    });
    cur = r.from_addr as Address;
  }
  return out;
}

export interface Sibling {
  wallet: Address;
  /** 'direct' from the funder, 'contract' from a contract the funder created, 'sameTx' internal transfer in a tx the funder sent */
  via: 'direct' | 'contract' | 'sameTx';
  /** the address that actually sent the ETH (funder or its contract) */
  from: Address;
  value: bigint;
  kind: TransferKind;
  txHash: Hex;
  block: number;
  ts: number;
  /** wallets row: funded first by this transfer with nonce 0 */
  fresh: boolean | null;
}

interface SiblingDbRow extends TransferDbRow {
  via: string;
  first_funding_tx: string | null;
  tx_count_at_first_funding: number | null;
}

/**
 * Wallets funded by `funder` since `since` (Date or unix seconds): directly, through
 * a contract the funder created (contract / disperse mode) or by an internal transfer
 * inside a tx the funder sent. One row per wallet (its earliest such funding);
 * contracts (created ones, or wallets rows with is_contract) are not siblings.
 */
export async function siblingsOf(sql: Sql, funder: string, since: Date | number = 0): Promise<Sibling[]> {
  const rows = await sql.query<SiblingDbRow>(
    `with created as (
       select to_addr from eth_transfers where from_addr = $1 and kind = 'create'
     ), funder_txs as (
       select tx_hash from eth_transfers where from_addr = $1 and trace_addr = ''
     ), cand as (
       select t.*, case
           when t.from_addr = $1 then 'direct'
           when t.from_addr in (select to_addr from created) then 'contract'
           else 'sameTx' end as via
       from eth_transfers t
       where t.ts >= to_timestamp($2) and t.value > 0 and t.kind <> 'create' and t.to_addr <> $1
         and (t.from_addr = $1
              or t.from_addr in (select to_addr from created)
              or (t.kind = 'internal' and t.tx_hash in (select tx_hash from funder_txs)))
     ), firsts as (
       select distinct on (to_addr) * from cand order by to_addr, block, id
     )
     select c.from_addr, c.to_addr, c.value::text as value, c.kind, c.tx_hash, c.trace_addr, c.block::float8 as block,
       extract(epoch from c.ts)::float8 as ts, c.via, w.first_funding_tx, w.tx_count_at_first_funding
     from firsts c
     left join wallets w on w.address = c.to_addr
     where c.to_addr not in (select to_addr from created) and coalesce(w.is_contract, false) = false
     order by c.block, c.id`,
    [funder.toLowerCase(), toSec(since)],
  );
  return rows.map((r) => ({
    wallet: r.to_addr as Address,
    via: r.via as Sibling['via'],
    from: r.from_addr as Address,
    value: BigInt(r.value),
    kind: r.kind as TransferKind,
    txHash: r.tx_hash as Hex,
    block: Number(r.block),
    ts: Number(r.ts),
    fresh: r.first_funding_tx === null ? null : r.first_funding_tx === r.tx_hash && r.tx_count_at_first_funding === 0,
  }));
}

/** All incoming funding transfers of a wallet (newest last), for the agent's get_wallet_funding. */
export async function incomingTransfers(sql: Sql, wallet: string, limit = 100): Promise<FundingHop[]> {
  const rows = await sql.query<TransferDbRow>(
    `select from_addr, to_addr, value::text as value, kind, tx_hash, trace_addr, block::float8 as block,
       extract(epoch from ts)::float8 as ts
     from eth_transfers
     where to_addr = $1 and (value > 0 or kind = 'create')
     order by block, id
     limit $2`,
    [wallet.toLowerCase(), limit],
  );
  return rows.map((r) => ({
    depth: 1,
    wallet: r.to_addr as Address,
    funder: r.from_addr as Address,
    value: BigInt(r.value),
    kind: r.kind as TransferKind,
    txHash: r.tx_hash as Hex,
    traceAddr: r.trace_addr,
    block: Number(r.block),
    ts: Number(r.ts),
  }));
}
