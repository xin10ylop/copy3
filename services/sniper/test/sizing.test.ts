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

  it('idleTiers (2 Nov): the tier with the largest minIdle ≤ idle multiplies the size, rounded down to 0.001 ETH', () => {
    const tiers = [
      { minIdle: 1, mult: 0.5 },
      { minIdle: 10, mult: 2 },
      { minIdle: 4, mult: 1.25 },
    ];
    const p = parsePreset({ buyEth: 0.07, sizing: { mode: 'bankroll', minEth: 0.002, maxEth: 0.003, fraction: 0.35, idleTiers: tiers } });
    // bankroll 0.0099 × 0.35 / 2 → clamped to the 0.002 minimum, then the tier
    expect(sizeBuy(p, eth('0.0099'), 2, 1)).toMatchObject({ quoteIn: eth('0.001'), mult: 0.5 });
    expect(sizeBuy(p, eth('0.0099'), 2, 3).quoteIn).toBe(eth('0.001'));
    expect(sizeBuy(p, eth('0.0099'), 2, 6)).toMatchObject({ quoteIn: eth('0.002'), mult: 1.25 }); // 0.0025 → 0.002
    expect(sizeBuy(p, eth('0.0099'), 2, 18)).toMatchObject({ quoteIn: eth('0.004'), mult: 2 });
    expect(sizeBuy(p, eth('0.0099'), 2, 18).note).toMatch(/× 2 \(18 idle exempt\) → 0\.004 ETH/);
    // no idle count (not a launch-second play) or below every tier: the base size
    expect(sizeBuy(p, eth('0.0099'), 2).quoteIn).toBe(eth('0.002'));
    expect(sizeBuy(p, eth('0.0099'), 2, 0)).toMatchObject({ quoteIn: eth('0.002') });
    expect(sizeBuy(p, eth('0.0099'), 2, 0).mult).toBeUndefined();
    // at 0.05 ETH stakes: 0.025 / 0.0625 / 0.1
    const big = parsePreset({ buyEth: 0.05, sizing: { mode: 'bankroll', minEth: 0.05, maxEth: 0.05, fraction: 0.35, idleTiers: tiers } });
    expect([1, 6, 12].map((i) => sizeBuy(big, eth('0.2'), 3, i).quoteIn)).toEqual([eth('0.025'), eth('0.062'), eth('0.1')]);
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

describe('Risk: team cool-off after a loss', () => {
  const launch = (exempt: string[]) =>
    ({ event: { deployer: '0xdeployer000000000000000000000000000000dd', exemptions: exempt } }) as unknown as Parameters<Risk['preCheck']>[1];
  const decision = { play: { id: 1 }, preset: { stopAfter: 1000, firstBuyOnly: false, maxFeeGwei: 1, buyEth: 0.002 } } as unknown as Parameters<Risk['preCheck']>[0];
  it("skips a launch whose team wallet lost within the window; the deployer alone does not count; off after the window", () => {
    const r = new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: 1, teamCoolOffMin: 5 });
    const team = ['0xdeployer000000000000000000000000000000dd', '0xTEAM00000000000000000000000000000000AA'];
    r.onPositionClosed(-0.0006, true, team, 1_000_000);
    expect(r.preCheck(decision, launch(['0xteam00000000000000000000000000000000aa']), 1_000_000 + 60_000).reasons.join()).toMatch(/team cool-off: 0xteam0000.* lost 60 s ago \(cool-off 5 min\)/);
    expect(r.preCheck(decision, launch(['0xdeployer000000000000000000000000000000dd']), 1_000_000 + 60_000).reasons).toEqual([]); // fresh deployer, no team overlap
    expect(r.preCheck(decision, launch(['0xteam00000000000000000000000000000000aa']), 1_000_000 + 5 * 60_000 + 1).reasons).toEqual([]);
    // a win does not start a cool-off
    r.onPositionClosed(+0.001, true, ['0xteam00000000000000000000000000000000bb'], 2_000_000);
    expect(r.preCheck(decision, launch(['0xteam00000000000000000000000000000000bb']), 2_000_000 + 1000).reasons).toEqual([]);
  });
});

