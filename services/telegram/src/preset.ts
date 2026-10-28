/**
 * Apply `/preset` key=value assignments to a play's preset and validate the result with the
 * shared `PresetSchema` (packages/core). Unknown keys (typos such as `trailing.activatPct`) are
 * rejected up front, because zod objects silently strip unknown keys.
 */
import { PresetSchema, type Preset } from '@hood/core';
import { z } from 'zod';
import type { PresetAssignment } from './parse.js';

export type PresetResult =
  | { ok: true; preset: Preset; changes: PresetChange[]; warnings: string[] }
  | { ok: false; errors: string[] };

export interface PresetChange {
  path: string;
  before: unknown;
  after: unknown;
}

export interface PresetLimits {
  /** hard cap on buyEth accepted from chat (TELEGRAM_MAX_BUY_ETH) */
  maxBuyEth: number;
}

export const DEFAULT_PRESET_LIMITS: PresetLimits = { maxBuyEth: 1 };

/** Strip optional/default/nullable wrappers (public zod 4 API: `.unwrap()`). */
function unwrap(schema: z.ZodType): z.ZodType {
  let s: z.ZodType = schema;
  for (let i = 0; i < 10; i++) {
    if (s instanceof z.ZodDefault || s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = s.unwrap() as z.ZodType;
    } else {
      break;
    }
  }
  return s;
}

/** True when `null` is a valid value for the field (e.g. `trailing`: null = trailing stop off). */
export function isNullableField(schema: z.ZodType): boolean {
  let s: z.ZodType = schema;
  for (let i = 0; i < 10; i++) {
    if (s instanceof z.ZodNullable) return true;
    if (s instanceof z.ZodDefault || s instanceof z.ZodOptional) s = s.unwrap() as z.ZodType;
    else return false;
  }
  return false;
}

/** The schema at a dotted path inside PresetSchema, or an error naming the bad segment. */
export function schemaAtPath(path: string[]): { ok: true; schema: z.ZodType } | { ok: false; error: string } {
  let cur: z.ZodType = PresetSchema;
  const walked: string[] = [];
  for (const seg of path) {
    const s = unwrap(cur);
    if (s instanceof z.ZodObject) {
      const shape = s.shape as Record<string, z.ZodType>;
      const next = shape[seg];
      if (!next) {
        const where = walked.length ? walked.join('.') : 'preset';
        return { ok: false, error: `unknown key "${[...walked, seg].join('.')}" (${where} has: ${Object.keys(shape).join(', ')})` };
      }
      cur = next;
    } else if (s instanceof z.ZodArray) {
      if (!/^\d+$/.test(seg)) return { ok: false, error: `"${walked.join('.')}" is a list: use an index like ${walked.join('.')}.0` };
      if (Number(seg) > 20) return { ok: false, error: `index ${seg} is out of range` };
      cur = s.element as z.ZodType;
    } else {
      return { ok: false, error: `"${walked.join('.')}" is a value, it has no field "${seg}"` };
    }
    walked.push(seg);
  }
  return { ok: true, schema: cur };
}

/** Every settable dotted path (for /help and error messages). */
export function presetPaths(): string[] {
  const out: string[] = [];
  const walk = (schema: z.ZodType, prefix: string[]): void => {
    const s = unwrap(schema);
    if (s instanceof z.ZodObject) {
      for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodType>)) walk(v, [...prefix, k]);
    } else {
      out.push(prefix.join('.'));
    }
  };
  walk(PresetSchema, []);
  return out;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function getPath(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: Record<string, unknown> | unknown[] = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i]!;
    const nextIsIndex = /^\d+$/.test(path[i + 1]!);
    const container = cur as Record<string, unknown>;
    let next = container[seg];
    if (next === null || typeof next !== 'object') {
      next = nextIsIndex ? [] : {};
      container[seg] = next;
    }
    cur = next as Record<string, unknown> | unknown[];
  }
  const last = path[path.length - 1]!;
  const container = cur as Record<string, unknown>;
  if (value === undefined) {
    if (Array.isArray(container) && /^\d+$/.test(last)) (container as unknown[]).splice(Number(last), 1);
    else delete container[last];
  } else {
    container[last] = value;
  }
}

