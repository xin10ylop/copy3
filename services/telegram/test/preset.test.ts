import { describe, expect, it } from 'vitest';
import { PresetSchema } from '@hood/core';
import { parsePresetAssignments } from '../src/parse.js';
import { applyPresetAssignments, presetLines, presetPaths, schemaAtPath } from '../src/preset.js';

const assign = (...tokens: string[]) => {
  const r = parsePresetAssignments(tokens);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe('preset key paths', () => {
  it('lists every settable leaf, including nested ones', () => {
    const paths = presetPaths();
    expect(paths).toEqual(expect.arrayContaining(['buyEth', 'trailing.activatePct', 'trailing.dropPct', 'burst.startMs', 'burst.count', 'takeProfits', 'timeoutSec']));
  });

  it('resolves nested and indexed paths and explains bad ones', () => {
    expect(schemaAtPath(['trailing', 'activatePct']).ok).toBe(true);
    expect(schemaAtPath(['takeProfits', '0', 'sellPct']).ok).toBe(true);
    expect(schemaAtPath(['trailing', 'activatPct'])).toMatchObject({ ok: false, error: expect.stringContaining('unknown key "trailing.activatPct" (trailing has: activatePct, dropPct)') });
    expect(schemaAtPath(['buyEthh'])).toMatchObject({ ok: false, error: expect.stringContaining('unknown key "buyEthh"') });
    expect(schemaAtPath(['buyEth', 'x'])).toMatchObject({ ok: false, error: expect.stringContaining('is a value') });
    expect(schemaAtPath(['takeProfits', 'pct'])).toMatchObject({ ok: false, error: expect.stringContaining('is a list') });
  });
});

describe('applyPresetAssignments', () => {
  it('applies nested keys on a partial stored preset (defaults filled first)', () => {
    const r = applyPresetAssignments({ buyEth: 0.07 }, assign('trailing.activatePct=80', 'tax=700'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preset.trailing).toEqual({ activatePct: 80, dropPct: 20 });
    expect(r.preset.maxTaxBps).toBe(700);
    expect(r.changes).toEqual([
      { path: 'trailing.activatePct', before: 50, after: 80 },
      { path: 'maxTaxBps', before: 1000, after: 700 },
    ]);
    expect(PresetSchema.safeParse(r.preset).success).toBe(true);
  });

  it('fills in the backtested defaults (docs/BACKTEST.md §2)', () => {
    const r = applyPresetAssignments({}, assign('buy=0.05'));
    expect(r).toMatchObject({
      ok: true,
      preset: { buyEth: 0.05, maxTaxBps: 1000, takeProfits: [], trailing: { activatePct: 50, dropPct: 20 }, stopLossPct: 40, timeoutSec: 60, exitIfExemptSellsPct: 0 },
    });
  });

  it('sets take profits by shorthand and by index', () => {
    const r1 = applyPresetAssignments({}, assign('tp=100:50,200:100'));
    expect(r1).toMatchObject({ ok: true, preset: { takeProfits: [{ pct: 100, sellPct: 50 }, { pct: 200, sellPct: 100 }] } });
    const r2 = applyPresetAssignments({ takeProfits: [{ pct: 150, sellPct: 100 }] }, assign('takeProfits.0.pct=180'));
    expect(r2).toMatchObject({ ok: true, preset: { takeProfits: [{ pct: 180, sellPct: 100 }] } });
    // the default ladder is empty: an index needs the whole entry
    expect(applyPresetAssignments({}, assign('takeProfits.0.pct=180'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^takeProfits\.0\.sellPct/)] });
    expect(applyPresetAssignments({}, assign('tp=none'))).toMatchObject({ ok: true, preset: { takeProfits: [] } });
  });

  it('none/off set the nullable exits to null (off) instead of restoring the default', () => {
    const r = applyPresetAssignments({}, assign('timeoutSec=none', 'exitIfExemptSellsPct=off', 'trailing=off'));
    expect(r).toMatchObject({
      ok: true,
      preset: { timeoutSec: null, exitIfExemptSellsPct: null, trailing: null },
      changes: [
        { path: 'timeoutSec', before: 60, after: null },
        { path: 'exitIfExemptSellsPct', before: 0, after: null },
        { path: 'trailing', before: { activatePct: 50, dropPct: 20 }, after: null },
      ],
    });
    if (r.ok) expect(r.warnings).toEqual(expect.arrayContaining([expect.stringContaining('trailing off'), expect.stringContaining('timeoutSec off')]));
    // stored nulls survive unrelated edits, and values turn them back on
    const keep = applyPresetAssignments({ timeoutSec: null, exitIfExemptSellsPct: null }, assign('buy=0.03'));
    expect(keep).toMatchObject({ ok: true, preset: { timeoutSec: null, exitIfExemptSellsPct: null } });
    const on = applyPresetAssignments({ timeoutSec: null, exitIfExemptSellsPct: null }, assign('timeout=90', 'exitIfExemptSellsPct=25'));
    expect(on).toMatchObject({ ok: true, preset: { timeoutSec: 90, exitIfExemptSellsPct: 25 } });
    // a plain optional (non-nullable) key is still removed by none
    const t = applyPresetAssignments({ maxEntryMcapEth: 8 }, assign('maxEntryMcapEth=none'));
    expect(t.ok && 'maxEntryMcapEth' in t.preset).toBe(false);
  });

  it('trailing=off disables the trailing stop and a nested key re-creates it from the 50/20 default', () => {
    for (const word of ['off', 'none', 'null', 'false']) {
      expect(applyPresetAssignments({}, assign(`trailing=${word}`))).toMatchObject({ ok: true, preset: { trailing: null } });
    }
    const back = applyPresetAssignments({ trailing: null }, assign('trailing.dropPct=15'));
    expect(back).toMatchObject({ ok: true, preset: { trailing: { activatePct: 50, dropPct: 15 } } });
    const alias = applyPresetAssignments({ trailing: null }, assign('trail.activatePct=60', 'trail.dropPct=30'));
    expect(alias).toMatchObject({ ok: true, preset: { trailing: { activatePct: 60, dropPct: 30 } } });
    expect(presetLines({ trailing: null })).toContain('trailing=off');
  });

  it('rejects typos instead of silently dropping them', () => {
    expect(applyPresetAssignments({}, assign('trailing.activatPct=80'))).toMatchObject({ ok: false, errors: [expect.stringContaining('unknown key')] });
  });

  it('reports schema violations with their path', () => {
    expect(applyPresetAssignments({}, assign('buyEth=-1'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^buyEth: /)] });
    expect(applyPresetAssignments({}, assign('burst.count=fast'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^burst\.count: .*number/)] });
    expect(applyPresetAssignments({ takeProfits: [{ pct: 150, sellPct: 100 }] }, assign('takeProfits.0.sellPct=150'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^takeProfits\.0\.sellPct/)] });
    expect(applyPresetAssignments({}, assign('timeoutSec=0'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^timeoutSec: /)] });
  });

  it('enforces the schema cap, the chat limits and domain sanity', () => {
    // the core schema caps maxTaxBps at 5000 (9900 = the launch-second tax would disable the gate)
    expect(applyPresetAssignments({}, assign('maxTaxBps=9900'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^maxTaxBps: .*5000/)] });
    expect(applyPresetAssignments({}, assign('maxTaxBps=5000'))).toMatchObject({ ok: true, warnings: [expect.stringContaining('looser than')] });
    expect(applyPresetAssignments({}, assign('buyEth=2'), { maxBuyEth: 1 })).toMatchObject({ ok: false, errors: [expect.stringContaining('TELEGRAM_MAX_BUY_ETH')] });
    // bankroll sizing: the chat cap bounds sizing.maxEth too
    const sized = applyPresetAssignments({}, assign('sizing.mode=bankroll', 'sizing.fraction=0.5'));
    expect(sized).toMatchObject({ ok: true, preset: { sizing: { mode: 'bankroll', fraction: 0.5, minEth: 0.01, maxEth: 0.3 } } });
    expect(applyPresetAssignments({}, assign('sizing.mode=bankroll', 'sizing.maxEth=2'), { maxBuyEth: 1 })).toMatchObject({ ok: false, errors: [expect.stringMatching(/^sizing\.maxEth 2 .*TELEGRAM_MAX_BUY_ETH/)] });
    expect(applyPresetAssignments({}, assign('sizing.minEth=0.5', 'sizing.maxEth=0.1'))).toMatchObject({ ok: false, errors: [expect.stringContaining('sizing.minEth 0.5 must be <= sizing.maxEth 0.1')] });
    expect(applyPresetAssignments({}, assign('burst.count=500'))).toMatchObject({ ok: false, errors: [expect.stringContaining('burst.count')] });
    expect(applyPresetAssignments({}, assign('trailing.dropPct=0'))).toMatchObject({ ok: false });
  });

  it('warns about settings that change behaviour', () => {
    const r = applyPresetAssignments({}, assign('maxTaxBps=500'));
    expect(r).toMatchObject({ ok: true, warnings: [expect.stringContaining('+1 s block')] });
  });

  it('presetLines flattens a preset to key=value', () => {
    const lines = presetLines({ buyEth: 0.05 });
    expect(lines).toEqual(
      expect.arrayContaining(['buyEth=0.05', 'trailing.activatePct=50', 'trailing.dropPct=20', 'takeProfits=[]', 'timeoutSec=60', 'exitIfExemptSellsPct=0', 'stopLossPct=40']),
    );
    expect(presetLines({ timeoutSec: null, exitIfExemptSellsPct: null })).toEqual(expect.arrayContaining(['timeoutSec=off', 'exitIfExemptSellsPct=off']));
  });
});
