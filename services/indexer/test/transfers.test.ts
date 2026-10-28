import { getContractAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  codeIsContract,
  extractTraceTransfers,
  extractTxTransfers,
  newWalletsFromTransfers,
  shouldTrace,
  sortTransfers,
} from '../src/transfers.js';
import type { Address, CallFrame, Hex, RpcBlock, RpcReceipt, RpcTransaction } from '../src/types.js';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const ETH = 10n ** 18n;
const hexv = (v: bigint) => `0x${v.toString(16)}` as Hex;


const FUNDER = a(0xf0);
const DISPERSE = a(0xd1);
const W1 = a(0x101);
const W2 = a(0x102);
const W3 = a(0x103);
/** CREATE address of FUNDER at nonce 5 (tx 4 below has no receipt) */
const CREATED = getContractAddress({ from: FUNDER, nonce: 5n }).toLowerCase();

describe('extractTraceTransfers (callTracer)', () => {
  // funder -> disperse contract (0.3 ETH) -> 3 wallets; plus edge cases
  const trace: CallFrame = {
    type: 'CALL',
    from: FUNDER,
    to: DISPERSE,
    value: hexv(3n * 10n ** 17n),
    calls: [
      { type: 'CALL', from: DISPERSE, to: W1, value: hexv(10n ** 17n) }, // 0
      { type: 'CALL', from: DISPERSE, to: W2, value: hexv(10n ** 17n) }, // 1
      {
        type: 'CALL', // 2: reverted sub-tree, nothing moves
        from: DISPERSE,
        to: a(0xbad),
        value: hexv(5n),
        error: 'execution reverted',
        calls: [{ type: 'CALL', from: a(0xbad), to: W3, value: hexv(5n) }],
      },
      { type: 'STATICCALL', from: DISPERSE, to: a(0x5), value: '0x0' }, // 3
      {
        type: 'DELEGATECALL', // 4: value field is the parent's msg.value, no transfer
        from: DISPERSE,
        to: a(0x6),
        value: hexv(3n * 10n ** 17n),
        calls: [{ type: 'CALL', from: DISPERSE, to: W3, value: hexv(10n ** 17n) }], // 4,0: real transfer
      },
      { type: 'CALL', from: DISPERSE, to: a(0x7), value: '0x0' }, // 5: zero value
      { type: 'CREATE', from: DISPERSE, to: a(0xc1), value: '0x0' }, // 6: creation w/o value: lineage row
      { type: 'CREATE2', from: DISPERSE, to: a(0xc2), value: hexv(7n) }, // 7
      { type: 'SELFDESTRUCT', from: a(0xc2), to: FUNDER, value: hexv(7n) }, // 8
    ],
  };
  const base = { block: 10, ts: 1000, txHash: h(1) };

  it('extracts CALL/CREATE value transfers with trace paths and skips reverted / delegate / static frames', () => {
    const rows = extractTraceTransfers(trace, base);
    expect(rows.map((r) => [r.traceAddr, r.kind, r.from, r.to, r.value])).toEqual([
      ['0', 'internal', DISPERSE, W1, 10n ** 17n],
      ['1', 'internal', DISPERSE, W2, 10n ** 17n],
      ['4,0', 'internal', DISPERSE, W3, 10n ** 17n],
      ['6', 'create', DISPERSE, a(0xc1), 0n],
      ['7', 'create', DISPERSE, a(0xc2), 7n],
      ['8', 'internal', a(0xc2), FUNDER, 7n],
    ]);
    expect(rows.every((r) => r.block === 10 && r.ts === 1000 && r.txHash === h(1))).toBe(true);
  });

  it('returns nothing for a reverted top-level frame', () => {
    expect(extractTraceTransfers({ ...trace, error: 'out of gas' }, base)).toEqual([]);
  });
});

