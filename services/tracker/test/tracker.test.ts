import { describe, expect, it } from 'vitest';
import { PgStore, emptyBatch, silentLog, type Address, type Hex, type TransferRow, type WalletRow } from '@hood/indexer';
import { pgliteSql } from '../../indexer/test/helpers/pglite-sql.js';
import { PgTrackerStore } from '../src/store.js';
import { Tracker } from '../src/tracker.js';
import { buildWatchPlay } from '../src/watch.js';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const mE = (milli: number) => BigInt(milli) * 10n ** 15n;
const FUNDER = a(0xf1);
const SPRAYER = a(0xc0);
const W1 = a(0x101), W2 = a(0x102), W3 = a(0x103), OLD = a(0x104), BIG = a(0x105);
const T0 = 1_800_000_000;

const tr = (block: number, tx: number, traceAddr: string, from: Address, to: Address, value: bigint, kind: TransferRow['kind']): TransferRow =>
  ({ block, ts: T0 + block, txHash: h(tx), traceAddr, from, to, value, kind });
const wallet = (address: Address, tx: number, nonce: number | null, isContract = false): WalletRow =>
  ({ address, firstSeenBlock: 0, firstSeenTs: T0, firstFunder: FUNDER, firstFundingValue: 1n, firstFundingTx: h(tx), isContract, txCountAtFirstFunding: nonce });

async function setup(now: () => Date = () => new Date(T0 * 1000)) {
  const { sql, db } = await pgliteSql();
  const indexer = new PgStore(sql);
  const p = buildWatchPlay({ funder: FUNDER, minEth: 0.01, maxEth: 0.015, name: 'sprayer', maxAgeSec: 3600 });
  await sql.query(`insert into plays (name, enabled, trigger, preset) values ($1, $2, $3::jsonb, $4::jsonb)`, [
    p.name, p.enabled, JSON.stringify(p.trigger), JSON.stringify(p.preset),
  ]);
  await sql.query(`insert into plays (name, enabled, trigger, preset) values ('disabled', false, $1::jsonb, '{}'::jsonb)`, [JSON.stringify(p.trigger)]);
  await sql.query(`insert into plays (name, enabled, trigger, preset) values ('no wallet rule', true, '{"deployerIn": []}'::jsonb, '{}'::jsonb)`);
  const notes: string[] = [];
  await db.listen('armed_changed', (x) => notes.push(x));
  const store = new PgTrackerStore(sql);
  const tracker = new Tracker(store, silentLog, { contractMaxAgeBlocks: 100 }, now);
  return { sql, indexer, store, tracker, notes };
}

