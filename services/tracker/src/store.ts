/** Persistence boundary of the tracker (SQL in PgTrackerStore; tests run it on PGlite). */
import { PlayTriggerSchema, PresetSchema } from '@hood/core';
import { armCandidate, expireArmed, insertEvent, listArmed, listEnabledPlays, notify, type Sql } from '@hood/db';
import { fundingPath, type Address, type FundingHop, type Hex, type TransferKind } from '@hood/indexer';
import type { ArmDecision, ContractOrigin, RecipientFacts, TransferEvent, WatchPlay } from './match.js';

/** JSON-safe copy (bigint -> string) for jsonb payloads / NOTIFY. */
const jsonSafe = (v: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(v ?? {}, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as Record<string, unknown>;

export const TRACKER_CHECKPOINT_KEY = 'tracker.checkpoint';
export const ARMED_CHANNEL = 'armed_changed';

export interface CandidateChange {
  id: number;
  playId: number;
  wallet: Address;
  status: 'armed' | 'expired' | 'fired' | 'disarmed';
  token?: Address;
}

export interface TrackerStore {
  getCheckpoint(): Promise<number | null>;
  setCheckpoint(block: number): Promise<void>;
  maxTransferBlock(): Promise<number | null>;
  /** smallest block in [from, to] that has eth_transfers (skips empty ranges) */
  nextTransferBlock(from: number, to: number): Promise<number | null>;
  transfersBetween(from: number, to: number): Promise<TransferEvent[]>;
  /** enabled plays with trigger.armedWallet; invalid triggers are reported via onInvalid */
  watchPlays(onInvalid?: (id: number, err: string) => void): Promise<WatchPlay[]>;
  contractOrigins(contracts: readonly Address[], funders: readonly Address[]): Promise<ContractOrigin[]>;
  recipientFacts(t: TransferEvent): Promise<RecipientFacts>;
  armedPlays(wallet: Address, playIds: readonly number[]): Promise<Set<number>>;
  arm(d: ArmDecision): Promise<number | null>;
  insertEvent(type: string, payload: unknown, level?: 'info' | 'warn'): Promise<void>;
  notifyArmed(payload: unknown): Promise<void>;
  /** true when the DB already NOTIFYs armed_changed from a trigger */
  armedTriggerInstalled(): Promise<boolean>;
  expire(now: Date): Promise<CandidateChange[]>;
  /** armed candidates whose wallet launched (deployer / fee recipient / exemption) -> 'fired' */
  markFired(): Promise<CandidateChange[]>;
  /** disarm still-armed candidates of plays whose fired count reached stopAfter */
  disarmExhausted(plays: readonly WatchPlay[]): Promise<CandidateChange[]>;
  armedCount(): Promise<number>;
  fundingPath(wallet: Address, depth: number): Promise<FundingHop[]>;
}

interface CandidateDbRow {
  id: number | string;
  play_id: number;
  wallet: string;
}

const toChange = (r: CandidateDbRow, status: CandidateChange['status']): CandidateChange => ({
  id: Number(r.id),
  playId: Number(r.play_id),
  wallet: r.wallet as Address,
  status,
});

export class PgTrackerStore implements TrackerStore {
  private triggerInstalled: boolean | null = null;

  constructor(readonly sql: Sql) {}

  async getCheckpoint(): Promise<number | null> {
    const rows = await this.sql.query<{ block: number | null }>(
      `select (value->>'block')::float8 as block from settings where key = $1`,
      [TRACKER_CHECKPOINT_KEY],
    );
    const b = rows[0]?.block;
    return b === undefined || b === null ? null : Number(b);
  }

  async setCheckpoint(block: number): Promise<void> {
    await this.sql.query(
      `insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
      [TRACKER_CHECKPOINT_KEY, JSON.stringify({ block })],
    );
  }

  async maxTransferBlock(): Promise<number | null> {
    const rows = await this.sql.query<{ b: number | null }>(`select max(block)::float8 as b from eth_transfers`);
    const b = rows[0]?.b;
    return b === undefined || b === null ? null : Number(b);
  }

  async nextTransferBlock(from: number, to: number): Promise<number | null> {
    const rows = await this.sql.query<{ b: number | null }>(
      `select min(block)::float8 as b from eth_transfers where block between $1 and $2`,
      [from, to],
    );
    const b = rows[0]?.b;
    return b === undefined || b === null ? null : Number(b);
  }

  async transfersBetween(from: number, to: number): Promise<TransferEvent[]> {
    const rows = await this.sql.query<{
      id: number; block: number; ts: number; tx_hash: string; trace_addr: string; from_addr: string; to_addr: string; value: string; kind: string;
    }>(
      `select id::float8 as id, block::float8 as block, extract(epoch from ts)::float8 as ts, tx_hash, trace_addr,
         from_addr, to_addr, value::text as value, kind
       from eth_transfers where block between $1 and $2 order by block, id`,
      [from, to],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      block: Number(r.block),
      ts: Number(r.ts),
      txHash: r.tx_hash as Hex,
      traceAddr: r.trace_addr,
      from: r.from_addr as Address,
      to: r.to_addr as Address,
      value: BigInt(r.value),
      kind: r.kind as TransferKind,
    }));
  }

  async watchPlays(onInvalid?: (id: number, err: string) => void): Promise<WatchPlay[]> {
    const out: WatchPlay[] = [];
    for (const p of await listEnabledPlays(this.sql)) {
      const trig = PlayTriggerSchema.safeParse(p.trigger ?? {});
      if (!trig.success) {
        onInvalid?.(p.id, trig.error.message);
        continue;
      }
      if (!trig.data.armedWallet || trig.data.armedWallet.funders.length === 0) continue;
      const preset = PresetSchema.safeParse(p.preset ?? {});
      out.push({
        id: Number(p.id),
        name: p.name ?? `play ${p.id}`,
        rule: trig.data.armedWallet,
        stopAfter: preset.success ? preset.data.stopAfter : 1,
      });
    }
    return out;
  }

  async contractOrigins(contracts: readonly Address[], funders: readonly Address[]): Promise<ContractOrigin[]> {
    if (contracts.length === 0 || funders.length === 0) return [];
    const rows = await this.sql.query<{ to_addr: string; from_addr: string; block: number; tx_hash: string }>(
      `select to_addr, from_addr, block::float8 as block, tx_hash from eth_transfers
       where kind = 'create' and to_addr = any($1::text[]) and from_addr = any($2::text[])`,
      [[...contracts], [...funders]],
    );
    return rows.map((r) => ({
      contract: r.to_addr as Address,
      creator: r.from_addr as Address,
      block: Number(r.block),
      txHash: r.tx_hash as Hex,
    }));
  }

  async recipientFacts(t: TransferEvent): Promise<RecipientFacts> {
    const rows = await this.sql.query<{
      prior: number; tx_count_at_first_funding: number | null; first_funding_tx: string | null; is_contract: boolean | null;
    }>(
      `select (select count(*) from eth_transfers e
                where (e.to_addr = $1 or e.from_addr = $1) and (e.block < $2 or (e.block = $2 and e.id < $3)))::int as prior,
              w.tx_count_at_first_funding, w.first_funding_tx, w.is_contract
       from (select 1) one left join wallets w on w.address = $1`,
      [t.to, t.block, t.id],
    );
    const r = rows[0];
    return {
      priorTransfers: Number(r?.prior ?? 0),
      txCountAtFirstFunding: r?.tx_count_at_first_funding ?? null,
      firstFundingTx: (r?.first_funding_tx ?? null) as Hex | null,
      isContract: r?.is_contract ?? null,
    };
  }

  async armedPlays(wallet: Address, playIds: readonly number[]): Promise<Set<number>> {
    if (playIds.length === 0) return new Set();
    const rows = await this.sql.query<{ play_id: number }>(
      `select play_id from armed_candidates where wallet = $1 and play_id = any($2::int[])`,
      [wallet, [...playIds]],
    );
    return new Set(rows.map((r) => Number(r.play_id)));
  }

  /** @hood/db armCandidate (callers check armedPlays first, so this is always a new arm). */
  async arm(d: ArmDecision): Promise<number | null> {
    const row = await armCandidate(this.sql, {
      playId: d.playId,
      wallet: d.wallet,
      sourceFunder: d.sourceFunder,
      fundedValue: d.value,
      fundedTx: d.txHash,
      expiresAt: d.expiresAt,
    });
    return row ? Number(row.id) : null;
  }

  async insertEvent(type: string, payload: unknown, level: 'info' | 'warn' = 'info'): Promise<void> {
    await insertEvent(this.sql, { level, source: 'tracker', type, payload: jsonSafe(payload) });
  }

  notifyArmed(payload: unknown): Promise<void> {
    return notify(this.sql, ARMED_CHANNEL, jsonSafe(payload));
  }

  async armedTriggerInstalled(): Promise<boolean> {
    if (this.triggerInstalled === null) {
      const rows = await this.sql.query<{ n: number }>(
        `select count(*)::int as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
         where c.relname = 'armed_candidates' and not t.tgisinternal`,
      );
      this.triggerInstalled = Number(rows[0]?.n ?? 0) > 0;
    }
    return this.triggerInstalled;
  }

  /** rows that @hood/db expireArmed (count only) is about to expire, then expireArmed itself */
  async expire(now: Date): Promise<CandidateChange[]> {
    const due = await this.sql.query<CandidateDbRow>(
      `select id::float8 as id, play_id, wallet from armed_candidates
       where status = 'armed' and expires_at is not null and expires_at < $1 order by id`,
      [now],
    );
    if (due.length === 0) return [];
    await expireArmed(this.sql, now);
    return due.map((r) => toChange(r, 'expired'));
  }

  async markFired(): Promise<CandidateChange[]> {
    const rows = await this.sql.query<{ id: number; play_id: number; wallet: string; token: string }>(
      `with hits as (
         select distinct on (c.id) c.id, l.token
         from armed_candidates c
         join launches l on (l.deployer = c.wallet or l.creator_fee_recipient = c.wallet or c.wallet = any(l.exemptions))
         where c.status = 'armed' and l.ts >= c.armed_at - interval '10 minutes'
         order by c.id, l.ts
       )
       update armed_candidates c set status = 'fired' from hits
       where c.id = hits.id
       returning c.id::float8 as id, c.play_id, c.wallet, hits.token`,
    );
    return rows.map((r) => ({ id: Number(r.id), playId: Number(r.play_id), wallet: r.wallet as Address, status: 'fired', token: r.token as Address }));
  }

  async disarmExhausted(plays: readonly WatchPlay[]): Promise<CandidateChange[]> {
    const out: CandidateChange[] = [];
    for (const p of plays) {
      const rows = await this.sql.query<CandidateDbRow>(
        `update armed_candidates set status = 'disarmed'
         where play_id = $1 and status = 'armed'
           and (select count(*) from armed_candidates f where f.play_id = $1 and f.status = 'fired') >= $2
         returning id::float8 as id, play_id, wallet`,
        [p.id, p.stopAfter],
      );
      out.push(...rows.map((r) => toChange(r, 'disarmed')));
    }
    return out;
  }

  async armedCount(): Promise<number> {
    return (await listArmed(this.sql, 'armed')).length;
  }

  fundingPath(wallet: Address, depth: number): Promise<FundingHop[]> {
    return fundingPath(this.sql, wallet, depth);
  }
}
