# @hood/agent - AI play finder, scout and backtester

The agent replicates the video's Claude "play finder" skill on our own indexed data.

* **`play <ca>`**: starts from one coin and unravels the operator behind it:
  * the deployer and its other launches;
  * the funding path, including sprayer/disperse contracts;
  * the exempt "team" wallets, plus the dump wallet they transfer tokens to and the treasury the ETH goes to;
  * the funder's other children and the decoys;
  * the first taxed buyer's entry and the peaks at 2/5/10/30/60 s.

  It writes a **CSV** and a **markdown report**, and proposes a **play** (a watch rule plus a preset) for approval in Telegram.
* **`scout`**: finds recent runners (peak10 ≥ X %) and clusters them in SQL by shared funder, deployer and team wallets. It runs the model only on clusters that no existing play covers.
* **`backtest <playId>`**: a deterministic backtest of a stored play (no model call, cost 0). It runs a grid search over TP, trailing, SL and timeout, writes a report and CSV, and updates `plays.stats`.
* **Auto-approval** (after every scout pass, `src/autopilot.ts`): a proposed play whose backtest clears `settings.auto_approve` (`{enabled, minCoins: 10, minExpectancyEth: 0.002, minWinRate: 0.35, maxConcurrentPlays: 20}`, seeded by `pnpm --filter @hood/db seed`) is enabled at once (operator → `active`, `play_auto_approved` event); the others wait for the Telegram buttons. `/play <ca>` results are never auto-approved.
* **`nightly`** (also scheduled by `serve` at `NIGHTLY_HOUR_UTC`): for every enabled play, re-backtest over the last `REFIT_DAYS` of launches matching its trigger (`launchesMatchingTrigger`, launch-second fingerprint included), refit the exits with `gridSearch` (≥ `REFIT_MIN_COINS` snipes; written when better by more than `REFIT_MARGIN_ETH`), disable it when the rolling realised expectancy of its last `ROLLING_TRADES` closed snipes (paper or live, ≥ `DISABLE_MIN_TRADES`) or the refit expectancy is ≤ 0, and on generic fingerprint plays add `deployerNotIn` / `teamWalletsNotIn` entries for operators whose last `BLACKLIST_MIN_LAUNCHES` matching launches all lost. Events: `play_refit`, `play_auto_disabled`, `operator_blacklisted`, `nightly_finished`.

The model is `claude-opus-5-5` with:
* adaptive thinking (`display: "summarized"`) and `output_config.effort: "high"`;
* a streaming tool runner with `betaZodTool` tools (`eager_input_streaming`);
* server-side refusal fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`);
* no forced `tool_choice`;
* prompt caching: an explicit breakpoint on the static system prompt, plus automatic caching of the growing conversation tail.

## Files

| File | What |
|---|---|
| `src/prompts.ts` | System prompt: the hunting method and the verified Pons V2 facts. It is stable and contains no per-run data, so it caches. It also builds the per-run user messages. |
| `src/tools.ts` | 18 tools: the 16 in SPEC §3 plus `get_token_transfers` and `get_exempt_flow`. |
| `src/queries.ts` | Typed SQL (tagged templates) against the schema in `packages/db/migrations`. |
| `src/db.ts` | Tagged-template layer over `@hood/db`'s driver-agnostic `Sql` (postgres.js in production, PGlite in tests). |
| `src/backtest.ts` | Pure simulator (`simulateSnipe`, `backtestPlay`, `gridSearch`, `derivePresetFromPeaks`). |
| `src/report.ts` | CSV (exact SPEC columns) and the markdown report template. |
| `src/trigger.ts`, `src/scout.ts` | Pure trigger matching (SPEC §4 semantics) and runner clustering. |
| `src/runner.ts` | `runPlayFinder`, `runScout`, `runBacktest`: the loop, limits, cost accounting and run records. |
| `src/main.ts` | CLI. |

## Environment

| Var | Default | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Optional when another credential is configured: the SDK also reads `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile. |
| `DATABASE_URL` | required | Postgres with migration `0001_init.sql` applied. |
| `NODE_HTTP` | - | RPC for live balances in `get_wallet`. Without it, balances are `null`. |
| `REPORTS_DIR` | `./reports` | CSV and report files are named `<yyyymmdd-hhmmss>-<slug>.csv/.md` (UTC). |
| `LOG_LEVEL` | `info` | pino. `debug` also logs thinking summaries. |
| `AGENT_MAX_ROUNDS` | `60` | Model turns per run. At 75 % of the limit, tool results carry a `budget_notice` asking the model to finish. |
| `AGENT_MAX_COST_USD` | `8` | Stops before the next turn once reached. |
| `SCOUT_INTERVAL_MIN` | `15` | `serve` loop period. |
| `SCOUT_SINCE_MIN` | 2 × interval | Look-back window of each scout pass. |
| `SCOUT_MIN_PEAK10_PCT` | `100` | Runner threshold (peak within 10 s of the first taxed entry). |
| `SCOUT_MAX_CLUSTERS` | `2` | New clusters investigated by the model per pass. |
| `SCOUT_MIN_CLUSTER_SIZE` | `2` | Clusters with fewer runners than this are ignored. |
| `SCOUT_IGNORE` | - | Comma list of hub addresses (exchange hot wallets…) that must not link operators. Pons infra is ignored automatically. |
| `AGENT_HEALTH_PORT` | `9470` | `serve` exposes `GET /healthz`. |
| `NIGHTLY_HOUR_UTC` | `3` | Hour (UTC) of the nightly job in `serve`; `-1` = off. |
| `REFIT_DAYS` | `3` | Look-back of the nightly re-backtest. |
| `REFIT_MIN_COINS` | `20` | Simulated snipes needed for a refit and for a refit-based disable. |
| `REFIT_MARGIN_ETH` | `0.0005` | A refit preset must beat the current one by more than this per snipe. |
| `ROLLING_TRADES` | `30` | Realised snipes in the rolling expectancy. |
| `DISABLE_MIN_TRADES` | `10` | Realised snipes needed before the rolling expectancy can disable a play. |
| `BLACKLIST_MIN_LAUNCHES` | `5` | Generic plays: blacklist an operator whose last N matching launches all lost. |

