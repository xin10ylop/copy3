import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { peakStats } from '../src/backtest.js';
import type { CsvSource, FundingHop, TokenRow } from '../src/queries.js';
import {
  CSV_COLUMNS,
  FALLBACK_ETH_USD,
  buildCsvRow,
  formatEt,
  formatUtc,
  fundingRoute,
  renderReport,
  resolveEthUsd,
  safeText,
  toCsv,
  writeOutput,
} from '../src/report.js';

const SPEC_COLUMNS =
  'ca, dev_wallet, name, symbol, start_mcap_usd, ath_mcap_usd, launch_time_utc, launch_time_et, tax_free, tax_free_buyers, first_taxed_buyer, first_taxed_mcap_usd, p2_pct, p2_mcap, p5_pct, p5_mcap, p10_pct, p10_mcap, p30_pct, p30_mcap, p60_pct, p60_mcap, funded_by, funded_eth, launch_kind, dev_buy_eth, notes'
    .split(',')
    .map((s) => s.trim());

const hop = (h: Partial<FundingHop> & Pick<FundingHop, 'depth' | 'address'>): FundingHop => ({
  funder: null,
  valueEth: null,
  txHash: null,
  ts: null,
  kind: null,
  isContract: null,
  createdBy: null,
  fresh: null,
  ...h,
});

function token(over: Partial<TokenRow> = {}): TokenRow {
  return {
    token: '0xa7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586',
    curve: '0xe2df162de883b0fb133f0f67466423d8d6533be2',
    deployer: '0xc92cc38d4403536ade5f2413cb785455d6b37cac',
    launcher: null,
    launchKind: 'launchToken',
    creatorFeeRecipient: null,
    creatorTaxBps: 200,
    name: 'Amlil',
    symbol: 'AMLIL',
    pairToken: null,
    exemptions: [],
    devBuyEth: null,
    block: 95_940_695,
    ts: 1_792_758_495, // 2026-10-23 12:28:15 UTC = 08:28:15 EDT
    txHash: '0x01',
    txFrom: null,
    startPrice: 1.68e-9,
    startMcapEth: 1.68,
    graduated: false,
    metrics: {
      firstTaxedBuyer: '0xc54d3914f91f984d61b63d491f38934c4e706b79',
      firstTaxedTs: 1_792_758_496,
      firstTaxedBlock: 95_940_704,
      firstTaxedPrice: 2.79e-9,
      firstTaxedMcapEth: 2.79,
      taxFreeBuyCount: 2,
      taxFreeQuoteEth: 0.38,
      athPrice: 1.3e-8,
      athTs: 1_792_758_508,
      athMcapEth: 13.3,
      peak2Pct: 44,
      peak5Pct: 222,
      peak10Pct: 222,
      peak30Pct: 377,
      peak60Pct: 300.25,
      mcap2: 4.02,
      mcap5: 8.98,
      mcap10: 8.98,
      mcap30: 13.31,
      mcap60: 11.17,
      lowAfterEntryPct: -8,
      nBuys60s: 125,
      nSells60s: 79,
      exemptSoldWithinSec: null,
    },
    ...over,
  };
}

const source = (over: Partial<CsvSource> = {}): CsvSource => ({
  token: token(),
  taxFreeBuyers: ['0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a', '0x9e3f51b4c11e415c0ccee32b9d7a7cc23932b7bf'],
  funding: [
    hop({ depth: 0, address: '0xc92cc38d4403536ade5f2413cb785455d6b37cac', funder: '0x00000000000000000000000000000000000000d1', valueEth: 0.0123, kind: 'internal' }),
    hop({ depth: 1, address: '0x00000000000000000000000000000000000000d1', funder: '0x00000000000000000000000000000000000000f1', kind: 'create', isContract: true }),
    hop({ depth: 2, address: '0x00000000000000000000000000000000000000f1', funder: null }),
  ],
  dumpWallets: ['0xa98da960d6000000000000000000000000000000'],
  ...over,
});

