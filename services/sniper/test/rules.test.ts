import type { ArmedCandidate, LaunchEvent } from '@hood/core';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { Rules, compileRegex } from '../src/rules.js';
import { play } from './helpers/fixtures.js';

const DEV = '0x81eb508048220493549302d8ea5ef73a3fde1784' as const;
const FEE_RCPT = '0x44e58c19c5d979ad4457075855acd88b93f5a49b' as const;
const TEAM = '0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a' as const;
const FUNDER = '0x9999999999999999999999999999999999999999' as const;
const OTHER = '0x1234567890123456789012345678901234567890' as const;
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);

const launch = (over: Partial<LaunchEvent> = {}): LaunchEvent => ({
  deployer: DEV,
  name: 'SHIBA INU',
  symbol: 'SHIB',
  launchKind: 'launchToken',
  exemptions: [DEV, FEE_RCPT, TEAM],
  creatorFeeRecipient: FEE_RCPT,
  creatorTaxBps: 200,
  devBuyQuoteIn: 0n,
  pairToken: '0x0000000000000000000000000000000000000000',
  launchConfigId: 0n,
  txFrom: DEV,
  ...over,
});

const armed = (over: Partial<ArmedCandidate> = {}): ArmedCandidate => ({
  playId: 1,
  wallet: DEV,
  sourceFunder: FUNDER,
  fundedValue: parseEther('0.012'),
  armedAt: new Date(NOW - 60_000),
  expiresAt: new Date(NOW + 3_600_000),
  status: 'armed',
  ...over,
});

const armedRule = { funders: [FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 3600, contractMode: false };

interface Case {
  name: string;
  trigger: Record<string, unknown>;
  event?: Partial<LaunchEvent>;
  armed?: ArmedCandidate[];
  expect: boolean;
  reason?: RegExp;
}

const cases: Case[] = [
  // armedWallet
  { name: 'armedWallet: deployer armed', trigger: { armedWallet: armedRule }, armed: [armed()], expect: true, reason: /armedWallet: 0x81eb.* funded by 0x9999.*0\.012 ETH, 60s ago/ },
  { name: 'armedWallet: tx.from armed (launchTokenFor)', trigger: { armedWallet: armedRule }, event: { deployer: OTHER, txFrom: DEV }, armed: [armed()], expect: true },
  { name: 'armedWallet: not armed', trigger: { armedWallet: armedRule }, armed: [armed({ wallet: OTHER })], expect: false, reason: /none of armedWallet matched/ },
  { name: 'armedWallet: other play', trigger: { armedWallet: armedRule }, armed: [armed({ playId: 2 })], expect: false },
  { name: 'armedWallet: expired', trigger: { armedWallet: armedRule }, armed: [armed({ expiresAt: new Date(NOW - 1) })], expect: false },
  { name: 'armedWallet: older than maxAgeSec', trigger: { armedWallet: { ...armedRule, maxAgeSec: 30 } }, armed: [armed()], expect: false },
  { name: 'armedWallet: funded above maxEth', trigger: { armedWallet: armedRule }, armed: [armed({ fundedValue: parseEther('0.2') })], expect: false },
  // deployerIn
  { name: 'deployerIn: hit', trigger: { deployerIn: [DEV.toUpperCase().replace('0X', '0x')] }, expect: true, reason: /deployerIn/ },
  { name: 'deployerIn: miss', trigger: { deployerIn: [OTHER] }, expect: false },
  // teamWalletsAny
  { name: 'teamWalletsAny: exemption hit', trigger: { teamWalletsAny: [TEAM] }, expect: true, reason: /teamWalletsAny: 0x3e57/ },
  { name: 'teamWalletsAny: creatorFeeRecipient hit', trigger: { teamWalletsAny: [FEE_RCPT] }, event: { exemptions: [DEV] }, expect: true },
  { name: 'teamWalletsAny: miss', trigger: { teamWalletsAny: [OTHER] }, expect: false },
  // regexes
  { name: 'nameRegex: case-insensitive bare pattern', trigger: { nameRegex: 'shiba' }, expect: true, reason: /nameRegex/ },
  { name: 'nameRegex: /pattern/flags form, case-sensitive', trigger: { nameRegex: '/^shiba/' }, expect: false },
  { name: 'symbolRegex: hit', trigger: { symbolRegex: '^SHIB$' }, expect: true },
  { name: 'symbolRegex: miss', trigger: { symbolRegex: '^DOGE$' }, expect: false },
  // filters
  { name: 'launchKind devBuy: rejects no-dev-buy', trigger: { deployerIn: [DEV], launchKind: 'devBuy' }, expect: false, reason: /launchKind=devBuy/ },
  { name: 'launchKind devBuy: accepts', trigger: { deployerIn: [DEV], launchKind: 'devBuy' }, event: { devBuyQuoteIn: parseEther('0.5'), launchKind: 'launchAndBuy' }, expect: true, reason: /dev buy 0\.5 ETH/ },
  { name: 'launchKind noDevBuy: rejects dev buy', trigger: { deployerIn: [DEV], launchKind: 'noDevBuy' }, event: { devBuyQuoteIn: 1n }, expect: false },
  { name: 'minDevBuyEth', trigger: { deployerIn: [DEV], minDevBuyEth: 0.3 }, event: { devBuyQuoteIn: parseEther('0.2') }, expect: false },
  { name: 'maxDevBuyEth', trigger: { deployerIn: [DEV], maxDevBuyEth: 0.3 }, event: { devBuyQuoteIn: parseEther('0.5') }, expect: false },
  { name: 'dev buy within [min,max]', trigger: { deployerIn: [DEV], minDevBuyEth: 0.1, maxDevBuyEth: 1 }, event: { devBuyQuoteIn: parseEther('0.5') }, expect: true },
  { name: 'non-ETH pair token never matches', trigger: { deployerIn: [DEV] }, event: { pairToken: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }, expect: false, reason: /not native ETH/ },
  // require (AND) vs OR
  { name: 'OR: one of two optional matchers hits', trigger: { deployerIn: [OTHER], nameRegex: 'shiba' }, expect: true },
  { name: 'require: required + optional both needed', trigger: { nameRegex: 'shiba', teamWalletsAny: [OTHER], require: ['nameRegex'] }, expect: false, reason: /none of teamWalletsAny matched/ },
  { name: 'require: all required hit, no optional configured', trigger: { nameRegex: 'shiba', teamWalletsAny: [TEAM], require: ['nameRegex', 'teamWalletsAny'] }, expect: true },
  { name: 'require: one required misses', trigger: { nameRegex: 'doge', teamWalletsAny: [TEAM], require: ['nameRegex', 'teamWalletsAny'] }, expect: false, reason: /required nameRegex did not match/ },
  { name: 'require: required + optional hit', trigger: { armedWallet: armedRule, nameRegex: 'shiba', symbolRegex: 'XXX', require: ['armedWallet'] }, armed: [armed()], expect: true },
  { name: 'require: unconfigured required matcher', trigger: { nameRegex: 'shiba', require: ['deployerIn'] }, expect: false, reason: /not configured/ },
  // safety
  { name: 'no identity matcher never matches', trigger: { launchKind: 'any' }, expect: false, reason: /no identity matcher/ },
  { name: 'bad regex is reported, never matches', trigger: { nameRegex: '(' }, expect: false, reason: /bad regex/ },
];

describe('Rules.evaluate (table)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const r = new Rules();
      r.setPlays([play({ id: 1, trigger: c.trigger })]);
      r.setArmed(c.armed ?? []);
      const ev = launch(c.event);
      const got = r.evaluate(ev, NOW);
      expect(got.length > 0).toBe(c.expect);
      if (c.reason) {
        const reasons = c.expect ? got[0]!.reasons : r.explain(ev, NOW)[0]!.reasons;
        expect(reasons.join(' | ')).toMatch(c.reason);
      }
    });
  }
});

