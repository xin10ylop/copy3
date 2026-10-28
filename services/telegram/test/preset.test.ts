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
    expect(r.preset.trailing).toEqual({ activatePct: 80, dropPct: 25 });
    expect(r.preset.maxTaxBps).toBe(700);
    expect(r.changes).toEqual([
      { path: 'trailing.activatePct', before: 100, after: 80 },
      { path: 'maxTaxBps', before: 1000, after: 700 },
    ]);
    expect(PresetSchema.safeParse(r.preset).success).toBe(true);
  });

  it('sets take profits by shorthand and by index, and removes optional keys', () => {
    const r1 = applyPresetAssignments({ timeoutSec: 60 }, assign('tp=100:50,200:100', 'timeoutSec=none'));
    expect(r1).toMatchObject({ ok: true, preset: { takeProfits: [{ pct: 100, sellPct: 50 }, { pct: 200, sellPct: 100 }] } });
    if (r1.ok) expect(r1.preset.timeoutSec).toBeUndefined();
    const r2 = applyPresetAssignments({}, assign('takeProfits.0.pct=180'));
    expect(r2).toMatchObject({ ok: true, preset: { takeProfits: [{ pct: 180, sellPct: 100 }] } });
  });

  it('rejects typos instead of silently dropping them', () => {
    expect(applyPresetAssignments({}, assign('trailing.activatPct=80'))).toMatchObject({ ok: false, errors: [expect.stringContaining('unknown key')] });
  });

  it('reports schema violations with their path', () => {
    expect(applyPresetAssignments({}, assign('buyEth=-1'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^buyEth: /)] });
    expect(applyPresetAssignments({}, assign('burst.count=fast'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^burst\.count: .*number/)] });
    expect(applyPresetAssignments({}, assign('takeProfits.0.sellPct=150'))).toMatchObject({ ok: false, errors: [expect.stringMatching(/^takeProfits\.0\.sellPct/)] });
  });

  it('enforces the chat limits and domain sanity', () => {
    expect(applyPresetAssignments({}, assign('buyEth=2'), { maxBuyEth: 1 })).toMatchObject({ ok: false, errors: [expect.stringContaining('TELEGRAM_MAX_BUY_ETH')] });
    expect(applyPresetAssignments({}, assign('maxTaxBps=9900'))).toMatchObject({ ok: false, errors: [expect.stringContaining('99 %')] });
    expect(applyPresetAssignments({}, assign('burst.count=500'))).toMatchObject({ ok: false, errors: [expect.stringContaining('burst.count')] });
    expect(applyPresetAssignments({}, assign('trailing.dropPct=0'))).toMatchObject({ ok: false });
  });

  it('warns about settings that change behaviour', () => {
    const r = applyPresetAssignments({}, assign('maxTaxBps=500'));
    expect(r).toMatchObject({ ok: true, warnings: [expect.stringContaining('+1 s block')] });
  });

  it('presetLines flattens a preset to key=value', () => {
    const lines = presetLines({ buyEth: 0.05 });
    expect(lines).toContain('buyEth=0.05');
    expect(lines).toContain('trailing.activatePct=100');
    expect(lines).toContain('takeProfits=150:100');
  });
});
