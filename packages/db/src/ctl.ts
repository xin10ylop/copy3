/**
 * hoodctl – operate the system without Telegram.
 *
 *   pnpm --filter @hood/db ctl status            kill state, enabled plays, armed candidates, open positions, today's PnL
 *   pnpm --filter @hood/db ctl kill [reason]     global kill switch ON (sniper stops entering; exits keep running)
 *   pnpm --filter @hood/db ctl resume            kill switch OFF
 *   pnpm --filter @hood/db ctl pnl [days]        realised PnL per day and per play (paper + live)
 *   pnpm --filter @hood/db ctl plays             list plays
 *   pnpm --filter @hood/db ctl play on|off <id>  enable / disable a play
 *   pnpm --filter @hood/db ctl events [n]        last n events (default 30)
 *   pnpm --filter @hood/db ctl race [days]       race measurements (probe txs, live buys): where we landed vs the first T+1 block
 *   pnpm --filter @hood/db ctl keygen [n]        print n new executor keys + addresses (written nowhere; no DATABASE_URL needed)
 *
 * Reads DATABASE_URL (except keygen). Every write goes through the same settings/plays rows the services LISTEN on.
 */
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getSetting, setSetting, insertEvent } from './helpers.js';
import type { Sql } from './sql.js';

const n = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

type Row = Record<string, unknown>;

/**
 * Is the kill switch on? EXACTLY the shapes the sniper's risk gate treats as ON
 * (services/sniper/src/risk.ts `killSwitchOn`, the telegram bot's parseKillState): `true`, `'on'`,
 * `'true'`, `1`, `{on: true}`, `{enabled: true}`, `{killed: true}`. `status` used to show `off` for
 * `true`, `'on'`, `1` and `{enabled: true}` while the sniper refused every entry.
 */
export function killSwitchOn(v: unknown): boolean {
  if (v === true || v === 'on' || v === 'true' || v === 1) return true;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return o.on === true || o.enabled === true || o.killed === true;
  }
  return false;
}

/** `hoodctl status` (exported for tests; `out` receives each line). */
export async function status(sql: Sql, out: (line: string) => void = console.log): Promise<void> {
  const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => sql.query<T>(text, params);
  const kill = await getSetting<unknown>(sql, 'kill_switch');
  const [plays] = await q<{ enabled: string; total: string }>(`select count(*) filter (where enabled) as enabled, count(*) as total from plays`);
  const [armed] = await q<{ c: string }>(`select count(*) as c from armed_candidates where status = 'armed'`);
  const open = await q<{ mode: string; c: string }>(`select mode, count(*) as c from snipes where status in ('pending','open') group by mode`);
  const today = await q<{ mode: string; n: string; pnl: number | null }>(
    `select mode, count(*) as n, sum(realized_pnl_eth) as pnl from snipes where status = 'closed' and closed_at >= date_trunc('day', now() at time zone 'utc') group by mode`,
  );
  const sizing = await getSetting<Record<string, unknown>>(sql, 'auto_approve');
  out(`kill switch : ${killSwitchOn(kill) ? 'ON' : 'off'}`);
  out(`plays       : ${plays?.enabled ?? 0} enabled / ${plays?.total ?? 0}`);
  out(`armed       : ${armed?.c ?? 0}`);
  out(`open        : ${open.map((r) => `${r.mode}=${r.c}`).join(' ') || 'none'}`);
  out(`today PnL   : ${today.map((r) => `${r.mode}: ${r.n} closed, ${Number(r.pnl ?? 0).toFixed(4)} ETH`).join(' | ') || 'no closed snipes yet'}`);
  out(`auto_approve: ${sizing ? JSON.stringify(sizing) : 'not set (run seed)'}`);
}

