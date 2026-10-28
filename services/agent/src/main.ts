/**
 * CLI:
 *   tsx src/main.ts play <ca> [--hint "text"]
 *   tsx src/main.ts scout [--since-minutes N] [--min-peak N] [--max-clusters N]
 *   tsx src/main.ts backtest <playId> [--since-days N]
 *   tsx src/main.ts serve            (scout every SCOUT_INTERVAL_MIN, /healthz on AGENT_HEALTH_PORT)
 */
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { loadEnv } from './config.js';
import { createAgentDeps, runBacktest, runPlayFinder, runScout } from './runner.js';

const USAGE = `usage:
  agent play <ca> [--hint "text"]
  agent scout [--since-minutes N] [--min-peak N] [--max-clusters N]
  agent backtest <playId> [--since-days N]
  agent serve`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      hint: { type: 'string' },
      'since-minutes': { type: 'string' },
      'min-peak': { type: 'string' },
      'max-clusters': { type: 'string' },
      'since-days': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd) {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  const env = loadEnv();
  const deps = createAgentDeps(env);
  const { logger } = deps;
  const numOpt = (v: string | undefined, def: number): number => (v === undefined ? def : Number(v));

  try {
    switch (cmd) {
      case 'play': {
        if (!arg) throw new Error('play needs a token address');
        const r = await runPlayFinder({ ca: arg, hint: values.hint }, deps);
        console.log(JSON.stringify({ runId: r.runId, stop: r.stop, reportPath: r.reportPath, csvPath: r.csvPath, playIds: r.proposedPlays.map((p) => p.playId), costUsd: r.costUsd }, null, 2));
        console.log(`\n${r.summary}`);
        return r.stop === 'error' ? 2 : 0;
      }
      case 'scout': {
        const r = await runScout(
          {
            sinceMinutes: numOpt(values['since-minutes'], env.SCOUT_SINCE_MIN ?? Math.ceil(env.SCOUT_INTERVAL_MIN * 2)),
            minPeak10Pct: numOpt(values['min-peak'], env.SCOUT_MIN_PEAK10_PCT),
            maxClusters: values['max-clusters'] === undefined ? undefined : Number(values['max-clusters']),
          },
          deps,
        );
        console.log(r.summary);
        console.log(`report: ${r.reportPath}`);
        return 0;
      }
      case 'backtest': {
        const id = Number(arg);
        if (!Number.isInteger(id) || id <= 0) throw new Error('backtest needs a numeric play id');
        const r = await runBacktest({ playId: id, sinceDays: values['since-days'] === undefined ? undefined : Number(values['since-days']) }, deps);
        console.log(r.summary);
        console.log(`report: ${r.reportPath}${r.csvPath ? `\ncsv: ${r.csvPath}` : ''}`);
        return 0;
      }
      case 'serve':
        return await serve(env, deps);
      default:
        console.error(USAGE);
        return 1;
    }
  } finally {
    if (cmd !== 'serve') await deps.sql.end({ timeout: 5 });
    logger.flush();
  }
}

async function serve(env: ReturnType<typeof loadEnv>, deps: ReturnType<typeof createAgentDeps>): Promise<number> {
  const { logger } = deps;
  const intervalMs = env.SCOUT_INTERVAL_MIN * 60_000;
  const sinceMinutes = env.SCOUT_SINCE_MIN ?? Math.ceil(env.SCOUT_INTERVAL_MIN * 2);
  let lastOk: string | null = null;
  let lastError: string | null = null;
  let running = false;
  let stopped = false;

  const health = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, lastScout: lastOk, lastError, running }));
    } else {
      res.writeHead(404).end();
    }
  });
  if (env.AGENT_HEALTH_PORT > 0) health.listen(env.AGENT_HEALTH_PORT);

  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const r = await runScout({ sinceMinutes, minPeak10Pct: env.SCOUT_MIN_PEAK10_PCT }, deps);
      lastOk = new Date().toISOString();
      lastError = null;
      logger.info({ summary: r.summary, costUsd: r.costUsd }, 'scout pass');
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err: lastError }, 'scout pass failed');
    } finally {
      running = false;
    }
  };

  logger.info({ intervalMin: env.SCOUT_INTERVAL_MIN, sinceMinutes }, 'agent serve: scout loop started');
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      stopped = true;
      clearInterval(timer);
      health.close();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  while (running) await new Promise((r) => setTimeout(r, 250));
  await deps.sql.end({ timeout: 5 });
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