## Commands

```bash
pnpm --filter @hood/agent play 0xa7a7c2f7cea8f9bb3b5b85802f0cd844fa9b7586 --hint "video coin"
pnpm --filter @hood/agent scout --since-minutes 60 --min-peak 100
pnpm --filter @hood/agent backtest 12 --since-days 30
pnpm --filter @hood/agent start nightly     # refit / auto-disable / blacklist once, now
pnpm --filter @hood/agent serve
pnpm --filter @hood/agent typecheck
pnpm --filter @hood/agent test
```

Every model run always returns a report path and a CSV path. If the model stops early (refusal, round or cost cap, or error), the runner writes them deterministically from the coins the model looked at.

## Cost per run (estimates, Opus 5.5 at $4 / $20 per MTok, cache reads $0.20, 5-minute cache writes $5)

* The cached prefix is about 9.5k tokens: the system prompt (~2.3k) and the 18 tool schemas (~7.2k). It is written once per run and then read on every turn.
* A typical `play` run takes 20-40 turns. Tool results are capped at 40k characters and usually run 0.5-3k tokens. Context grows to about 40-60k tokens by the end.
* Per turn, roughly:
  * cache read of the history, ~30k × $0.20/M ≈ $0.006;
  * cache write of the new tail, ~2k × $5/M ≈ $0.01;
  * output (thinking + tool input), ~1-2k × $20/M ≈ $0.02-0.04.
* So a play run is about **$1-2** typical, with ~$3 for a long investigation. It is hard-capped by `AGENT_MAX_COST_USD`.
* `scout`: the SQL pass is free. Each investigated cluster costs about one play run, so a pass costs at most `SCOUT_MAX_CLUSTERS` × the per-run cap.
* `backtest`: $0, no model call.

The exact cost is computed from `usage`, and `usage.iterations` when a fallback ran. Each attempt is priced at the rates of the model that served it. The result is stored in `agent_runs.cost_usd`. The token breakdown and the tool-call log are in `agent_runs.input.meta`.

## How a proposed play reaches Telegram

1. `propose_play` validates the trigger with core's `PlayTriggerSchema`. It merges the preset patch into core's defaults and validates it with `PresetSchema`. It rejects triggers that have no condition.
2. It backtests the play on the evidence coins.
3. In one transaction it writes:
   * `operators` (`status='candidate'`, `created_by='agent'`);
   * `plays` (`enabled=false`, `trigger`, `preset`, and `stats = { pattern, evidenceCoins, triggerMatches, dateRange, backtest, runId }`);
   * an `events` row: `source='agent'`, `type='play_proposed'`, payload `{ playId, operatorId, runId, name, operator, summary, needsApproval: true }`.

   The `plays` NOTIFY trigger from migration 0001 also announces the play on `plays_changed`.
4. Telegram tails `events` and shows approve/reject buttons for `play_proposed`:
   * approve: `update plays set enabled = true` and `update operators set status = 'active'`;
   * reject: leave the play disabled, or set the operator to `retired`.

   The sniper only arms enabled plays.
