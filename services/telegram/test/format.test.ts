import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  fmtBps,
  fmtDuration,
  fmtEth,
  fmtMcap,
  fmtMcapK,
  fmtPct,
  fmtTime,
  fmtTokens,
  fmtUsd,
  Links,
  localDate,
  localHour,
  mcapEthFromPrice,
  shortAddr,
  splitMessage,
  startOfLocalDay,
  toWei,
  weiToEth,
} from '../src/format.js';

describe('amounts', () => {
  it('formats ETH with 4 decimals from numbers and wei', () => {
    expect(fmtEth(0.07)).toBe('0.0700 ETH');
    expect(fmtEth(70_000_000_000_000_000n)).toBe('0.0700 ETH');
    expect(fmtEth(123_456_789_000_000_000n)).toBe('0.1235 ETH');
    expect(fmtEth(-0.01234)).toBe('-0.0123 ETH');
    expect(fmtEth(0.01234, { signed: true })).toBe('+0.0123 ETH');
    expect(fmtEth(0.5, { unit: false })).toBe('0.5000');
    expect(fmtEth(null)).toBe('-');
    expect(weiToEth(-1_500_000_000_000_000_000n)).toBe(-1.5);
    expect(toWei('4000000000000000')).toBe(4_000_000_000_000_000n);
    expect(toWei('abc')).toBeNull();
  });

  it('formats USD, percentages with sign, bps and token amounts', () => {
    expect(fmtUsd(950.256)).toBe('$950.26');
    expect(fmtUsd(12_345.6)).toBe('$12,346');
    expect(fmtUsd(1_250_000)).toBe('$1.25M');
    expect(fmtUsd(-42.5)).toBe('-$42.50');
    expect(fmtUsd(42.5, { signed: true })).toBe('+$42.50');
    expect(fmtPct(12.345)).toBe('+12.3%');
    expect(fmtPct(-40)).toBe('-40.0%');
    expect(fmtPct(0)).toBe('+0.0%');
    expect(fmtPct(undefined)).toBe('-');
    expect(fmtBps(618)).toBe('6.18%');
    expect(fmtTokens(3_870_000n * 10n ** 18n)).toBe('3.87M');
  });

  it('formats market caps in k (USD) and falls back to ETH without a rate', () => {
    expect(fmtMcapK(12_345)).toBe('$12.3k');
    expect(fmtMcapK(950)).toBe('$950');
    expect(fmtMcapK(1_500_000)).toBe('$1.50M');
    expect(fmtMcap(4.1, 3000)).toBe('$12.3k (4.10 ETH)');
    expect(fmtMcap(4.1, null)).toBe('4.10 ETH');
    expect(mcapEthFromPrice(4.1e-9)).toBeCloseTo(4.1);
  });
});

describe('time', () => {
  it('formats durations', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(192)).toBe('3m 12s');
    expect(fmtDuration(7500)).toBe('2h 05m');
    expect(fmtDuration(3 * 86_400 + 4 * 3600)).toBe('3d 4h');
  });

  it('computes local calendar boundaries in a zone with DST', () => {
    const d = new Date('2026-10-28T03:30:00Z'); // 23:30 previous day in New York (EDT, UTC-4)
    expect(localDate(d, 'America/New_York')).toBe('2026-10-27');
    expect(localHour(d, 'America/New_York')).toBe(23);
    expect(startOfLocalDay(d, 'America/New_York').toISOString()).toBe('2026-10-27T04:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-12-01T12:00:00Z'), 'America/New_York').toISOString()).toBe('2026-12-01T05:00:00.000Z');
    expect(startOfLocalDay(d, 'UTC').toISOString()).toBe('2026-10-28T00:00:00.000Z');
    expect(fmtTime(new Date('2026-10-28T19:20:05Z'), 'UTC')).toBe('2026-10-28 19:20:05 UTC');
  });
});

describe('links and escaping', () => {
  const links = new Links();
  const addr = '0xabcdef0123456789abcdef0123456789abcdef01';

  it('links addresses, txs and tokens to Blockscout and GMGN', () => {
    expect(shortAddr(addr)).toBe('0xabcd…ef01');
    expect(links.address(addr)).toBe(`<a href="https://robinhoodchain.blockscout.com/address/${addr}">0xabcd…ef01</a>`);
    const tx = `0x${'12'.repeat(32)}`;
    expect(links.tx(tx)).toBe(`<a href="https://robinhoodchain.blockscout.com/tx/${tx}">0x121212…1212</a>`);
    expect(links.token(addr, 'Amlil', 'AML')).toBe(
      `<b>Amlil ($AML)</b> <a href="https://robinhoodchain.blockscout.com/token/${addr}">scan</a> · <a href="https://gmgn.ai/robinhood/token/${addr}">gmgn</a>`,
    );
    expect(new Links({ explorerUrl: 'https://4663scan.io/', gmgnChain: 'rh' }).gmgnUrl(addr)).toBe(`https://gmgn.ai/rh/token/${addr}`);
  });

  it('escapes HTML in user-controlled strings (token names)', () => {
    expect(escapeHtml('<script>&')).toBe('&lt;script&gt;&amp;');
    expect(links.token(addr, '<b>pwn</b>', null)).toContain('&lt;b&gt;pwn&lt;/b&gt;');
  });

  it('splits long messages on line boundaries', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = splitMessage(text, 1000);
    expect(parts.length).toBeGreaterThan(5);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join('\n')).toBe(text);
  });
});
