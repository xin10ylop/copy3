/**
 * Seed the always-on layer (idempotent; safe to re-run after every deploy):
 *
 *  - operator `generic` (status `active`): owner of the fingerprint plays that need no human;
 *  - play `team-buy-0.1` (ENABLED): `{ launchSecond: { minTeamBuyEth: 0.1 } }` — a tax-exempt
 *    non-deployer wallet bought ≥ 0.1 ETH in the launch second. docs/BACKTEST.md #2: +0.0058 ETH
 *    (+8.3 %) per 0.07 ETH snipe over 268 launches, positive on every out-of-sample day;
 *  - play `team-buy-0.05` (disabled): the broader threshold, not backtested on its own;
 *  - settings `kill_switch` (off) and `auto_approve` (the scout's auto-approval policy), only when
 *    absent — a kill switch someone turned on is never turned off by a seed.
 *
 * Plays are matched by NAME: an existing play is left untouched (its preset may have been refit
 * by the nightly job or tuned with /preset, and a human may have disabled it).
 *
 * "enabled" is harmless while the sniper runs with EXECUTION_MODE=paper (the default): enabled
 * plays then only produce paper snipes. They trade real money only once the executor is switched
 * to live (docs/RUNBOOK.md §7-8).
 *
 * CLI: `pnpm --filter @hood/db seed` (uses DATABASE_URL; run `migrate` first).
 */
import { fileURLToPath } from 'node:url';
import { PlayTriggerSchema, parsePreset, type PlayTrigger, type Preset } from '@hood/core';
import type { Sql } from './sql.js';

export const GENERIC_OPERATOR = 'generic';

/** settings.auto_approve: the scout enables a proposed play when its backtest clears every bar. */
export interface AutoApprovePolicy {
  enabled: boolean;
  /** backtested snipes (entered) on the evidence coins, at least */
  minCoins: number;
  /** mean PnL per snipe (ETH), at least */
  minExpectancyEth: number;
  /** share of winning snipes (0..1), at least */
  minWinRate: number;
  /** never auto-approve when this many plays are already enabled */
  maxConcurrentPlays: number;
}

export const DEFAULT_AUTO_APPROVE: AutoApprovePolicy = {
  enabled: true,
  minCoins: 10,
  minExpectancyEth: 0.002,
  minWinRate: 0.35,
  maxConcurrentPlays: 20,
};

/** Kill switch "off" in the shape the telegram bot writes (services/telegram parseKillState). */
export const KILL_SWITCH_OFF = { on: false, reason: null, by: 'seed', at: null } as const;

/**
 * The backtested preset (Preset defaults = Backtest #2 walk-forward: no fixed TP, trailing 50/20,
 * SL 40 %, timeout 60 s, exit on the first exempt transfer-out) with the two risk fields a generic
 * play needs to work every day: `stopAfter` effectively unlimited (MAX_CONCURRENT and the daily
 * loss limit are the real caps) and `firstBuyOnly: false` (the backtest traded every launch of a
 * repeat deployer, e.g. the operator with 201 launches in 62 h).
 */
export function genericPreset(): Preset {
  return parsePreset({ stopAfter: 1_000_000, firstBuyOnly: false });
}

export interface SeedPlay {
  name: string;
  enabled: boolean;
  trigger: PlayTrigger;
  preset: Preset;
  stats: Record<string, unknown>;
}

