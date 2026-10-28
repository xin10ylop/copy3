import { describe, expect, it } from 'vitest';
import { BlockHashWindow, checkParent } from '../src/reorg.js';
import type { Hex } from '../src/types.js';

const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

describe('reorg detection', () => {
  it('accepts matching or unknown parents and asks to roll back 10 blocks otherwise', () => {
    const w = new BlockHashWindow(64);
    for (let b = 100; b < 120; b++) w.set(b, h(b));
    expect(checkParent(w, { number: 120, parentHash: h(119) })).toEqual({ ok: true });
    expect(checkParent(w, { number: 500, parentHash: h(1) })).toEqual({ ok: true }); // parent unknown
    expect(checkParent(w, { number: 120, parentHash: h(999) })).toEqual({ ok: false, rollbackFrom: 110 });
    expect(checkParent(w, { number: 105, parentHash: h(999) }, 10, 100)).toEqual({ ok: false, rollbackFrom: 100 });
  });

  it('bounds memory and truncates on rollback', () => {
    const w = new BlockHashWindow(8);
    for (let b = 0; b < 100; b++) w.set(b, h(b));
    expect(w.size_).toBe(8);
    expect(w.get(91)).toBeUndefined();
    w.truncateFrom(95);
    expect(w.get(95)).toBeUndefined();
    expect(w.get(94)).toBe(h(94));
  });
});