5. Runs also emit `agent_run_finished` (with report/CSV paths, cost and play ids), `scout_finished` and `backtest_finished` events.

### API for services/telegram

```ts
import { runPlayFinder, runScout, runBacktest, createAgentDeps, setDefaultDeps } from '@hood/agent';

runPlayFinder(args: { ca: string; hint?: string }, deps?: Partial<AgentDeps>): Promise<RunResult>
runScout(args: { sinceMinutes: number; minPeak10Pct: number; maxClusters?: number }, deps?: Partial<AgentDeps>): Promise<ScoutResult>
runBacktest(args: { playId: number; sinceDays?: number }, deps?: Partial<AgentDeps>): Promise<BacktestRunResult>

// share telegram's @hood/db connection and logger (optional; otherwise deps come from env on first use)
setDefaultDeps(createAgentDeps(loadEnv(), { sql: hoodSql, logger }));
```

`RunResult` has these fields:
* `runId` and `kind`;
* `reportPath` and `csvPath`;
* `proposedPlay?` and `proposedPlays`;
* `summary`, which is ≤ 10 lines from the model plus stop notes;
* `costUsd`, `rounds` and `usage`;
* `stop`: `end_turn | refusal | max_rounds | budget | max_tokens | error`;
* `error?`.

`runPlayFinder` throws only on an invalid CA. API errors are recorded and returned as `stop: 'error'`.

## How to add a tool

1. Add the SQL to `src/queries.ts`:
   * return ETH as float (`value::float8 / 1e18`) and time as unix seconds;
   * paginate with `pageOf` / `paged` (≤ 200 rows).
2. Define the tool in `buildTools` (`src/tools.ts`) with `tool(ctx, name, description, zodSchema, run)`:
   * use `addressSchema` for every address;
   * keep schemas free of `.transform()`, because `betaZodTool` renders them to JSON Schema;
   * say in the description **when** to call it.
3. Append the tool to the returned array **and** to `TOOL_NAMES` at the end. The tool list is part of the cached prefix, so changing the order invalidates the cache.
4. If the tool changes the method, mention it in `SYSTEM_PROMPT`. Keep the prompt free of per-run data.
5. Add tests in `test/tools.test.ts`: schema rejection, and behaviour against the seeded PGlite DB (`test/helpers/seed.ts`).

## Tests

```
test/backtest.test.ts      simulator on synthetic paths (video pump, trailing, rug, transfer-out exit, slow cook)
                           and the real Amlil fixture, grid search, preset derivation
test/report.test.ts        CSV columns and order, UTC/New York (EDT/EST), tax-free badge, injection guard, report sections
test/queries.test.ts       every query on PGlite with the real migrations and an operator scenario
test/tools.test.ts         schemas reject bad addresses, tool behaviour, output cap
test/runner.test.ts        scripted Anthropic API: get_token -> get_wallet_funding -> write_csv -> propose_play;
                           refusal, round/cost caps, request shape (model, thinking, effort, fallbacks, caching)
test/scout.test.ts         clustering (funder / contract creator / team wallet / deployer, hubs ignored), coverage, runScout
test/trigger.test.ts       SPEC §4 trigger semantics, launchSecond fields, blacklists
test/autopilot.test.ts     auto-approval policy (pure + PGlite), nightly decisions (refit / keep / disable /
                           blacklist), runNightly end to end on synthetic launches, the db seed
test/backtest-run.test.ts  runBacktest end to end
```

The tests make no network calls. The Anthropic API is mocked with a custom `fetch` that streams scripted SSE turns, so the real SDK tool runner and stream parser run.

## Modelling notes and caveats

* Fees come from core's curve math, verified by replaying the 204 Amlil trades:
  * the snipe tax, the 1 % fee and the creator tax are all taken from `quoteIn`, and `CurveBuy.fee` includes the snipe tax;
  * sells pay the fee and the creator tax on the gross proceeds.

  `feeEth` in `get_trades` excludes the snipe tax.
* The backtest assumes we land first in the first `T+1` block.
  * Exits are priced against the historical curve state without our own buy, which is conservative.
  * Exempt transfer-outs are exits at the pre-dump price, because the transfer is seen about one block before the sells.
* `launches.launch_kind` holds the entry point (`launchToken | launchAndBuy | launchTokenFor`). "Dev buy" means `dev_buy_quote > 0` or `launchAndBuy`.
* SDK 0.90 specifics:
  * `betaZodTool` has no `eager_input_streaming` option, so it is spread onto each tool;
  * `fallbacks` is not typed, so it is passed through in the request body;
  * the stream accumulator drops `message_delta.stop_details`, so the runner reads it from the raw event.

  Revisit these when the SDK is upgraded.
