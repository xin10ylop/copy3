import { describe, expect, it } from 'vitest';
import { matchTrigger, type LaunchContext } from '../src/trigger.js';

const F = '0x00000000000000000000000000000000000000f1';
const C = '0x00000000000000000000000000000000000000c1';
const ctx = (o: Partial<LaunchContext> = {}): LaunchContext => ({
  token: '0x01',
  name: 'Amlil',
  symbol: 'AMLIL',
  deployer: '0x00000000000000000000000000000000000000de',
  launchKind: 'noDevBuy',
  devBuyEth: null,
  teamWallets: ['0x00000000000000000000000000000000000000e1'],
  fundings: [{ wallet: '0x00000000000000000000000000000000000000de', role: 'deployer', funder: C, funderCreator: F, valueEth: 0.012, fresh: true }],
  ...o,
});
const armed = (contractMode: boolean, freshOnly = true) => ({ funders: [F], minEth: 0.01, maxEth: 0.015, freshOnly, maxAgeSec: 3600, contractMode });

describe('matchTrigger', () => {
  it('requires every condition in `require` and ORs the others', () => {
    expect(matchTrigger(ctx(), { armedWallet: armed(true), nameRegex: '^amlil$', require: ['armedWallet'] }).matched).toBe(true);
    expect(matchTrigger(ctx({ name: 'Other' }), { armedWallet: armed(true), nameRegex: '^amlil$', require: ['armedWallet'] }).matched).toBe(false);
    expect(matchTrigger(ctx({ name: 'Other' }), { armedWallet: armed(true), nameRegex: '^amlil$', require: [] }).matched).toBe(true);
    expect(matchTrigger(ctx(), { nameRegex: '^x', symbolRegex: 'AML', require: [] }).hits).toEqual(['symbolRegex']);
  });

  it('armed wallet: contract mode, value range and freshness', () => {
    expect(matchTrigger(ctx(), { armedWallet: armed(false), require: ['armedWallet'] }).matched).toBe(false);
    expect(matchTrigger(ctx(), { armedWallet: { ...armed(true), maxEth: 0.011 }, require: ['armedWallet'] }).matched).toBe(false);
    const stale = ctx({ fundings: [{ ...ctx().fundings[0]!, fresh: false }] });
    expect(matchTrigger(stale, { armedWallet: armed(true), require: ['armedWallet'] }).matched).toBe(false);
    expect(matchTrigger(stale, { armedWallet: armed(true, false), require: ['armedWallet'] }).matched).toBe(true);
  });

  it('launch kind and dev-buy range are hard filters; no condition matches nothing', () => {
    const team = { teamWalletsAny: ['0x00000000000000000000000000000000000000E1'], require: [] as [] };
    expect(matchTrigger(ctx(), { ...team, launchKind: 'devBuy' }).matched).toBe(false);
    expect(matchTrigger(ctx({ devBuyEth: 0.5 }), { ...team, launchKind: 'devBuy', maxDevBuyEth: 0.3 }).reason).toBe('maxDevBuyEth');
    expect(matchTrigger(ctx({ devBuyEth: 0.2 }), { ...team, launchKind: 'devBuy', maxDevBuyEth: 0.3 }).matched).toBe(true);
    expect(matchTrigger(ctx(), { require: [] }).matched).toBe(false);
  });
});
