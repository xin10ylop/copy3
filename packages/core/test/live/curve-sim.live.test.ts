/**
 * LIVE=1 verification duties (SPEC §8 a/b/c/d). All reads use 'latest' only
 * (the public RPC is non-archive). No transactions are sent — only eth_call
 * simulations with state overrides. Results are appended to RESEARCH by hand
 * after a run; this test asserts the invariants we built the code around.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeAbiParameters,
  parseAbiParameters,
  toFunctionSelector,
  decodeErrorResult,
  parseAbi,
} from 'viem';
import { rpc, rpcRaw, hex } from './rpc.js';
import { PONS_V2, MULTICALL3 } from '../../src/addresses.js';
import { priceImpactBps, mcapFromReserves } from '../../src/pons/curve.js';

const LIVE = process.env.LIVE === '1';
const errAbi = parseAbi([
  'error SlippageExceeded(uint256 amountOut, uint256 minOut)',
  'error ZeroAmount()',
  'error AlreadyGraduated()',
  'error InvalidLaunchEconomics()',
  'error NativeValueMismatch(uint256 sent, uint256 expected)',
]);

function decodeErr(data?: string): string {
  if (!data || data === '0x') return '(no data)';
  try {
    const r = decodeErrorResult({ abi: errAbi, data: data as `0x${string}` });
    return `${r.errorName}(${(r.args ?? []).map(String).join(',')})`;
  } catch {
    return `unknown ${data.slice(0, 10)}`;
  }
}

async function callUint(to: string, sig: string): Promise<bigint> {
  const r = await rpc<string>('eth_call', [{ to, data: toFunctionSelector(sig) }, 'latest']);
  return BigInt(r);
}

/** Find the newest non-graduated native-quote curve from recent TokenLaunched logs. */
async function findFreshCurve(): Promise<{ curve: string; token: string }> {
  const bn = BigInt(await rpc<string>('eth_blockNumber', []));
  const logs = await rpc<{ topics: string[] }[]>('eth_getLogs', [
    {
      fromBlock: hex(bn - 6000n),
      toBlock: 'latest',
      address: PONS_V2.factory,
      topics: ['0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'],
    },
  ]);
  for (const l of logs.slice().reverse()) {
    const curve = '0x' + l.topics[2]!.slice(26);
    const token = '0x' + l.topics[1]!.slice(26);
    const grad = await callUint(curve, 'function graduated()');
    const nat = await callUint(curve, 'function isNativeQuote()');
    if (grad === 0n && nat === 1n) return { curve, token };
  }
  throw new Error('no fresh non-graduated native curve found');
}

