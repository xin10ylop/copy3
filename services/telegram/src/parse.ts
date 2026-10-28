/**
 * Command argument parsing + validation. Pure functions: every parser returns
 * `{ ok: true, value }` or `{ ok: false, error }` with a message fit for the chat.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T = never>(error: string): Parsed<T> => ({ ok: false, error });

/**
 * Split a command's argument string into tokens. Whitespace separates tokens; "double" or
 * 'single' quotes group words (so names may contain spaces). Telegram's "smart" quotes count too.
 */
export function tokenize(input: string): string[] {
  const s = input.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has || cur) out.push(cur);
  return out;
}

const ADDRESS_EXACT = /^0x[0-9a-fA-F]{40}$/;
/** exactly 40 hex digits, not part of a longer hex string (e.g. a tx hash) */
const ADDRESS_IN_TEXT = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/;

/**
 * Validate an EVM address. Accepts a bare address or a pasted explorer / GMGN URL that contains
 * exactly one; returns it lower-cased. Rejects tx hashes and anything with the wrong length.
 */
export function parseAddress(input: string | undefined, what = 'address'): Parsed<`0x${string}`> {
  const s = (input ?? '').trim();
  if (!s) return fail(`missing ${what}`);
  if (ADDRESS_EXACT.test(s)) return ok(s.toLowerCase() as `0x${string}`);
  if (/^(https?:\/\/|[a-z0-9.-]+\.[a-z]{2,}\/)/i.test(s)) {
    const m = ADDRESS_IN_TEXT.exec(s);
    if (m && /0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(s) === false) return ok(m[0].toLowerCase() as `0x${string}`);
  }
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return fail(`${what} looks like a transaction hash, not an address`);
  return fail(`invalid ${what}: expected 0x followed by 40 hex characters`);
}

