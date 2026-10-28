/**
 * Arbitrum Nitro sequencer-feed decoder (Robinhood Chain).
 *
 * One websocket text frame carries `{version, messages: [...]}`; every message is one L2
 * block (`sequenceNumber` == L2 block number on Robinhood Chain). `message.message.l2Msg`
 * is base64; its first byte is the L2 message kind (nitro `arbos/parse_l2.go`):
 *   0 UnsignedUserTx, 1 ContractTx, 2 NonmutatingCall, 3 Batch, 4 SignedTx,
 *   6 Heartbeat (deprecated), 7 SignedCompressedTx.
 * A batch (3) is a sequence of `[uint64 BE length][sub-message]` (sub-messages carry their
 * own kind byte; nesting depth ≤ 16). A signed tx (4) is a standard (typed or legacy)
 * signed Ethereum transaction. Everything except 3/4 is skipped and counted.
 *
 * Hot-path notes: txs are located with a minimal RLP walker; only `to`, `selector`, `value`,
 * `nonce`, `type` and `chainId` are extracted eagerly. `hash` (keccak256 of the serialized tx,
 * ~50 µs in JS), `input`, `raw` and gas fields are lazy getters, and the sender is recovered
 * only on `recoverFrom()` (secp256k1, ~1 ms). Callers filter on `to`/`selector` first.
 */
import { keccak256, recoverTransactionAddress, type Address, type Hex } from 'viem';

export type FeedTxType = 'legacy' | 'eip2930' | 'eip1559' | 'eip4844' | 'eip7702';

/** A user transaction decoded from the feed (or built from RPC data with a known sender). */
export interface DecodedTx {
  /** Position among the user txs of the block (ArbOS internal txs are not in the feed). */
  readonly index: number;
  readonly hash: Hex;
  readonly type: FeedTxType;
  readonly chainId: number | undefined;
  /** Lower-case recipient, `null` for contract creation. */
  readonly to: Address | null;
  readonly value: bigint;
  readonly nonce: number;
  readonly gas: bigint;
  readonly gasPrice: bigint | undefined;
  readonly maxFeePerGas: bigint | undefined;
  readonly maxPriorityFeePerGas: bigint | undefined;
  readonly input: Hex;
  /** Lower-case 4-byte selector (`0x12345678`) or `null` when input is shorter than 4 bytes. */
  readonly selector: Hex | null;
  /** Serialized signed transaction (what `eth_sendRawTransaction` would take). */
  readonly raw: Hex;
  /** Sender once known (after `recoverFrom()` resolved, or when built from RPC data). */
  readonly from: Address | undefined;
  /** Recovers the sender (secp256k1, ~1 ms) once and caches it. Lower-case. */
  recoverFrom(): Promise<Address>;
}

export interface FeedBlock {
  /** L2 block number (== feed sequenceNumber). */
  block: number;
  /** Block timestamp, whole seconds (the value the Pons snipe tax uses). */
  timestamp: number;
  txs: DecodedTx[];
  /** Local wall-clock ms when the frame arrived (see `nowMs()` in clock.ts). */
  receivedAt: number;
  /** Block hash as announced by the feed (present on Robinhood Chain feed v1 frames). */
  blockHash?: Hex | undefined;
  /** L1 message header kind (3 = L2 message; others are delayed-inbox messages). */
  headerKind: number;
}

/** Running counters of everything the decoder skipped or failed on. */
export interface FeedDecodeCounters {
  frames: number;
  blocks: number;
  txs: number;
  /** Count per skipped L2 message kind (0/1/2/6/7/unknown). */
  skippedKinds: Record<number, number>;
  /** L1 header kinds other than 3 (deposits, retryables, batch-posting reports…). */
  nonL2Headers: number;
  parseErrors: number;
  /** messages with an invalid shape (null, bad sequence number, missing timestamp, non-string l2Msg) */
  malformed: number;
  lastError?: string;
}

export const feedDecodeCounters: FeedDecodeCounters = {
  frames: 0,
  blocks: 0,
  txs: 0,
  skippedKinds: {},
  nonL2Headers: 0,
  parseErrors: 0,
  malformed: 0,
};

export function resetFeedDecodeCounters(): void {
  feedDecodeCounters.frames = 0;
  feedDecodeCounters.blocks = 0;
  feedDecodeCounters.txs = 0;
  feedDecodeCounters.skippedKinds = {};
  feedDecodeCounters.nonL2Headers = 0;
  feedDecodeCounters.parseErrors = 0;
  feedDecodeCounters.malformed = 0;
  delete feedDecodeCounters.lastError;
}

