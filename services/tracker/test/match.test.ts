import { ArmedWalletRuleSchema } from '@hood/core';
import { describe, expect, it } from 'vitest';
import { armedKey, inRange, isFresh, matchTransfer, type ContractOrigin, type MatchFacts, type RecipientFacts, type TransferEvent, type WatchPlay } from '../src/match.js';
import type { Address, Hex } from '@hood/indexer';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const mE = (milli: number) => BigInt(milli) * 10n ** 15n; // milli-ETH -> wei

const FUNDER = a(0xf1);
const OTHER = a(0xf2);
const SPRAYER = a(0xc0); // contract created by FUNDER
const DISPERSE = a(0xd0); // public disperse contract
const WALLET = a(0x101);
const NOW = new Date('2026-10-28T12:00:00Z');

const play = (id: number, rule: Partial<Parameters<typeof ArmedWalletRuleSchema.parse>[0]> = {}): WatchPlay => ({
  id,
  name: `p${id}`,
  rule: ArmedWalletRuleSchema.parse({ funders: [FUNDER], minEth: 0.01, maxEth: 0.015, freshOnly: true, maxAgeSec: 3600, contractMode: true, ...rule }),
  stopAfter: 1,
});

const transfer = (o: Partial<TransferEvent> = {}): TransferEvent => ({
  id: 10,
  block: 1000,
  ts: 1_800_000_000,
  txHash: h(1),
  traceAddr: '',
  from: FUNDER,
  to: WALLET,
  value: mE(12),
  kind: 'tx',
  ...o,
});

const freshFacts: RecipientFacts = { priorTransfers: 0, txCountAtFirstFunding: 0, firstFundingTx: h(1), isContract: false };
const facts = (o: Partial<MatchFacts> = {}): MatchFacts => ({ recipient: freshFacts, origins: [], txSender: null, armed: new Set(), ...o });
const opts = { now: NOW, contractMaxAgeBlocks: 100 };
const origin = (o: Partial<ContractOrigin> = {}): ContractOrigin => ({ contract: SPRAYER, creator: FUNDER, block: 990, txHash: h(9), ...o });

type Case = [name: string, t: TransferEvent, f: MatchFacts, plays: WatchPlay[], expected: string | { via: string; funder: Address }];

const cases: Case[] = [
  ['direct funding of a fresh wallet', transfer(), facts(), [play(1)], { via: 'direct', funder: FUNDER }],
  ['contract mode: sprayer created by the funder 10 blocks earlier', transfer({ from: SPRAYER, kind: 'internal', traceAddr: '0' }), facts({ origins: [origin()] }), [play(1)], { via: 'contract', funder: FUNDER }],
  ['contract mode: sprayer created in the same tx (long ago is fine)', transfer({ from: SPRAYER, kind: 'internal', traceAddr: '1' }), facts({ origins: [origin({ block: 1, txHash: h(1) })] }), [play(1)], { via: 'contract', funder: FUNDER }],
  ['contract mode: sprayer too old', transfer({ from: SPRAYER, kind: 'internal' }), facts({ origins: [origin({ block: 800 })] }), [play(1)], 'funder'],
  ['contract mode: created by someone else', transfer({ from: SPRAYER, kind: 'internal' }), facts({ origins: [origin({ creator: OTHER })] }), [play(1)], 'funder'],
  ['contract mode off', transfer({ from: SPRAYER, kind: 'internal' }), facts({ origins: [origin()] }), [play(1, { contractMode: false })], 'funder'],
  ['same-tx disperse sent by the funder', transfer({ from: DISPERSE, kind: 'internal', traceAddr: '0' }), facts({ txSender: FUNDER }), [play(1)], { via: 'sameTx', funder: FUNDER }],
  ['unrelated sender', transfer({ from: OTHER }), facts(), [play(1)], 'funder'],
  ['below range', transfer({ value: mE(9) }), facts(), [play(1)], 'range'],
  ['above range', transfer({ value: mE(16) }), facts(), [play(1)], 'range'],
  ['range bounds are inclusive (0.015 exactly)', transfer({ value: mE(15) }), facts(), [play(1)], { via: 'direct', funder: FUNDER }],
  ['not fresh: earlier transfers', transfer(), facts({ recipient: { ...freshFacts, priorTransfers: 2 } }), [play(1)], 'not_fresh'],
  ['not fresh: nonce > 0 at first funding', transfer(), facts({ recipient: { ...freshFacts, txCountAtFirstFunding: 4 } }), [play(1)], 'not_fresh'],
  ['not fresh: first funded by another tx', transfer(), facts({ recipient: { ...freshFacts, firstFundingTx: h(77) } }), [play(1)], 'not_fresh'],
  ['nonce unknown is not fresh by default', transfer(), facts({ recipient: { ...freshFacts, txCountAtFirstFunding: null } }), [play(1)], 'nonce_unknown'],
  ['freshOnly=false accepts an old wallet', transfer(), facts({ recipient: { ...freshFacts, priorTransfers: 9, txCountAtFirstFunding: 50 } }), [play(1, { freshOnly: false })], { via: 'direct', funder: FUNDER }],
  ['recipient is a contract', transfer(), facts({ recipient: { ...freshFacts, isContract: true } }), [play(1)], 'contract_recipient'],
  ['recipient is another funder', transfer({ to: OTHER }), facts(), [play(1, { funders: [FUNDER, OTHER] })], 'funder_recipient'],
  ['duplicate: already armed for this play', transfer(), facts({ armed: new Set([armedKey(1, WALLET)]) }), [play(1)], 'duplicate'],
  ['contract creation is not a funding', transfer({ kind: 'create', to: SPRAYER }), facts(), [play(1)], 'kind'],
];