async function pnl(sql: Sql, days: number): Promise<void> {
  const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => sql.query<T>(text, params);
  const perDay = await q<{ day: string; mode: string; n: string; wins: string; pnl: number | null }>(
    `select to_char(closed_at at time zone 'utc', 'YYYY-MM-DD') as day, mode, count(*) as n,
            count(*) filter (where realized_pnl_eth > 0) as wins, sum(realized_pnl_eth) as pnl
       from snipes where status = 'closed' and closed_at >= now() - ($1 || ' days')::interval
      group by 1, 2 order by 1 desc, 2`,
    [String(days)],
  );
  console.log('day         mode   n   wins  pnl ETH');
  for (const r of perDay) console.log(`${r.day}  ${r.mode.padEnd(5)}  ${String(r.n).padStart(3)}  ${String(r.wins).padStart(4)}  ${Number(r.pnl ?? 0).toFixed(4)}`);
  const perPlay = await q<{ play_id: number; name: string; mode: string; n: string; pnl: number | null }>(
    `select s.play_id, p.name, s.mode, count(*) as n, sum(s.realized_pnl_eth) as pnl
       from snipes s join plays p on p.id = s.play_id
      where s.status = 'closed' and s.closed_at >= now() - ($1 || ' days')::interval
      group by 1, 2, 3 order by 5 desc nulls last`,
    [String(days)],
  );
  console.log('\nplay                          mode   n   pnl ETH');
  for (const r of perPlay) console.log(`${String(r.play_id).padStart(3)} ${r.name.slice(0, 24).padEnd(24)}  ${r.mode.padEnd(5)}  ${String(r.n).padStart(3)}  ${Number(r.pnl ?? 0).toFixed(4)}`);
}

/** The `decision.race` fields `hoodctl race` reads (services/sniper/src/race.ts RaceRecord). */
export interface RaceRow {
  decidedAt: Date;
  launchTx: string | null;
  race: {
    source?: string;
    status?: string;
    reason?: string;
    blockOffset?: number | null;
    txIndex?: number | null;
    buysAhead?: number | null;
    buysInBlock?: number | null;
    sendVsBoundaryMs?: number;
    revertReason?: string | null;
  };
}

const short = (h: string | null): string => (h && h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : (h ?? '-'));
const cell = (v: number | null | undefined, signed = false): string => (v === null || v === undefined ? '-' : signed && v >= 0 ? `+${v}` : String(v));
const pct = (a: number, b: number): string => (b === 0 ? '   - ' : `${((100 * a) / b).toFixed(1).padStart(5)} %`);
function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** a tx left and landed (or should have): the denominator of the race rates */
const SENT = new Set(['mined', 'reverted', 'not_mined']);
const LANDED = new Set(['mined', 'reverted']);