export const L2_MESSAGE_KIND = {
  UnsignedUserTx: 0,
  ContractTx: 1,
  NonmutatingCall: 2,
  Batch: 3,
  SignedTx: 4,
  Heartbeat: 6,
  SignedCompressedTx: 7,
} as const;

const L1_MESSAGE_TYPE_L2_MESSAGE = 3;
type SerializedTx = Parameters<typeof recoverTransactionAddress>[0]['serializedTransaction'];
const MAX_BATCH_DEPTH = 16;

/** Minimal RLP item locator (no allocation). Returns [payloadStart, payloadEnd, isList, next]. */
function rlpItem(b: Uint8Array, pos: number, limit: number): [number, number, boolean, number] {
  if (pos >= limit) throw new Error('rlp: out of bounds');
  const p = b[pos]!;
  let start: number;
  let len: number;
  let list = false;
  if (p < 0x80) return [pos, pos + 1, false, pos + 1];
  if (p <= 0xb7) {
    start = pos + 1;
    len = p - 0x80;
  } else if (p <= 0xbf) {
    const ll = p - 0xb7;
    len = 0;
    for (let i = 0; i < ll; i++) len = len * 256 + b[pos + 1 + i]!;
    start = pos + 1 + ll;
  } else if (p <= 0xf7) {
    list = true;
    start = pos + 1;
    len = p - 0xc0;
  } else {
    list = true;
    const ll = p - 0xf7;
    len = 0;
    for (let i = 0; i < ll; i++) len = len * 256 + b[pos + 1 + i]!;
    start = pos + 1 + ll;
  }
  const end = start + len;
  if (end > limit) throw new Error('rlp: item overruns parent');
  return [start, end, list, end];
}

const TYPE_BY_BYTE: Record<number, FeedTxType> = { 1: 'eip2930', 2: 'eip1559', 3: 'eip4844', 4: 'eip7702' };
// field indexes: [chainId, nonce, gasPrice|maxPrio, maxFee, gas, to, value, data]  (-1 = absent)
const LAYOUT: Record<FeedTxType, { chainId: number; nonce: number; gasPrice: number; maxPrio: number; maxFee: number; gas: number; to: number; value: number; data: number; v: number }> = {
  legacy: { chainId: -1, nonce: 0, gasPrice: 1, maxPrio: -1, maxFee: -1, gas: 2, to: 3, value: 4, data: 5, v: 6 },
  eip2930: { chainId: 0, nonce: 1, gasPrice: 2, maxPrio: -1, maxFee: -1, gas: 3, to: 4, value: 5, data: 6, v: -1 },
  eip1559: { chainId: 0, nonce: 1, gasPrice: -1, maxPrio: 2, maxFee: 3, gas: 4, to: 5, value: 6, data: 7, v: -1 },
  eip4844: { chainId: 0, nonce: 1, gasPrice: -1, maxPrio: 2, maxFee: 3, gas: 4, to: 5, value: 6, data: 7, v: -1 },
  eip7702: { chainId: 0, nonce: 1, gasPrice: -1, maxPrio: 2, maxFee: 3, gas: 4, to: 5, value: 6, data: 7, v: -1 },
};

const hexOf = (b: Uint8Array, start: number, end: number): Hex =>
  `0x${Buffer.from(b.buffer, b.byteOffset + start, end - start).toString('hex')}` as Hex;

function uintOf(b: Uint8Array, start: number, end: number): bigint {
  if (end - start <= 6) {
    let n = 0;
    for (let i = start; i < end; i++) n = n * 256 + b[i]!;
    return BigInt(n);
  }
  return BigInt(hexOf(b, start, end));
}

function numOf(b: Uint8Array, start: number, end: number): number {
  let n = 0;
  for (let i = start; i < end; i++) n = n * 256 + b[i]!;
  return n;
}

/**
 * Feed transaction backed by its raw bytes. `to`, `selector`, `value`, `nonce`, `type` and
 * `chainId` are extracted eagerly (a few µs); `hash` (keccak, ~50 µs in JS), `input`, `raw`
 * and the gas fields are computed on first access and cached.
 */
