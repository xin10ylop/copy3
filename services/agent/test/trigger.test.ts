import { describe, expect, it } from 'vitest';
import { isGenericTrigger, matchTrigger, specifiedConditions, type LaunchContext } from '../src/trigger.js';

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

describe('matchTrigger: launchSecond and blacklists (same semantics as the sniper rules)', () => {
  const ls = (teamBuyEth: number, teamBuyers = teamBuyEth > 0 ? 1 : 0, devBuyEth = 0) => ctx({ launchSecond: { teamBuyEth, teamBuyers, devBuyEth } });
  it('launchSecond alone matches on the team buy; without data it never matches', () => {
    expect(matchTrigger(ls(0.19), { launchSecond: { minTeamBuyEth: 0.1 } })).toEqual({ matched: true, hits: ['launchSecond'] });
    expect(matchTrigger(ls(0.05), { launchSecond: { minTeamBuyEth: 0.1 } }).reason).toBe('minTeamBuyEth');
    expect(matchTrigger(ctx(), { launchSecond: { minTeamBuyEth: 0.1 } }).reason).toBe('launchSecond: no data');
    expect(matchTrigger(ls(2), { launchSecond: { minTeamBuyEth: 0.1, maxTeamBuyEth: 1 } }).reason).toBe('maxTeamBuyEth');
    expect(matchTrigger(ls(0.3, 1), { launchSecond: { minTeamBuyers: 2 } }).reason).toBe('minTeamBuyers');
    expect(matchTrigger(ls(0, 0, 0.2), { launchSecond: { minDevBuyEth: 0.1 } }).matched).toBe(true);
    expect(matchTrigger(ls(0.2, 1, 0.2), { launchSecond: { minTeamBuyEth: 0.1, maxDevBuyEth: 0.1 } }).reason).toBe('launchSecond.maxDevBuyEth');
    expect(matchTrigger(ls(0.2, 1, 0.01), { launchSecond: { minTeamBuyEth: 0.1, requireNoDevBuy: true } }).reason).toBe('requireNoDevBuy');
    expect(matchTrigger(ls(0.2), { launchSecond: { requireNoDevBuy: true } }).reason).toBe('no conditions');
  });

  it('launchSecond is AND with identity conditions; generic = launchSecond only', () => {
    const t = { deployerIn: ['0x00000000000000000000000000000000000000de'], launchSecond: { minTeamBuyEth: 0.1 } };
    expect(matchTrigger(ls(0.2), t).hits).toEqual(['deployerIn', 'launchSecond']);
    expect(matchTrigger(ls(0.01), t).matched).toBe(false);
    expect(matchTrigger(ls(0.2, 1), { ...t, deployerIn: ['0x00000000000000000000000000000000000000ff'] }).reason).toBe('no optional hit');
    expect(specifiedConditions({ launchSecond: { minTeamBuyEth: 0.1 } })).toEqual(['launchSecond']);
    expect(isGenericTrigger({ launchSecond: { minTeamBuyEth: 0.1 } })).toBe(true);
    expect(isGenericTrigger(t)).toBe(false);
  });

  it('deployerNotIn (deployer or tx sender) and teamWalletsNotIn are hard filters', () => {
    const t = { launchSecond: { minTeamBuyEth: 0.1 } };
    expect(matchTrigger(ls(0.2), { ...t, deployerNotIn: ['0x00000000000000000000000000000000000000DE'] }).reason).toBe('deployerNotIn');
    expect(matchTrigger({ ...ls(0.2), txFrom: '0x00000000000000000000000000000000000000aa' }, { ...t, deployerNotIn: ['0x00000000000000000000000000000000000000aa'] }).reason).toBe('deployerNotIn');
    expect(matchTrigger(ls(0.2), { ...t, teamWalletsNotIn: ['0x00000000000000000000000000000000000000e1'] }).reason).toBe('teamWalletsNotIn');
    expect(matchTrigger(ls(0.2), { ...t, deployerNotIn: ['0x00000000000000000000000000000000000000ff'] }).matched).toBe(true);
  });
});