/** `hoodctl race` output: one row per measurement, then the summary per source (exported for tests). */
export function formatRace(rows: RaceRow[]): string[] {
  const out: string[] = [];
  out.push('decided_at (UTC)     source launch tx      status      offset txIdx ahead inBlock  sent-vs-boundary');
  for (const r of rows) {
    const x = r.race;
    const status = x.status ?? '?';
    const sent = x.sendVsBoundaryMs === undefined ? '' : `${x.sendVsBoundaryMs >= 0 ? '+' : ''}${x.sendVsBoundaryMs} ms`;
    const why = status === 'reverted' && x.revertReason ? `  ${x.revertReason}` : !SENT.has(status) && x.reason ? `  ${x.reason}` : '';
    out.push(
      `${r.decidedAt.toISOString().slice(0, 19).replace('T', ' ')}  ${(x.source ?? '?').padEnd(6)} ${short(r.launchTx).padEnd(13)} ${status.padEnd(11)} ${cell(x.blockOffset, true).padStart(6)} ${cell(x.txIndex).padStart(5)} ${cell(x.buysAhead).padStart(5)} ${cell(x.buysInBlock).padStart(7)}  ${sent.padStart(16)}${why}`,
    );
  }
  const sources = [...new Set(rows.map((r) => r.race.source ?? '?'))].sort();
  const groups: [string, RaceRow[]][] = sources.map((s) => [s, rows.filter((r) => (r.race.source ?? '?') === s)]);
  if (groups.length > 1) groups.push(['all', rows]);
  for (const [name, g] of groups) {
    const sent = g.filter((r) => SENT.has(r.race.status ?? ''));
    const landed = sent.filter((r) => LANDED.has(r.race.status ?? ''));
    const off = (r: RaceRow): number | null | undefined => r.race.blockOffset;
    const target = landed.filter((r) => off(r) === 0);
    const first = target.filter((r) => r.race.buysAhead === 0);
    const early = landed.filter((r) => typeof off(r) === 'number' && off(r)! < 0);
    const late = landed.filter((r) => typeof off(r) === 'number' && off(r)! > 0);
    const ahead = landed.map((r) => r.race.buysAhead).filter((v): v is number => typeof v === 'number');
    const med = median(ahead);
    out.push('');
    out.push(`${name}: ${g.length} run(s), ${sent.length} sent, ${landed.length} landed, ${sent.length - landed.length} not mined, ${g.length - sent.length} not sent (gate / kill switch / aborted / send failed)`);
    out.push(`  in target block (offset 0)   : ${pct(target.length, sent.length)}  (${target.length}/${sent.length})`);
    out.push(`  first in block (race won)    : ${pct(first.length, sent.length)}  (${first.length}/${sent.length})  <- the measured race win rate`);
    out.push(`  early (second T, 99 % tax)   : ${pct(early.length, sent.length)}  (${early.length}/${sent.length})`);
    out.push(`  late (after the target block): ${pct(late.length, sent.length)}  (${late.length}/${sent.length})`);
    out.push(`  median buysAhead             : ${med === null ? '-' : med}${ahead.length ? `  (over ${ahead.length} landed)` : ''}`);
  }
  if (rows.length === 0) out.push('', 'no race measurements yet (EXECUTION_MODE=probe or live records one per planned burst)');
  return out;
}

/** `hoodctl race [days]`: every snipe row with a `decision.race` record in the last `days` days. */
export async function race(sql: Sql, days: number, out: (line: string) => void = console.log): Promise<void> {
  const rows = await sql.query<{ decided_at: Date; launch_tx: string | null; race: unknown }>(
    `select decided_at, decision->'launch'->>'txHash' as launch_tx, decision->'race' as race
       from snipes where decision->'race' is not null and decided_at >= now() - ($1 || ' days')::interval
      order by decided_at, id`,
    [String(days)],
  );
  const parsed: RaceRow[] = rows.map((r) => ({
    decidedAt: new Date(r.decided_at),
    launchTx: r.launch_tx,
    race: (typeof r.race === 'string' ? JSON.parse(r.race) : (r.race ?? {})) as RaceRow['race'],
  }));
  for (const l of formatRace(parsed)) out(l);
}

export interface TradeRow {
  id: number;
  decidedAt: Date;
  mode: string;
  status: string;
  symbol: string | null;
  buyEth: number | null;
  pnlEth: number | null;
  exit: string | null;
  heldSec: number | null;
  race: { status?: string; blockOffset?: number | null; buysAhead?: number | null } | null;
  /** run notes (abort reason, exit signal reading, …); shown as a second line */
  notes?: string | null;
}

/** The note that explains a row: the abort reason for aborted runs, the exit-signal reading for closed ones. */
function whyOf(r: TradeRow): string | null {
  if (!r.notes) return null;
  const parts = r.notes.split('; ').map((x) => x.trim()).filter(Boolean);
  if (r.status === 'closed') return parts.find((x) => x.startsWith('exit ')) ?? null;
  return parts.filter((x) => !x.startsWith('exit ')).slice(-1)[0] ?? null;
}