export function seedPlays(): SeedPlay[] {
  return [
    {
      name: 'team-buy-0.1',
      enabled: true,
      trigger: PlayTriggerSchema.parse({ launchSecond: { minTeamBuyEth: 0.1 } }),
      preset: genericPreset(),
      stats: {
        source: 'backtest#2',
        segment: 'exempt non-deployer wallet bought >= 0.1 ETH in the launch second',
        backtest: { n: 268, winRate: 0.46, expectancyEth: 0.0058, totalEth: 1.56, buyEth: 0.07, preset: 'video (TP150, trail 100/25, SL40, t/o 60)' },
        walkForward: [
          { testDay: '2026-10-27', n: 95, expectancyEth: 0.0041 },
          { testDay: '2026-10-28', n: 86, expectancyEth: 0.0062 },
        ],
        caveat: 'first-in-block fill assumed; if last in block: -0.0009 ETH per snipe',
      },
    },
    {
      name: 'team-buy-0.05',
      enabled: false,
      trigger: PlayTriggerSchema.parse({ launchSecond: { minTeamBuyEth: 0.05 } }),
      preset: genericPreset(),
      stats: {
        source: 'backtest#2',
        segment: 'exempt non-deployer wallet bought >= 0.05 ETH in the launch second',
        note: 'between the "any team buy" (+0.0026/snipe, n=448) and "team buy >= 0.1" (+0.0058, n=268) segments; not backtested at 0.05 itself. Enable once the nightly refit shows a positive expectancy.',
      },
    },
  ];
}

export interface SeedResult {
  operatorId: number;
  operatorCreated: boolean;
  playsCreated: string[];
  playsExisting: string[];
  settingsCreated: string[];
}

const J = (v: unknown): string => JSON.stringify(v ?? null);

/** Idempotent seed (one transaction). */
export async function seed(sql: Sql, opts: { plays?: SeedPlay[]; autoApprove?: AutoApprovePolicy } = {}): Promise<SeedResult> {
  const plays = opts.plays ?? seedPlays();
  return sql.begin(async (tx) => {
    let operatorCreated = false;
    let op = await tx.query<{ id: number | string }>('SELECT id FROM operators WHERE name = $1 ORDER BY id LIMIT 1', [GENERIC_OPERATOR]);
    if (!op[0]) {
      op = await tx.query<{ id: number | string }>(
        `INSERT INTO operators (name, notes, status, created_by) VALUES ($1, $2, 'active', 'seed') RETURNING id`,
        [GENERIC_OPERATOR, 'Fingerprint plays that need no operator identity (launch-second team buys). Seeded by @hood/db seed.'],
      );
      operatorCreated = true;
    }
    const operatorId = Number(op[0]!.id);

    const playsCreated: string[] = [];
    const playsExisting: string[] = [];
    for (const p of plays) {
      const found = await tx.query<{ id: number | string }>('SELECT id FROM plays WHERE name = $1 ORDER BY id LIMIT 1', [p.name]);
      if (found[0]) {
        playsExisting.push(p.name);
        continue;
      }
      await tx.query(
        `INSERT INTO plays (operator_id, name, enabled, trigger, preset, created_by, stats)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'seed', $6::jsonb)`,
        [operatorId, p.name, p.enabled, J(p.trigger), J(p.preset), J(p.stats)],
      );
      playsCreated.push(p.name);
    }

    const settingsCreated: string[] = [];
    const defaults: [string, unknown][] = [
      ['kill_switch', KILL_SWITCH_OFF],
      ['auto_approve', opts.autoApprove ?? DEFAULT_AUTO_APPROVE],
    ];
    for (const [key, value] of defaults) {
      const rows = await tx.query<{ key: string }>(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key`,
        [key, J(value)],
      );
      if (rows[0]) settingsCreated.push(key);
    }
    return { operatorId, operatorCreated, playsCreated, playsExisting, settingsCreated };
  });
}

/** CLI entry: connect via DATABASE_URL, seed, report, exit. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const { createDb } = await import('./index.js');
  const db = createDb(url, { max: 1 });
  try {
    const r = await seed(db);
    console.log(`operator ${GENERIC_OPERATOR}: id ${r.operatorId}${r.operatorCreated ? ' (created)' : ''}`);
    console.log(`plays created: ${r.playsCreated.join(', ') || '-'}; already present (left as is): ${r.playsExisting.join(', ') || '-'}`);
    console.log(`settings created: ${r.settingsCreated.join(', ') || '-'} (existing settings are never overwritten)`);
    console.log('note: with EXECUTION_MODE=paper (default) enabled plays only paper-trade until the executor is switched to live.');
  } finally {
    await db.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
