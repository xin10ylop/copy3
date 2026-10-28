/**
 * Pure clustering for the scout: group recent runners by shared on-chain fingerprint
 * (deployer, team/exempt wallets, funders of the deployer or team wallets, and the
 * creator of a disperse contract that did the funding) with union-find, then drop the
 * clusters an existing play already covers.
 */
import type { PlayTrigger } from './deps.js';
import { matchTrigger, type LaunchContext } from './trigger.js';

/** Infra that funds or touches everyone and must never link two operators (RESEARCH §3). */
export const INFRA_ADDRESSES: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', // PonsV2LaunchFactory
  '0xe33e9e479df8802cb0866d5d05258bec4cf62948', // PonsV2LaunchAndBuy
  '0x3711cea4feade896c913c68f01eda97cb06d1a42', // launch deployer
  '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc', // trade router
  '0x8366a39cc670b4001a1121b8f6a443a643e40951', // v4 PoolManager
  '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e', // fee escrow
  '0x42df2a798f82289e177311362e8f5ccc45c1219c', // buyback vault
];

export interface RunnerFingerprint {
  token: string;
  name: string | null;
  ts: number;
  peakPct: number | null;
  deployer: string;
  teamWallets: string[];
  /** first funders of the deployer and team wallets, plus creators of funding contracts */
  funders: string[];
  /** the deployer's own first funder, for display */
  deployerFunder: string | null;
}

export function fingerprintOf(ctx: LaunchContext, runner: { ts: number; peakPct: number | null }): RunnerFingerprint {
  const funders = new Set<string>();
  for (const f of ctx.fundings) {
    if (f.funder) funders.add(f.funder);
    if (f.funderCreator) funders.add(f.funderCreator);
  }
  return {
    token: ctx.token,
    name: ctx.name,
    ts: runner.ts,
    peakPct: runner.peakPct,
    deployer: ctx.deployer,
    teamWallets: [...ctx.teamWallets],
    funders: [...funders],
    deployerFunder: ctx.fundings.find((f) => f.role === 'deployer')?.funder ?? null,
  };
}

export interface RunnerCluster {
  key: string;
  tokens: RunnerFingerprint[];
  sharedFunders: string[];
  sharedTeamWallets: string[];
  sharedDeployers: string[];
  covered: boolean;
  coveredBy: number[];
}

export interface PlayCoverage {
  playId: number;
  trigger: PlayTrigger;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let p = this.parent.get(x) ?? x;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function shared(values: readonly string[][]): string[] {
  const counts = new Map<string, number>();
  for (const vs of values) for (const v of new Set(vs)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].filter(([, n]) => n >= 2).map(([v]) => v).sort();
}

export function clusterRunners(
  rows: readonly RunnerFingerprint[],
  opts: { ignore?: readonly string[]; plays?: readonly PlayCoverage[]; contexts?: ReadonlyMap<string, LaunchContext>; minSize?: number } = {},
): RunnerCluster[] {
  const ignore = new Set([...INFRA_ADDRESSES, ...(opts.ignore ?? [])].map((a) => a.toLowerCase()));
  const uf = new UnionFind();
  const keysOf = (r: RunnerFingerprint): string[] => [
    `d:${r.deployer}`,
    ...r.teamWallets.filter((w) => !ignore.has(w)).map((w) => `t:${w}`),
    ...r.funders.filter((f) => !ignore.has(f)).map((f) => `f:${f}`),
  ];
  for (const r of rows) {
    uf.find(`tok:${r.token}`);
    for (const k of keysOf(r)) if (!k.endsWith(':')) uf.union(`tok:${r.token}`, k);
  }
  const groups = new Map<string, RunnerFingerprint[]>();
  for (const r of rows) {
    const root = uf.find(`tok:${r.token}`);
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }

  const playKeys = new Map<string, number[]>();
  for (const p of opts.plays ?? []) {
    const keys = [
      ...(p.trigger.armedWallet?.funders ?? []).map((f) => `f:${f.toLowerCase()}`),
      ...(p.trigger.deployerIn ?? []).map((d) => `d:${d.toLowerCase()}`),
      ...(p.trigger.teamWalletsAny ?? []).map((t) => `t:${t.toLowerCase()}`),
    ];
    for (const k of keys) playKeys.set(k, [...(playKeys.get(k) ?? []), p.playId]);
  }

  const out: RunnerCluster[] = [];
  for (const tokens of groups.values()) {
    if (tokens.length < (opts.minSize ?? 1)) continue;
    tokens.sort((a, b) => a.ts - b.ts);
    const coveredBy = new Set<number>();
    for (const t of tokens) {
      for (const k of keysOf(t)) for (const id of playKeys.get(k) ?? []) coveredBy.add(id);
      const ctx = opts.contexts?.get(t.token);
      if (ctx) for (const p of opts.plays ?? []) if (matchTrigger(ctx, p.trigger).matched) coveredBy.add(p.playId);
    }
    out.push({
      key: tokens[0]!.token,
      tokens,
      sharedFunders: shared(tokens.map((t) => t.funders.filter((f) => !ignore.has(f)))),
      sharedTeamWallets: shared(tokens.map((t) => t.teamWallets.filter((w) => !ignore.has(w)))),
      sharedDeployers: shared(tokens.map((t) => [t.deployer])),
      covered: coveredBy.size > 0,
      coveredBy: [...coveredBy].sort((a, b) => a - b),
    });
  }
  const best = (c: RunnerCluster): number => Math.max(...c.tokens.map((t) => t.peakPct ?? 0));
  return out.sort((a, b) => b.tokens.length - a.tokens.length || best(b) - best(a));
}
