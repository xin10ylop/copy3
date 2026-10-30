/**
 * A late, position-less writer (the race measurement finishing after the position closed) must
 * not clear a closed row's sells / PnL — 30 Oct 2026, snipes 58 and 59 on the Ohio box.
 */
import { describe, expect, it } from 'vitest';
import { silentLogger } from '../src/log.js';
import type { PositionEntry } from '../src/positions.js';
import { Recorder } from '../src/recorder.js';
import { MemoryStore } from '../src/store.js';
import type { SnipeRun } from '../src/types.js';
import { LAUNCH } from './helpers/fixtures.js';

function run(): SnipeRun {
  return {
    id: 0,
    key: 'k:1:0',
    mode: 'live',
    playId: 1,
    launch: { event: { deployer: LAUNCH.deployer, name: 'S', symbol: 'S', launchKind: 'launchToken', exemptions: [], creatorFeeRecipient: LAUNCH.creatorFeeRecipient, creatorTaxBps: 0, devBuyQuoteIn: 0n, pairToken: '0x0000000000000000000000000000000000000000', launchConfigId: 0n }, block: LAUNCH.block, ts: LAUNCH.ts, receivedAt: 0, txHash: LAUNCH.txHash, token: LAUNCH.token, curve: LAUNCH.curve, source: 'feed' },
    decision: { play: { id: 1 } as never, preset: {} as never, reasons: ['test'] },
    status: 'pending',
    decidedAt: Date.now(),
    quoteIn: 3_000_000_000_000_000n,
    minTokensOut: 0n,
    maxTaxBps: 1000,
    deadlineBlock: LAUNCH.block + 25,
    deadlineTs: LAUNCH.ts + 2,
    burst: [],
    notes: [],
    sizing: { mode: 'fixed', bankrollEth: null, note: '' } as never,
  } as unknown as SnipeRun;
}

describe('recorder: late position-less writers', () => {
  it("a 'race' update after the close keeps sells and realizedPnlEth; a generic position-less update of a filled run keeps them too", async () => {
    const store = new MemoryStore();
    const rec = new Recorder(store, silentLogger, { recordFeedBlocks: false });
    const r = run();
    rec.snipe(r, undefined, 'snipe_decided');
    await rec.idle();
    expect(r.id).toBeGreaterThan(0);
    // fill + close, written with the position
    r.fill = { block: LAUNCH.block + 9, ts: LAUNCH.ts + 1, quoteIn: r.quoteIn, tokensOut: 10n ** 24n, taxPaid: 0n, taxBps: 618, entryPrice: 3e-9, txHash: `0x${'aa'.repeat(32)}`, memberIndex: 0 } as never;
    r.status = 'closed';
    const p = { phase: 'closed', sales: [{ at: 1, reason: 'exempt_dump', tokensIn: '1', quoteOut: '2' }], realizedQuote: 2_864_082_799_975_872n, costBasis: r.quoteIn } as unknown as PositionEntry;
    rec.snipe(r, p, 'snipe_closed');
    await rec.idle();
    const row = () => store.snipes.get(r.id)!;
    expect(row().status).toBe('closed');
    expect(row().sells).toHaveLength(1);
    expect(row().realizedPnlEth).toBeCloseTo(-0.000135917, 9);
    // the race measurement finishes late, without the position
    r.notes.push('race: block +9 vs the first T+1 block');
    rec.update(r, undefined, 'race');
    await rec.idle();
    expect(row().sells).toHaveLength(1);
    expect(row().realizedPnlEth).toBeCloseTo(-0.000135917, 9);
    expect(row().notes).toContain('race: block +9');
    // any other position-less update of a filled run keeps the position columns as well
    rec.snipe(r, undefined, 'snipe_update');
    await rec.idle();
    expect(row().sells).toHaveLength(1);
    expect(row().realizedPnlEth).toBeCloseTo(-0.000135917, 9);
  });
});
