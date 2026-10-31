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
/**
 * The epoch: `settings.epoch = { at, note }`. `hoodctl pnl / race / trades / status` count from it
 * (rows before it stay in the database; `hoodctl trades 30 all` shows them). Set it when the code
 * changed enough that older trades no longer describe the bot: `hoodctl epoch now "race fix"`.
 */
export async function epochAt(sql: Sql): Promise<{ at: Date; note: string | null } | null> {
  const rows = await sql.query<{ value: { at?: string; note?: string } | string }>(`select value from settings where key = 'epoch'`);
  const v = rows[0]?.value;
  const o = typeof v === 'string' ? (JSON.parse(v) as { at?: string; note?: string }) : v;
  if (!o?.at) return null;
  const at = new Date(o.at);
  return Number.isNaN(at.getTime()) ? null : { at, note: o.note ?? null };
}
/** SQL: the later of the day window and the epoch (ignored with `all`). */
const sinceSql = (col: string, all: boolean): string =>
  all ? `${col} >= now() - ($1 || ' days')::interval` : `${col} >= greatest(now() - ($1 || ' days')::interval, coalesce((select (value->>'at')::timestamptz from settings where key = 'epoch'), '-infinity'::timestamptz))`;
async function epochLine(sql: Sql, all: boolean): Promise<string | null> {
  if (all) return null;
  const e = await epochAt(sql);
  return e ? `(since the epoch ${fmtWhen(e.at)}${e.note ? `, "${e.note}"` : ''}; add "all" to see every row)` : null;
}

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
  const e = await epochAt(sql);
  if (e) {
    const since = await sql.query<{ mode: string; n: number; pnl: number | null }>(
      `select mode, count(*) as n, sum(realized_pnl_eth) as pnl from snipes where status = 'closed' and closed_at >= $1 group by mode`,
      [e.at],
    );
    out(`since epoch : ${fmtWhen(e.at)}${e.note ? ` "${e.note}"` : ''} → ${since.map((r) => `${r.mode}: ${r.n} closed, ${Number(r.pnl ?? 0).toFixed(4)} ETH`).join(' | ') || 'no closed snipes yet'}`);
  }
  out(`auto_approve: ${sizing ? JSON.stringify(sizing) : 'not set (run seed)'}`);
}

