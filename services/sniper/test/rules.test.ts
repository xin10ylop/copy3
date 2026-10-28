import type { ArmedCandidate, LaunchEvent } from '@hood/core';
import { parseEther } from 'viem';
import { describe, expect, it } from 'vitest';
import { Rules, compileRegex } from '../src/rules.js';
import type { LaunchSecondStage, LaunchSecondStats } from '../src/types.js';
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

/** Launch-second totals: team ETH, team buyers (default 1 when team > 0), dev ETH. */
const tot = (team = 0, buyers = team > 0 ? 1 : 0, dev = 0) => ({ teamBuyEth: team, teamBuyers: buyers, devBuyEth: dev });
const ls = (seen: ReturnType<typeof tot>, confirmed: ReturnType<typeof tot> = seen, exemptOut = 0): LaunchSecondStats => ({ seen, confirmed, exemptOut, pending: 0 });

interface Case {
  name: string;
  trigger: Record<string, unknown>;
  event?: Partial<LaunchEvent>;
  armed?: ArmedCandidate[];
  /** launch-second ledger totals passed to evaluate */
  ls?: LaunchSecondStats;
  stage?: LaunchSecondStage;
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
  // launchSecond: minTeamBuyEth
  { name: 'launchSecond.minTeamBuyEth: team bought 0.19 ≥ 0.1', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19)), expect: true, reason: /launchSecond: team 0\.19 ETH by 1 wallet\(s\), dev 0 ETH \(seen\)/ },
  { name: 'launchSecond.minTeamBuyEth: team bought 0.05 < 0.1', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.05)), expect: false, reason: /team buy 0\.05 ETH < min 0\.1/ },
  { name: 'launchSecond.minTeamBuyEth: exactly at the threshold', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.1)), expect: true },
  { name: 'launchSecond: no ledger data yet never matches', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, expect: false, reason: /no launch-second data yet/ },
  // maxTeamBuyEth
  { name: 'launchSecond.maxTeamBuyEth: 1.5 > 1', trigger: { launchSecond: { minTeamBuyEth: 0.1, maxTeamBuyEth: 1 } }, ls: ls(tot(1.5)), expect: false, reason: /team buy 1\.5 ETH > max 1/ },
  { name: 'launchSecond.maxTeamBuyEth: 0.5 within [0.1, 1]', trigger: { launchSecond: { minTeamBuyEth: 0.1, maxTeamBuyEth: 1 } }, ls: ls(tot(0.5)), expect: true },
  // minTeamBuyers
  { name: 'launchSecond.minTeamBuyers: 1 buyer < 2', trigger: { launchSecond: { minTeamBuyers: 2 } }, ls: ls(tot(0.4, 1)), expect: false, reason: /1 team buyer\(s\) < min 2/ },
  { name: 'launchSecond.minTeamBuyers: 2 buyers', trigger: { launchSecond: { minTeamBuyers: 2 } }, ls: ls(tot(0.38, 2)), expect: true, reason: /by 2 wallet/ },
  // minDevBuyEth / maxDevBuyEth / requireNoDevBuy
  { name: 'launchSecond.minDevBuyEth: dev 0.1 ≥ 0.05', trigger: { launchSecond: { minDevBuyEth: 0.05 } }, ls: ls(tot(0, 0, 0.1)), expect: true, reason: /dev 0\.1 ETH/ },
  { name: 'launchSecond.minDevBuyEth: dev 0.01 < 0.05', trigger: { launchSecond: { minDevBuyEth: 0.05 } }, ls: ls(tot(0, 0, 0.01)), expect: false, reason: /dev buy 0\.01 ETH < min 0\.05/ },
  { name: 'launchSecond.maxDevBuyEth: dev 0.1 > 0.05', trigger: { launchSecond: { minTeamBuyEth: 0.1, maxDevBuyEth: 0.05 } }, ls: ls(tot(0.2, 1, 0.1)), expect: false, reason: /dev buy 0\.1 ETH > max 0\.05/ },
  { name: 'launchSecond.maxDevBuyEth: dev 0.02 ≤ 0.05', trigger: { launchSecond: { minTeamBuyEth: 0.1, maxDevBuyEth: 0.05 } }, ls: ls(tot(0.2, 1, 0.02)), expect: true },
  { name: 'launchSecond.requireNoDevBuy: dev bought', trigger: { launchSecond: { minTeamBuyEth: 0.1, requireNoDevBuy: true } }, ls: ls(tot(0.2, 1, 0.01)), expect: false, reason: /requireNoDevBuy but dev bought 0\.01 ETH/ },
  { name: 'launchSecond.requireNoDevBuy: no dev buy', trigger: { launchSecond: { minTeamBuyEth: 0.1, requireNoDevBuy: true } }, ls: ls(tot(0.2)), expect: true },
  { name: 'launchSecond without an ETH demand is only a filter: alone it never matches', trigger: { launchSecond: { requireNoDevBuy: true, maxTeamBuyEth: 5 } }, ls: ls(tot(0.2)), expect: false, reason: /no identity matcher/ },
  { name: 'launchSecond without an ETH demand filters an identity matcher', trigger: { deployerIn: [DEV], launchSecond: { requireNoDevBuy: true } }, ls: ls(tot(0, 0, 0.3)), expect: false, reason: /requireNoDevBuy/ },
  // stages: hint (feed, seen) vs confirm (minimums need CurveBuy-proven buys)
  { name: 'launchSecond confirm stage: seen 0.19 but nothing confirmed', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19), tot(0)), stage: 'confirm', expect: false, reason: /team buy 0 ETH < min 0\.1 \(confirmed\)/ },
  { name: 'launchSecond hint stage: the same unconfirmed feed buy is enough to schedule', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19), tot(0)), stage: 'hint', expect: true },
  { name: 'launchSecond confirm stage: maximums use everything seen', trigger: { launchSecond: { minTeamBuyEth: 0.1, maxTeamBuyEth: 1 } }, ls: ls(tot(2), tot(0.5)), stage: 'confirm', expect: false, reason: /team buy 2 ETH > max 1 \(confirmed\)/ },
  { name: 'launchSecond confirm stage: confirmed 0.19', trigger: { launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19)), stage: 'confirm', expect: true, reason: /\(confirmed\)/ },
  // launchSecond is always AND; identity matchers keep their OR / require semantics
  { name: 'launchSecond AND deployerIn: deployer misses', trigger: { deployerIn: [OTHER], launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19)), expect: false, reason: /none of deployerIn matched/ },
  { name: 'launchSecond AND deployerIn: team buy misses', trigger: { deployerIn: [DEV], launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.01)), expect: false, reason: /team buy 0\.01 ETH < min 0\.1/ },
  { name: 'launchSecond AND deployerIn: both hit', trigger: { deployerIn: [DEV], launchSecond: { minTeamBuyEth: 0.1 } }, ls: ls(tot(0.19)), expect: true, reason: /launchSecond.*deployerIn/ },
  { name: "require: ['launchSecond'] is accepted", trigger: { launchSecond: { minTeamBuyEth: 0.1 }, require: ['launchSecond'] }, ls: ls(tot(0.19)), expect: true },
  // blacklists
  { name: 'deployerNotIn: blacklisted deployer never matches', trigger: { launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [DEV] }, ls: ls(tot(0.19)), expect: false, reason: /deployerNotIn: 0x81eb.* is blacklisted/ },
  { name: 'deployerNotIn: blacklisted tx sender (launchTokenFor)', trigger: { launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [DEV] }, event: { deployer: OTHER, txFrom: DEV }, ls: ls(tot(0.19)), expect: false, reason: /deployerNotIn/ },
  { name: 'deployerNotIn: wins over a deployerIn hit', trigger: { deployerIn: [DEV], deployerNotIn: [DEV] }, expect: false, reason: /blacklisted/ },
  { name: 'deployerNotIn: other deployers still match', trigger: { launchSecond: { minTeamBuyEth: 0.1 }, deployerNotIn: [OTHER] }, ls: ls(tot(0.19)), expect: true },
  { name: 'teamWalletsNotIn: blacklisted team wallet in the exemptions', trigger: { launchSecond: { minTeamBuyEth: 0.1 }, teamWalletsNotIn: [TEAM] }, ls: ls(tot(0.19)), expect: false, reason: /teamWalletsNotIn: 0x3e57.* is blacklisted/ },
  { name: 'teamWalletsNotIn: blacklisted creatorFeeRecipient', trigger: { deployerIn: [DEV], teamWalletsNotIn: [FEE_RCPT] }, event: { exemptions: [DEV] }, expect: false, reason: /teamWalletsNotIn/ },
  { name: 'teamWalletsNotIn: unrelated wallet does not block', trigger: { launchSecond: { minTeamBuyEth: 0.1 }, teamWalletsNotIn: [OTHER] }, ls: ls(tot(0.19)), expect: true },
];

