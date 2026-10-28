/**
 * Report + CSV output (the video's "play finder" deliverables).
 *
 * CSV columns are exactly docs/SPEC.md §3 (agent). Numbers come from the DB (launches,
 * token_metrics, funding path), never from the model; the model contributes `notes`
 * and may override the funding route it traced. ETH -> USD uses settings.eth_usd with a
 * fixed fallback (and a warning) when it is missing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DerivedPreset, PeakStats } from './backtest.js';
import type { CsvSource, FundingHop } from './queries.js';

export const CSV_COLUMNS = [
  'ca',
  'dev_wallet',
  'name',
  'symbol',
  'start_mcap_usd',
  'ath_mcap_usd',
  'launch_time_utc',
  'launch_time_et',
  'tax_free',
  'tax_free_buyers',
  'first_taxed_buyer',
  'first_taxed_mcap_usd',
  'p2_pct',
  'p2_mcap',
  'p5_pct',
  'p5_mcap',
  'p10_pct',
  'p10_mcap',
  'p30_pct',
  'p30_mcap',
  'p60_pct',
  'p60_mcap',
  'funded_by',
  'funded_eth',
  'launch_kind',
  'dev_buy_eth',
  'notes',
] as const;

export type CsvColumn = (typeof CSV_COLUMNS)[number];
export type CsvRow = Record<CsvColumn, string>;

/** Used when settings.eth_usd is missing; callers must surface the warning. */
export const FALLBACK_ETH_USD = 3500;

export interface EthUsd {
  usd: number;
  source: 'settings' | 'fallback';
  warning?: string;
}

export function resolveEthUsd(setting: number | null): EthUsd {
  if (setting !== null && Number.isFinite(setting) && setting > 0) return { usd: setting, source: 'settings' };
  return {
    usd: FALLBACK_ETH_USD,
    source: 'fallback',
    warning: `settings.eth_usd is not set; USD columns use a fixed ${FALLBACK_ETH_USD} USD/ETH. Set it with: insert into settings(key, value) values ('eth_usd', '<usd>') on conflict (key) do update set value = excluded.value`,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-10-23 12:28:15` (UTC). */
export function formatUtc(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
});

/** `2026-10-23 08:28:15 EDT` (America/New_York, DST-aware). */
export function formatEt(unixSec: number): string {
  const parts = Object.fromEntries(etFormatter.formatToParts(new Date(unixSec * 1000)).map((p) => [p.type, p.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']} ${parts['hour']}:${parts['minute']}:${parts['second']} ${parts['timeZoneName']}`;
}

const usd = (eth: number | null | undefined, ethUsd: number): string => (eth === null || eth === undefined ? '' : String(Math.round(eth * ethUsd)));
const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '' : v.toFixed(1));
const eth = (v: number | null | undefined): string => (v === null || v === undefined ? '' : String(Number(v.toFixed(6))));

/** Neutralises spreadsheet formulas in attacker-controlled text (token names, notes). */
export function safeText(s: string | null | undefined): string {
  const v = (s ?? '').replace(/[\r\n]+/g, ' ').trim();
  return /^[=+\-@\t]/.test(v) ? `'${v}` : v;
}

function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** `exchange > funder > disperse [contract, internal]` - source first, the dev's direct funder last. */
export function fundingRoute(hops: readonly FundingHop[]): string {
  const funders = hops.filter((h) => h.funder !== null);
  if (funders.length === 0) return '';
  const info = new Map(hops.map((h) => [h.address, h]));
  return [...funders]
    .reverse()
    .map((h) => {
      const tags: string[] = [];
      if (info.get(h.funder!)?.isContract) tags.push('contract');
      if (h.kind && h.kind !== 'tx') tags.push(h.kind);
      return tags.length ? `${h.funder} [${tags.join(', ')}]` : h.funder!;
    })
    .join(' > ');
}

export interface CsvOverrides {
  notes?: string | undefined;
  fundedBy?: string | undefined;
  fundedEth?: number | undefined;
}

