/**
 * Synthetic operator scenario modelled on the Amlil example (docs/EXAMPLES.md):
 *   EXCHANGE -> FUNDER (sprayer) -CREATE-> DISPERSE contract -internal-> DEV1 (fresh) + gas to TEAM1/TEAM2
 *   DEV1 launches TOKEN1 "Amlil" (plain launchToken, exemptions DEV1+TEAM1+TEAM2, creator tax 2 %)
 *   TEAM1/TEAM2 buy at +0 s tax-free, FIRST_TAXED buys at +1 s paying 6.18 %, the curve runs,
 *   TEAM1/TEAM2 transfer their tokens to DUMP at +6 s, DUMP sells, DUMP sends ETH to TREASURY.
 *   FUNDER directly funds DEV2 which launches TOKEN2 "Amlil 2" a day later (same play).
 *   SPAM (unrelated funder) launches two "Amlil" decoys that never run.
 */
import type { PGlite } from '@electric-sql/pglite';

export const addr = (tag: string): string => `0x${tag.padStart(40, '0')}`;

export const T = 1_792_758_495; // 2026-10-23 12:28:15 UTC
export const A = {
  EXCHANGE: addr('e0'),
  FUNDER: addr('f1'),
  DISPERSE: addr('d15e'),
  DEV1: addr('de01'),
  DEV2: addr('de02'),
  TEAM1: addr('7e01'),
  TEAM2: addr('7e02'),
  FIRST_TAXED: addr('c54d'),
  BUYER2: addr('b002'),
  DUMP: addr('a98d'),
  TREASURY: addr('7ea5'),
  SPAM: addr('5a11'),
  SPAM_FUNDER: addr('5af0'),
  TOKEN1: addr('a7a7'),
  CURVE1: addr('c1'),
  TOKEN2: addr('a7a8'),
  CURVE2: addr('c2'),
  DECOY1: addr('dec1'),
  DECOY2: addr('dec2'),
} as const;

const wei = (eth: number): string => BigInt(Math.round(eth * 1e6)) * 10n ** 12n + '';
const ts = (sec: number): string => `to_timestamp(${sec})`;
const q = (s: string | null): string => (s === null ? 'null' : `'${s}'`);
const arr = (xs: string[]): string => `array[${xs.map(q).join(',')}]::text[]`;

let txn = 0;
const tx = (): string => `0x${(++txn).toString(16).padStart(64, '0')}`;

function ethTransfer(block: number, sec: number, from: string, to: string, eth: number, kind: 'tx' | 'internal' | 'create', trace = ''): string {
  return `insert into eth_transfers (block, ts, tx_hash, trace_addr, from_addr, to_addr, value, kind)
          values (${block}, ${ts(sec)}, '${tx()}', '${trace}', '${from}', '${to}', ${wei(eth)}, '${kind}');`;
}

function wallet(address: string, firstFunder: string | null, valueEth: number | null, fresh: boolean, isContract = false, sec = T - 3600): string {
  return `insert into wallets (address, first_seen_block, first_seen_ts, first_funder, first_funding_value, first_funding_tx, is_contract, tx_count_at_first_funding)
          values ('${address}', 1, ${ts(sec)}, ${q(firstFunder)}, ${valueEth === null ? 'null' : wei(valueEth)}, null, ${isContract}, ${fresh ? 0 : 25});`;
}

function launch(o: {
  token: string;
  curve: string;
  deployer: string;
  name: string;
  symbol: string;
  sec: number;
  exemptions: string[];
  creatorTaxBps?: number;
  kind?: 'launchToken' | 'launchAndBuy' | 'launchTokenFor';
  devBuyEth?: number;
}): string {
  return `insert into launches (token, curve, deployer, launcher, launch_kind, creator_fee_recipient, creator_tax_bps, name, symbol, pair_token,
            exemptions, dev_buy_quote, block, ts, tx_hash, tx_from, start_price, start_mcap_eth)
          values ('${o.token}', '${o.curve}', '${o.deployer}', '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', '${o.kind ?? 'launchToken'}', '${o.deployer}',
            ${o.creatorTaxBps ?? 200}, '${o.name}', '${o.symbol}', '0x0000000000000000000000000000000000000000',
            ${arr(o.exemptions)}, ${o.devBuyEth ? wei(o.devBuyEth) : '0'}, 100, ${ts(o.sec)}, '${tx()}', '${o.deployer}', 1.68e-9, 1.68);`;
}