describe('Risk: the team cool-off survives a restart', () => {
  it('seeds recent losses from the store so a relaunch right after a restart is still skipped', () => {
    const r = new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: 1, teamCoolOffMin: 5 });
    const now = Date.now();
    r.seed({ countsByPlay: {}, realizedPnlSince: 0, tokens: [], playDeployers: [], recentLosses: [{ closedAt: new Date(now - 90_000), exemptions: ['0xdeployer000000000000000000000000000000dd', '0xTEAM00000000000000000000000000000000CC'] }] });
    const decision = { play: { id: 1 }, preset: { stopAfter: 1000, firstBuyOnly: false, maxFeeGwei: 1, buyEth: 0.002 } } as unknown as Parameters<Risk['preCheck']>[0];
    const launch = { event: { deployer: '0xdeployer000000000000000000000000000000ee', exemptions: ['0xteam00000000000000000000000000000000cc'] } } as unknown as Parameters<Risk['preCheck']>[1];
    expect(r.preCheck(decision, launch, now).reasons.join()).toMatch(/team cool-off: 0xteam0000.*cc lost 90 s ago/);
  });
});

describe('Risk: pause new entries after N losses in a row (1 Nov 2026: HF relaunched 7x with fresh wallets)', () => {
  const launch = { event: { deployer: '0xdeployer000000000000000000000000000000dd', exemptions: [] } } as unknown as Parameters<Risk['preCheck']>[1];
  const decision = { play: { id: 1 }, preset: { stopAfter: 1000, firstBuyOnly: false, maxFeeGwei: 1, buyEth: 0.002 } } as unknown as Parameters<Risk['preCheck']>[0];
  it('4 losses in a row pause entries for 10 min; a win in between resets the count; an orphan (0 PnL) leaves it alone', () => {
    const r = new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: 1, lossStreakPause: 4, lossStreakPauseMin: 10 });
    const t = 10_000_000;
    r.onPositionClosed(-0.0002, true, [], t);
    r.onPositionClosed(-0.0002, true, [], t + 1);
    r.onPositionClosed(+0.0008, true, [], t + 2); // a win: back to 0
    r.onPositionClosed(-0.0002, true, [], t + 3);
    r.onPositionClosed(-0.0002, true, [], t + 4);
    r.onPositionClosed(0, true, [], t + 5); // orphan adoption: not a trade result
    r.onPositionClosed(-0.0002, true, [], t + 6);
    expect(r.preCheck(decision, launch, t + 7).reasons).toEqual([]); // 3 in a row
    r.onPositionClosed(-0.0002, true, [], t + 8); // the 4th
    expect(r.preCheck(decision, launch, t + 60_000).reasons.join()).toMatch(/loss-streak pause: 4 losses in a row, new entries resume in 541 s/);
    expect(r.preCheck(decision, launch, t + 8 + 10 * 60_000).reasons).toEqual([]);
    expect(r.lossStreak).toBe(0); // the count starts over after a pause
  });

  it('off by default (0), and the pause survives a restart (seeded from the last hour of closes, in close order)', () => {
    const off = new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: 1 });
    for (let i = 0; i < 6; i++) off.onPositionClosed(-0.0002, true, [], 1000 + i);
    expect(off.preCheck(decision, launch, 2000).reasons).toEqual([]);
    const now = Date.now();
    const r = new Risk({ mode: 'live', maxConcurrent: 3, maxGasPriceGwei: 1, dailyLossLimitEth: 1, lossStreakPause: 4, lossStreakPauseMin: 10 });
    const at = (sAgo: number, pnlEth: number) => ({ closedAt: new Date(now - sAgo * 1000), pnlEth });
    r.seed({ countsByPlay: {}, realizedPnlSince: 0, tokens: [], playDeployers: [], recentCloses: [at(60, -0.0002), at(300, -0.0002), at(200, -0.0002), at(500, +0.001), at(100, -0.0002)] });
    expect(r.preCheck(decision, launch, now).reasons.join()).toMatch(/loss-streak pause: 4 losses in a row, new entries resume in 540 s/);
  });
});
