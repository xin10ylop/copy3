# HoodSniper

HoodSniper finds memecoin-launch "operator plays" on the **Pons V2** launchpad on **Robinhood Chain**
(EVM L2, chainId 4663, Arbitrum Nitro) and snipes them in the first taxed second. It replaces the
Telegram-bot stack from the reference video, built from TradeWiz dev-snipe presets, Packet Tracker
funding-trail watches and a Claude "play finder" chat. HoodSniper uses its own node and sequencer
feed, an Opus 5.5 agent, a timed transaction burst from Ohio, and backtested exits.

The launch second costs 99 % snipe tax. At +1 s it is 6.18 %, at +2 s 0.19 %, after that 0.
Entering at +1 s and exiting mechanically within seconds is the whole edge. See
[docs/RESEARCH.md](docs/RESEARCH.md) §3.

```
                    Robinhood Chain sequencer (AWS us-east-2)
         feed wss ──────────┬─────────────────────────────▲ txs (burst, ~3 ms RTT from Ohio)
                            │                             │
  ┌─ Ohio executor ─────────▼─────────────────────────────┴──┐
  │ sniper: feed decode → rules (plays, armed, team wallets)  │   PonsSniper.sol
  │         → timed burst → position manager (TP/trail/SL)    │── owner = cold wallet,
  └──────────────────▲───────────────────────┬────────────────┘   operator = executor key
     config via NOTIFY│ (WireGuard)           │ snipes, events, feed_blocks
  ┌─ Chicago box (Cherry Servers) ───────────┴─────────────────────────────────────┐
  │ nitro node ──► indexer ──► Postgres ◄── tracker (funder → armed wallets)        │
  │ (debug API)                 ▲    ▲                                              │
  │                             │    └── agent: play finder / scout / backtest      │
  │                             └─────── telegram: commands, approvals, alerts ◄──► you
  └─────────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
pnpm install && pnpm typecheck && pnpm test      # Node 22, pnpm 10; tests never touch the network
```

Paper week first, on one AWS Ohio VM with Alchemy as the node (no Chicago box):
**[infra/ohio/README.md](infra/ohio/README.md)** (`sudo bash infra/ohio/bootstrap.sh`, then `hoodctl status`).

Production, from zero to live: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**. It covers providers, the
Cherry box and snapshot restore, the backfill, the services, play discovery and approval, contract
deploy, the ≥ 3-day paper gate, a small live canary, daily ops, incidents and costs. Read
**[docs/RISKS.md](docs/RISKS.md)** before you fund anything.

## How it runs every day

Nobody has to pick operators for the system to trade. Two kinds of plays run side by side:

```
sequencer feed ─► sniper (Ohio) ─┬─ launch block: operator plays (armed funder, deployer, team wallets, name) ─┐
                                 └─ launch-second ledger: team / dev buys in second T, every block            │
                                      → generic play team-buy-0.1 ("a tax-exempt non-deployer wallet          │
                                        bought ≥ 0.1 ETH in the launch second")                               │
                                                                                                              ▼
                     match (µs, memory) → launch receipt + the team buys' CurveBuy receipts (proof) → burst into T+1
                     → exits: first exempt transfer-out (dump), trailing +50 %/−20 %, SL 40 %, 60 s timeout

agent serve (Chicago) ─┬─ every SCOUT_INTERVAL_MIN: runners → operator clusters → Opus unravels new ones →
                       │  proposes plays → settings.auto_approve enables the strong ones, the rest → Telegram card
                       └─ nightly at NIGHTLY_HOUR_UTC: re-backtest every enabled play on the last 3 days →
                          refit its exits, auto-disable losers (realised or refit expectancy ≤ 0),
                          blacklist operators whose last 5 launches lost (generic plays)
```

1. **Once.** `pnpm --filter @hood/db migrate`, then `pnpm --filter @hood/db seed`: operator `generic`,
   play `team-buy-0.1` (enabled, the backtested preset), `team-buy-0.05` (disabled),
   `settings.kill_switch` off and `settings.auto_approve`. Docs: [RUNBOOK](docs/RUNBOOK.md) §3.