describe('Rules.evaluate (table, paper mode: every identity matcher arms a run)', () => {
  for (const c of cases) {
    it(c.name, () => {
      const r = new Rules({ mode: 'paper' });
      r.setPlays([play({ id: 1, trigger: c.trigger })]);
      r.setArmed(c.armed ?? []);
      const ev = launch(c.event);
      const got = r.evaluate(ev, NOW, c.ls, c.stage);
      expect(got.length > 0).toBe(c.expect);
      if (c.reason) {
        const reasons = c.expect ? got[0]!.reasons : r.explain(ev, NOW, c.ls, c.stage)[0]!.reasons;
        expect(reasons.join(' | ')).toMatch(c.reason);
      }
    });
  }
});

describe('H1: live plays need a non-spoofable matcher', () => {
  const live = (trigger: Record<string, unknown>, armedList: ArmedCandidate[] = []): Rules => {
    const r = new Rules({ mode: 'live' });
    r.setPlays([play({ id: 1, trigger })]);
    r.setArmed(armedList);
    return r;
  };
  it('name / symbol / team wallets alone never arm a LIVE run (anyone can launch with those)', () => {
    for (const t of [{ nameRegex: 'shiba' }, { symbolRegex: '^SHIB$' }, { teamWalletsAny: [TEAM] }, { nameRegex: 'shiba', teamWalletsAny: [TEAM], require: ['nameRegex', 'teamWalletsAny'] }]) {
      const r = live(t);
      expect(r.evaluate(launch(), NOW)).toHaveLength(0);
      expect(r.explain(launch(), NOW)[0]!.reasons.join()).toMatch(/non-spoofable/);
      // the same play still arms a paper run
      const pr = new Rules({ mode: 'paper' });
      pr.setPlays([play({ id: 1, trigger: t })]);
      expect(pr.evaluate(launch(), NOW)).toHaveLength(1);
    }
  });
  it('deployerIn or armedWallet (bound to the tx signer / TokenLaunched.deployer) arm a live run', () => {
    expect(live({ deployerIn: [DEV] }).evaluate(launch(), NOW)).toHaveLength(1);
    expect(live({ armedWallet: armedRule }, [armed()]).evaluate(launch(), NOW)).toHaveLength(1);
    // an anchor plus a spoofable filter: both must hold as configured
    expect(live({ deployerIn: [DEV], nameRegex: 'doge', require: ['deployerIn', 'nameRegex'] }).evaluate(launch(), NOW)).toHaveLength(0);
    expect(live({ deployerIn: [OTHER], nameRegex: 'shiba' }).evaluate(launch(), NOW)).toHaveLength(0); // OR hit only on the name
  });
  it('launchSecond that demands ETH is a live-eligible matcher (real curve buys, confirmed before signing)', () => {
    const stats = ls(tot(0.19));
    expect(live({ launchSecond: { minTeamBuyEth: 0.1 } }).evaluate(launch(), NOW, stats)).toHaveLength(1);
    expect(live({ launchSecond: { minTeamBuyers: 1 } }).evaluate(launch(), NOW, stats)).toHaveLength(1);
    expect(live({ launchSecond: { minDevBuyEth: 0.05 } }).evaluate(launch(), NOW, ls(tot(0, 0, 0.1)))).toHaveLength(1);
    // it anchors a spoofable identity matcher too
    expect(live({ teamWalletsAny: [TEAM], launchSecond: { minTeamBuyEth: 0.1 } }).evaluate(launch(), NOW, stats)).toHaveLength(1);
    // a launch-second rule without an ETH demand anchors nothing
    const r = live({ nameRegex: 'shiba', launchSecond: { maxTeamBuyEth: 5 } });
    expect(r.evaluate(launch(), NOW, stats)).toHaveLength(0);
    expect(r.explain(launch(), NOW, stats)[0]!.reasons.join()).toMatch(/non-spoofable/);
    // and without the ledger nothing fires
    expect(live({ launchSecond: { minTeamBuyEth: 0.1 } }).evaluate(launch(), NOW)).toHaveLength(0);
  });

  it('the default mode is live (fail closed)', () => {
    const r = new Rules();
    r.setPlays([play({ id: 1, trigger: { nameRegex: 'shiba' } })]);
    expect(r.evaluate(launch(), NOW)).toHaveLength(0);
  });
});

