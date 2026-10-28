/** Block-range helpers for eth_getLogs backfill (pure). */
export interface BlockRange {
  from: number;
  to: number;
}

/** Split [from, to] (inclusive) into consecutive ranges of at most `size` blocks. */
export function chunkRanges(from: number, to: number, size = 20_000): BlockRange[] {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) {
    throw new Error(`invalid range ${from}..${to}`);
  }
  if (!Number.isInteger(size) || size < 1) throw new Error(`invalid chunk size ${size}`);
  const out: BlockRange[] = [];
  for (let a = from; a <= to; a += size) out.push({ from: a, to: Math.min(to, a + size - 1) });
  return out;
}

/** Halve a range (used when the node rejects a getLogs request as too large). */
export function splitRange(r: BlockRange): [BlockRange, BlockRange] | null {
  if (r.to <= r.from) return null;
  const mid = r.from + Math.floor((r.to - r.from) / 2);
  return [
    { from: r.from, to: mid },
    { from: mid + 1, to: r.to },
  ];
}

/** Split a list into chunks of `size` (e.g. address lists for eth_getLogs). */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
