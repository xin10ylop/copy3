import { parsePreset } from '@hood/core';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { FALLBACK_DAILY_LOSS_ETH, Risk } from '../src/risk.js';
import { PaperBankroll, SIZE_STEP_WEI, sizeBuy } from '../src/sizing.js';

const bankroll = (over: Record<string, unknown> = {}) => parsePreset({ buyEth: 0.07, sizing: { mode: 'bankroll', ...over } });
const eth = (x: string): bigint => parseEther(x);

describe('sizeBuy (Preset.sizing)', () => {
  it('fixed mode buys buyEth whatever the bankroll', () => {
    const p = parsePreset({ buyEth: 0.07 });
    expect(sizeBuy(p, eth('10'), 3)).toMatchObject({ quoteIn: eth('0.07'), mode: 'fixed', bankrollEth: null });
    expect(sizeBuy(p, null, 3).quoteIn).toBe(eth('0.07'));
  });

  it('bankroll mode: bankroll × fraction / maxConcurrent', () => {
    expect(sizeBuy(bankroll(), eth('0.6'), 3)).toMatchObject({ quoteIn: eth('0.05'), mode: 'bankroll', bankrollEth: 0.6, clamped: null });
    expect(sizeBuy(bankroll({ fraction: 0.5 }), eth('0.6'), 1).quoteIn).toBe(eth('0.3'));
    expect(sizeBuy(bankroll(), eth('1.2'), 0).quoteIn).toBe(eth('0.3')); // maxConcurrent ≤ 0 counts as 1, then the max clamp
  });

  it('clamps to [minEth, maxEth]', () => {
    // the owner's start: ~0.1 ETH in the contract → 0.1 × 0.25 / 3 = 0.0083 → the 0.01 floor
    expect(sizeBuy(bankroll(), eth('0.1'), 3)).toMatchObject({ quoteIn: eth('0.01'), clamped: 'min' });
    expect(sizeBuy(bankroll(), eth('100'), 3)).toMatchObject({ quoteIn: eth('0.3'), clamped: 'max' });
    expect(sizeBuy(bankroll({ minEth: 0.02, maxEth: 0.05 }), eth('0'), 3)).toMatchObject({ quoteIn: eth('0.02'), clamped: 'min' });
  });

  it('rounds down to 0.001 ETH', () => {
    // 0.5 × 0.25 / 3 = 0.041666… → 0.041
    const s = sizeBuy(bankroll(), eth('0.5'), 3);
    expect(s.quoteIn).toBe(eth('0.041'));
    expect(s.quoteIn % SIZE_STEP_WEI).toBe(0n);
    expect(sizeBuy(bankroll(), eth('0.9999'), 2).quoteIn).toBe(eth('0.124')); // 0.1249875 → 0.124
  });

  it('an unknown bankroll (no balance read yet) buys the minimum', () => {
    expect(sizeBuy(bankroll(), null, 3)).toMatchObject({ quoteIn: eth('0.01'), clamped: 'min', bankrollEth: null });
  });
});

