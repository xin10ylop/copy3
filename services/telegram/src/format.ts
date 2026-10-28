/**
 * Display helpers for Telegram messages (HTML parse mode).
 *
 * Conventions: ETH with 4 decimals, USD with a $ sign, percentages always signed, market caps
 * in "k"/"M" USD (falling back to ETH when no ETH/USD rate is known), addresses shortened and
 * linked to the Robinhood Chain Blockscout explorer, tokens also linked to GMGN.
 */

export const DEFAULT_EXPLORER_URL = 'https://robinhoodchain.blockscout.com';
/** GMGN path segment for Robinhood Chain. Unverified (gmgn.ai blocks scripted access); override with GMGN_CHAIN. */
export const DEFAULT_GMGN_CHAIN = 'robinhood';

const WEI_PER_ETH = 10n ** 18n;

/** Escape the three characters Telegram's HTML parse mode treats specially. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for use inside an HTML attribute value (href). */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** wei (bigint) → ETH (number). Exact to ~1e-15 ETH, which is plenty for display. */
export function weiToEth(wei: bigint): number {
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / WEI_PER_ETH;
  const frac = abs % WEI_PER_ETH;
  const v = Number(whole) + Number(frac) / 1e18;
  return neg ? -v : v;
}

/** Parse a wei amount coming from postgres `numeric` (string), JSON (string/number) or bigint. */
export function toWei(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

/** ETH amount: number = ETH, bigint = wei. 4 decimals: `0.0700 ETH`. */
export function fmtEth(v: number | bigint | null | undefined, opts: { signed?: boolean; unit?: boolean } = {}): string {
  if (v === null || v === undefined) return '-';
  const eth = typeof v === 'bigint' ? weiToEth(v) : v;
  if (!Number.isFinite(eth)) return '-';
  const rounded = Math.round(eth * 1e4) / 1e4;
  const body = Math.abs(rounded).toFixed(4);
  const sign = rounded < 0 ? '-' : opts.signed ? '+' : '';
  return `${sign}${body}${opts.unit === false ? '' : ' ETH'}`;
}

/** USD: `$950.25`, `$12,345`, `$1.23M`; negative values keep their sign. */
export function fmtUsd(v: number | null | undefined, opts: { signed?: boolean } = {}): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  let body: string;
  if (abs >= 1e6) body = `${(abs / 1e6).toFixed(2)}M`;
  else if (abs >= 1000) body = Math.round(abs).toLocaleString('en-US');
  else body = abs.toFixed(2);
  const sign = v < 0 && abs >= 0.005 ? '-' : opts.signed ? '+' : '';
  return `${sign}$${body}`;
}

/** Percentage with explicit sign and one decimal: `+12.3%`, `-40.0%`, `+0.0%`. */
export function fmtPct(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const factor = 10 ** decimals;
  const rounded = Math.round(v * factor) / factor;
  const sign = rounded < 0 ? '-' : '+';
  return `${sign}${Math.abs(rounded).toFixed(decimals)}%`;
}

/** Basis points as a percentage: 618 → `6.18%` (unsigned, two decimals). */
export function fmtBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '-';
  return `${(bps / 100).toFixed(2)}%`;
}