describe('Rules state', () => {
  it('returns every matching play in id order with its preset; disabled plays are ignored', () => {
    const r = new Rules();
    r.setPlays([
      play({ id: 7, trigger: { nameRegex: 'shiba' }, preset: { buyEth: 0.2 } }),
      play({ id: 3, trigger: { deployerIn: [DEV] }, preset: { buyEth: 0.05 } }),
      { ...play({ id: 1, trigger: { deployerIn: [DEV] } }), enabled: false },
    ]);
    const d = r.evaluate(launch(), NOW);
    expect(d.map((x) => x.play.id)).toEqual([3, 7]);
    expect(d[0]!.preset.buyEth).toBe(0.05);
    expect(r.playCount).toBe(2);
  });

  it('armed candidates can be added and removed incrementally (NOTIFY armed_changed)', () => {
    const r = new Rules();
    r.setPlays([play({ id: 1, trigger: { armedWallet: armedRule } })]);
    expect(r.evaluate(launch(), NOW)).toHaveLength(0);
    r.addArmed(armed());
    expect(r.armedCount).toBe(1);
    expect(r.evaluate(launch(), NOW)).toHaveLength(1);
    r.removeArmed(1, DEV);
    expect(r.evaluate(launch(), NOW)).toHaveLength(0);
  });

  it('evaluate is fast (pure memory)', () => {
    const r = new Rules();
    r.setPlays(Array.from({ length: 50 }, (_, i) => play({ id: i + 1, trigger: { nameRegex: `token${i}`, deployerIn: [OTHER] } })));
    const ev = launch();
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) r.evaluate(ev, NOW);
    const us = ((performance.now() - t0) * 1000) / 2000;
    // eslint-disable-next-line no-console
    console.log(`[rules] 50 plays: ${us.toFixed(1)} µs/evaluate`);
    expect(us).toBeLessThan(500);
  });

  it('compileRegex supports /pat/flags and drops g', () => {
    expect(compileRegex('/a/gi').flags).toBe('i');
    expect(compileRegex('abc').flags).toBe('i');
  });
});