describe('extractTxTransfers (top-level)', () => {
  const tx = (i: number, to: Address | null, value: bigint, from = FUNDER): RpcTransaction => ({
    hash: h(i),
    from,
    to,
    value: hexv(value),
    input: '0x',
    nonce: '0x5',
    blockNumber: '0x64',
    blockHash: h(0xb),
    transactionIndex: hexv(BigInt(i)),
  });
  const rc = (i: number, ok: boolean, contractAddress: Address | null = null): RpcReceipt => ({
    transactionHash: h(i),
    transactionIndex: hexv(BigInt(i)),
    blockNumber: '0x64',
    blockHash: h(0xb),
    from: FUNDER,
    to: null,
    contractAddress,
    status: ok ? '0x1' : '0x0',
    logs: [],
  });
  const block: RpcBlock = {
    number: '0x64',
    hash: h(0xb),
    parentHash: h(0xa),
    timestamp: '0x3e8',
    transactions: [
      tx(1, W1, ETH / 100n), // plain transfer
      tx(2, W2, ETH / 100n), // reverted
      tx(3, null, 0n), // creation without value (lineage)
      tx(4, null, ETH), // creation with value, no receipt: address from CREATE formula
      tx(5, DISPERSE, 0n), // zero-value call
    ],
  };
  const receipts = new Map([
    [h(1), rc(1, true)],
    [h(2), rc(2, false)],
    [h(3), rc(3, true, a(0xc3))],
    [h(5), rc(5, true)],
  ]);

  it('keeps successful value txs and all creations', () => {
    const rows = extractTxTransfers(block, receipts);
    expect(rows.map((r) => [r.txHash, r.kind, r.to, r.value, r.traceAddr])).toEqual([
      [h(1), 'tx', W1, ETH / 100n, ''],
      [h(3), 'create', a(0xc3), 0n, ''],
      [h(4), 'create', CREATED, ETH, ''],
    ]);
    expect(rows[0]).toMatchObject({ block: 100, ts: 1000, from: FUNDER });
  });

  it('decides which txs to trace', () => {
    const watched = new Set<string>([DISPERSE]);
    expect(shouldTrace(tx(1, W1, 1n), rc(1, true), false, watched)).toBe(false); // value to EOA
    expect(shouldTrace(tx(1, DISPERSE, 1n), rc(1, true), true, new Set())).toBe(true); // value to contract
    expect(shouldTrace(tx(1, a(0x77), 0n), rc(1, true), true, new Set())).toBe(false); // 0-value call
    expect(shouldTrace(tx(5, DISPERSE, 0n), rc(5, true), true, watched)).toBe(true); // watched sprayer contract
    expect(shouldTrace(tx(3, null, 0n), rc(3, true), false, watched)).toBe(true); // creation
    expect(shouldTrace(tx(2, DISPERSE, 1n), rc(2, false), true, watched)).toBe(false); // reverted
  });

  it('derives first-funding wallet rows (first transfer in wins, known wallets skipped)', () => {
    const rows = sortTransfers(
      [
        ...extractTraceTransfers({ type: 'CALL', from: FUNDER, to: DISPERSE, value: '0x1', calls: [{ type: 'CALL', from: DISPERSE, to: W1, value: '0x5' }] }, { block: 100, ts: 1000, txHash: h(9) }),
        ...extractTxTransfers(block, receipts),
      ],
      new Map([[h(1), 0], [h(3), 2], [h(4), 3], [h(9), 8]]),
    );
    const wallets = newWalletsFromTransfers(rows, (x) => x === a(0xc3));
    expect(wallets.map((w) => [w.address, w.firstFunder, w.firstFundingValue, w.isContract, w.txCountAtFirstFunding])).toEqual([
      [W1, FUNDER, ETH / 100n, null, null],
      [CREATED, FUNDER, ETH, true, 0],
    ]);
  });

  it('treats EIP-7702 delegated EOAs as EOAs', () => {
    expect(codeIsContract('0x')).toBe(false);
    expect(codeIsContract('0x6080604052')).toBe(true);
    expect(codeIsContract('0xef0100' + '11'.repeat(20))).toBe(false);
  });
});
