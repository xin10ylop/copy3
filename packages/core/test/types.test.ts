import { describe, it, expect } from 'vitest';
import { parsePreset, parsePlay, PresetSchema, PlayTriggerSchema, AddressSchema } from '../src/types.js';

describe('parsePreset defaults (SPEC §4)', () => {
  it('fills the backtest #2 defaults from an empty object (docs/BACKTEST.md)', () => {
    const p = parsePreset({});
    expect(p.buyEth).toBe(0.07);
    expect(p.maxTaxBps).toBe(1000);
    expect(p.burst).toEqual({ startMs: -120, spacingMs: 15, count: 10 });
    expect(p.stopAfter).toBe(1);
    expect(p.takeProfits).toEqual([]);
    expect(p.trailing).toEqual({ activatePct: 50, dropPct: 20 });
    expect(p.stopLossPct).toBe(40);
    expect(p.timeoutSec).toBe(60);
    expect(p.exitIfExemptSellsPct).toBe(0); // dump exit on the first exempt transfer-out/sell
    expect(p.abortIfExemptSellInLaunchBlock).toBe(true);
    expect(p.firstBuyOnly).toBe(true);
  });

  it('M3: maxTaxBps is capped at 5000 (≥ 9900 would disable the tax gate)', () => {
    expect(parsePreset({ maxTaxBps: 5000 }).maxTaxBps).toBe(5000);
    for (const m of [5001, 9900, 65535]) expect(() => parsePreset({ maxTaxBps: m })).toThrow();
  });

  it('respects overrides', () => {
    const p = parsePreset({ buyEth: 0.2, maxTaxBps: 700, burst: { spacingMs: 20 } });
    expect(p.buyEth).toBe(0.2);
    expect(p.maxTaxBps).toBe(700);
    expect(p.burst).toEqual({ startMs: -120, spacingMs: 20, count: 10 });
  });

  it('is a stable schema object', () => {
    expect(PresetSchema.parse({}).slippageBps).toBe(3000);
  });
});

describe('parsePlay defaults', () => {
  it('defaults trigger and preset from a bare play', () => {
    const play = parsePlay({ name: 'Amlo', enabled: true });
    expect(play.name).toBe('Amlo');
    expect(play.enabled).toBe(true);
    expect(play.trigger.launchKind).toBe('any');
    expect(play.trigger.require).toEqual([]);
    expect(play.preset.buyEth).toBe(0.07);
  });

  it('parses an armed-wallet trigger', () => {
    const play = parsePlay({
      trigger: {
        armedWallet: { funders: ['0x44E58C19C5D979AD4457075855ACD88B93F5A49B'], minEth: 0.01, maxEth: 0.2 },
        require: ['armedWallet'],
      },
    });
    expect(play.trigger.armedWallet?.funders[0]).toBe('0x44e58c19c5d979ad4457075855acd88b93f5a49b');
    expect(play.trigger.armedWallet?.freshOnly).toBe(true);
    expect(play.trigger.require).toEqual(['armedWallet']);
  });
});

describe('AddressSchema', () => {
  it('lower-cases', () => {
    expect(AddressSchema.parse('0xABCdef0000000000000000000000000000000001')).toBe(
      '0xabcdef0000000000000000000000000000000001',
    );
  });
  it('rejects bad input', () => {
    expect(() => AddressSchema.parse('0x123')).toThrow();
  });
});

describe('PlayTriggerSchema', () => {
  it('defaults launchKind and require', () => {
    const t = PlayTriggerSchema.parse({});
    expect(t.launchKind).toBe('any');
    expect(t.require).toEqual([]);
  });
});
