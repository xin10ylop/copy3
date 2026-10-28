/** Synthetic RPC logs for tests (manual ABI encoding of the Pons events). */
import { PONS_TOPICS } from '../../src/pons.js';
import type { Address, Hex, RpcLog } from '../../src/types.js';

export const word = (v: bigint | number): string => BigInt(v).toString(16).padStart(64, '0');
export const topicOf = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`;
export const hx = (n: number): Hex => `0x${n.toString(16)}`;

interface Pos {
  block: number;
  tx: Hex;
  logIndex: number;
}

const base = (address: string, p: Pos) => ({
  address: address.toLowerCase() as Address,
  blockNumber: hx(p.block),
  blockHash: `0x${word(p.block)}` as Hex,
  transactionHash: p.tx,
  transactionIndex: '0x0' as Hex,
  logIndex: hx(p.logIndex),
  removed: false,
});

export function curveBuyLog(curve: string, p: Pos, a: { buyer: string; recipient: string; quoteIn: bigint; tokensOut: bigint; fee: bigint; tax: bigint }): RpcLog {
  return {
    ...base(curve, p),
    topics: [PONS_TOPICS.CurveBuy, topicOf(a.buyer), topicOf(a.recipient)],
    data: `0x${word(a.quoteIn)}${word(a.tokensOut)}${word(a.fee)}${word(a.tax)}`,
  };
}

export function curveSellLog(curve: string, p: Pos, a: { seller: string; recipient: string; tokensIn: bigint; quoteOut: bigint; fee: bigint; tax: bigint }): RpcLog {
  return {
    ...base(curve, p),
    topics: [PONS_TOPICS.CurveSell, topicOf(a.seller), topicOf(a.recipient)],
    data: `0x${word(a.tokensIn)}${word(a.quoteOut)}${word(a.fee)}${word(a.tax)}`,
  };
}

export function snipeTaxLog(curve: string, p: Pos, recipient: string, amount: bigint): RpcLog {
  return { ...base(curve, p), topics: [PONS_TOPICS.SnipeTaxCharged, topicOf(recipient)], data: `0x${word(amount)}` };
}

export function exemptedLog(curve: string, p: Pos, account: string): RpcLog {
  return { ...base(curve, p), topics: [PONS_TOPICS.SnipeTaxExempted, topicOf(account)], data: '0x' };
}

export function transferLog(token: string, p: Pos, from: string, to: string, value: bigint): RpcLog {
  return { ...base(token, p), topics: [PONS_TOPICS.Erc20Transfer, topicOf(from), topicOf(to)], data: `0x${word(value)}` };
}

export function tokenLaunchedLog(
  factory: string,
  p: Pos,
  a: { token: string; curve: string; deployer: string; graduationThreshold?: bigint },
): RpcLog {
  return {
    ...base(factory, p),
    topics: [PONS_TOPICS.TokenLaunched, topicOf(a.token), topicOf(a.curve), topicOf(a.deployer)],
    data: `0x${word(0)}${word(0)}${word(a.graduationThreshold ?? 4_200_000_000_000_000_000n)}`,
  };
}