class FeedTx implements DecodedTx {
  readonly type: FeedTxType;
  readonly to: Address | null;
  readonly selector: Hex | null;
  readonly value: bigint;
  readonly nonce: number;
  readonly chainId: number | undefined;
  private readonly f: Int32Array; // [start,end] per field
  private fromCache: Address | undefined;
  private fromPromise: Promise<Address> | undefined;
  private hashCache: Hex | undefined;
  private inputCache: Hex | undefined;
  private rawCache: Hex | undefined;

  constructor(
    readonly index: number,
    private readonly bytes: Uint8Array,
  ) {
    let listPos = 0;
    if (bytes.length === 0) throw new Error('empty tx');
    if (bytes[0]! >= 0xc0) this.type = 'legacy';
    else {
      const t = TYPE_BY_BYTE[bytes[0]!];
      if (!t) throw new Error(`unsupported tx type 0x${bytes[0]!.toString(16)}`);
      this.type = t;
      listPos = 1;
    }
    const [ls, le, isList] = rlpItem(bytes, listPos, bytes.length);
    if (!isList) throw new Error('tx is not an RLP list');
    const f = new Int32Array(32);
    let pos = ls;
    let n = 0;
    while (pos < le && n < 16) {
      const [s, e, , next] = rlpItem(bytes, pos, le);
      f[2 * n] = s;
      f[2 * n + 1] = e;
      n++;
      pos = next;
    }
    const L = LAYOUT[this.type];
    if (n <= Math.max(L.data, L.v)) throw new Error('tx has too few fields');
    this.f = f;
    const toS = f[2 * L.to]!;
    const toE = f[2 * L.to + 1]!;
    this.to = toE - toS === 20 ? hexOf(bytes, toS, toE) : toE === toS ? null : (() => { throw new Error('bad to'); })();
    const dS = f[2 * L.data]!;
    const dE = f[2 * L.data + 1]!;
    this.selector = dE - dS >= 4 ? hexOf(bytes, dS, dS + 4) : null;
    this.value = uintOf(bytes, f[2 * L.value]!, f[2 * L.value + 1]!);
    this.nonce = numOf(bytes, f[2 * L.nonce]!, f[2 * L.nonce + 1]!);
    if (L.chainId >= 0) this.chainId = numOf(bytes, f[2 * L.chainId]!, f[2 * L.chainId + 1]!);
    else {
      const v = numOf(bytes, f[2 * L.v]!, f[2 * L.v + 1]!);
      this.chainId = v >= 35 ? Math.floor((v - 35) / 2) : undefined;
    }
  }

  private field(i: number): bigint | undefined {
    return i < 0 ? undefined : uintOf(this.bytes, this.f[2 * i]!, this.f[2 * i + 1]!);
  }

  get hash(): Hex {
    return (this.hashCache ??= keccak256(this.bytes));
  }

  get raw(): Hex {
    return (this.rawCache ??= hexOf(this.bytes, 0, this.bytes.length));
  }

  get input(): Hex {
    const L = LAYOUT[this.type];
    return (this.inputCache ??= hexOf(this.bytes, this.f[2 * L.data]!, this.f[2 * L.data + 1]!));
  }

  get gas(): bigint {
    return this.field(LAYOUT[this.type].gas)!;
  }

  get gasPrice(): bigint | undefined {
    return this.field(LAYOUT[this.type].gasPrice);
  }

  get maxFeePerGas(): bigint | undefined {
    return this.field(LAYOUT[this.type].maxFee);
  }

  get maxPriorityFeePerGas(): bigint | undefined {
    return this.field(LAYOUT[this.type].maxPrio);
  }

  get from(): Address | undefined {
    return this.fromCache;
  }

  recoverFrom(): Promise<Address> {
    if (this.fromCache) return Promise.resolve(this.fromCache);
    this.fromPromise ??= recoverTransactionAddress({
      serializedTransaction: this.raw as SerializedTx,
    }).then((a) => {
      const lower = a.toLowerCase() as Address;
      this.fromCache = lower;
      return lower;
    });
    return this.fromPromise;
  }

  toJSON(): Record<string, unknown> {
    return {
      index: this.index,
      hash: this.hash,
      type: this.type,
      from: this.fromCache,
      to: this.to,
      value: this.value.toString(),
      nonce: this.nonce,
      selector: this.selector,
    };
  }
}

