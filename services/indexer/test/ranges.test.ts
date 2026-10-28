import { describe, expect, it } from 'vitest';
import { getLogsSplitting } from '../src/backfill-core.js';
import { parseBackfillArgs } from '../src/backfill-args.js';
import { chunkList, chunkRanges, splitRange } from '../src/ranges.js';
import { RpcError } from '../src/rpc.js';
import type { LogFilter } from '../src/chain.js';
import type { RpcLog } from '../src/types.js';

describe('chunkRanges', () => {
  it('splits into <= 20k-block inclusive ranges', () => {
    expect(chunkRanges(100, 45_099)).toEqual([
      { from: 100, to: 20_099 },
      { from: 20_100, to: 40_099 },
      { from: 40_100, to: 45_099 },
    ]);
    expect(chunkRanges(5, 5)).toEqual([{ from: 5, to: 5 }]);
    expect(chunkRanges(0, 39_999, 20_000)).toHaveLength(2);
  });

  it('covers every block exactly once', () => {
    const r = chunkRanges(7, 12_345, 1000);
    expect(r[0]!.from).toBe(7);
    expect(r.at(-1)!.to).toBe(12_345);
    for (let i = 1; i < r.length; i++) expect(r[i]!.from).toBe(r[i - 1]!.to + 1);
    expect(r.every((x) => x.to - x.from + 1 <= 1000)).toBe(true);
  });

  it('rejects bad input', () => {
    expect(() => chunkRanges(10, 5)).toThrow();
    expect(() => chunkRanges(0, 5, 0)).toThrow();
    expect(() => chunkRanges(-1, 5)).toThrow();
  });

  it('splits ranges and lists', () => {
    expect(splitRange({ from: 0, to: 9 })).toEqual([
      { from: 0, to: 4 },
      { from: 5, to: 9 },
    ]);
    expect(splitRange({ from: 3, to: 3 })).toBeNull();
    expect(chunkList([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('getLogsSplitting', () => {
  it('halves ranges the node rejects as too large', async () => {
    const calls: Array<[number, number]> = [];
    const chain = {
      async getLogs(f: LogFilter): Promise<RpcLog[]> {
        calls.push([f.fromBlock, f.toBlock]);
        if (f.toBlock - f.fromBlock + 1 > 250) throw new RpcError('query returned more than 10000 results', -32005, 'eth_getLogs');
        return [{ blockNumber: `0x${f.fromBlock.toString(16)}` } as RpcLog];
      },
    };
    const logs = await getLogsSplitting(chain, { from: 0, to: 999 }, { topics: [] });
    expect(logs).toHaveLength(4);
    expect(calls.filter(([a, b]) => b - a + 1 <= 250)).toEqual([
      [0, 249],
      [250, 499],
      [500, 749],
      [750, 999],
    ]);
  });

  it('rethrows non-RPC failures', async () => {
    const chain = { getLogs: async () => Promise.reject(new Error('socket hang up')) };
    await expect(getLogsSplitting(chain, { from: 0, to: 9 }, { topics: [] })).rejects.toThrow('socket hang up');
  });
});

describe('parseBackfillArgs', () => {
  it('parses --from/--to and defaults', () => {
    expect(parseBackfillArgs(['--from', '100', '--to', '200'])).toEqual({
      from: 100,
      to: 200,
      sinceDays: null,
      chunk: 20_000,
      mode: 'logs',
      tokenTransfers: true,
      tokenWindowHours: 24,
      addressBatch: 100,
      dryRun: false,
    });
  });

  it('parses --since-days, flags, and pnpm\'s "--" separator', () => {
    const a = parseBackfillArgs(['--', '--since-days', '3', '--mode', 'blocks', '--no-token-transfers', '--chunk', '5000', '--dry-run']);
    expect(a).toMatchObject({ from: null, to: 'latest', sinceDays: 3, mode: 'blocks', tokenTransfers: false, chunk: 5000, dryRun: true });
  });

  it('validates', () => {
    expect(() => parseBackfillArgs([])).toThrow(/--from or --since-days/);
    expect(() => parseBackfillArgs(['--from', '10', '--to', '5'])).toThrow();
    expect(() => parseBackfillArgs(['--from', '1', '--chunk', '20001'])).toThrow();
    expect(() => parseBackfillArgs(['--from', '1', '--since-days', '2'])).toThrow();
    expect(() => parseBackfillArgs(['--from', 'abc'])).toThrow();
  });
});
