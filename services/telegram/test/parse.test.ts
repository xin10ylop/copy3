import { describe, expect, it } from 'vitest';
import {
  coerceValue,
  parseAddress,
  parseEthAmount,
  parseId,
  parseIntInRange,
  parsePresetAssignments,
  parseWatchArgs,
  tokenize,
} from '../src/parse.js';

const A = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const a = A.toLowerCase();

describe('tokenize', () => {
  it('splits on whitespace and groups quotes (incl. Telegram smart quotes)', () => {
    expect(tokenize('  a  b\tc ')).toEqual(['a', 'b', 'c']);
    expect(tokenize('x "two words" \'y z\'')).toEqual(['x', 'two words', 'y z']);
    expect(tokenize('name=“My Play”')).toEqual(['name=My Play']);
    expect(tokenize('""')).toEqual(['']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('parseAddress', () => {
  it('accepts a checksummed or lower-case address and lower-cases it', () => {
    expect(parseAddress(A)).toEqual({ ok: true, value: a });
    expect(parseAddress(`  ${a} `)).toEqual({ ok: true, value: a });
  });

  it('extracts the address from a pasted explorer or GMGN link', () => {
    expect(parseAddress(`https://robinhoodchain.blockscout.com/token/${A}`)).toEqual({ ok: true, value: a });
    expect(parseAddress(`https://gmgn.ai/robinhood/token/${A}?ref=x`)).toEqual({ ok: true, value: a });
  });

  it('rejects tx hashes, wrong lengths, non-hex and empty input', () => {
    const tx = `0x${'ab'.repeat(32)}`;
    expect(parseAddress(tx)).toMatchObject({ ok: false, error: expect.stringContaining('transaction hash') });
    expect(parseAddress(`https://robinhoodchain.blockscout.com/tx/${tx}`).ok).toBe(false);
    expect(parseAddress('0x1234').ok).toBe(false);
    expect(parseAddress(`${a}00`).ok).toBe(false);
    expect(parseAddress('0xZZcdef0123456789abcdef0123456789abcdef01').ok).toBe(false);
    expect(parseAddress(a.slice(2)).ok).toBe(false);
    expect(parseAddress(undefined, 'funder')).toEqual({ ok: false, error: 'missing funder' });
  });
});

describe('numbers', () => {
  it('parseId', () => {
    expect(parseId('12')).toEqual({ ok: true, value: 12 });
    expect(parseId('#12')).toEqual({ ok: true, value: 12 });
    expect(parseId('0').ok).toBe(false);
    expect(parseId('-1').ok).toBe(false);
    expect(parseId('1.5').ok).toBe(false);
    expect(parseId('99999999999').ok).toBe(false);
  });

  it('parseEthAmount', () => {
    expect(parseEthAmount('0.057')).toEqual({ ok: true, value: 0.057 });
    expect(parseEthAmount('.01')).toEqual({ ok: true, value: 0.01 });
    expect(parseEthAmount('0,015')).toEqual({ ok: true, value: 0.015 });
    expect(parseEthAmount('0.1eth')).toEqual({ ok: true, value: 0.1 });
    expect(parseEthAmount('1e3').ok).toBe(false);
    expect(parseEthAmount('-1').ok).toBe(false);
    expect(parseEthAmount('abc').ok).toBe(false);
    expect(parseEthAmount('5000').ok).toBe(false);
  });

  it('parseIntInRange applies the default and the bounds', () => {
    expect(parseIntInRange(undefined, 'days', 1, 365, 1)).toEqual({ ok: true, value: 1 });
    expect(parseIntInRange('7', 'days', 1, 365, 1)).toEqual({ ok: true, value: 7 });
    expect(parseIntInRange('0', 'days', 1, 365, 1).ok).toBe(false);
    expect(parseIntInRange('x', 'days', 1, 365, 1).ok).toBe(false);
  });
});

describe('parseWatchArgs', () => {
  it('parses the full form with a quoted name', () => {
    expect(parseWatchArgs(tokenize(`${A} 0.057 0.174 fresh "Amlil operator"`))).toEqual({
      ok: true,
      value: { funder: a, minEth: 0.057, maxEth: 0.174, fresh: true, name: 'Amlil operator' },
    });
  });

  it('defaults to fresh-only, supports `any`, multi-word names and preset=<playId>', () => {
    expect(parseWatchArgs([a, '0.01', '0.015'])).toEqual({ ok: true, value: { funder: a, minEth: 0.01, maxEth: 0.015, fresh: true } });
    expect(parseWatchArgs([a, '0.01', '0.015', 'any', 'big', 'spender', 'preset=3'])).toEqual({
      ok: true,
      value: { funder: a, minEth: 0.01, maxEth: 0.015, fresh: false, name: 'big spender', presetFromPlayId: 3 },
    });
    expect(parseWatchArgs([a, '0.01', '0.015', 'operator2'])).toMatchObject({ ok: true, value: { fresh: true, name: 'operator2' } });
  });

  it('rejects bad input', () => {
    expect(parseWatchArgs([a, '0.01'])).toMatchObject({ ok: false, error: expect.stringContaining('usage') });
    expect(parseWatchArgs(['0x12', '0.01', '0.02'])).toMatchObject({ ok: false, error: expect.stringContaining('funder') });
    expect(parseWatchArgs([a, '0.2', '0.1'])).toMatchObject({ ok: false, error: expect.stringContaining('must not exceed') });
    expect(parseWatchArgs([a, '0', '0'])).toMatchObject({ ok: false, error: expect.stringContaining('greater than 0') });
    expect(parseWatchArgs([a, '1', '500'], { maxEth: 100 })).toMatchObject({ ok: false, error: expect.stringContaining('sanity limit') });
    expect(parseWatchArgs([a, '0.1', '0.2', 'preset=x'])).toMatchObject({ ok: false, error: expect.stringContaining('preset play id') });
  });
});

describe('parsePresetAssignments', () => {
  it('parses nested key paths, aliases and typed values', () => {
    const r = parsePresetAssignments(['buy=0.05', 'trailing.activatePct=80', 'firstBuyOnly=false', 'timeoutSec=none', 'burst.count=12']);
    expect(r).toEqual({
      ok: true,
      value: [
        { path: ['buyEth'], value: 0.05, raw: 'buy=0.05' },
        { path: ['trailing', 'activatePct'], value: 80, raw: 'trailing.activatePct=80' },
        { path: ['firstBuyOnly'], value: false, raw: 'firstBuyOnly=false' },
        { path: ['timeoutSec'], value: undefined, raw: 'timeoutSec=none' },
        { path: ['burst', 'count'], value: 12, raw: 'burst.count=12' },
      ],
    });
  });

  it('understands the take-profit shorthand, JSON values and array indexes', () => {
    expect(parsePresetAssignments(['tp=100:50,200:100'])).toMatchObject({
      ok: true,
      value: [{ path: ['takeProfits'], value: [{ pct: 100, sellPct: 50 }, { pct: 200, sellPct: 100 }] }],
    });
    expect(parsePresetAssignments(['takeProfits=[{"pct":150,"sellPct":100}]'])).toMatchObject({ ok: true, value: [{ value: [{ pct: 150, sellPct: 100 }] }] });
    expect(parsePresetAssignments(['takeProfits.0.pct=120'])).toMatchObject({ ok: true, value: [{ path: ['takeProfits', '0', 'pct'], value: 120 }] });
  });

  it('rejects malformed keys, missing values, bad JSON and duplicates', () => {
    expect(parsePresetAssignments([])).toMatchObject({ ok: false, error: expect.stringContaining('usage') });
    expect(parsePresetAssignments(['buyEth'])).toMatchObject({ ok: false, error: expect.stringContaining('key=value') });
    expect(parsePresetAssignments(['=1'])).toMatchObject({ ok: false });
    expect(parsePresetAssignments(['trailing..dropPct=1'])).toMatchObject({ ok: false, error: expect.stringContaining('invalid key') });
    expect(parsePresetAssignments(['1buy=1'])).toMatchObject({ ok: false, error: expect.stringContaining('invalid key') });
    expect(parsePresetAssignments(['buyEth='])).toMatchObject({ ok: false, error: expect.stringContaining('empty value') });
    expect(parsePresetAssignments(['takeProfits=[{bad'])).toMatchObject({ ok: false, error: expect.stringContaining('invalid JSON') });
    expect(parsePresetAssignments(['buy=0.1', 'buyEth=0.2'])).toMatchObject({ ok: false, error: expect.stringContaining('set twice') });
  });

  it('coerceValue keeps unknown words as strings for the schema to reject', () => {
    expect(coerceValue('yes')).toEqual({ ok: true, value: true });
    expect(coerceValue('1e-3')).toEqual({ ok: true, value: 0.001 });
    expect(coerceValue('fast')).toEqual({ ok: true, value: 'fast' });
  });
});
