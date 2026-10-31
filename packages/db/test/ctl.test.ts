/** hoodctl (packages/db/src/ctl.ts): importing it has no side effects; `status` reads the kill switch like the sniper does. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fmtWhen, formatRace, formatTrades, keygen, killSwitchOn, race, status, tzLabel } from '../src/ctl.js';
import { insertSnipe, setSetting } from '../src/helpers.js';
import { makeTestDb, reset, type TestDb } from './pglite.js';

let db: TestDb;
beforeAll(async () => {
  db = await makeTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await reset(db);
});

// every shape services/sniper/src/risk.ts killSwitchOn treats as ON (telegram parseKillState writes these)
const ON: unknown[] = [true, 'on', 'true', 1, { on: true }, { killed: true, by: 'tg' }, { enabled: true }];
const OFF: unknown[] = [false, 'off', 0, null, undefined, {}, { on: false, reason: null, by: 'seed', at: null }, { killed: false }];

describe('hoodctl status: kill switch', () => {
  it('killSwitchOn accepts exactly the shapes the sniper risk gate accepts', () => {
    for (const v of ON) expect(killSwitchOn(v), JSON.stringify(v)).toBe(true);
    for (const v of OFF) expect(killSwitchOn(v), JSON.stringify(v) ?? 'undefined').toBe(false);
  });

  it('status shows ON for every shape the sniper treats as ON (it showed "off" for true / "on" / 1 / {enabled:true})', async () => {
    for (const v of ON) {
      await setSetting(db.sql, 'kill_switch', v);
      const lines: string[] = [];
      await status(db.sql, (l) => lines.push(l));
      expect(lines[0], JSON.stringify(v)).toBe('kill switch : ON');
    }
    await setSetting(db.sql, 'kill_switch', { on: false, by: 'hoodctl' });
    const lines: string[] = [];
    await status(db.sql, (l) => lines.push(l));
    expect(lines[0]).toBe('kill switch : off');
  });
});

describe('hoodctl race: where probe txs / live buys landed vs the first T+1 block', () => {
  const LTX = (c: string): string => `0x${c.repeat(64)}`;
  const probe = (o: Record<string, unknown>): Record<string, unknown> => ({ source: 'probe', status: 'mined', sendVsBoundaryMs: -126, ...o });

  it('prints one row per measurement and the summary (target block, first in block = race win rate, early, late, median buysAhead)', async () => {
    const rows: [string, Record<string, unknown> | undefined][] = [
      ['a', probe({ blockOffset: 0, txIndex: 1, buysAhead: 0, buysInBlock: 3 })], // won
      ['b', probe({ blockOffset: 0, txIndex: 2, buysAhead: 1, buysInBlock: 2 })], // target block, 1 ahead
      ['c', probe({ blockOffset: 1, txIndex: 0, buysAhead: 0, buysInBlock: 4 })], // late
      ['d', probe({ blockOffset: -1, txIndex: 7, buysAhead: 2, buysInBlock: 1 })], // early
      ['e', probe({ status: 'not_mined' })],
      ['f', probe({ status: 'skipped', reason: 'probe gate: probe key unfunded', sendVsBoundaryMs: undefined })],
      ['9', undefined], // a paper row without a race record is not listed
    ];
    for (const [c, r] of rows) {
      await insertSnipe(db.sql, { token: '0xt', curve: '0xc', mode: 'paper', decision: { launch: { txHash: LTX(c) }, ...(r ? { race: r } : {}) } });
    }
    const lines: string[] = [];
    await race(db.sql, 1, (l) => lines.push(l));
    expect(lines[0]).toMatch(/^decided_at \(UTC\)\s+source launch tx\s+status\s+offset txIdx ahead inBlock\s+sent-vs-boundary$/);
    const body = lines.slice(1, 7);
    expect(body).toHaveLength(6);
    expect(body[0]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d  probe  0xaaaa…aaaa\s+mined\s+\+0\s+1\s+0\s+3\s+-126 ms$/);
    expect(body[2]).toMatch(/0xcccc…cccc\s+mined\s+\+1\s+0\s+0\s+4/);
    expect(body[3]).toMatch(/0xdddd…dddd\s+mined\s+-1\s+7\s+2\s+1/);
    expect(body[4]).toMatch(/not_mined\s+-\s+-\s+-\s+-/);
    expect(body[5]).toMatch(/skipped .* probe gate: probe key unfunded$/);
    const summary = lines.slice(7).join('\n');
    expect(summary).toContain('probe: 6 run(s), 5 sent, 4 landed, 1 not mined, 1 not sent');
    expect(summary).toMatch(/in target block \(offset 0\)\s+:\s+40\.0 %  \(2\/5\)/);
    expect(summary).toMatch(/first in block \(race won\)\s+:\s+20\.0 %  \(1\/5\)  <- the measured race win rate/);
    expect(summary).toMatch(/early \(second T, 99 % tax\)\s+:\s+20\.0 %  \(1\/5\)/);
    expect(summary).toMatch(/late \(after the target block\):\s+20\.0 %  \(1\/5\)/);
    expect(summary).toMatch(/median buysAhead\s+: 0\.5  \(over 4 landed\)/);
  });

  it('live rows get their own summary next to the probes, with the revert reason of a lost burst', () => {
    const at = new Date('2026-10-29T12:00:00Z');
    const lines = formatRace([
      { decidedAt: at, launchTx: LTX('1'), race: { source: 'probe', status: 'mined', blockOffset: 0, txIndex: 0, buysAhead: 0, buysInBlock: 1 } },
      { decidedAt: at, launchTx: LTX('2'), race: { source: 'live', status: 'reverted', blockOffset: 0, txIndex: 5, buysAhead: 3, buysInBlock: 4, revertReason: 'AlreadyBought' } },
    ]);
    expect(lines[1]).toBe('2026-10-29 12:00:00  probe  0x1111…1111   mined           +0     0     0       1                  ');
    expect(lines[2]).toMatch(/live   0x2222…2222   reverted\s+\+0\s+5\s+3\s+4\s+AlreadyBought$/);
    const text = lines.join('\n');
    expect(text).toContain('live: 1 run(s), 1 sent, 1 landed');
    expect(text).toContain('probe: 1 run(s), 1 sent, 1 landed');
    expect(text).toContain('all: 2 run(s), 2 sent, 2 landed');
    expect(formatRace([]).join('\n')).toMatch(/no race measurements yet/);
  });

  it('prints timestamps in HOOD_TZ (Beirut = UTC+2 after the October clock change), header named after the zone', () => {
    const at = new Date('2026-10-29T12:00:00Z');
    expect(fmtWhen(at, 'Asia/Beirut')).toBe('2026-10-29 14:00:00');
    expect(fmtWhen(at, 'UTC')).toBe('2026-10-29 12:00:00');
    expect(fmtWhen(at, 'Not/AZone')).toBe('2026-10-29 12:00:00');
    expect(tzLabel('Asia/Beirut')).toBe('Beirut');
    const lines = formatRace([{ decidedAt: at, launchTx: LTX('1'), race: { source: 'live', status: 'mined', blockOffset: 0, txIndex: 0, buysAhead: 0, buysInBlock: 1 } }], 'Asia/Beirut');
    expect(lines[0]).toMatch(/^decided_at \(Beirut\)/);
    expect(lines[1]).toMatch(/^2026-10-29 14:00:00  live/);
    const t = formatTrades([{ id: 1, decidedAt: at, mode: 'live', status: 'closed', symbol: 'X', buyEth: 0.002, pnlEth: 0.0001, exit: 'timeout', heldSec: 60, race: null }], 'Asia/Beirut');
    expect(t[0]).toMatch(/^when \(Beirut\)/);
    expect(t[1]).toMatch(/^2026-10-29 14:00:00  live/);
  });
});

describe('hoodctl keygen', () => {
  it('prints n fresh keys with their addresses and the env line, nothing else', () => {
    const lines: string[] = [];
    keygen(2, (l) => lines.push(l));
    const env = lines.find((l) => l.startsWith('EXECUTOR_PRIVATE_KEYS='))!;
    const keys = env.slice('EXECUTOR_PRIVATE_KEYS='.length).split(',');
    expect(keys).toHaveLength(2);
    for (const k of keys) expect(k).toMatch(/^0x[0-9a-f]{64}$/);
    expect(keys[0]).not.toBe(keys[1]);
    expect(lines.filter((l) => /^# key \d: address 0x[0-9a-fA-F]{40}$/.test(l))).toHaveLength(2);
    expect(lines.join('\n')).toMatch(/written nowhere/);
  });
});

describe('hoodctl trades: one line per trade with the running total', () => {
  it('shows result, pnl, %, held time, race outcome and the cumulative net', () => {
    const t0 = new Date('2026-10-30T13:01:59Z');
    const lines = formatTrades([
      { id: 1, decidedAt: t0, mode: 'live', status: 'closed', symbol: 'HOOK404', buyEth: 0.003, pnlEth: -0.00056, exit: 'exempt_dump', heldSec: 90.7, race: { status: 'mined', blockOffset: 0, buysAhead: 0 } },
      { id: 2, decidedAt: new Date(t0.getTime() + 60_000), mode: 'live', status: 'closed', symbol: 'GLADE', buyEth: 0.002, pnlEth: 0.00016, exit: 'trailing', heldSec: 4.1, race: { status: 'mined', blockOffset: 9, buysAhead: 0 } },
      { id: 3, decidedAt: new Date(t0.getTime() + 120_000), mode: 'live', status: 'failed', symbol: 'X', buyEth: 0.003, pnlEth: null, exit: null, heldSec: null, race: { status: 'reverted' } },
      { id: 4, decidedAt: new Date(t0.getTime() + 180_000), mode: 'live', status: 'aborted', symbol: 'Hype', buyEth: 0.002, pnlEth: null, exit: null, heldSec: null, race: null, notes: 'planned 0.002; aborted: launch rejected: team cool-off: 0x01d2 lost 2 min ago' },
      { id: 5, decidedAt: new Date(t0.getTime() + 240_000), mode: 'live', status: 'closed', symbol: 'APPLE', buyEth: 0.002, pnlEth: -0.00063, exit: 'stop_loss', heldSec: 58, race: { status: 'mined', blockOffset: 0, buysAhead: 0 }, notes: 'decided 412 ms after the launch block arrived (launch-second); exit stop_loss at -32.1% (peak +29.6%, held 57.9s, snapshot block 5 +16 logs, last block 6)' },
    ]);
    expect(lines[1]).toMatch(/HOOK404.*0\.0030.*loss.*-0\.00056.*-18\.7%.*91s.*exempt_dump, won \(first in block\).*-0\.00056/);
    expect(lines[2]).toMatch(/GLADE.*WIN.*\+0\.00016.*\+8\.0%.*4s.*trailing, late \+9 blocks.*-0\.00040/);
    expect(lines[3]).toMatch(/failed.*reverted/);
    // the note that explains a row sits under it: the abort reason, or the exit-signal reading
    expect(lines[4]).toMatch(/Hype.*aborted/);
    expect(lines[5]).toBe(`${' '.repeat(28)}└ aborted: launch rejected: team cool-off: 0x01d2 lost 2 min ago`);
    expect(lines[6]).toMatch(/APPLE.*loss.*-0\.00063.*stop_loss, won \(first in block\)/);
    expect(lines[7]).toBe(`${' '.repeat(28)}└ decided 412 ms after the launch block arrived (launch-second)`);
    expect(lines[8]).toMatch(/└ exit stop_loss at -32\.1% \(peak \+29\.6%/);
    expect(lines[lines.length - 1]).toBe('3 closed trade(s), 1 win(s), net -0.00103 ETH');
  });
});