/** `hoodctl trades [days]`: one line per trade, net return and the running total (exported for tests). */
export function formatTrades(rows: TradeRow[]): string[] {
  const out: string[] = [];
  out.push('when (UTC)           mode   symbol       buy ETH   result      pnl ETH    pnl %   held   race                  cumulative');
  let cum = 0;
  let wins = 0;
  let n = 0;
  for (const r of rows) {
    const closed = r.status === 'closed' && r.pnlEth !== null;
    if (closed) {
      cum += r.pnlEth!;
      n++;
      if (r.pnlEth! > 0) wins++;
    }
    const pct = closed && r.buyEth ? (r.pnlEth! / r.buyEth) * 100 : null;
    const race = r.race
      ? r.race.status === 'reverted' || r.race.status === 'not_mined'
        ? r.race.status
        : r.race.blockOffset === 0 && (r.race.buysAhead ?? 0) === 0
          ? 'won (first in block)'
          : r.race.blockOffset === 0
            ? `${r.race.buysAhead} ahead`
            : `late +${r.race.blockOffset} blocks`
      : '-';
    const result = closed ? (r.pnlEth! > 0 ? 'WIN' : 'loss') : r.status;
    out.push(
      `${r.decidedAt.toISOString().slice(0, 19).replace('T', ' ')}  ${r.mode.padEnd(5)}  ${(r.symbol ?? '?').slice(0, 11).padEnd(11)}  ${r.buyEth === null ? '-'.padStart(7) : r.buyEth.toFixed(4).padStart(7)}   ${result.padEnd(9)}  ${closed ? (r.pnlEth! >= 0 ? '+' : '') + r.pnlEth!.toFixed(5) : '-'.padStart(8)}  ${pct === null ? '-'.padStart(6) : ((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%').padStart(6)}  ${r.heldSec === null ? '-'.padStart(5) : (r.heldSec.toFixed(0) + 's').padStart(5)}   ${(closed ? `${r.exit ?? '?'}, ${race}` : race).padEnd(20)}  ${closed ? (cum >= 0 ? '+' : '') + cum.toFixed(5) : ''}`,
    );
    const why = whyOf(r);
    if (why) out.push(`${' '.repeat(28)}└ ${why.slice(0, 150)}`);
  }
  out.push('');
  out.push(`${n} closed trade(s), ${wins} win(s), net ${cum >= 0 ? '+' : ''}${cum.toFixed(5)} ETH`);
  return out;
}

export async function trades(sql: Sql, days: number, out: (line: string) => void = console.log): Promise<void> {
  const rows = await sql.query<{
    id: number;
    decided_at: Date;
    mode: string;
    status: string;
    symbol: string | null;
    quote_in: string | number | null;
    realized_pnl_eth: number | null;
    exit: string | null;
    held_s: number | null;
    race: unknown;
    notes: string | null;
  }>(
    `select id, decided_at, mode, status, notes,
            decision->'launch'->'event'->>'symbol' as symbol,
            quote_in, realized_pnl_eth,
            sells->0->>'reason' as exit,
            case when sells->0->>'at' is not null then (sells->0->>'at')::numeric / 1000 - extract(epoch from decided_at) end as held_s,
            decision->'race' as race
       from snipes
      where decided_at >= now() - ($1 || ' days')::interval and status in ('closed', 'failed', 'aborted', 'open', 'pending')
      order by decided_at, id`,
    [String(days)],
  );
  const parsed: TradeRow[] = rows.map((r) => ({
    id: r.id,
    decidedAt: new Date(r.decided_at),
    mode: r.mode,
    status: r.status,
    symbol: r.symbol,
    buyEth: r.quote_in === null ? null : Number(r.quote_in) / 1e18,
    pnlEth: r.realized_pnl_eth === null ? null : Number(r.realized_pnl_eth),
    exit: r.exit,
    heldSec: r.held_s === null ? null : Number(r.held_s),
    race: r.race ? ((typeof r.race === 'string' ? JSON.parse(r.race) : r.race) as TradeRow['race']) : null,
    notes: r.notes,
  }));
  for (const l of formatTrades(parsed)) out(l);
}