describe.skipIf(!LIVE)('live curve simulation (verification §8)', () => {
  it('(a) buy param order is buy(quoteIn, minTokensOut, recipient); reversed reverts; high minOut → SlippageExceeded', async () => {
    const { curve } = await findFreshCurve();
    const buySel = toFunctionSelector('function buy(uint256,uint256,address)');
    const recipient = '0x1111111111111111111111111111111111111111';
    const value = 10n ** 16n; // 0.01 ETH
    const ov = { [recipient]: { balance: hex(10n ** 18n) } };

    const argA = encodeAbiParameters(parseAbiParameters('uint256,uint256,address'), [value, 0n, recipient]).slice(2);
    const argB = encodeAbiParameters(parseAbiParameters('uint256,uint256,address'), [0n, value, recipient]).slice(2);
    const argHigh = encodeAbiParameters(parseAbiParameters('uint256,uint256,address'), [value, 10n ** 30n, recipient]).slice(2);

    const rA = await rpcRaw<string>('eth_call', [{ to: curve, from: recipient, value: hex(value), data: buySel + argA }, 'latest', ov]);
    const rB = await rpcRaw<string>('eth_call', [{ to: curve, from: recipient, value: hex(value), data: buySel + argB }, 'latest', ov]);
    const rHigh = await rpcRaw<string>('eth_call', [{ to: curve, from: recipient, value: hex(value), data: buySel + argHigh }, 'latest', ov]);

    // correct order returns tokensOut
    expect(rA.error, `A revert: ${decodeErr(rA.error?.data)}`).toBeUndefined();
    expect(BigInt(rA.result!)).toBeGreaterThan(0n);
    // reversed order reverts (msg.value != quoteIn arg → NativeValueMismatch)
    expect(rB.error).toBeDefined();
    // excessive minTokensOut reverts with SlippageExceeded
    expect(rHigh.error).toBeDefined();
    expect(decodeErr(rHigh.error?.data)).toContain('SlippageExceeded');
    console.log('[§8a] reversed-order revert =', decodeErr(rB.error?.data));
  }, 120_000);

  it('(b) a contract caller (locker) is allowed to buy (no tx.origin restriction)', async () => {
    const { curve } = await findFreshCurve();
    const buySel = toFunctionSelector('function buy(uint256,uint256,address)');
    const recipient = '0x1111111111111111111111111111111111111111';
    const value = 10n ** 16n;
    const arg = encodeAbiParameters(parseAbiParameters('uint256,uint256,address'), [value, 0n, recipient]).slice(2);
    const r = await rpcRaw<string>('eth_call', [
      { to: curve, from: PONS_V2.locker, value: hex(value), data: buySel + arg },
      'latest',
      { [PONS_V2.locker]: { balance: hex(10n ** 18n) } },
    ]);
    console.log('[§8b] contract-caller buy =', r.error ? `REVERT ${decodeErr(r.error.data)}` : `tokensOut ${BigInt(r.result!)}`);
    expect(r.error, 'contract caller should be allowed → PonsSniper helper is viable').toBeUndefined();
  }, 120_000);

  it('(c) reads economics and computes start mcap + 0.07 ETH price impact; large buys are not capped', async () => {
    const { curve } = await findFreshCurve();
    const reserves = await rpc<string>('eth_call', [{ to: curve, data: toFunctionSelector('function getReserves()') }, 'latest']);
    const quote = BigInt('0x' + reserves.slice(2, 66));
    const token = BigInt('0x' + reserves.slice(66, 130));
    const [impactCap, feeBps, creatorBps, phantom, realQuote, launchedAt, gradThresh] = await Promise.all([
      callUint(curve, 'function maxInternalPriceImpactBps()'),
      callUint(curve, 'function feeBps()'),
      callUint(curve, 'function creatorTaxBps()'),
      callUint(curve, 'function phantomQuote()'),
      callUint(curve, 'function realQuoteReserve()'),
      callUint(curve, 'function launchedAt()'),
      callUint(curve, 'function graduationThreshold()'),
    ]);
    const mcap = mcapFromReserves({ quote, token });
    const impact = priceImpactBps({ quote, token }, 70_000_000_000_000_000n, Number(feeBps), Number(creatorBps), 0n);
    console.log('[§8c]', {
      maxInternalPriceImpactBps: Number(impactCap),
      feeBps: Number(feeBps),
      creatorTaxBps: Number(creatorBps),
      phantom: phantom.toString(),
      realQuote: realQuote.toString(),
      launchedAt: Number(launchedAt),
      graduationThresholdEth: Number(gradThresh) / 1e18,
      mcapEth: mcap,
      buy0_07ImpactBps: impact,
    });
    expect(feeBps).toBe(100n);
    expect(gradThresh).toBe(4_200_000_000_000_000_000n);

    // a 1 ETH buy (impact >> 3 %) is NOT rejected by maxInternalPriceImpactBps on external buys
    const buySel = toFunctionSelector('function buy(uint256,uint256,address)');
    const recipient = '0x1111111111111111111111111111111111111111';
    const big = 10n ** 18n;
    const arg = encodeAbiParameters(parseAbiParameters('uint256,uint256,address'), [big, 0n, recipient]).slice(2);
    const r = await rpcRaw<string>('eth_call', [
      { to: curve, from: recipient, value: hex(big), data: buySel + arg },
      'latest',
      { [recipient]: { balance: hex(5n * 10n ** 18n) } },
    ]);
    console.log('[§8c] 1 ETH buy =', r.error ? `REVERT ${decodeErr(r.error.data)}` : `tokensOut ${BigInt(r.result!)}`);
    expect(r.error, 'external large buy should not be impact-capped').toBeUndefined();
  }, 120_000);

  it('(d) multicall3 is deployed at the canonical address', async () => {
    const code = await rpc<string>('eth_getCode', [MULTICALL3, 'latest']);
    const len = (code.length - 2) / 2;
    console.log('[§8d] multicall3 codeLen =', len);
    expect(len).toBeGreaterThan(0);
  }, 60_000);
});