export function buildCsvRow(src: CsvSource, ethUsd: number, o: CsvOverrides = {}): CsvRow {
  const t = src.token;
  const m = t.metrics;
  const taxFreeCount = m?.taxFreeBuyCount ?? src.taxFreeBuyers.length;
  const notes = [o.notes ?? '', src.dumpWallets.length ? `dump wallet(s): ${src.dumpWallets.join(' ')}` : '']
    .filter((s) => s.length > 0)
    .join(' | ');
  return {
    ca: t.token,
    dev_wallet: t.deployer,
    name: safeText(t.name),
    symbol: safeText(t.symbol),
    start_mcap_usd: usd(t.startMcapEth, ethUsd),
    ath_mcap_usd: usd(m?.athMcapEth, ethUsd),
    launch_time_utc: formatUtc(t.ts),
    launch_time_et: formatEt(t.ts),
    tax_free: taxFreeCount > 0 ? `YES ${taxFreeCount}` : 'NO',
    tax_free_buyers: src.taxFreeBuyers.join(';'),
    first_taxed_buyer: m?.firstTaxedBuyer ?? '',
    first_taxed_mcap_usd: usd(m?.firstTaxedMcapEth, ethUsd),
    p2_pct: pct(m?.peak2Pct),
    p2_mcap: usd(m?.mcap2, ethUsd),
    p5_pct: pct(m?.peak5Pct),
    p5_mcap: usd(m?.mcap5, ethUsd),
    p10_pct: pct(m?.peak10Pct),
    p10_mcap: usd(m?.mcap10, ethUsd),
    p30_pct: pct(m?.peak30Pct),
    p30_mcap: usd(m?.mcap30, ethUsd),
    p60_pct: pct(m?.peak60Pct),
    p60_mcap: usd(m?.mcap60, ethUsd),
    funded_by: safeText(o.fundedBy ?? fundingRoute(src.funding)),
    funded_eth: eth(o.fundedEth ?? src.funding[0]?.valueEth ?? null),
    launch_kind: safeText(t.launchKind),
    dev_buy_eth: eth(t.devBuyEth ?? 0),
    notes: safeText(notes),
  };
}

export function toCsv(rows: readonly CsvRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(','));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export function timestampSlug(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

export function fileSlug(s: string): string {
  const v = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return v || 'report';
}

/** Writes `<dir>/<yyyymmdd-hhmmss>-<slug>.<ext>` and returns the absolute path. */
export async function writeOutput(dir: string, slug: string, ext: 'csv' | 'md', content: string, now = new Date()): Promise<string> {
  const abs = path.resolve(dir);
  await mkdir(abs, { recursive: true });
  const file = path.join(abs, `${timestampSlug(now)}-${fileSlug(slug)}.${ext}`);
  await writeFile(file, content, 'utf8');
  return file;
}

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------

export type PlayPattern = 'dev_buys' | 'team_buys' | 'decoys' | 'mixed' | 'unknown';

export const PATTERN_LABEL: Record<PlayPattern, string> = {
  dev_buys: 'Dev buys at launch (launchAndBuy, deployer exempt)',
  team_buys: 'Dev never buys; exempt "team" wallets buy in the launch second and exit via token transfers to a dump wallet',
  decoys: 'Decoys then the real one (same name from a spam wallet, the runner from a freshly funded wallet)',
  mixed: 'Mixed patterns',
  unknown: 'Pattern not established',
};

export interface ReportSections {
  operatorSummary: string;
  howFunded: string;
  howToCatch: string;
  recommendedPreset: string;
  caveats: string;
}

export interface ReportInput {
  title: string;
  pattern: PlayPattern;
  sections: ReportSections;
  coins: readonly CsvRow[];
  ethUsd: EthUsd;
  generatedAt: Date;
  runId?: number | undefined;
  stats?: PeakStats | undefined;
  derived?: DerivedPreset | null | undefined;
  extraMd?: string | undefined;
}

const fmt = (v: number | null): string => (v === null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(0)} %`);

function coinsTable(rows: readonly CsvRow[]): string {
  if (rows.length === 0) return '_No coins attached._';
  const head = '| name | ca | launch (ET) | tax-free | first taxed mcap $ | +2 s | +5 s | +10 s | +30 s | +60 s |\n|---|---|---|---|---|---|---|---|---|---|';
  const body = rows.map((r) => {
    const md = (s: string): string => s.replace(/\|/g, '\\|');
    const p = (v: string): string => (v ? `${v} %` : '-');
    return `| ${md(r.name)} | \`${r.ca}\` | ${r.launch_time_et} | ${r.tax_free} | ${r.first_taxed_mcap_usd || '-'} | ${p(r.p2_pct)} | ${p(r.p5_pct)} | ${p(r.p10_pct)} | ${p(r.p30_pct)} | ${p(r.p60_pct)} |`;
  });
  return [head, ...body].join('\n');
}

