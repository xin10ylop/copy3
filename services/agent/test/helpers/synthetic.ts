/**
 * Synthetic launches for the autopilot tests: a launch row, an optional team buy in the launch
 * second (recipient = an exempt non-deployer wallet) and a price path of retail trades, so that
 * `launchesMatchingTrigger` + `loadBacktestItems` + the simulator see realistic shapes:
 *   WIN  — runs to ~2.8× the entry and pulls back (trailing 50/20 exits around +80 %)
 *   LOSE — dumps 50 % within 2 s (stop loss)
 *   FLAT — drifts (a timeout exit at a small loss after tax and fees)
 */
import type { PGlite } from '@electric-sql/pglite';

export const addr = (tag: string): string => `0x${tag.padStart(40, '0')}`;
const wei = (eth: number): string => (BigInt(Math.round(eth * 1e9)) * 10n ** 9n).toString();
const ts = (sec: number): string => `to_timestamp(${sec})`;

export type Shape = 'win' | 'lose' | 'flat';
export const PATHS: Record<Shape, Array<[dt: number, price: number]>> = {
  win: [[1, 2.8e-9], [2, 4e-9], [3, 6e-9], [5, 7.5e-9], [8, 5.5e-9], [20, 3e-9], [70, 2e-9]],
  lose: [[1, 2.2e-9], [2, 1.2e-9], [5, 1.1e-9], [30, 1e-9], [70, 0.9e-9]],
  flat: [[1, 2.55e-9], [10, 2.6e-9], [30, 2.5e-9], [70, 2.5e-9]],
};

export interface SynthLaunch {
  token: string;
  deployer: string;
  /** exempt non-deployer wallets; the first one buys `teamBuyEth` in the launch second */
  team: string[];
  sec: number;
  teamBuyEth: number;
  shape: Shape;
  /** deployer buy in the launch second (outside the launch tx) */
  devBuyEth?: number;
}

let n = 0;
const tx = (): string => `0x${(++n).toString(16).padStart(64, 'a')}`;

export async function insertLaunches(pg: PGlite, launches: readonly SynthLaunch[]): Promise<void> {
  const stmts: string[] = [];
  for (const l of launches) {
    const curve = `0x${l.token.slice(2, 40)}c`;
    const exemptions = `array[${[l.deployer, ...l.team].map((a) => `'${a}'`).join(',')}]::text[]`;
    const launchTx = tx();
    stmts.push(`insert into launches (token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps, name, symbol, pair_token,
        exemptions, dev_buy_quote, block, ts, tx_hash, tx_from, start_price, start_mcap_eth)
      values ('${l.token}', '${curve}', '${l.deployer}', '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', 'launchToken', '${l.deployer}', 0,
        'S${n}', 'S', '0x0000000000000000000000000000000000000000', ${exemptions}, 0, ${n}, ${ts(l.sec)}, '${launchTx}', '${l.deployer}', 1.68e-9, 1.68);`);
    let li = 0;
    const trade = (dt: number, recipient: string, quoteEth: number, price: number, exempt: boolean): string =>
      `insert into curve_trades (token, curve, block, ts, tx_hash, log_index, side, trader, recipient, tx_from, quote, tokens, fee, tax, snipe_tax,
          price_after, seconds_since_launch, exempt)
        values ('${l.token}', '${curve}', ${1000 + dt * 10 + li}, ${ts(l.sec + dt)}, '${tx()}', ${li++}, 'buy', '${recipient}', '${recipient}', '${recipient}',
          ${wei(quoteEth)}, ${wei(quoteEth / price)}, ${wei(quoteEth * 0.01)}, 0, 0, ${price}, ${dt}, ${exempt});`;
    if (l.teamBuyEth > 0) stmts.push(trade(0, l.team[0]!, l.teamBuyEth, 2.5e-9, true));
    if (l.devBuyEth) stmts.push(trade(0, l.deployer, l.devBuyEth, 2.6e-9, true));
    for (const [dt, price] of PATHS[l.shape]) stmts.push(trade(dt, addr('b0b'), 0.05, price, false));
  }
  await pg.exec(stmts.join('\n'));
}

export interface SnipeRowInput {
  playId: number;
  pnlEth: number;
  closedSec: number;
  mode?: 'paper' | 'live';
}

export async function insertClosedSnipes(pg: PGlite, rows: readonly SnipeRowInput[]): Promise<void> {
  await pg.exec(
    rows
      .map(
        (r, i) => `insert into snipes (play_id, token, curve, decision, mode, status, realized_pnl_eth, closed_at)
          values (${r.playId}, '${addr(`5${i}`)}', '${addr(`c5${i}`)}', '{}'::jsonb, '${r.mode ?? 'paper'}', 'closed', ${r.pnlEth}, ${ts(r.closedSec)});`,
      )
      .join('\n'),
  );
}
