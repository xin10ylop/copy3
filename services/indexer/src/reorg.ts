/**
 * Reorg detection (pure). Nitro reorgs are rare (sequencer-ordered chain), so the
 * policy is defensive and simple: remember the last `size` block hashes; when a new
 * block's parentHash does not match what we stored for its parent, roll back
 * `depth` blocks (default 10) and re-process from there.
 */
import type { Hex } from './types.js';

export class BlockHashWindow {
  private readonly hashes = new Map<number, Hex>();
  constructor(private readonly size = 128) {}

  set(block: number, hash: Hex): void {
    this.hashes.set(block, hash);
    for (const b of this.hashes.keys()) if (b <= block - this.size) this.hashes.delete(b);
  }

  get(block: number): Hex | undefined {
    return this.hashes.get(block);
  }

  /** Forget everything at or above `block`. */
  truncateFrom(block: number): void {
    for (const b of [...this.hashes.keys()]) if (b >= block) this.hashes.delete(b);
  }

  clear(): void {
    this.hashes.clear();
  }

  get size_(): number {
    return this.hashes.size;
  }
}

export type ReorgCheck = { ok: true } | { ok: false; rollbackFrom: number };

/**
 * @returns ok when the parent is unknown (nothing to compare) or matches;
 *          otherwise the first block to re-process.
 */
export function checkParent(
  window: BlockHashWindow,
  block: { number: number; parentHash: Hex },
  depth = 10,
  floor = 0,
): ReorgCheck {
  const expected = window.get(block.number - 1);
  if (expected === undefined || expected.toLowerCase() === block.parentHash.toLowerCase()) return { ok: true };
  return { ok: false, rollbackFrom: Math.max(floor, block.number - depth) };
}