describe('PaperBankroll (paper compounding)', () => {
  it('totalWei is free + committed: the daily-loss base does not shrink while positions are open', () => {
    const b = new PaperBankroll(eth('0.1'));
    b.commit('a', eth('0.025'));
    b.commit('b', eth('0.025'));
    b.commit('c', eth('0.025'));
    expect(b.balanceWei()).toBe(eth('0.025'));
    expect(b.totalWei()).toBe(eth('0.1'));
    b.close('a', 0.01);
    expect(b.totalWei()).toBe(eth('0.11'));
    expect(b.balanceWei()).toBe(eth('0.06'));
  });

  it('commits on decide, releases on no-fill, books PnL on close', () => {
    const b = new PaperBankroll(eth('0.1'));
    b.commit('a', eth('0.01'));
    expect(b.balanceWei()).toBe(eth('0.09'));
    b.release('a');
    expect(b.balanceWei()).toBe(eth('0.1'));
    b.commit('b', eth('0.01'));
    b.close('b', 0.002);
    expect(b.balanceWei()).toBe(eth('0.102'));
    expect(b.realizedEth).toBeCloseTo(0.002, 12);
    b.commit('c', eth('0.01'));
    b.close('c', -0.004);
    expect(b.balanceWei()).toBe(eth('0.098'));
  });

  it('seeds the all-time realised paper PnL from the DB and never goes negative', () => {
    const b = new PaperBankroll(eth('0.1'));
    b.seedRealized(0.05);
    expect(b.balanceWei()).toBe(eth('0.15'));
    b.seedRealized(-1);
    expect(b.balanceWei()).toBe(0n);
  });

  it('sizes grow with the bankroll: +8 % per trade compounds the buy size', () => {
    const b = new PaperBankroll(eth('0.5'));
    const p = bankroll({ fraction: 0.25 });
    const sizes: bigint[] = [];
    for (let i = 0; i < 30; i++) {
      const s = sizeBuy(p, b.balanceWei(), 1).quoteIn;
      sizes.push(s);
      b.commit(`t${i}`, s);
      b.close(`t${i}`, (Number(s) / 1e18) * 0.08);
    }
    expect(sizes[0]).toBe(eth('0.125'));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]!).toBeGreaterThanOrEqual(sizes[i - 1]!);
    expect(sizes.at(-1)!).toBeGreaterThan(eth('0.2')); // 0.5 × 1.02^29 ≈ 0.89 → 0.222
    expect(Number(b.balanceWei()) / 1e18).toBeGreaterThan(0.85);
  });
});

describe('daily loss limit as a share of the bankroll', () => {
  const risk = (o: { eth?: number; pct?: number } = {}) =>
    new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: o.eth, dailyLossLimitPct: o.pct ?? 15 });

  it('DAILY_LOSS_LIMIT_PCT of the first bankroll figure of the UTC day', () => {
    const r = risk();
    expect(r.dailyLossLimitEth).toBe(FALLBACK_DAILY_LOSS_ETH); // no bankroll known yet
    r.setBankroll(0.2);
    r.setBankroll(0.15); // later figures of the same day do not move the base
    expect(r.dailyLossLimitEth).toBeCloseTo(0.03, 12);
    r.onPositionClosed(-0.031);
    expect(r.sendCheck().reasons.join()).toMatch(/daily loss -0\.0310 ETH ≥ limit 0\.03/);
  });

  it('DAILY_LOSS_LIMIT_ETH wins when set; settings override both', () => {
    const r = risk({ eth: 0.05 });
    r.setBankroll(10);
    expect(r.dailyLossLimitEth).toBe(0.05);
    const s = risk();
    s.setBankroll(1);
    s.setSettings({ daily_loss_limit_pct: 5 });
    expect(s.dailyLossLimitEth).toBeCloseTo(0.05, 12);
    s.setSettings({ daily_loss_limit_eth: 0.2 });
    expect(s.dailyLossLimitEth).toBe(0.2);
  });

  it('the base resets with the UTC day', () => {
    const r = risk();
    const day1 = Date.UTC(2026, 9, 28, 23, 0, 0);
    r.setBankroll(1, day1);
    expect(r.bankrollAtDayStart).toBe(1);
    r.setBankroll(2, day1 + 2 * 3600_000); // next UTC day
    expect(r.bankrollAtDayStart).toBe(2);
  });

  it('config: DAILY_LOSS_LIMIT_ETH unset or empty → percentage mode (15 % default); PAPER_BANKROLL_ETH 0.1', () => {
    expect(loadConfig({}).DAILY_LOSS_LIMIT_ETH).toBeUndefined();
    expect(loadConfig({ DAILY_LOSS_LIMIT_ETH: '' }).DAILY_LOSS_LIMIT_ETH).toBeUndefined();
    expect(loadConfig({ DAILY_LOSS_LIMIT_ETH: '0.3' }).DAILY_LOSS_LIMIT_ETH).toBe(0.3);
    expect(loadConfig({}).DAILY_LOSS_LIMIT_PCT).toBe(15);
    expect(loadConfig({}).PAPER_BANKROLL_ETH).toBe(0.1);
    expect(() => loadConfig({ DAILY_LOSS_LIMIT_PCT: '0' })).toThrow();
  });
});