async function pnl(sql: Sql, days: number, all = false): Promise<void> {
  const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => sql.query<T>(text, params);
  const perDay = await q<{ day: string; mode: string; n: string; wins: string; pnl: number | null }>(
    `select to_char(closed_at at time zone 'utc', 'YYYY-MM-DD') as day, mode, count(*) as n,
            count(*) filter (where realized_pnl_eth > 0) as wins, sum(realized_pnl_eth) as pnl
       from snipes where status = 'closed' and ${sinceSql('closed_at', all)}
      group by 1, 2 order by 1 desc, 2`,
    [String(days)],
  );
  console.log('day         mode   n   wins  pnl ETH');
  for (const r of perDay) console.log(`${r.day}  ${r.mode.padEnd(5)}  ${String(r.n).padStart(3)}  ${String(r.wins).padStart(4)}  ${Number(r.pnl ?? 0).toFixed(4)}`);
  const perPlay = await q<{ play_id: number; name: string; mode: string; n: string; pnl: number | null }>(
    `select s.play_id, p.name, s.mode, count(*) as n, sum(s.realized_pnl_eth) as pnl
       from snipes s join plays p on p.id = s.play_id
      where s.status = 'closed' and ${sinceSql('s.closed_at', all)}
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
/** Time zone for the timestamps hoodctl prints: HOOD_TZ (IANA name, e.g. Asia/Beirut), default UTC. */
export const DISPLAY_TZ = process.env.HOOD_TZ || 'UTC';
const tzFormats = new Map<string, Intl.DateTimeFormat>();
/** `YYYY-MM-DD HH:mm:ss` in `tz` (an invalid zone falls back to UTC). */
export function fmtWhen(d: Date, tz = DISPLAY_TZ): string {
  let f = tzFormats.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('sv-SE', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    tzFormats.set(tz, f);
  }
  return f.format(d).replace('T', ' ');
}
/** The zone label for a column header: `UTC` or the city part of the IANA name (`Beirut`). */
export function tzLabel(tz = DISPLAY_TZ): string {
  return tz === 'UTC' ? 'UTC' : (tz.split('/').pop() ?? tz).replace(/_/g, ' ');
}

export function formatRace(rows: RaceRow[], tz = DISPLAY_TZ): string[] {
  const out: string[] = [];
  out.push(`${`decided_at (${tzLabel(tz)})`.padEnd(21)}source launch tx      status      offset txIdx ahead inBlock  sent-vs-boundary`);
  for (const r of rows) {
    const x = r.race;
    const status = x.status ?? '?';
    const sent = x.sendVsBoundaryMs === undefined ? '' : `${x.sendVsBoundaryMs >= 0 ? '+' : ''}${x.sendVsBoundaryMs} ms`;
    const why = status === 'reverted' && x.revertReason ? `  ${x.revertReason}` : !SENT.has(status) && x.reason ? `  ${x.reason}` : '';
    out.push(
      `${fmtWhen(r.decidedAt, tz)}  ${(x.source ?? '?').padEnd(6)} ${short(r.launchTx).padEnd(13)} ${status.padEnd(11)} ${cell(x.blockOffset, true).padStart(6)} ${cell(x.txIndex).padStart(5)} ${cell(x.buysAhead).padStart(5)} ${cell(x.buysInBlock).padStart(7)}  ${sent.padStart(16)}${why}`,
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
export async function race(sql: Sql, days: number, out: (line: string) => void = console.log, all = false): Promise<void> {
  const rows = await sql.query<{ decided_at: Date; launch_tx: string | null; race: unknown }>(
    `select decided_at, decision->'launch'->>'txHash' as launch_tx, decision->'race' as race
       from snipes where decision->'race' is not null and ${sinceSql('decided_at', all)}
      order by decided_at, id`,
    [String(days)],
  );
  const parsed: RaceRow[] = rows.map((r) => ({
    decidedAt: new Date(r.decided_at),
    launchTx: r.launch_tx,
    race: (typeof r.race === 'string' ? JSON.parse(r.race) : (r.race ?? {})) as RaceRow['race'],
  }));
  for (const l of formatRace(parsed)) out(l);
  const el = await epochLine(sql, all);
  if (el) out(el);
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

/**
 * The notes that explain a row: the decision timing ("decided N ms after the launch block arrived",
 * the race's starting point), then the exit-signal reading for closed runs or the last note (the
 * abort reason) for the others.
 */
function whyOf(r: TradeRow): string[] {
  if (!r.notes) return [];
  const parts = r.notes.split('; ').map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  const decided = parts.find((x) => x.startsWith('decided '));
  if (decided) out.push(decided);
  const rest = parts.filter((x) => !x.startsWith('decided '));
  const last = r.status === 'closed' ? rest.find((x) => x.startsWith('exit ')) : rest.filter((x) => !x.startsWith('exit ')).slice(-1)[0];
  if (last) out.push(last);
  return out;
}

/** `hoodctl trades [days]`: one line per trade, net return and the running total (exported for tests). */
export function formatTrades(rows: TradeRow[], tz = DISPLAY_TZ): string[] {
  const out: string[] = [];
  out.push(`${`when (${tzLabel(tz)})`.padEnd(21)}mode   symbol       buy ETH   result      pnl ETH    pnl %   held   race                  cumulative`);
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
      `${fmtWhen(r.decidedAt, tz)}  ${r.mode.padEnd(5)}  ${(r.symbol ?? '?').slice(0, 11).padEnd(11)}  ${r.buyEth === null ? '-'.padStart(7) : r.buyEth.toFixed(4).padStart(7)}   ${result.padEnd(9)}  ${closed ? (r.pnlEth! >= 0 ? '+' : '') + r.pnlEth!.toFixed(5) : '-'.padStart(8)}  ${pct === null ? '-'.padStart(6) : ((pct >= 0 ? '+' : '') + pct.toFixed(1) + '%').padStart(6)}  ${r.heldSec === null ? '-'.padStart(5) : (r.heldSec.toFixed(0) + 's').padStart(5)}   ${(closed ? `${r.exit ?? '?'}, ${race}` : race).padEnd(20)}  ${closed ? (cum >= 0 ? '+' : '') + cum.toFixed(5) : ''}`,
    );
    for (const why of whyOf(r)) out.push(`${' '.repeat(28)}└ ${why.slice(0, 150)}`);
  }
  out.push('');
  out.push(`${n} closed trade(s), ${wins} win(s), net ${cum >= 0 ? '+' : ''}${cum.toFixed(5)} ETH`);
  return out;
}

export async function trades(sql: Sql, days: number, out: (line: string) => void = console.log, all = false): Promise<void> {
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
      where ${sinceSql('decided_at', all)} and status in ('closed', 'failed', 'aborted', 'open', 'pending')
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
  const el = await epochLine(sql, all);
  if (el) out(el);
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
      return pnl(sql, n(rest[0], 7), rest.includes('all'));
    case 'race':
      return race(sql, n(rest[0], 1), undefined, rest.includes('all'));
    case 'trades':
      return trades(sql, n(rest[0], 1), undefined, rest.includes('all'));
    case 'epoch': {
      // hoodctl epoch now ["note"] | <ISO timestamp> ["note"] | off
      const [when, ...noteParts] = rest;
      if (!when) {
        const e = await epochAt(sql);
        console.log(e ? `epoch ${fmtWhen(e.at)}${e.note ? ` "${e.note}"` : ''}` : 'no epoch (every command counts from its day window)');
        return;
      }
      if (when === 'off') {
        await q(`delete from settings where key = 'epoch'`);
        console.log('epoch off');
        return;
      }
      const at = when === 'now' ? new Date() : new Date(when);
      if (Number.isNaN(at.getTime())) throw new Error('usage: ctl epoch now|<ISO timestamp>|off ["note"]');
      await setSetting(sql, 'epoch', { at: at.toISOString(), note: noteParts.join(' ') || null, by: 'hoodctl' });
      console.log(`epoch ${fmtWhen(at)}: pnl / race / trades / status count from here (add "all" to a command to see every row)`);
      return;
    }
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
      for (const r of rows.reverse()) console.log(`${fmtWhen(new Date(r.ts))} ${r.level.padEnd(5)} ${r.type.padEnd(22)} ${JSON.stringify(r.payload).slice(0, 140)}`);
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
