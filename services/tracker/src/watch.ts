/**
 * Build a play from a funder spec (Telegram `/watch <funder> <min> <max> [fresh] [play]`),
 * the equivalent of Packet Tracker "watch this funder and arm fresh wallets it funds".
 */
import { parsePlay, type Play, type Preset } from '@hood/core';

export interface WatchSpec {
  funder: string | readonly string[];
  minEth: number;
  maxEth: number;
  /** only arm fresh recipients (no prior transfers, nonce 0); default true */
  fresh?: boolean;
  name?: string;
  /** preset overrides (e.g. cloned from another play); defaults from @hood/core */
  preset?: Partial<Preset>;
  /** also match transfers from contracts the funder created / disperse txs it sent; default true */
  contractMode?: boolean;
  /** armed candidate lifetime; default 48 h */
  maxAgeSec?: number;
  /** default true: the admin explicitly asked to watch (execution is still gated by EXECUTION_MODE) */
  enabled?: boolean;
  operatorId?: number;
  createdBy?: string;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u;

export function buildWatchPlay(spec: WatchSpec): Play {
  const funders = (typeof spec.funder === 'string' ? [spec.funder] : [...spec.funder]).map((f) => f.trim());
  if (funders.length === 0) throw new Error('at least one funder is required');
  for (const f of funders) if (!ADDRESS_RE.test(f)) throw new Error(`invalid funder address: ${f}`);
  if (!Number.isFinite(spec.minEth) || !Number.isFinite(spec.maxEth) || spec.minEth < 0) {
    throw new Error('minEth/maxEth must be finite and >= 0');
  }
  if (spec.minEth > spec.maxEth) throw new Error(`minEth (${spec.minEth}) > maxEth (${spec.maxEth})`);
  const short = `${funders[0]!.slice(0, 6)}…${funders[0]!.slice(-4)}`.toLowerCase();
  return parsePlay({
    name: spec.name ?? `watch ${short} ${spec.minEth}-${spec.maxEth} ETH`,
    enabled: spec.enabled ?? true,
    ...(spec.operatorId !== undefined ? { operatorId: spec.operatorId } : {}),
    ...(spec.createdBy !== undefined ? { createdBy: spec.createdBy } : {}),
    trigger: {
      armedWallet: {
        funders,
        minEth: spec.minEth,
        maxEth: spec.maxEth,
        freshOnly: spec.fresh ?? true,
        maxAgeSec: spec.maxAgeSec ?? 48 * 3600,
        contractMode: spec.contractMode ?? true,
      },
      launchKind: 'any',
      require: ['armedWallet'],
    },
    preset: spec.preset ?? {},
  });
}

export interface WatchCommand {
  spec: WatchSpec;
  /** the optional trailing [play] argument: id or name of a play whose preset to clone */
  presetFrom: string | null;
}

/** Parse the arguments of `/watch <funder> <min> <max> [fresh|any] [play]`. */
export function parseWatchCommand(args: readonly string[]): WatchCommand {
  const [funder, min, max, ...rest] = args.map((a) => a.trim()).filter((a) => a.length > 0);
  if (!funder || min === undefined || max === undefined) throw new Error('usage: /watch <funder> <minEth> <maxEth> [fresh|any] [play]');
  const minEth = Number(min);
  const maxEth = Number(max);
  if (Number.isNaN(minEth) || Number.isNaN(maxEth)) throw new Error('minEth/maxEth must be numbers');
  let fresh = true;
  let i = 0;
  const flag = rest[0]?.toLowerCase();
  if (flag === 'fresh' || flag === 'any' || flag === 'all') {
    fresh = flag === 'fresh';
    i = 1;
  }
  const presetFrom = rest.slice(i).join(' ') || null;
  const spec: WatchSpec = { funder, minEth, maxEth, fresh };
  buildWatchPlay(spec); // validate early
  return { spec, presetFrom };
}