2. **Always on, from the feed.** The generic play is the edge measured in
   [BACKTEST.md](docs/BACKTEST.md) #2: +0.0058 ETH (+8 %) per 0.07 ETH snipe on 268 launches
   (~90 a day), positive on every out-of-sample day, **if** we are first in the +1 s block. The
   sniper keeps a ledger of every launch's second `T`, fires as soon as the team buy shows up, and
   signs only after the buy is proven on chain ([sniper README](services/sniper/README.md#launch-second-fingerprint-triggerlaunchsecond)).
   Operator plays found by the agent run next to it on the same burst path.
3. **Every N minutes, the scout** clusters fresh runners by funder / team wallet / deployer, lets
   Opus unravel clusters no operator play covers yet, and proposes plays. A proposal whose backtest
   clears `settings.auto_approve` (≥ 10 coins, ≥ 0.002 ETH per snipe, ≥ 35 % wins, < 20 plays
   enabled) is enabled at once; the others arrive in Telegram with Approve / Reject.
4. **Every night** (03:00 UTC by default) the agent refits each enabled play's exits on the last
   3 days, disables plays that stopped paying (rolling realised expectancy over the last 30 snipes,
   paper or live, or refit expectancy ≤ 0) and blacklists losing operators on the generic plays.
5. **Sizing.** Fixed `buyEth`, or `sizing.mode = bankroll`: a share of the contract balance per
   snipe (start at 0.01 ETH with ~0.1 ETH in the contract; the size follows the balance), with the
   daily loss limit at 15 % of the day's starting balance.

**What you do:** watch Telegram — the daily summary, fills and exits, `play_auto_approved`,
`play_refit`, `play_auto_disabled`, `operator_blacklisted` and error alerts; approve or reject the
cards auto-approval left for you; `/pnl [days]`, `/positions`, `/status`; `/kill <reason>` whenever
something looks wrong (stops new entries in milliseconds, exits keep running) and `/resume`. You also
decide when paper becomes live (RUNBOOK §7-8: `EXECUTION_MODE=paper` makes every "enabled" harmless
until then) and when to add capital.

## Services

| Service | Runs on | Start | Key env | Health |
|---|---|---|---|---|
| nitro node | Chicago (compose `nitro`) | `infra/node/run-node.sh snapshot`, then `infra/compose.sh up -d` | `L1_RPC_URL`, `L1_BEACON_URL` (blobs), `NITRO_IMAGE`, `DATA_ROOT` | `eth_blockNumber` |
| Postgres 16 | Chicago | compose `postgres` + `migrate` (`pnpm --filter @hood/db migrate`) | `POSTGRES_PASSWORD`, `PG_*` tuning | `pg_isready` |
| indexer | Chicago | `pnpm --filter @hood/indexer start` / `… backfill --since-days 14` | `NODE_WS`, `NODE_HTTP`, `DATABASE_URL`, `START_BLOCK`, `TRACE_INTERNAL` | `/healthz` |
| tracker | Chicago | `pnpm --filter @hood/tracker start` | `DATABASE_URL` | `/healthz` |
| agent | Chicago | `pnpm --filter @hood/agent start serve` (scout loop + nightly job; `… start nightly` runs it once) | `ANTHROPIC_API_KEY`, `DATABASE_URL`, `NODE_HTTP`, `REPORTS_DIR`, `SCOUT_*`, `AGENT_MAX_COST_USD`, `NIGHTLY_HOUR_UTC`, `REFIT_*` | `/healthz` (`AGENT_HEALTH_PORT`) |
| telegram | Chicago | `pnpm --filter @hood/telegram start` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `DATABASE_URL`, `REPORTS_DIR`, `TELEGRAM_TZ`, `TELEGRAM_DAILY_SUMMARY_HOUR` | `/healthz` |
| sniper | **Ohio** (`hood-sniper.service`); Chicago only via compose profile `executor` | `pnpm --filter @hood/sniper start` | `FEED_URL(_SECONDARY)`, `NODE_WS`, `SEND_ENDPOINTS`, `DATABASE_URL`, `EXECUTOR_PRIVATE_KEYS`, `SNIPER_CONTRACT`, `EXECUTION_MODE=paper\|live`, `MAX_GAS_PRICE_GWEI`, `DAILY_LOSS_LIMIT_ETH` or `DAILY_LOSS_LIMIT_PCT`, `PAPER_BANKROLL_ETH` | `/healthz` |
| monitoring | Chicago, compose profile `monitoring` | Prometheus + Grafana + node/postgres exporters | `GRAFANA_ADMIN_PASSWORD` | – |

Env templates: `.env.example`, `infra/env/chicago.env.example`, `infra/env/executor.env.example`.
Infra: `infra/docker-compose.yml`, `infra/Dockerfile` (one image; the service is picked by
`SERVICE`), `infra/cherry/` (API provisioning + cloud-init + Terraform), `infra/executor/` (Ohio
install, systemd, chrony), `infra/ohio/` (Path A: the paper stack on one Ohio box against Alchemy,
`bootstrap.sh` + `compose.yml` + `hoodctl`; env template `infra/env/ohio.env.example`),
`infra/backup.sh`, `infra/healthcheck.sh`.

Telegram commands: `/status /play <ca> /scout /plays /play_on /play_off /watch /armed /positions
/pnl [days] /preset <id> k=v… /backtest <id> /kill /resume`. Proposed plays arrive with
Approve/Reject buttons. Alerts cover armed wallets, burst sent, filled (entry mcap, tax), closed
(PnL, reason, hold time), aborted, errors, and a daily summary.

## Status (2026-10-28)

| Component | State |
|---|---|
| packages/core: addresses, ABIs, feed decoder, curve math, clock, zod types (incl. `launchSecond`, `sizing`) | typecheck ok, 73 tests pass (6 live tests skipped without `LIVE=1`) |
| packages/db: schema, migrations, NOTIFY triggers, helpers (postgres.js + PGlite), `seed` (generic plays + settings) | ok, 20 tests |
| contracts: PonsSniper.sol + deploy script | ok, 10 tests. Curve call encoding and contract callers still to verify live (RESEARCH §7) |
| services/indexer: live + backfill | ok, 62 tests (one PGlite round-trip test is timing-flaky under a parallel workspace run; it passes alone) |
| services/tracker: funding-trail watcher | ok, 32 tests |
| services/agent: Opus 5.5 play finder / scout / backtest, auto-approval, nightly refit / disable / blacklist | ok, 96 tests |
| services/sniper: feed → burst → exits, paper mode, launch-second ledger, bankroll sizing | ok, 172 tests. Must pass the paper gate before live |
| services/telegram: bot, approvals, notifier | ok, 96 tests (incl. PGlite store + trigger e2e, real agent/tracker binding) |
| infra: compose, Dockerfile, Cherry, executor, backups, health | `docker compose config` ok, `bash -n` + shellcheck clean, cloud-init YAML parses, `terraform validate` ok |
| Live trading | **Not yet.** Paper first (RUNBOOK §7) |

Monthly running cost: ≈ $545-900 (Chicago server $233, L1 endpoints, Ohio VM ≈ $70, Anthropic,
gas). See RUNBOOK §11.

## Operating without Telegram

Telegram is optional (compose profile `telegram`). Nothing in the trading loop
depends on it: plays that pass `settings.auto_approve` are enabled automatically,
and everything else is reachable from the command line:

```
pnpm --filter @hood/db ctl status          # kill state, enabled plays, armed, open positions, today's PnL
pnpm --filter @hood/db ctl pnl 7           # realised PnL per day and per play
pnpm --filter @hood/db ctl kill | resume   # global kill switch
pnpm --filter @hood/db ctl plays | play on|off <id> | events 50
```
On the Path A Ohio box the same commands run inside a container: `hoodctl status`, `hoodctl pnl 7`,
`hoodctl kill`, … ([infra/ohio/README.md](infra/ohio/README.md)).
Health endpoints: every service exposes `/healthz`; logs are JSON (pino).
