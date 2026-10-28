/**
 * eth_transfers extraction (pure).
 *
 * kind 'tx'       - top-level tx with value > 0 to an address (trace_addr '')
 * kind 'create'   - contract creation. Top-level (to = null, trace_addr '') or internal
 *                   CREATE/CREATE2 frame. Recorded EVEN WITH value 0 so that the tracker
 *                   can resolve "contract created by funder" (contract mode).
 * kind 'internal' - CALL / SELFDESTRUCT frame with value > 0 found by callTracer.
 * Reverted txs and reverted frames (and their sub-trees) move no value and are skipped.
 */
import { getContractAddress } from 'viem';
import { hexToBig, hexToNum } from './hex.js';
import type { Address, CallFrame, Hex, RpcBlock, RpcReceipt, RpcTransaction, TransferRow, WalletRow } from './types.js';

const lc = (a: string) => a.toLowerCase() as Address;

export function receiptOk(r: RpcReceipt | undefined): boolean {
  return r === undefined || r.status === '0x1';
}

export function extractTxTransfers(
  block: Pick<RpcBlock, 'number' | 'timestamp' | 'transactions'>,
  receipts: ReadonlyMap<string, RpcReceipt>,
): TransferRow[] {
  const blockNum = hexToNum(block.number);
  const ts = hexToNum(block.timestamp);
  const out: TransferRow[] = [];
  for (const tx of block.transactions) {
    const rc = receipts.get(tx.hash);
    if (!receiptOk(rc)) continue;
    const value = hexToBig(tx.value);
    if (tx.to === null) {
      const created = rc?.contractAddress ?? getContractAddress({ from: tx.from, nonce: hexToBig(tx.nonce) });
      out.push({ block: blockNum, ts, txHash: tx.hash, traceAddr: '', from: lc(tx.from), to: lc(created), value, kind: 'create' });
    } else if (value > 0n) {
      out.push({ block: blockNum, ts, txHash: tx.hash, traceAddr: '', from: lc(tx.from), to: lc(tx.to), value, kind: 'tx' });
    }
  }
  return out;
}

/**
 * Which txs to debug_traceTransaction: successful txs that create a contract, or
 * carry value into an address with code, or call a contract we watch (contracts
 * recently created by someone - "sprayer" contracts that disperse ETH they hold).
 */
export function shouldTrace(
  tx: Pick<RpcTransaction, 'to' | 'value'>,
  receipt: RpcReceipt | undefined,
  toHasCode: boolean,
  watched: ReadonlySet<string>,
): boolean {
  if (!receiptOk(receipt)) return false;
  if (tx.to === null) return true;
  if (watched.has(tx.to.toLowerCase())) return true;
  return hexToBig(tx.value) > 0n && toHasCode;
}

export function extractTraceTransfers(
  root: CallFrame,
  base: { block: number; ts: number; txHash: Hex },
): TransferRow[] {
  const out: TransferRow[] = [];
  if (root.error) return out;
  const walk = (frame: CallFrame, path: number[]) => {
    (frame.calls ?? []).forEach((child, i) => {
      if (child.error) return; // reverted: no value moved in this sub-tree
      const p = [...path, i];
      const type = child.type.toUpperCase();
      const value = hexToBig(child.value);
      const traceAddr = p.join(',');
      if ((type === 'CREATE' || type === 'CREATE2') && child.to) {
        out.push({ ...base, traceAddr, from: lc(child.from), to: lc(child.to), value, kind: 'create' });
      } else if ((type === 'CALL' || type === 'SELFDESTRUCT') && value > 0n && child.to) {
        out.push({ ...base, traceAddr, from: lc(child.from), to: lc(child.to), value, kind: 'internal' });
      }
      walk(child, p);
    });
  };
  walk(root, []);
  return out;
}

/** Order transfers deterministically: block, tx position, trace path. */
export function sortTransfers(rows: TransferRow[], txIndex: ReadonlyMap<string, number>): TransferRow[] {
  const cmpPath = (a: string, b: string) => {
    if (a === b) return 0;
    if (a === '') return -1;
    if (b === '') return 1;
    const pa = a.split(',').map(Number);
    const pb = b.split(',').map(Number);
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      const d = pa[i]! - pb[i]!;
      if (d !== 0) return d;
    }
    return pa.length - pb.length;
  };
  return [...rows].sort(
    (a, b) => a.block - b.block || (txIndex.get(a.txHash) ?? 0) - (txIndex.get(b.txHash) ?? 0) || cmpPath(a.traceAddr, b.traceAddr),
  );
}

/**
 * First-funding candidates: the first transfer INTO each address not yet known.
 * `isContract` / `txCountAtFirstFunding` are filled by the caller via RPC (creates
 * are contracts by definition).
 */
export function newWalletsFromTransfers(
  transfers: readonly TransferRow[],
  isKnown: (address: Address) => boolean,
): WalletRow[] {
  const seen = new Set<string>();
  const out: WalletRow[] = [];
  for (const t of transfers) {
    if (seen.has(t.to) || isKnown(t.to)) continue;
    seen.add(t.to);
    out.push({
      address: t.to,
      firstSeenBlock: t.block,
      firstSeenTs: t.ts,
      firstFunder: t.from,
      firstFundingValue: t.value,
      firstFundingTx: t.txHash,
      isContract: t.kind === 'create' ? true : null,
      txCountAtFirstFunding: t.kind === 'create' ? 0 : null,
    });
  }
  return out;
}

/** EIP-7702 delegated EOAs carry code 0xef0100||address; they are still EOAs. */
export function codeIsContract(code: string | null | undefined): boolean {
  if (!code || code === '0x') return false;
  return !code.toLowerCase().startsWith('0xef0100');
}