describe('matchTransfer (table)', () => {
  it.each(cases)('%s', (_name, t, f, plays, expected) => {
    const r = matchTransfer(t, plays, f, opts);
    if (typeof expected === 'string') {
      expect(r.arms).toEqual([]);
      expect(r.rejections).toEqual([{ playId: plays[0]!.id, reason: expected }]);
    } else {
      expect(r.rejections).toEqual([]);
      expect(r.arms).toHaveLength(1);
      expect(r.arms[0]).toMatchObject({ playId: plays[0]!.id, wallet: t.to, sourceFunder: expected.funder, via: expected.via, value: t.value, txHash: t.txHash, block: t.block });
    }
  });

  it('sets expires_at = now + maxAgeSec', () => {
    const r = matchTransfer(transfer(), [play(1, { maxAgeSec: 7200 })], facts(), opts);
    expect(r.arms[0]!.expiresAt.toISOString()).toBe('2026-10-28T14:00:00.000Z');
  });

  it('arms every matching play, rejects the rest, and never twice for the same play', () => {
    const plays = [play(1), play(2, { minEth: 0.05, maxEth: 0.2 }), play(3, { funders: [OTHER] }), play(1)];
    const r = matchTransfer(transfer(), plays, facts(), opts);
    expect(r.arms.map((x) => x.playId)).toEqual([1]);
    expect(r.rejections).toEqual([
      { playId: 2, reason: 'range' },
      { playId: 3, reason: 'funder' },
      { playId: 1, reason: 'duplicate' },
    ]);
  });

  it('unknownNonceIsFresh opt-in', () => {
    const r = matchTransfer(transfer(), [play(1)], facts({ recipient: { ...freshFacts, txCountAtFirstFunding: null } }), { ...opts, unknownNonceIsFresh: true });
    expect(r.arms).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('inRange compares in wei without float drift', () => {
    const rule = { minEth: 0.057, maxEth: 0.174 };
    expect(inRange(57_000_000_000_000_000n, rule)).toBe(true);
    expect(inRange(56_999_999_999_999_999n, rule)).toBe(false);
    expect(inRange(174_000_000_000_000_000n, rule)).toBe(true);
    expect(inRange(174_000_000_000_000_001n, rule)).toBe(false);
    expect(inRange(10n ** 30n, { minEth: 0, maxEth: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  it('isFresh', () => {
    expect(isFresh({ txHash: h(1) }, freshFacts)).toEqual({ fresh: true });
    expect(isFresh({ txHash: h(1) }, { ...freshFacts, firstFundingTx: null })).toEqual({ fresh: true });
  });
});
