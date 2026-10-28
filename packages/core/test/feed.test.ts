import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  keccak256,
  parseTransaction,
  recoverAddress,
  serializeTransaction,
  type Hex,
  type TransactionSerializable,
} from 'viem';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeFeedFrame,
  decodeL2Message,
  decodedTxFromRpc,
  feedDecodeCounters,
  resetFeedDecodeCounters,
  type DecodedTx,
  type FeedBlock,
} from '../src/feed/decoder.js';

const fixture = fileURLToPath(new URL('./fixtures/feed-frames.jsonl', import.meta.url));
const lines = readFileSync(fixture, 'utf8').trim().split('\n');
const frames = lines.map((l) => JSON.parse(l) as { receivedAt: number; frame: unknown });
const texts = frames.map((f) => JSON.stringify(f.frame));

describe('decodeFeedFrame on captured Robinhood Chain frames', () => {
  let blocks: FeedBlock[] = [];
  let perFrameMs = 0;

  beforeAll(() => {
    resetFeedDecodeCounters();
    // warm-up (first parseTransaction call loads code paths)
    for (let i = 0; i < 3; i++) frames.forEach((f, j) => decodeFeedFrame(texts[j]!, f.receivedAt));
    resetFeedDecodeCounters();
    const t0 = performance.now();
    blocks = frames.flatMap((f, j) => decodeFeedFrame(texts[j]!, f.receivedAt));
    perFrameMs = (performance.now() - t0) / frames.length;
    const t1 = performance.now();
    for (const b of blocks) for (const t of b.txs) void t.hash;
    const hashMs = (performance.now() - t1) / feedDecodeCounters.txs;
    // eslint-disable-next-line no-console
    console.log(
      `[feed] ${frames.length} frames, ${blocks.length} blocks, ${feedDecodeCounters.txs} txs, ` +
        `decode ${perFrameMs.toFixed(3)} ms/frame (JSON.parse + base64 + RLP locate), ` +
        `${((perFrameMs * frames.length) / feedDecodeCounters.txs * 1000).toFixed(1)} µs/tx; lazy hash ${(hashMs * 1000).toFixed(1)} µs/tx`,
    );
  });

  it('decodes every frame (39 blocks + 1 confirmedSequenceNumber frame) without errors', () => {
    expect(feedDecodeCounters.frames).toBe(40);
    expect(blocks.length).toBe(39);
    expect(feedDecodeCounters.parseErrors).toBe(0);
    expect(feedDecodeCounters.nonL2Headers).toBe(0);
  });

  it('block numbers are consecutive and timestamps monotonic', () => {
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i]!.block).toBe(blocks[i - 1]!.block + 1);
      expect(blocks[i]!.timestamp).toBeGreaterThanOrEqual(blocks[i - 1]!.timestamp);
    }
    expect(blocks[0]!.block).toBe(100307474);
    expect(blocks[0]!.timestamp).toBe(1793214820);
    expect(blocks.at(-1)!.timestamp).toBe(1793214824);
  });

  it('every block has txs with hashes, lower-case to and selectors', () => {
    for (const b of blocks) {
      expect(b.txs.length).toBeGreaterThan(0);
      expect(b.blockHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(b.receivedAt).toBeGreaterThan(1.79e12);
      b.txs.forEach((tx, i) => {
        expect(tx.index).toBe(i);
        expect(tx.hash).toMatch(/^0x[0-9a-f]{64}$/);
        if (tx.to) expect(tx.to).toBe(tx.to.toLowerCase());
      });
    }
    const all = blocks.flatMap((b) => b.txs);
    expect(all.some((t) => t.to !== null && /^0x[0-9a-f]{40}$/.test(t.to))).toBe(true);
    const withSel = all.filter((t) => t.selector !== null);
    expect(withSel.length).toBeGreaterThan(all.length / 2);
    for (const t of withSel) {
      expect(t.selector).toMatch(/^0x[0-9a-f]{8}$/);
      expect(t.input.startsWith(t.selector!)).toBe(true);
    }
    // the feed carries both batch (kind 3) and single signed-tx (kind 4) messages, incl. legacy txs
    expect(all.some((t) => t.type === 'legacy')).toBe(true);
    expect(all.some((t) => t.type === 'eip1559' && t.chainId === 4663)).toBe(true);
  });

  it('lazy RLP fields equal viem parseTransaction for every fixture tx', () => {
    for (const tx of blocks.flatMap((b) => b.txs)) {
      const p = parseTransaction(tx.raw) as TransactionSerializable & { data?: Hex };
      expect(tx.type).toBe(p.type);
      expect(tx.to).toBe(p.to ? p.to.toLowerCase() : null);
      expect(tx.value).toBe(p.value ?? 0n);
      expect(tx.nonce).toBe(p.nonce ?? 0);
      expect(tx.gas).toBe(p.gas);
      expect(tx.input).toBe((p.data ?? '0x').toLowerCase());
      expect(tx.chainId).toBe(p.chainId);
      // viem drops zero-valued fee fields; we report 0n
      expect(tx.maxFeePerGas ?? 0n).toBe(p.maxFeePerGas ?? 0n);
      expect(tx.maxPriorityFeePerGas ?? 0n).toBe(p.maxPriorityFeePerGas ?? 0n);
      expect(tx.gasPrice ?? 0n).toBe(p.gasPrice ?? 0n);
    }
  });

  it('hash = keccak(raw) and raw round-trips through viem serialize', () => {
    const sample = blocks.flatMap((b) => b.txs).filter((_, i) => i % 37 === 0);
    for (const tx of sample) {
      expect(tx.hash).toBe(keccak256(tx.raw));
      const parsed = parseTransaction(tx.raw);
      const { r, s, v, yParity, ...unsigned } = parsed as TransactionSerializable & {
        r: Hex;
        s: Hex;
        v?: bigint;
        yParity?: number;
      };
      const reserialized = serializeTransaction(unsigned as TransactionSerializable, {
        r,
        s,
        ...(yParity !== undefined ? { yParity } : {}),
        ...(v !== undefined ? { v } : {}),
      });
      expect(reserialized).toBe(tx.raw);
    }
  });

  it('lazily recovered sender matches an independent viem recovery of the same raw tx', async () => {
    const txs = blocks.flatMap((b) => b.txs);
    const pick: DecodedTx[] = [txs[0]!, txs.find((t) => t.type === 'legacy')!];
    for (const tx of pick) {
      expect(tx.from).toBeUndefined();
      const from = await tx.recoverFrom();
      expect(tx.from).toBe(from);
      expect(from).toBe(from.toLowerCase());
      const parsed = parseTransaction(tx.raw) as TransactionSerializable & {
        r: Hex;
        s: Hex;
        v?: bigint;
        yParity?: number;
      };
      const { r, s, v, yParity, ...unsigned } = parsed;
      const signingHash = keccak256(serializeTransaction(unsigned as TransactionSerializable));
      const recovered = await recoverAddress({
        hash: signingHash,
        signature: { r, s, ...(yParity !== undefined ? { yParity } : { v: v! }) },
      });
      expect(from).toBe(recovered.toLowerCase());
      expect(await tx.recoverFrom()).toBe(from); // cached
    }
  });

  it('ignores confirmedSequenceNumber frames and counts skipped kinds', () => {
    resetFeedDecodeCounters();
    expect(decodeFeedFrame('{"version":1,"confirmedSequenceNumberMessage":{"sequenceNumber":1}}', 1)).toEqual([]);
    // batch with: heartbeat(6), compressed(7), unsigned(0) and one real signed tx
    const real = blocks[0]!.txs[0]!.raw;
    const rawBytes = Buffer.from(real.slice(2), 'hex');
    const seg = (b: Buffer): Buffer => {
      const len = Buffer.alloc(8);
      len.writeBigUInt64BE(BigInt(b.length));
      return Buffer.concat([len, b]);
    };
    const msg = Buffer.concat([
      Buffer.from([3]),
      seg(Buffer.from([6])),
      seg(Buffer.from([7, 1, 2, 3])),
      seg(Buffer.from([0, 9, 9])),
      seg(Buffer.concat([Buffer.from([4]), rawBytes])),
      seg(Buffer.concat([Buffer.from([3]), seg(Buffer.concat([Buffer.from([4]), rawBytes]))])), // nested batch
    ]);
    const out: DecodedTx[] = [];
    decodeL2Message(msg, out);
    expect(out.length).toBe(2);
    expect(out[0]!.hash).toBe(blocks[0]!.txs[0]!.hash);
    expect(feedDecodeCounters.skippedKinds).toEqual({ 0: 1, 6: 1, 7: 1 });
    // garbage signed tx is counted, not thrown
    decodeL2Message(Buffer.from([4, 1, 2, 3]), out);
    expect(feedDecodeCounters.parseErrors).toBe(1);
  });

  it('builds DecodedTx from RPC data with a known sender', async () => {
    const fx = JSON.parse(
      readFileSync(fileURLToPath(new URL('./fixtures/launch-tx.json', import.meta.url)), 'utf8'),
    ) as { tx: Parameters<typeof decodedTxFromRpc>[0] };
    const tx = decodedTxFromRpc(fx.tx);
    expect(tx.selector).toBe('0xf35abbcf');
    expect(tx.to).toBe('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
    expect(tx.value).toBe(500_000_000_000_000n);
    expect(await tx.recoverFrom()).toBe('0x81eb508048220493549302d8ea5ef73a3fde1784');
  });
});
