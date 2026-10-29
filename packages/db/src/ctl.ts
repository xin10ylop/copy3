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
 *
 * Reads DATABASE_URL. Every write goes through the same settings/plays rows the services LISTEN on.
 */
import { fileURLToPath } from 'node:url';
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
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(2);
  }
  const { createDb } = await import('./index.js');
  const sql = createDb(url);
  const [cmd = 'status', ...rest] = process.argv.slice(2);
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