let logIdx = 0;
function trade(
  token: string,
  curve: string,
  launchSec: number,
  dt: number,
  side: 'buy' | 'sell',
  who: string,
  quoteEth: number,
  tokens: number,
  priceAfter: number,
  o: { snipeTaxEth?: number; exempt?: boolean } = {},
): string {
  return `insert into curve_trades (token, curve, block, ts, tx_hash, log_index, side, trader, recipient, tx_from, quote, tokens, fee, tax, snipe_tax,
            price_after, seconds_since_launch, exempt)
          values ('${token}', '${curve}', ${1000 + dt * 10 + (logIdx % 10)}, ${ts(launchSec + dt)}, '${tx()}', ${logIdx++}, '${side}', '${who}', '${who}', '${who}',
            ${wei(quoteEth)}, ${wei(tokens)}, ${wei(quoteEth * 0.01 + (o.snipeTaxEth ?? 0))}, ${wei(quoteEth * 0.02)}, ${wei(o.snipeTaxEth ?? 0)},
            ${priceAfter}, ${dt}, ${o.exempt ?? false});`;
}

function tokenTransfer(token: string, sec: number, block: number, from: string, to: string, tokens: number): string {
  return `insert into token_transfers (token, block, ts, tx_hash, log_index, from_addr, to_addr, value)
          values ('${token}', ${block}, ${ts(sec)}, '${tx()}', 0, '${from}', '${to}', ${wei(tokens)});`;
}

function metrics(token: string, firstTaxedSec: number, peaks: [number, number, number, number, number], low: number, taxFree: number): string {
  const [p2, p5, p10, p30, p60] = peaks;
  const entry = 2.79e-9;
  const m = (p: number): number => entry * (1 + p / 100) * 1e9;
  return `insert into token_metrics (token, first_taxed_buyer, first_taxed_ts, first_taxed_block, first_taxed_price, first_taxed_mcap_eth,
            tax_free_buy_count, tax_free_quote, ath_price, ath_ts, ath_mcap_eth, peak2_pct, peak5_pct, peak10_pct, peak30_pct, peak60_pct,
            mcap2, mcap5, mcap10, mcap30, mcap60, low_after_entry_pct, n_buys_60s, n_sells_60s, exempt_sold_within_sec, updated_at)
          values ('${token}', '${A.FIRST_TAXED}', ${ts(firstTaxedSec)}, 1010, ${entry}, ${entry * 1e9}, ${taxFree}, ${wei(0.38)},
            ${entry * (1 + Math.max(...peaks) / 100)}, ${ts(firstTaxedSec + 12)}, ${m(Math.max(...peaks))},
            ${p2}, ${p5}, ${p10}, ${p30}, ${p60}, ${m(p2)}, ${m(p5)}, ${m(p10)}, ${m(p30)}, ${m(p60)}, ${low}, 120, 70, null, now());`;
}

/** Price path shared by both real coins (the video shape). */
const PATH: Array<[dt: number, price: number]> = [
  [1, 3.1e-9],
  [2, 6e-9],
  [3, 8e-9],
  [5, 10.5e-9],
  [10, 9e-9],
  [20, 6e-9],
  [30, 4.5e-9],
  [60, 3e-9],
];