describe('Tracker on PGlite (packages/db migration)', () => {
  it('arms fresh wallets funded directly and through a sprayer contract, once', async () => {
    const { sql, indexer, tracker, notes } = await setup();
    await indexer.writeBatch({ ...emptyBatch(), transfers: [tr(5, 50, '', OLD, OLD, 1n, 'tx'), tr(6, 60, '', a(0x999), OLD, mE(1), 'tx')] });
    await tracker.init();
    expect(tracker.stats.checkpoint).toBe(6);
    expect(tracker.plays.map((p) => p.name)).toEqual(['sprayer']);
    expect(tracker.stats.checkpoint).toBe(6);

    await indexer.writeBatch({
      ...emptyBatch(),
      transfers: [
        tr(10, 1, '', FUNDER, W1, mE(12), 'tx'), // direct, fresh
        tr(10, 2, '', FUNDER, SPRAYER, 0n, 'create'), // sprayer created by the funder
        tr(11, 3, '', FUNDER, SPRAYER, mE(50), 'tx'),
        tr(12, 4, '0', SPRAYER, W2, mE(13), 'internal'), // contract mode
        tr(12, 4, '1', SPRAYER, OLD, mE(13), 'internal'), // not fresh (prior transfers)
        tr(12, 4, '2', SPRAYER, BIG, mE(40), 'internal'), // out of range
        tr(13, 5, '', FUNDER, W3, mE(11), 'tx'), // nonce unknown -> not armed
      ],
      wallets: [wallet(W1, 1, 0), wallet(W2, 4, 0), wallet(BIG, 4, 0), wallet(W3, 5, null), wallet(SPRAYER, 2, null, true)],
    });
    await tracker.onBlock(13);
    const rows = await sql.query<{ wallet: string; source_funder: string; status: string; funded_value: string; exp: number; armed: number }>(
      `select wallet, source_funder, status, funded_value::text as funded_value,
              extract(epoch from expires_at)::float8 as exp, extract(epoch from armed_at)::float8 as armed
       from armed_candidates order by id`,
    );
    expect(rows.map((r) => [r.wallet, r.source_funder, r.status, r.funded_value])).toEqual([
      [W1, FUNDER, 'armed', mE(12).toString()],
      [W2, FUNDER, 'armed', mE(13).toString()],
    ]);
    expect(rows[0]!.exp).toBe(T0 + 3600);
    const events = await sql.query<{ type: string; payload: { via: string; fundingPath: unknown[] } }>(`select type, payload from events order by id`);
    expect(events.map((e) => [e.type, e.payload.via])).toEqual([['armed', 'direct'], ['armed', 'contract']]);
    expect(events[1]!.payload.fundingPath).toHaveLength(2); // W2 <- sprayer <- funder
    expect(tracker.stats.checkpoint).toBe(13);

    // the migration's trigger notifies armed_changed; the tracker does not double-notify
    await new Promise((r) => setTimeout(r, 20));
    expect(notes.map((n) => JSON.parse(n).wallet)).toEqual([W1, W2]);

    // re-delivery / replay is idempotent
    await tracker.handleTransfers(await new PgTrackerStore(sql).transfersBetween(10, 13));
    const [{ n }] = (await sql.query<{ n: number }>(`select count(*)::int n from armed_candidates`)) as [{ n: number }];
    expect(n).toBe(2);
    await sql.end();
  });

  it('starts after pre-existing history, then catches up via polling and notifications', async () => {
    const { indexer, tracker, sql } = await setup();
    // funding that happened before the tracker ever ran is history, not a new arm
    await indexer.writeBatch({ ...emptyBatch(), transfers: [tr(20, 1, '', FUNDER, W1, mE(12), 'tx')], wallets: [wallet(W1, 1, 0)] });
    await tracker.init();
    expect(tracker.stats.checkpoint).toBe(20);
    await indexer.writeBatch({ ...emptyBatch(), transfers: [tr(21, 2, '', FUNDER, W2, mE(12), 'tx')], wallets: [wallet(W2, 2, 0)] });
    await tracker.poll(); // missed NOTIFY: the poll finds block 21
    expect(tracker.stats.checkpoint).toBe(21);
    await indexer.writeBatch({ ...emptyBatch(), transfers: [tr(30, 3, '', FUNDER, W3, mE(12), 'tx')], wallets: [wallet(W3, 3, 0)] });
    await tracker.onBlock(30);
    const rows = await sql.query<{ wallet: string }>(`select wallet from armed_candidates order by id`);
    expect(rows.map((r) => r.wallet)).toEqual([W2, W3]);
    await sql.end();
  });

  it('sweeps: fires on launch by the armed wallet, expires, disarms after stopAfter', async () => {
    let now = new Date(T0 * 1000);
    const { indexer, tracker, sql } = await setup(() => now);
    await tracker.init(); // empty DB -> checkpoint 0, everything later is new
    expect(tracker.stats.checkpoint).toBe(0);
    await indexer.writeBatch({
      ...emptyBatch(),
      transfers: [tr(40, 1, '', FUNDER, W1, mE(12), 'tx'), tr(40, 2, '', FUNDER, W2, mE(12), 'tx'), tr(41, 3, '', FUNDER, W3, mE(12), 'tx')],
      wallets: [wallet(W1, 1, 0), wallet(W2, 2, 0), wallet(W3, 3, 0)],
    });
    await tracker.onBlock(41);
    // W3 armed 10 min later than the others
    await sql.query(`update armed_candidates set expires_at = expires_at + interval '10 minutes' where wallet = $1`, [W3]);
    // W1 launches a token -> fired; stopAfter=1 -> remaining candidates of the play are disarmed
    await sql.query(
      `insert into launches (token, curve, deployer, launch_kind, block, ts) values ($1, $2, $3, 'launchToken', 50, now())`,
      [a(0xaaa), a(0xccc), W1],
    );
    now = new Date((T0 + 3600 + 1) * 1000); // W2 and W1's original expiry passed, W3 not yet
    const changes = await tracker.sweep();
    expect(changes.map((c) => [c.wallet, c.status])).toEqual([
      [W1, 'fired'],
      [W2, 'expired'],
      [W3, 'disarmed'],
    ]);
    expect(changes.find((c) => c.status === 'fired')?.token).toBe(a(0xaaa));
    const types = await sql.query<{ type: string }>(`select type from events where type like 'candidate_%' order by id`);
    expect(types.map((t) => t.type)).toEqual(['candidate_fired', 'candidate_expired', 'candidate_disarmed']);
    expect(await new PgTrackerStore(sql).armedCount()).toBe(0);
    await sql.end();
  });
});