/** Positive integer id (plays, snipes). */
export function parseId(input: string | undefined, what = 'id'): Parsed<number> {
  const s = (input ?? '').trim().replace(/^#/, '');
  if (!s) return fail(`missing ${what}`);
  if (!/^\d+$/.test(s)) return fail(`invalid ${what}: expected a positive integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) return fail(`invalid ${what}: out of range`);
  return ok(n);
}

/** Decimal ETH amount (`0.01`, `.057`, `1`), within [0, max]. */
export function parseEthAmount(input: string | undefined, what = 'amount', max = 1000): Parsed<number> {
  const s = (input ?? '').trim().replace(/eth$/i, '').replace(',', '.');
  if (!s) return fail(`missing ${what}`);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return fail(`invalid ${what}: expected a decimal ETH amount like 0.05`);
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return fail(`invalid ${what}`);
  if (n > max) return fail(`${what} ${n} ETH is above the ${max} ETH sanity limit`);
  return ok(n);
}

/** Optional integer in [min, max] with a default. */
export function parseIntInRange(input: string | undefined, what: string, min: number, max: number, def: number): Parsed<number> {
  if (input === undefined || input.trim() === '') return ok(def);
  const s = input.trim();
  if (!/^-?\d+$/.test(s)) return fail(`invalid ${what}: expected an integer`);
  const n = Number(s);
  if (n < min || n > max) return fail(`${what} must be between ${min} and ${max}`);
  return ok(n);
}

// ---------------------------------------------------------------------------------------------
// /watch <funder> <min> <max> [fresh|any] [name…] [preset=<playId>]
// ---------------------------------------------------------------------------------------------

export interface WatchArgs {
  funder: `0x${string}`;
  minEth: number;
  maxEth: number;
  fresh: boolean;
  name?: string;
  /** copy the preset of this play instead of the SPEC defaults */
  presetFromPlayId?: number;
}

export const WATCH_USAGE = '/watch <funder> <minEth> <maxEth> [fresh|any] [name] [preset=<playId>]';

export function parseWatchArgs(tokens: string[], opts: { maxEth?: number } = {}): Parsed<WatchArgs> {
  const rest = [...tokens];
  let presetFromPlayId: number | undefined;
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = /^preset=(.*)$/i.exec(rest[i] ?? '');
    if (!m) continue;
    const id = parseId(m[1], 'preset play id');
    if (!id.ok) return id;
    presetFromPlayId = id.value;
    rest.splice(i, 1);
  }
  if (rest.length < 3) return fail(`usage: ${WATCH_USAGE}`);
  const funder = parseAddress(rest[0], 'funder address');
  if (!funder.ok) return funder;
  const limit = opts.maxEth ?? 100;
  const minEth = parseEthAmount(rest[1], 'min', limit);
  if (!minEth.ok) return minEth;
  const maxEth = parseEthAmount(rest[2], 'max', limit);
  if (!maxEth.ok) return maxEth;
  if (maxEth.value <= 0) return fail('max must be greater than 0');
  if (minEth.value > maxEth.value) return fail(`min (${minEth.value}) must not exceed max (${maxEth.value})`);
  let fresh = true;
  let i = 3;
  const mode = rest[3]?.toLowerCase();
  if (mode === 'fresh' || mode === 'any') {
    fresh = mode === 'fresh';
    i = 4;
  }
  const name = rest.slice(i).join(' ').trim();
  if (name.length > 80) return fail('name is too long (max 80 characters)');
  const value: WatchArgs = { funder: funder.value, minEth: minEth.value, maxEth: maxEth.value, fresh };
  if (name) value.name = name;
  if (presetFromPlayId !== undefined) value.presetFromPlayId = presetFromPlayId;
  return ok(value);
}

// ---------------------------------------------------------------------------------------------
// /preset <playId> key=value …
// ---------------------------------------------------------------------------------------------

/** `undefined` value = remove the key (falls back to the schema default, if any). */
export interface PresetAssignment {
  path: string[];
  value: unknown;
  raw: string;
}

/** Short aliases accepted in /preset (documented in /help). */
export const PRESET_ALIASES: Record<string, string> = {
  buy: 'buyEth',
  tax: 'maxTaxBps',
  slippage: 'slippageBps',
  sl: 'stopLossPct',
  tp: 'takeProfits',
  timeout: 'timeoutSec',
  trail: 'trailing',
};

const KEY_PATH = /^[A-Za-z][A-Za-z0-9]*(\.(?:[A-Za-z][A-Za-z0-9]*|\d+))*$/;

/**
 * Coerce a raw value string: booleans, numbers, `none`/`null`/`unset` (remove), JSON arrays/objects,
 * and the take-profit shorthand `pct:sellPct,pct:sellPct` (e.g. `tp=100:50,200:100`).
 */
export function coerceValue(raw: string, key?: string): Parsed<unknown> {
  const s = raw.trim();
  if (s === '') return fail(`empty value${key ? ` for ${key}` : ''}`);
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'on' || lower === 'yes') return ok(true);
  if (lower === 'false' || lower === 'off' || lower === 'no') return ok(false);
  if (lower === 'none' || lower === 'null' || lower === 'unset' || lower === '-') return ok(undefined);
  if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return ok(Number(s));
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return ok(JSON.parse(s) as unknown);
    } catch {
      return fail(`invalid JSON${key ? ` for ${key}` : ''}`);
    }
  }
  if (/^\d+(\.\d+)?:\d+(\.\d+)?(,\d+(\.\d+)?:\d+(\.\d+)?)*$/.test(s)) {
    return ok(
      s.split(',').map((pair) => {
        const [pct, sellPct] = pair.split(':');
        return { pct: Number(pct), sellPct: Number(sellPct) };
      }),
    );
  }
  return ok(s);
}

export const PRESET_USAGE = '/preset <playId> key=value … (e.g. buyEth=0.05 trailing.activatePct=80 tp=100:50,200:100 timeoutSec=none trailing=off)';

export function parsePresetAssignments(tokens: string[]): Parsed<PresetAssignment[]> {
  if (tokens.length === 0) return fail(`usage: ${PRESET_USAGE}`);
  const out: PresetAssignment[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return fail(`expected key=value, got "${tok}"`);
    let key = tok.slice(0, eq).trim();
    const rawValue = tok.slice(eq + 1);
    if (!KEY_PATH.test(key)) return fail(`invalid key "${key}" (use dotted paths like trailing.activatePct)`);
    const [head, ...tail] = key.split('.');
    const alias = PRESET_ALIASES[head ?? ''];
    if (alias) key = [alias, ...tail].join('.');
    if (seen.has(key)) return fail(`${key} is set twice`);
    seen.add(key);
    const v = coerceValue(rawValue, key);
    if (!v.ok) return v;
    out.push({ path: key.split('.'), value: v.value, raw: tok });
  }
  return ok(out);
}