function coin(token: string, curve: string, deployer: string, name: string, sec: number): string[] {
  const s: string[] = [
    launch({ token, curve, deployer, name, symbol: name.toUpperCase().replace(/\s+/g, ''), sec, exemptions: [deployer, A.TEAM1, A.TEAM2] }),
    trade(token, curve, sec, 0, 'buy', A.TEAM1, 0.1924, 100e6, 2.2e-9, { exempt: true }),
    trade(token, curve, sec, 0, 'buy', A.TEAM2, 0.1877, 80e6, 2.5e-9, { exempt: true }),
    trade(token, curve, sec, 1, 'buy', A.FIRST_TAXED, 0.035, 12.53e6, 3.1e-9, { snipeTaxEth: 0.035 * 0.0618 }),
  ];
  for (const [dt, price] of PATH.slice(1)) s.push(trade(token, curve, sec, dt, 'buy', A.BUYER2, 0.05, 1e7, price));
  s.push(trade(token, curve, sec, 6, 'sell', A.DUMP, 0.5, 90e6, 9.6e-9));
  s.push(trade(token, curve, sec, 7, 'sell', A.DUMP, 0.45, 90e6, 9.2e-9));
  s.push(trade(token, curve, sec, 8, 'sell', A.FIRST_TAXED, 0.09, 12.53e6, 9.1e-9));
  for (let i = 0; i < 4; i++) {
    s.push(tokenTransfer(token, sec + 6, 1055 + i, i % 2 ? A.TEAM2 : A.TEAM1, A.DUMP, 45e6));
  }
  return s;
}

export async function seedOperator(pg: PGlite): Promise<void> {
  const day = 86_400;
  const stmts: string[] = [
    // funding graph
    ethTransfer(10, T - 7200, A.EXCHANGE, A.FUNDER, 5, 'tx'),
    ethTransfer(11, T - 3700, A.FUNDER, A.DISPERSE, 0.05, 'create'),
    ethTransfer(11, T - 3700, A.DISPERSE, A.DEV1, 0.012, 'internal', '0'),
    ethTransfer(12, T - 1, A.DISPERSE, A.TEAM1, 0.0004, 'internal', '0'),
    ethTransfer(12, T - 1, A.DISPERSE, A.TEAM2, 0.0004, 'internal', '1'),
    ethTransfer(13, T + day - 3600, A.FUNDER, A.DEV2, 0.011, 'tx'),
    ethTransfer(20, T + 60, A.DUMP, A.TREASURY, 0.9, 'tx'),
    ethTransfer(21, T + day + 60, A.DUMP, A.TREASURY, 0.8, 'tx'),
    ethTransfer(5, T - 9 * day, A.SPAM_FUNDER, A.SPAM, 1, 'tx'),
    wallet(A.FUNDER, A.EXCHANGE, 5, false),
    wallet(A.DISPERSE, A.FUNDER, 0.05, true, true),
    wallet(A.DEV1, A.DISPERSE, 0.012, true),
    wallet(A.DEV2, A.FUNDER, 0.011, true),
    wallet(A.TEAM1, A.DISPERSE, 0.0004, true),
    wallet(A.TEAM2, A.DISPERSE, 0.0004, true),
    wallet(A.DUMP, null, null, true),
    wallet(A.SPAM, A.SPAM_FUNDER, 1, false),
    // coins
    ...coin(A.TOKEN1, A.CURVE1, A.DEV1, 'Amlil', T),
    ...coin(A.TOKEN2, A.CURVE2, A.DEV2, 'Amlil 2', T + day),
    metrics(A.TOKEN1, T + 1, [44, 222, 222, 377, 250], -8, 2),
    metrics(A.TOKEN2, T + day + 1, [60, 180, 240, 300, 200], -12, 2),
    // decoys from a spam wallet
    launch({ token: A.DECOY1, curve: addr('cd1'), deployer: A.SPAM, name: 'Amlil', symbol: 'AMLIL', sec: T - 2 * day, exemptions: [A.SPAM] }),
    launch({ token: A.DECOY2, curve: addr('cd2'), deployer: A.SPAM, name: 'AMLIL', symbol: 'AMLIL', sec: T - day, exemptions: [A.SPAM] }),
    metrics(A.DECOY1, T - 2 * day + 1, [2, 3, 3, 1, -20], -40, 0),
    `insert into settings (key, value) values ('eth_usd', '4000'::jsonb);`,
  ];
  await pg.exec(stmts.join('\n'));
}
