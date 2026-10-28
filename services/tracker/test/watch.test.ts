import { describe, expect, it } from 'vitest';
import { buildWatchPlay, parseWatchCommand } from '../src/watch.js';

const FUNDER = '0x00000000000000000000000000000000000000F1';

describe('buildWatchPlay', () => {
  it('builds an enabled armedWallet play with SPEC defaults', () => {
    const p = buildWatchPlay({ funder: FUNDER, minEth: 0.01, maxEth: 0.015 });
    expect(p.enabled).toBe(true);
    expect(p.name).toBe('watch 0x0000…00f1 0.01-0.015 ETH');
    expect(p.trigger).toMatchObject({
      armedWallet: { funders: [FUNDER.toLowerCase()], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 172_800, contractMode: true },
      launchKind: 'any',
      require: ['armedWallet'],
    });
    expect(p.preset).toMatchObject({ buyEth: 0.07, maxTaxBps: 1000, stopLossPct: 40, stopAfter: 1 });
  });

  it('applies options and preset overrides', () => {
    const p = buildWatchPlay({
      funder: [FUNDER, '0x00000000000000000000000000000000000000f2'],
      minEth: 0.057,
      maxEth: 0.174,
      fresh: false,
      name: 'amlo sprayer',
      preset: { buyEth: 0.1, takeProfits: [{ pct: 100, sellPct: 50 }, { pct: 200, sellPct: 100 }] },
      contractMode: false,
      maxAgeSec: 3600,
      enabled: false,
      createdBy: 'tg:1',
    });
    expect(p).toMatchObject({ name: 'amlo sprayer', enabled: false, createdBy: 'tg:1' });
    expect(p.trigger.armedWallet).toMatchObject({ freshOnly: false, contractMode: false, maxAgeSec: 3600 });
    expect(p.trigger.armedWallet?.funders).toHaveLength(2);
    expect(p.preset.buyEth).toBe(0.1);
    expect(p.preset.takeProfits).toHaveLength(2);
  });

  it('validates', () => {
    expect(() => buildWatchPlay({ funder: '0x123', minEth: 0, maxEth: 1 })).toThrow(/invalid funder/);
    expect(() => buildWatchPlay({ funder: FUNDER, minEth: 0.2, maxEth: 0.1 })).toThrow(/minEth/);
    expect(() => buildWatchPlay({ funder: FUNDER, minEth: -1, maxEth: 0.1 })).toThrow();
    expect(() => buildWatchPlay({ funder: [], minEth: 0, maxEth: 0.1 })).toThrow(/funder/);
  });
});

describe('parseWatchCommand', () => {
  it('parses /watch <funder> <min> <max> [fresh|any] [play]', () => {
    expect(parseWatchCommand([FUNDER, '0.01', '0.015'])).toEqual({ spec: { funder: FUNDER, minEth: 0.01, maxEth: 0.015, fresh: true }, presetFrom: null });
    expect(parseWatchCommand([FUNDER, '0.01', '0.015', 'any', 'amlo', 'play'])).toEqual({ spec: { funder: FUNDER, minEth: 0.01, maxEth: 0.015, fresh: false }, presetFrom: 'amlo play' });
    expect(parseWatchCommand([FUNDER, '0.01', '0.015', '7']).presetFrom).toBe('7');
    expect(() => parseWatchCommand([FUNDER, '0.01'])).toThrow(/usage/);
    expect(() => parseWatchCommand([FUNDER, 'x', '1'])).toThrow();
  });
});