/** Transaction with eagerly known fields and sender (RPC data, tests). */
class KnownTx implements DecodedTx {
  private fromCache: Address | undefined;
  constructor(
    readonly index: number,
    readonly hash: Hex,
    readonly type: FeedTxType,
    readonly chainId: number | undefined,
    readonly to: Address | null,
    readonly value: bigint,
    readonly nonce: number,
    readonly gas: bigint,
    readonly gasPrice: bigint | undefined,
    readonly maxFeePerGas: bigint | undefined,
    readonly maxPriorityFeePerGas: bigint | undefined,
    readonly input: Hex,
    readonly selector: Hex | null,
    readonly raw: Hex,
    knownFrom: Address,
  ) {
    this.fromCache = knownFrom.toLowerCase() as Address;
  }

  get from(): Address | undefined {
    return this.fromCache;
  }

  recoverFrom(): Promise<Address> {
    return Promise.resolve(this.fromCache!);
  }
}

function selectorOf(input: Hex): Hex | null {
  return input.length >= 10 ? (input.slice(0, 10).toLowerCase() as Hex) : null;
}

/** Decode one serialized signed tx (bytes after the L2 kind byte). Throws on malformed input. */
export function decodeSignedTx(raw: Hex | Uint8Array, index: number): DecodedTx {
  const bytes = typeof raw === 'string' ? Buffer.from(raw.slice(2), 'hex') : raw;
  return new FeedTx(index, bytes);
}

/** Fields of an RPC transaction object (eth_getTransactionByHash / block with txs). */
export interface RpcTxLike {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint | Hex | string | number;
  nonce: number | Hex | string;
  gas?: bigint | Hex | string | number;
  type?: Hex | string;
  chainId?: Hex | string | number;
  maxFeePerGas?: bigint | Hex | string;
  maxPriorityFeePerGas?: bigint | Hex | string;
  gasPrice?: bigint | Hex | string;
  transactionIndex?: number | Hex | string | null;
}

const big = (v: bigint | Hex | string | number | undefined): bigint | undefined =>
  v === undefined || v === null ? undefined : typeof v === 'bigint' ? v : BigInt(v);

/**
 * Build a `DecodedTx` from RPC data with a known sender (used for the TokenLaunched fallback
 * path and in tests). `raw` is empty (`0x`) because the signature is not needed.
 */
export function decodedTxFromRpc(tx: RpcTxLike): DecodedTx {
  const typeHex = typeof tx.type === 'string' ? tx.type : '0x2';
  const type: FeedTxType =
    typeHex === '0x0' || typeHex === 'legacy'
      ? 'legacy'
      : typeHex === '0x1' || typeHex === 'eip2930'
        ? 'eip2930'
        : typeHex === '0x3' || typeHex === 'eip4844'
          ? 'eip4844'
          : typeHex === '0x4' || typeHex === 'eip7702'
            ? 'eip7702'
            : 'eip1559';
  const input = (tx.input ?? '0x').toLowerCase() as Hex;
  const idx = tx.transactionIndex == null ? 0 : Number(tx.transactionIndex);
  return new KnownTx(
    idx,
    tx.hash.toLowerCase() as Hex,
    type,
    tx.chainId === undefined ? undefined : Number(tx.chainId),
    tx.to ? (tx.to.toLowerCase() as Address) : null,
    big(tx.value) ?? 0n,
    Number(tx.nonce),
    big(tx.gas) ?? 0n,
    big(tx.gasPrice),
    big(tx.maxFeePerGas),
    big(tx.maxPriorityFeePerGas),
    input,
    selectorOf(input),
    '0x',
    tx.from,
  );
}

function bump(kind: number): void {
  feedDecodeCounters.skippedKinds[kind] = (feedDecodeCounters.skippedKinds[kind] ?? 0) + 1;
}

