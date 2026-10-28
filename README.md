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

Production, from zero to live: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**. It covers providers, the
Cherry box and snapshot restore, the backfill, the services, play discovery and approval, contract
deploy, the ≥ 3-day paper gate, a small live canary, daily ops, incidents and costs. Read
**[docs/RISKS.md](docs/RISKS.md)** before you fund anything.

## Services

| Service | Runs on | Start | Key env | Health |
|---|---|---|---|---|
| nitro node | Chicago (compose `nitro`) | `infra/node/run-node.sh snapshot`, then `infra/compose.sh up -d` | `L1_RPC_URL`, `L1_BEACON_URL` (blobs), `NITRO_IMAGE`, `DATA_ROOT` | `eth_blockNumber` |
| Postgres 16 | Chicago | compose `postgres` + `migrate` (`pnpm --filter @hood/db migrate`) | `POSTGRES_PASSWORD`, `PG_*` tuning | `pg_isready` |
| indexer | Chicago | `pnpm --filter @hood/indexer start` / `… backfill --since-days 14` | `NODE_WS`, `NODE_HTTP`, `DATABASE_URL`, `START_BLOCK`, `TRACE_INTERNAL` | `/healthz` |
| tracker | Chicago | `pnpm --filter @hood/tracker start` | `DATABASE_URL` | `/healthz` |
| agent | Chicago | `pnpm --filter @hood/agent start serve` | `ANTHROPIC_API_KEY`, `DATABASE_URL`, `NODE_HTTP`, `REPORTS_DIR`, `SCOUT_*`, `AGENT_MAX_COST_USD` | `/healthz` (`AGENT_HEALTH_PORT`) |
| telegram | Chicago | `pnpm --filter @hood/telegram start` | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `DATABASE_URL`, `REPORTS_DIR`, `TELEGRAM_TZ`, `TELEGRAM_DAILY_SUMMARY_HOUR` | `/healthz` |
| sniper | **Ohio** (`hood-sniper.service`); Chicago only via compose profile `executor` | `pnpm --filter @hood/sniper start` | `FEED_URL(_SECONDARY)`, `NODE_WS`, `SEND_ENDPOINTS`, `DATABASE_URL`, `EXECUTOR_PRIVATE_KEY`, `SNIPER_CONTRACT`, `EXECUTION_MODE=paper\|live`, `MAX_GAS_PRICE_GWEI`, `DAILY_LOSS_LIMIT_ETH` | `/healthz` |
| monitoring | Chicago, compose profile `monitoring` | Prometheus + Grafana + node/postgres exporters | `GRAFANA_ADMIN_PASSWORD` | – |

Env templates: `.env.example`, `infra/env/chicago.env.example`, `infra/env/executor.env.example`.
Infra: `infra/docker-compose.yml`, `infra/Dockerfile` (one image; the service is picked by
`SERVICE`), `infra/cherry/` (API provisioning + cloud-init + Terraform), `infra/executor/` (Ohio
install, systemd, chrony), `infra/backup.sh`, `infra/healthcheck.sh`.

Telegram commands: `/status /play <ca> /scout /plays /play_on /play_off /watch /armed /positions
/pnl [days] /preset <id> k=v… /backtest <id> /kill /resume`. Proposed plays arrive with
Approve/Reject buttons. Alerts cover armed wallets, burst sent, filled (entry mcap, tax), closed
(PnL, reason, hold time), aborted, errors, and a daily summary.

## Status (2026-10-28)

| Component | State |
|---|---|
| packages/core: addresses, ABIs, feed decoder, curve math, clock, zod types | typecheck ok, 64 tests pass (6 live tests skipped without `LIVE=1`) |
| packages/db: schema, migrations, NOTIFY triggers, helpers (postgres.js + PGlite) | ok, 17 tests |
| contracts: PonsSniper.sol + deploy script | ok, 10 tests. Curve call encoding and contract callers still to verify live (RESEARCH §7) |
| services/indexer: live + backfill | ok, 62 tests (one PGlite round-trip test is timing-flaky under a parallel workspace run; it passes alone) |
| services/tracker: funding-trail watcher | ok, 32 tests |
| services/agent: Opus 5.5 play finder / scout / backtest | ok, 72 tests |
| services/sniper: feed → burst → exits, paper mode | ok, 72 tests. Must pass the paper gate before live |
| services/telegram: bot, approvals, notifier | ok, 93 tests (incl. PGlite store + trigger e2e, real agent/tracker binding) |
| infra: compose, Dockerfile, Cherry, executor, backups, health | `docker compose config` ok, `bash -n` + shellcheck clean, cloud-init YAML parses, `terraform validate` ok |
| Live trading | **Not yet.** Paper first (RUNBOOK §7) |

Monthly running cost: ≈ $545-900 (Chicago server $233, L1 endpoints, Ohio VM ≈ $70, Anthropic,
gas). See RUNBOOK §11.
