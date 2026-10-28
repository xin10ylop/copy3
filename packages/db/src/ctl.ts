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
import { createDb } from './index.js';
import { getSetting, setSetting, insertEvent } from './helpers.js';

const url = process.env['DATABASE_URL'];
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const sql = createDb(url);
const [cmd = 'status', ...rest] = process.argv.slice(2);
const n = (v: string | undefined, d: number): number => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);

type Row = Record<string, unknown>;
const q = <T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> => sql.query<T>(text, params);

async function status(): Promise<void> {
  const kill = await getSetting<Record<string, unknown>>(sql, 'kill_switch');
  const [plays] = await q<{ enabled: string; total: string }>(`select count(*) filter (where enabled) as enabled, count(*) as total from plays`);
  const [armed] = await q<{ c: string }>(`select count(*) as c from armed_candidates where status = 'armed'`);
  const open = await q<{ mode: string; c: string }>(`select mode, count(*) as c from snipes where status in ('pending','open') group by mode`);
  const today = await q<{ mode: string; n: string; pnl: number | null }>(
    `select mode, count(*) as n, sum(realized_pnl_eth) as pnl from snipes where status = 'closed' and closed_at >= date_trunc('day', now() at time zone 'utc') group by mode`,
  );
  const sizing = await getSetting<Record<string, unknown>>(sql, 'auto_approve');
  console.log(`kill switch : ${kill && (kill['on'] === true || kill['killed'] === true) ? 'ON' : 'off'}`);
  console.log(`plays       : ${plays?.enabled ?? 0} enabled / ${plays?.total ?? 0}`);
  console.log(`armed       : ${armed?.c ?? 0}`);
  console.log(`open        : ${open.map((r) => `${r.mode}=${r.c}`).join(' ') || 'none'}`);
  console.log(`today PnL   : ${today.map((r) => `${r.mode}: ${r.n} closed, ${Number(r.pnl ?? 0).toFixed(4)} ETH`).join(' | ') || 'no closed snipes yet'}`);
  console.log(`auto_approve: ${sizing ? JSON.stringify(sizing) : 'not set (run seed)'}`);
}

async function pnl(days: number): Promise<void> {
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

async function main(): Promise<void> {
  switch (cmd) {
    case 'status':
      return status();
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
      return pnl(n(rest[0], 7));
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

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void sql.end());