/** Walk an L2 message, appending decoded txs. Exported for tests. */
export function decodeL2Message(msg: Uint8Array, out: DecodedTx[], depth = 0): void {
  if (msg.length === 0) return;
  const kind = msg[0]!;
  if (kind === L2_MESSAGE_KIND.SignedTx) {
    try {
      out.push(new FeedTx(out.length, msg.subarray(1)));
      feedDecodeCounters.txs++;
    } catch (e) {
      feedDecodeCounters.parseErrors++;
      feedDecodeCounters.lastError = (e as Error).message.split('\n')[0];
    }
    return;
  }
  if (kind === L2_MESSAGE_KIND.Batch) {
    if (depth >= MAX_BATCH_DEPTH) {
      feedDecodeCounters.parseErrors++;
      feedDecodeCounters.lastError = 'batch depth exceeded';
      return;
    }
    const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
    let off = 1;
    while (off + 8 <= msg.length) {
      const len = Number(view.getBigUint64(off, false));
      off += 8;
      if (len > msg.length - off) {
        feedDecodeCounters.parseErrors++;
        feedDecodeCounters.lastError = 'batch segment overruns message';
        return;
      }
      decodeL2Message(msg.subarray(off, off + len), out, depth + 1);
      off += len;
    }
    return;
  }
  // 0 unsigned user tx / 1 contract tx / 2 non-mutating call / 6 heartbeat / 7 compressed: skip.
  bump(kind);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sequence number of a feed message, or undefined when the message is malformed. */
function seqOf(m: unknown): number | undefined {
  if (!isObj(m)) return undefined;
  const n = m.sequenceNumber;
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** Lowest/highest valid sequence number in a frame without decoding txs (dedupe, jump checks). */
export function peekFrameRange(frame: unknown): { min: number; max: number } | undefined {
  const msgs = isObj(frame) ? frame.messages : undefined;
  if (!Array.isArray(msgs)) return undefined;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const m of msgs) {
    const n = seqOf(m);
    if (n === undefined) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  return Number.isFinite(min) ? { min, max } : undefined;
}

/** Cheap peek at the highest sequence number in a frame without decoding txs (for dedupe). */
export function peekFrameSequence(frame: unknown): number | undefined {
  return peekFrameRange(frame)?.max;
}

/**
 * Decode an already JSON-parsed frame. `minBlockExclusive` skips blocks ≤ it (dedupe).
 * Never throws: malformed messages (null, wrong types, missing timestamp, non-string l2Msg)
 * are skipped and counted in `feedDecodeCounters.malformed`.
 */
export function decodeParsedFrame(
  frame: unknown,
  receivedAt: number,
  minBlockExclusive = -1,
): FeedBlock[] {
  feedDecodeCounters.frames++;
  const msgs = isObj(frame) ? frame.messages : undefined;
  if (!Array.isArray(msgs)) return []; // e.g. confirmedSequenceNumberMessage
  const blocks: FeedBlock[] = [];
  for (const m of msgs) {
    const seq = seqOf(m);
    if (seq === undefined) {
      feedDecodeCounters.malformed++;
      continue;
    }
    if (seq <= minBlockExclusive) continue;
    const outer = (m as Record<string, unknown>).message;
    const inner = isObj(outer) && isObj(outer.message) ? outer.message : undefined;
    const header = inner && isObj(inner.header) ? inner.header : undefined;
    const ts = header?.timestamp;
    if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts <= 0) {
      feedDecodeCounters.malformed++;
      continue;
    }
    const headerKind = typeof header?.kind === 'number' ? header.kind : -1;
    const txs: DecodedTx[] = [];
    const l2Msg = inner?.l2Msg;
    if (headerKind === L1_MESSAGE_TYPE_L2_MESSAGE && typeof l2Msg === 'string') {
      try {
        decodeL2Message(Buffer.from(l2Msg, 'base64'), txs);
      } catch (e) {
        feedDecodeCounters.parseErrors++;
        feedDecodeCounters.lastError = (e as Error).message.split('\n')[0];
      }
    } else if (headerKind === L1_MESSAGE_TYPE_L2_MESSAGE) {
      feedDecodeCounters.malformed++;
    } else {
      feedDecodeCounters.nonL2Headers++;
    }
    feedDecodeCounters.blocks++;
    const bh = (m as Record<string, unknown>).blockHash;
    blocks.push({
      block: seq,
      timestamp: ts,
      txs,
      receivedAt,
      blockHash: typeof bh === 'string' && /^0x[0-9a-fA-F]{64}$/.test(bh) ? (bh.toLowerCase() as Hex) : undefined,
      headerKind,
    });
  }
  return blocks;
}

/**
 * Decode one websocket text frame into L2 blocks.
 * Frames without `messages` (e.g. `confirmedSequenceNumberMessage`) yield `[]`.
 * Malformed JSON throws; malformed txs are skipped and counted in `feedDecodeCounters`.
 */
export function decodeFeedFrame(text: string, receivedAt: number): FeedBlock[] {
  return decodeParsedFrame(JSON.parse(text) as unknown, receivedAt);
}