function statsTable(stats: PeakStats): string {
  const head = '| window | coins | p25 | median | p75 | share >= +100 % |\n|---|---|---|---|---|---|';
  const body = stats.windows.map(
    (w) => `| ${w.window} s | ${w.count} | ${fmt(w.p25)} | ${fmt(w.median)} | ${fmt(w.p75)} | ${(w.shareGe100 * 100).toFixed(0)} % |`,
  );
  const low = `\nLow after entry (60 s): median ${fmt(stats.low.median)}, p25 ${fmt(stats.low.p25)}, p75 ${fmt(stats.low.p75)} (${stats.low.count} coins).`;
  return [head, ...body].join('\n') + low;
}

export function dateRange(rows: readonly CsvRow[]): string {
  const ts = rows.map((r) => r.launch_time_utc).filter(Boolean).sort();
  if (ts.length === 0) return 'no dated coins';
  return ts[0] === ts[ts.length - 1] ? `${ts[0]} UTC` : `${ts[0]} -> ${ts[ts.length - 1]} UTC`;
}

export function renderReport(r: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# ${r.title.replace(/[\r\n]+/g, ' ')}`);
  lines.push('');
  lines.push(
    `_Generated ${formatUtc(Math.floor(r.generatedAt.getTime() / 1000))} UTC${r.runId !== undefined ? ` · agent run #${r.runId}` : ''} · ` +
      `ETH/USD ${r.ethUsd.usd} (${r.ethUsd.source}) · ${r.coins.length} coins · ${dateRange(r.coins)}_`,
  );
  if (r.ethUsd.warning) lines.push('', `> Warning: ${r.ethUsd.warning}`);
  lines.push('', '## Operator summary', '', `**Pattern:** ${PATTERN_LABEL[r.pattern]}`, '', r.sections.operatorSummary.trim());
  lines.push('', '## How they are funded', '', r.sections.howFunded.trim());
  lines.push('', '## How to catch it', '', r.sections.howToCatch.trim());
  lines.push('', '## Recommended preset', '', r.sections.recommendedPreset.trim());
  if (r.derived) {
    lines.push('', 'Derived from the peak distribution:', '', ...r.derived.justification.map((j) => `- ${j}`));
  }
  if (r.stats) lines.push('', '### Peak distribution (from the first taxed buyer\'s entry)', '', statsTable(r.stats));
  lines.push('', '## Coins', '', coinsTable(r.coins));
  if (r.extraMd && r.extraMd.trim()) lines.push('', r.extraMd.trim());
  lines.push('', '## Caveats', '', r.sections.caveats.trim());
  lines.push(
    '',
    '_Links are asserted only where backed by an eth_transfers path, a token transfer or the launch exemption list. ' +
      'Peaks are measured from the first taxed buyer; a real snipe pays 6.18 % snipe tax + 1 % fee + creator tax + its own impact._',
  );
  return lines.join('\n') + '\n';
}