function issuesToStrings(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'preset'}: ${i.message}`);
}

/** Domain sanity on top of the schema (hard errors and soft warnings). */
function sanity(p: Preset, limits: PresetLimits): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (p.buyEth > limits.maxBuyEth) errors.push(`buyEth ${p.buyEth} is above the chat limit of ${limits.maxBuyEth} ETH (TELEGRAM_MAX_BUY_ETH)`);
  if (p.sizing.mode === 'bankroll' && p.sizing.maxEth > limits.maxBuyEth)
    errors.push(`sizing.maxEth ${p.sizing.maxEth} is above the chat limit of ${limits.maxBuyEth} ETH (TELEGRAM_MAX_BUY_ETH)`);
  if (p.sizing.minEth > p.sizing.maxEth) errors.push(`sizing.minEth ${p.sizing.minEth} must be <= sizing.maxEth ${p.sizing.maxEth}`);
  if (p.slippageBps > 9900) errors.push('slippageBps must be <= 9900');
  if (p.burst.count > 50) errors.push('burst.count must be <= 50');
  if (p.burst.spacingMs > 500) errors.push('burst.spacingMs must be <= 500');
  if (p.stopLossPct <= 0 || p.stopLossPct > 100) errors.push('stopLossPct must be in (0, 100]');
  for (const [i, tp] of p.takeProfits.entries()) {
    if (tp.pct <= 0) errors.push(`takeProfits.${i}.pct must be > 0`);
  }
  if (p.trailing && (p.trailing.dropPct <= 0 || p.trailing.dropPct >= 100)) errors.push('trailing.dropPct must be in (0, 100)');
  if (p.maxTaxBps < 618) warnings.push('maxTaxBps < 618: the +1 s block (6.18 % tax) will be skipped, only +2 s (0.19 %) or later can fill');
  if (p.maxTaxBps > 1000) warnings.push('maxTaxBps > 1000 is looser than the video\'s 10 % tax protection');
  const sorted = [...p.takeProfits].sort((a, b) => a.pct - b.pct);
  if (sorted.some((tp, i) => tp !== p.takeProfits[i])) warnings.push('takeProfits are not in ascending pct order');
  if (p.takeProfits.length > 0 && !p.takeProfits.some((tp) => tp.sellPct === 100)) warnings.push('no take-profit sells 100 %: the rest exits via trailing/stop loss/timeout');
  if (p.takeProfits.length === 0 && p.trailing === null) warnings.push('no take-profit and trailing off: only stop loss, timeout and the team-outflow exit can close a position');
  if (p.timeoutSec === null) warnings.push('timeoutSec off: a position that never hits an exit is held indefinitely');
  return { errors, warnings };
}

/**
 * Apply assignments to `current` (the stored preset JSON, possibly partial). Missing fields take
 * the schema defaults first, so `trailing.dropPct=20` works on a preset stored without `trailing`.
 */
export function applyPresetAssignments(current: unknown, assignments: PresetAssignment[], limits: PresetLimits = DEFAULT_PRESET_LIMITS): PresetResult {
  const pathErrors: string[] = [];
  for (const a of assignments) {
    const r = schemaAtPath(a.path);
    if (!r.ok) pathErrors.push(r.error);
  }
  if (pathErrors.length) return { ok: false, errors: pathErrors };

  const base = PresetSchema.safeParse(current ?? {});
  const before: Record<string, unknown> = clone(
    base.success ? (base.data as Record<string, unknown>) : ((current && typeof current === 'object' ? current : {}) as Record<string, unknown>),
  );
  const draft = clone(before);
  for (const a of assignments) {
    let value = clone(a.value);
    const target = schemaAtPath(a.path);
    // `trailing=off|none|null|false` on a nullable field stores null (disabled), not "use the default"
    if (target.ok && isNullableField(target.schema) && (value === undefined || value === false || value === null)) value = null;
    // a nested key under a null/missing object (trailing.dropPct=20 while trailing=off) re-creates it
    // from the schema default first, so the other fields are not left undefined
    for (let i = 1; i < a.path.length; i++) {
      const prefix = a.path.slice(0, i);
      const cur = getPath(draft, prefix);
      if (cur !== null && cur !== undefined) continue;
      const at = schemaAtPath(prefix);
      const seeded = at.ok ? at.schema.safeParse(undefined) : null;
      const seed = seeded?.success && seeded.data && typeof seeded.data === 'object' ? clone(seeded.data) : /^\d+$/.test(a.path[i]!) ? [] : {};
      setPath(draft, prefix, seed);
    }
    setPath(draft, a.path, value);
  }

  const parsed = PresetSchema.safeParse(draft);
  if (!parsed.success) return { ok: false, errors: issuesToStrings(parsed.error) };
  const { errors, warnings } = sanity(parsed.data, limits);
  if (errors.length) return { ok: false, errors };

  const changes: PresetChange[] = assignments.map((a) => ({
    path: a.path.join('.'),
    before: getPath(before, a.path),
    after: getPath(parsed.data, a.path),
  }));
  return { ok: true, preset: parsed.data, changes, warnings };
}

/** Flatten a preset into `key=value` lines (what /preset <id> without assignments shows). */
export function presetLines(preset: unknown): string[] {
  const parsed = PresetSchema.safeParse(preset ?? {});
  const p = parsed.success ? (parsed.data as Record<string, unknown>) : ((preset ?? {}) as Record<string, unknown>);
  const lines: string[] = [];
  const walk = (v: unknown, prefix: string): void => {
    if (Array.isArray(v)) {
      if (v.every((x) => x && typeof x === 'object' && 'pct' in x && 'sellPct' in x)) {
        lines.push(`${prefix}=${(v as Array<{ pct: number; sellPct: number }>).map((x) => `${x.pct}:${x.sellPct}`).join(',') || '[]'}`);
      } else {
        lines.push(`${prefix}=${JSON.stringify(v)}`);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, prefix ? `${prefix}.${k}` : k);
    } else if (v === null) {
      lines.push(`${prefix}=off`);
    } else {
      lines.push(`${prefix}=${String(v)}`);
    }
  };
  walk(p, '');
  return lines;
}

export function fmtValue(v: unknown): string {
  if (v === undefined) return '(default)';
  if (v === null) return 'off';
  if (Array.isArray(v) && v.every((x) => x && typeof x === 'object' && 'pct' in x)) {
    return (v as Array<{ pct: number; sellPct: number }>).map((x) => `${x.pct}:${x.sellPct}`).join(',');
  }
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
