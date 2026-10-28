import { parseArgs } from 'node:util';

export interface BackfillArgs {
  from: number | null;
  to: number | 'latest';
  sinceDays: number | null;
  chunk: number;
  mode: 'logs' | 'blocks';
  tokenTransfers: boolean;
  tokenWindowHours: number;
  addressBatch: number;
  dryRun: boolean;
}

const posInt = (name: string, v: string | undefined, def: number): number => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer, got ${v}`);
  return n;
};

export const BACKFILL_USAGE = `usage: pnpm --filter @hood/indexer backfill (--from <block> | --since-days <n>) [--to <block|latest>]
       [--chunk 20000] [--mode logs|blocks] [--no-token-transfers] [--token-window-hours 24]
       [--address-batch 100] [--dry-run]`;

export function parseBackfillArgs(argv: string[]): BackfillArgs {
  const { values } = parseArgs({
    args: argv.filter((a) => a !== '--'),
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      'since-days': { type: 'string' },
      chunk: { type: 'string' },
      mode: { type: 'string' },
      'no-token-transfers': { type: 'boolean' },
      'token-window-hours': { type: 'string' },
      'address-batch': { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    strict: true,
  });
  const from = values.from !== undefined ? posInt('from', values.from, 0) : null;
  const sinceDaysRaw = values['since-days'];
  const sinceDays = sinceDaysRaw !== undefined ? Number(sinceDaysRaw) : null;
  if (sinceDays !== null && (!Number.isFinite(sinceDays) || sinceDays <= 0)) throw new Error('--since-days must be > 0');
  if (from === null && sinceDays === null) throw new Error(`--from or --since-days is required\n${BACKFILL_USAGE}`);
  if (from !== null && sinceDays !== null) throw new Error('use either --from or --since-days');
  const to = values.to === undefined || values.to === 'latest' ? 'latest' : posInt('to', values.to, 0);
  if (from !== null && to !== 'latest' && to < from) throw new Error('--to must be >= --from');
  const chunk = posInt('chunk', values.chunk, 20_000);
  if (chunk < 1 || chunk > 20_000) throw new Error('--chunk must be in [1, 20000]');
  const mode = values.mode ?? 'logs';
  if (mode !== 'logs' && mode !== 'blocks') throw new Error('--mode must be logs or blocks');
  return {
    from,
    to,
    sinceDays,
    chunk,
    mode,
    tokenTransfers: !values['no-token-transfers'],
    tokenWindowHours: posInt('token-window-hours', values['token-window-hours'], 24),
    addressBatch: Math.max(1, posInt('address-batch', values['address-batch'], 100)),
    dryRun: values['dry-run'] ?? false,
  };
}