/** `hoodctl keygen [n]`: n fresh keys printed once, written nowhere (exported for tests). */
export function keygen(n: number, out: (line: string) => void = console.log): void {
  const count = Math.max(1, Math.min(20, Math.floor(n)));
  const keys = Array.from({ length: count }, () => generatePrivateKey());
  out(`# ${count} new executor key(s). Shown ONCE and written nowhere: copy what you need now.`);
  keys.forEach((k, i) => out(`# key ${i + 1}: address ${privateKeyToAccount(k).address}`));
  out(`EXECUTOR_PRIVATE_KEYS=${keys.join(',')}`);
  out(`# put the EXECUTOR_PRIVATE_KEYS line into the env file (Ohio: sudo nano /opt/hood/hoodsniper/.env.ohio, it stays 0600), fund the address(es) with gas, never paste the keys anywhere else.`);
}

async function main(sql: Sql, cmd: string, rest: string[]): Promise<void> {
  const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => sql.query<T>(text, params);
  switch (cmd) {
    case 'status':
      return status(sql);
    case 'kill': {
      await setSetting(sql, 'kill_switch', { on: true, by: 'hoodctl', reason: rest.join(' ') || null, at: new Date().toISOString() });
      await insertEvent(sql, { level: 'warn', type: 'kill_switch', payload: { on: true, by: 'hoodctl' } });
      console.log('kill switch ON');
      return;
    }
    case 'resume': {
      await setSetting(sql, 'kill_switch', { on: false, by: 'hoodctl', at: new Date().toISOString() });
      await insertEvent(sql, { level: 'info', type: 'kill_switch', payload: { on: false, by: 'hoodctl' } });
      console.log('kill switch off');
      return;
    }
    case 'pnl':
      return pnl(sql, n(rest[0], 7));
    case 'race':
      return race(sql, n(rest[0], 1));
    case 'trades':
      return trades(sql, n(rest[0], 1));
    case 'plays': {
      const rows = await q<{ id: number; name: string; enabled: boolean; operator: string | null; stats: unknown }>(
        `select p.id, p.name, p.enabled, o.name as operator, p.stats from plays p left join operators o on o.id = p.operator_id order by p.id`,
      );
      for (const r of rows) console.log(`${String(r.id).padStart(3)} ${r.enabled ? 'ON ' : 'off'} ${r.name.padEnd(28)} ${r.operator ?? '-'}  ${JSON.stringify(r.stats ?? {}).slice(0, 80)}`);
      return;
    }
    case 'play': {
      const [onoff, idRaw] = rest;
      const id = n(idRaw, NaN);
      if ((onoff !== 'on' && onoff !== 'off') || !Number.isFinite(id)) throw new Error('usage: ctl play on|off <id>');
      await q(`update plays set enabled = $1, updated_at = now() where id = $2`, [onoff === 'on', id]);
      await insertEvent(sql, { level: 'info', type: onoff === 'on' ? 'play_enabled' : 'play_disabled', payload: { playId: id, by: 'hoodctl' } });
      console.log(`play ${id} ${onoff}`);
      return;
    }
    case 'events': {
      const rows = await q<{ ts: Date; level: string; type: string; payload: unknown }>(`select ts, level, type, payload from events order by id desc limit $1`, [n(rest[0], 30)]);
      for (const r of rows.reverse()) console.log(`${new Date(r.ts).toISOString()} ${r.level.padEnd(5)} ${r.type.padEnd(22)} ${JSON.stringify(r.payload).slice(0, 140)}`);
      return;
    }
    default:
      throw new Error(`unknown command ${cmd}; see the header of packages/db/src/ctl.ts`);
  }
}

/** CLI entry (only when run as a script: importing this module has no side effects). */
async function cli(): Promise<void> {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  if (cmd === 'keygen') return keygen(n(rest[0], 1));
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { createDb } = await import('./index.js');
  const sql = createDb(url);
  try {
    await main(sql, cmd, rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void cli();