describe('CSV', () => {
  it('has exactly the SPEC columns in order', () => {
    expect([...CSV_COLUMNS]).toEqual(SPEC_COLUMNS);
    const csv = toCsv([buildCsvRow(source(), 4000)]);
    expect(csv.split('\n')[0]).toBe(SPEC_COLUMNS.join(','));
  });

  it('fills USD, both time zones, the tax-free badge, peaks and the funding route', () => {
    const row = buildCsvRow(source(), 4000, { notes: 'team pattern' });
    expect(row.launch_time_utc).toBe('2026-10-23 12:28:15');
    expect(row.launch_time_et).toBe('2026-10-23 08:28:15 EDT');
    expect(row.start_mcap_usd).toBe('6720');
    expect(row.ath_mcap_usd).toBe('53200');
    expect(row.first_taxed_mcap_usd).toBe('11160');
    expect(row.tax_free).toBe('YES 2');
    expect(row.tax_free_buyers.split(';')).toHaveLength(2);
    expect(row.p2_pct).toBe('44.0');
    expect(row.p60_pct).toBe('300.3');
    expect(row.p30_mcap).toBe('53240');
    expect(row.funded_by).toBe('0x00000000000000000000000000000000000000f1 [create] > 0x00000000000000000000000000000000000000d1 [contract, internal]');
    expect(row.funded_eth).toBe('0.0123');
    expect(row.dev_buy_eth).toBe('0');
    expect(row.notes).toBe('team pattern | dump wallet(s): 0xa98da960d6000000000000000000000000000000');
  });

  it('uses EST in winter and NO when nothing was bought tax-free', () => {
    const winter = 1_798_000_000; // 2026-12-23
    expect(formatUtc(winter)).toBe('2026-12-23 04:26:40');
    expect(formatEt(winter)).toBe('2026-12-22 23:26:40 EST');
    const row = buildCsvRow(source({ token: token({ metrics: null }), taxFreeBuyers: [] }), 4000);
    expect(row.tax_free).toBe('NO');
    expect(row.p5_pct).toBe('');
  });

  it('quotes commas and neutralises formula injection from token names', () => {
    const row = buildCsvRow(source({ token: token({ name: '=HYPERLINK("x"),evil', symbol: '+SYM' }) }), 4000, { notes: 'a "quoted" note' });
    const csv = toCsv([row]);
    expect(row.name.startsWith("'=")).toBe(true);
    expect(row.symbol).toBe("'+SYM");
    expect(csv).toContain(`"'=HYPERLINK(""x""),evil"`);
    expect(csv).toContain('"a ""quoted"" note | dump wallet(s)');
    expect(safeText('line\nbreak')).toBe('line break');
  });

  it('falls back to a fixed ETH/USD with a warning', () => {
    expect(resolveEthUsd(3200)).toEqual({ usd: 3200, source: 'settings' });
    const fb = resolveEthUsd(null);
    expect(fb.usd).toBe(FALLBACK_ETH_USD);
    expect(fb.source).toBe('fallback');
    expect(fb.warning).toMatch(/eth_usd/);
  });

  it('formats the funding route source-first', () => {
    expect(fundingRoute([])).toBe('');
    expect(fundingRoute([hop({ depth: 0, address: '0xa', funder: '0xb', kind: 'tx' })])).toBe('0xb');
  });
});

describe('report', () => {
  it('renders every section, the coin table, peak distribution and stats header; writes timestamped files', async () => {
    const coins = [buildCsvRow(source(), 4000)];
    const md = renderReport({
      title: 'Amlil operator',
      pattern: 'team_buys',
      sections: {
        operatorSummary: 'Two exempt team wallets buy 0.38 ETH in the launch second.',
        howFunded: 'Sprayer -> disperse contract -> fresh dev.',
        howToCatch: 'Watch the sprayer for 0.010-0.015 ETH to fresh wallets.',
        recommendedPreset: 'TP +150 %, trailing 100/25, SL 40 %.',
        caveats: 'Two coins only.',
      },
      coins,
      ethUsd: resolveEthUsd(null),
      generatedAt: new Date('2026-10-28T12:00:00Z'),
      runId: 7,
      stats: peakStats([{ peak2Pct: 44, peak5Pct: 222, peak10Pct: 222, peak30Pct: 377, peak60Pct: 300, lowAfterEntryPct: -8 }]),
    });
    for (const h of ['## Operator summary', '## How they are funded', '## How to catch it', '## Recommended preset', '## Coins', '## Caveats', '### Peak distribution']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('agent run #7');
    expect(md).toContain('1 coins · 2026-10-23 12:28:15 UTC');
    expect(md).toContain('> Warning: settings.eth_usd is not set');
    expect(md).toContain('Dev never buys');
    expect(md).toContain('| 5 s | 1 | +222 %');

    const dir = mkdtempSync(path.join(tmpdir(), 'agent-report-'));
    const file = await writeOutput(dir, 'Amlil operator / run 7', 'md', md, new Date('2026-10-28T12:34:56Z'));
    expect(path.basename(file)).toBe('20261028-123456-amlil-operator-run-7.md');
    expect(readFileSync(file, 'utf8')).toBe(md);
  });
});
