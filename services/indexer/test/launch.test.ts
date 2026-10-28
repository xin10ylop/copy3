import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';
import { CurveBook } from '../src/book.js';
import { buildLaunchRow } from '../src/launch.js';
import { decodePonsLogs, parseLaunchCall } from '../src/pons.js';
import { processEvents } from '../src/process.js';
import type { Address, Hex } from '../src/types.js';
import { START_RESERVES, launchTxFixture } from './helpers/fixtures.js';

const fx = launchTxFixture();
const TOKEN = '0xe9a2dc2003a9e7e2ca11f93b64c08b55a749215d';
const CURVE = '0xd30a935fddef5f5855519874ee2f4e7a7ea36821';
const DEPLOYER = '0x81eb508048220493549302d8ea5ef73a3fde1784';
const FEE_RECIPIENT = '0x44e58c19c5d979ad4457075855acd88b93f5a49b';

describe('launch row from the real launchToken tx fixture', () => {
  const events = decodePonsLogs(fx.receipt.logs);
  const ts = Number(fx.block.timestamp);

  it('decodes Initialized, 2x SnipeTaxExempted and TokenLaunched from the receipt', () => {
    expect(events.map((e) => e.type)).toEqual(['initialized', 'exempted', 'exempted', 'launched']);
    const launched = events.find((e) => e.type === 'launched');
    expect(launched).toMatchObject({ token: TOKEN, curve: CURVE, deployer: DEPLOYER, launchConfigId: 0n, graduationThreshold: 4_200_000_000_000_000_000n });
  });

  it('joins calldata (name/symbol/creatorFeeRecipient) and the exemption logs', () => {
    const book = new CurveBook();
    const res = processEvents(book, events, [], {
      tsOf: () => ts,
      txOf: (h) => (h === fx.tx.hash ? { from: fx.tx.from, to: fx.tx.to, input: fx.tx.input } : undefined),
      startReserves: () => START_RESERVES,
    });
    expect(res.launches).toHaveLength(1);
    const l = res.launches[0]!;
    expect(l).toMatchObject({
      token: TOKEN,
      curve: CURVE,
      deployer: DEPLOYER,
      launcher: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
      launchKind: 'launchToken',
      name: 'SHIBA INU',
      symbol: 'SHIB',
      logo: 'https://leverhood.xyz/api/images/66de1e61d1a5d522711923d988fc3567',
      creatorFeeRecipient: FEE_RECIPIENT,
      creatorTaxBps: 0,
      exemptions: [FEE_RECIPIENT, DEPLOYER],
      devBuyQuote: null,
      block: 100_299_817,
      ts: 1_793_214_021,
      txHash: fx.tx.hash,
      txFrom: DEPLOYER,
      graduated: false,
    });
    expect(l.startPrice).toBeCloseTo(1.68e-9, 15);
    expect(l.startMcapEth).toBeCloseTo(1.68, 9);
    expect(book.get(CURVE as Address)?.exempt).toEqual(new Set([DEPLOYER, FEE_RECIPIENT]));
    // idempotent: re-processing the same logs does not create a second launch
    const again = processEvents(book, events, [], { tsOf: () => ts, txOf: () => undefined, startReserves: () => null });
    expect(again.launches).toHaveLength(0);
  });

  it('falls back to the first trade price and flags a dev buy inside the launch tx', () => {
    const l = buildLaunchRow({
      launched: { token: TOKEN, curve: CURVE, deployer: DEPLOYER, pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: 0n, graduationThreshold: 0n, block: 1, txHash: '0x01' } as never,
      tx: null,
      ts: 10,
      exempted: [DEPLOYER as Address],
      devBuyInTx: 5n * 10n ** 16n,
      startReserves: null,
      firstTrade: { quote: 2n * 10n ** 15n, tokens: 10n ** 24n },
    });
    expect(l.launchKind).toBe('unknown');
    expect(l.devBuyQuote).toBe(5n * 10n ** 16n);
    expect(l.startPrice).toBeCloseTo(2e-9, 15);
    expect(l.name).toBeNull();
  });
});

describe('parseLaunchCall (stub ABI) matches the measured selectors', () => {
  const abi = parseAbi([
    'struct S { string a; string b; string c; string d; string e; }',
    'struct P { string name; string symbol; string logo; string description; S socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 salt1; bytes32 salt2; }',
    'function launchToken(P params, uint256 launchConfigId, address pairToken)',
    'function launchToken(P params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions)',
    'function launchTokenFor(P params, uint256 launchConfigId, address pairToken, address deployer, address[] snipeTaxExemptions)',
    'function launchAndBuy(P params, uint256 launchConfigId, address pairToken, uint256 buyQuoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions)',
  ]);
  const params = {
    name: 'Amlil',
    symbol: 'AMLIL',
    logo: '',
    description: '',
    socials: { a: '', b: '', c: '', d: '', e: '' },
    creatorFeeRecipient: '0x3e572ce00dd5ba0386d868fc42c33a9cd73ed91a' as Hex,
    creatorTaxBps: 200,
    buybackEnabled: false,
    salt1: `0x${'11'.repeat(32)}` as Hex,
    salt2: `0x${'22'.repeat(32)}` as Hex,
  };
  const team = ['0x9e3f51b4c11e415c0ccee32b9d7a7cc23932b7bf'] as Hex[];
  const from = '0xc92cc38d4403536ade5f2413cb785455d6b37cac' as Hex;

  it('selectors', () => {
    expect(abi.filter((x) => x.type === 'function').map((f) => toFunctionSelector(f))).toEqual([
      '0xf35abbcf',
      '0xa72101af',
      '0xd6a0eef5',
      '0xf85f8e41',
    ]);
  });

  it('4-arg launchToken carries explicit exemptions; deployer = tx.from', () => {
    const input = encodeFunctionData({ abi, functionName: 'launchToken', args: [params, 0n, '0x0000000000000000000000000000000000000000', team] });
    expect(input.slice(0, 10)).toBe('0xa72101af');
    const c = parseLaunchCall({ from, input });
    expect(c).toMatchObject({ kind: 'launchToken', name: 'Amlil', creatorTaxBps: 200, exemptions: team, deployer: from, devBuyQuoteIn: 0n });
  });

  it('launchAndBuy carries the dev buy, launchTokenFor an explicit deployer', () => {
    const lab = encodeFunctionData({ abi, functionName: 'launchAndBuy', args: [params, 0n, '0x0000000000000000000000000000000000000000', 7n * 10n ** 16n, 1n, from, []] });
    expect(parseLaunchCall({ from, input: lab })).toMatchObject({ kind: 'launchAndBuy', devBuyQuoteIn: 7n * 10n ** 16n });
    const ltf = encodeFunctionData({ abi, functionName: 'launchTokenFor', args: [params, 0n, '0x0000000000000000000000000000000000000000', team[0]!, []] });
    expect(parseLaunchCall({ from, input: ltf })).toMatchObject({ kind: 'launchTokenFor', deployer: team[0] });
    expect(parseLaunchCall({ from, input: '0xa9059cbb' })).toBeNull();
  });
});