describe('Rules state', () => {
  it('returns every matching play in id order with its preset; disabled plays are ignored', () => {
    const r = new Rules({ mode: 'paper' });
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

  it('hasLaunchSecondPlays tells the sniper whether to keep launch-second ledgers', () => {
    const r = new Rules();
    r.setPlays([play({ id: 1, trigger: { deployerIn: [DEV] } })]);
    expect(r.hasLaunchSecondPlays).toBe(false);
    r.setPlays([play({ id: 1, trigger: { deployerIn: [DEV] } }), play({ id: 2, trigger: { launchSecond: { minTeamBuyEth: 0.1 } } })]);
    expect(r.hasLaunchSecondPlays).toBe(true);
    r.setPlays([{ ...play({ id: 2, trigger: { launchSecond: { minTeamBuyEth: 0.1 } } }), enabled: false }]);
    expect(r.hasLaunchSecondPlays).toBe(false);
  });

  it('evaluatePlay re-checks one play against the ledger (confirm stage)', () => {
    const r = new Rules();
    r.setPlays([play({ id: 4, trigger: { launchSecond: { minTeamBuyEth: 0.1 } } })]);
    expect(r.evaluatePlay(4, launch(), NOW, ls(tot(0.19), tot(0)), 'confirm').matched).toBe(false);
    expect(r.evaluatePlay(4, launch(), NOW, ls(tot(0.19)), 'confirm').matched).toBe(true);
    expect(r.evaluatePlay(5, launch(), NOW, ls(tot(0.19))).reasons).toEqual(['play no longer enabled']);
  });

  it('compileRegex supports /pat/flags and drops g', () => {
    expect(compileRegex('/a/gi').flags).toBe('i');
    expect(compileRegex('abc').flags).toBe('i');
  });
});