/** Market cap in USD with k/M suffix: `$950`, `$12.3k`, `$1.25M`. */
export function fmtMcapK(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '-';
  const abs = Math.abs(usd);
  if (abs >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
  if (abs >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${Math.round(usd)}`;
}

/** Market cap given in ETH: USD k-format when the rate is known (`$12.3k (4.10 ETH)`), else ETH. */
export function fmtMcap(mcapEth: number | null | undefined, ethUsd: number | null | undefined): string {
  if (mcapEth === null || mcapEth === undefined || !Number.isFinite(mcapEth)) return '-';
  const eth = `${mcapEth.toFixed(2)} ETH`;
  if (ethUsd === null || ethUsd === undefined || !Number.isFinite(ethUsd) || ethUsd <= 0) return eth;
  return `${fmtMcapK(mcapEth * ethUsd)} (${eth})`;
}

/** Pons tokens have a fixed 1e9 supply: mcap(ETH) = price(ETH/token) × 1e9. */
export const TOKEN_SUPPLY = 1_000_000_000;
export function mcapEthFromPrice(priceEth: number | null | undefined): number | null {
  if (priceEth === null || priceEth === undefined || !Number.isFinite(priceEth)) return null;
  return priceEth * TOKEN_SUPPLY;
}

/** `45s`, `3m 12s`, `2h 05m`, `3d 4h`. */
export function fmtDuration(totalSec: number | null | undefined): string {
  if (totalSec === null || totalSec === undefined || !Number.isFinite(totalSec)) return '-';
  const s = Math.max(0, Math.round(totalSec));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/** Token amounts (18 decimals) → `3.87M`, `12.5k`, `950`. */
export function fmtTokens(units: bigint | null | undefined): string {
  if (units === null || units === undefined) return '-';
  const v = weiToEth(units);
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(2);
}

/** `0x1234…abcd` */
export function shortAddr(a: string): string {
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** `0xabcdef…1234` for tx hashes. */
export function shortHash(h: string): string {
  return /^0x[0-9a-fA-F]{64}$/.test(h) ? `${h.slice(0, 8)}…${h.slice(-4)}` : h;
}

/** Wall-clock time in one zone: `2026-10-28 15:20:05 EDT`. */
export function fmtTime(d: Date, tz = 'UTC'): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')} ${get('timeZoneName')}`;
}

/** `YYYY-MM-DD` of `d` in `tz`. */
export function localDate(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Local hour (0-23) of `d` in `tz`. */
export function localHour(d: Date, tz: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(d);
  return Number(h) % 24;
}

/** The instant of local midnight (start of the calendar day containing `d`) in `tz`. */
export function startOfLocalDay(d: Date, tz: string): Date {
  const [y, m, day] = localDate(d, tz).split('-').map(Number) as [number, number, number];
  // Guess UTC midnight of that date, then correct by the zone offset at that instant (twice for DST edges).
  let guess = Date.UTC(y, m - 1, day);
  for (let i = 0; i < 2; i++) {
    const offsetMs = zoneOffsetMs(new Date(guess), tz);
    guess = Date.UTC(y, m - 1, day) - offsetMs;
  }
  return new Date(guess);
}

function zoneOffsetMs(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(d);
  const get = (t: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(d.getTime() / 1000) * 1000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

export interface LinkConfig {
  explorerUrl: string;
  gmgnChain: string;
}

export const DEFAULT_LINKS: LinkConfig = { explorerUrl: DEFAULT_EXPLORER_URL, gmgnChain: DEFAULT_GMGN_CHAIN };

export function anchor(url: string, text: string): string {
  return `<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`;
}

export class Links {
  readonly explorer: string;
  readonly gmgnChain: string;

  constructor(cfg: LinkConfig = DEFAULT_LINKS) {
    this.explorer = cfg.explorerUrl.replace(/\/+$/, '');
    this.gmgnChain = cfg.gmgnChain;
  }

  addressUrl(a: string): string {
    return `${this.explorer}/address/${a}`;
  }
  tokenUrl(a: string): string {
    return `${this.explorer}/token/${a}`;
  }
  txUrl(h: string): string {
    return `${this.explorer}/tx/${h}`;
  }
  gmgnUrl(token: string): string {
    return `https://gmgn.ai/${this.gmgnChain}/token/${token}`;
  }

  /** `<a>0x1234…abcd</a>` linked to the explorer address page. */
  address(a: string | null | undefined): string {
    if (!a) return '-';
    return anchor(this.addressUrl(a), shortAddr(a));
  }
  /** `<a>0xabcdef…1234</a>` linked to the explorer tx page. */
  tx(h: string | null | undefined): string {
    if (!h) return '-';
    return anchor(this.txUrl(h), shortHash(h));
  }
  /** `NAME ($SYM)` + `[scan] [gmgn]` links. */
  token(token: string, name?: string | null, symbol?: string | null): string {
    const label = name ? `${name}${symbol ? ` ($${symbol})` : ''}` : shortAddr(token);
    return `<b>${escapeHtml(label)}</b> ${anchor(this.tokenUrl(token), 'scan')} · ${anchor(this.gmgnUrl(token), 'gmgn')}`;
  }
}

/** Telegram hard limit is 4096 characters per message; leave room for a truncation marker. */
export const TELEGRAM_MAX_TEXT = 4096;

/** Split long text on line boundaries into chunks of at most `max` characters. */
export function splitMessage(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    const piece = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    if (cur.length + piece.length + 1 > max) {
      if (cur) out.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Plain-text truncation (for summaries we escape afterwards). */
export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
