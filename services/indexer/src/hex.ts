import type { Address } from './types.js';

export function hexToNum(h: string | null | undefined): number {
  if (!h) return 0;
  return Number.parseInt(h, 16);
}

export function hexToBig(h: string | null | undefined): bigint {
  if (!h || h === '0x') return 0n;
  return BigInt(h);
}

export function numToHex(n: number | bigint): `0x${string}` {
  return `0x${n.toString(16)}`;
}

export function lower<T extends string>(a: T): Address {
  return a.toLowerCase() as Address;
}

/** 1e18-scaled bigint -> float (ETH). */
export function weiToEth(wei: bigint): number {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  return Number(whole) + Number(frac) / 1e18;
}

/** ETH (decimal number) -> wei without float drift for normal inputs (e.g. 0.015). */
export function ethToWei(eth: number): bigint {
  if (!Number.isFinite(eth) || eth < 0) throw new Error(`invalid ETH amount ${eth}`);
  let s = eth.toString();
  if (s.includes('e') || s.includes('E')) s = eth.toFixed(18);
  const [w = '0', f = ''] = s.split('.');
  return BigInt(w) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
