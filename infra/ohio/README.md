# Path A: the paper stack on one Ohio box (Alchemy, no own node)

One Ubuntu VM in AWS us-east-2 runs the whole system in **paper mode** for a week, with Alchemy as
the Robinhood Chain node. There is no Chicago box, no nitro node and no WireGuard. Alchemy serves
Robinhood Chain over HTTP and WS (`eth_subscribe newHeads`, `debug_traceTransaction` with
`callTracer`, 20k-block `eth_getLogs`). The public sequencer feed is still the sniper's detection
source.

```
  AWS us-east-2, one VM (ufw: SSH only; every port below binds to 127.0.0.1)
  ┌────────────────────────────────────────────────────────────────────────────────────┐
  │ postgres 16 (volume pgdata)  ◄── migrate + seed (one-shot, every `up`)             │
  │ indexer  ── Alchemy HTTP (blocks, receipts, traces) + WS (newHeads, Pons logs)      │ :8081
  │ backfill ── one-shot: logs mode BACKFILL_DAYS, blocks mode BACKFILL_BLOCKS_DAYS     │
  │ tracker  ── funders → armed wallets (DB only)                                      │ :8082
  │ agent    ── serve: scout every 15 min + nightly refit (Anthropic) → /opt/hood/reports │ :8083
  │ sniper   ── EXECUTION_MODE=paper, PAPER_FILL=last, feed wss://feed.mainnet…        │ :8084
  │ telegram ── optional (profile "telegram")                                          │ :8085
  └────────────────────────────────────────────────────────────────────────────────────┘
```

| File | What |
|---|---|
| `infra/ohio/bootstrap.sh` | `sudo bash bootstrap.sh`, idempotent: Docker + compose, Node 22 + pnpm, `/opt/hood`, clone/update, `.env.ohio`, chrony, swap, ufw, build, `up`, the first backfill |
| `infra/ohio/compose.yml` | the stack. Containers receive only the variables listed for them, and the sniper is fixed to `paper` with no keys |
| `infra/ohio/hoodctl` | wrapper, installed as `/usr/local/bin/hoodctl`: compose commands plus `pnpm --filter @hood/db ctl …` inside a container |
| `infra/env/ohio.env.example` | every variable, with comments. It becomes `/opt/hood/hoodsniper/.env.ohio` (0600) |

## What you need

- **VM.** Ubuntu 24.04 in us-east-2. Use a 2-4 vCPU instance with at least 4 GB RAM: a
  `c7i.large` (2 vCPU / 4 GB, the bootstrap adds 4 GB swap) or, more comfortably, a `c7i.xlarge`
  or `m7i.large`. The root disk should be **50 GB gp3** (the AMI default of 8 GB is too small).
  The security group allows inbound **22/tcp from your IP only**.
- **Alchemy.** A Pay-As-You-Go app with Robinhood Chain mainnet enabled. Copy only its API key.
  The free tier (30M CU/month, 300 CU/s) runs out within a day; see "Alchemy cost" below.
- **Anthropic API key** with a monthly spend limit set in the Console.
- **GitHub token**, only if the repo is private: a fine-grained, read-only token for this repo.
  Revoke it after the week.

## From a fresh box to a running paper stack

On your laptop, from a checkout of the branch you want to run. The box clones that branch from
GitHub, so push it first.

```bash
IP=<elastic or public ip>
scp -i ~/.ssh/sniper-ohio.pem infra/ohio/bootstrap.sh ubuntu@$IP:
ssh -i ~/.ssh/sniper-ohio.pem ubuntu@$IP
```

On the box:

```bash
# 1st run: installs everything, clones, writes /opt/hood/hoodsniper/.env.ohio, then STOPS (exit 2)
sudo HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_REPO_REF=<branch> \
     HOOD_GIT_TOKEN=<read-only token, private repos only> bash bootstrap.sh

# fill in the two keys (ALCHEMY_KEY = the bare key, not the URL). POSTGRES_PASSWORD is already generated.
sudo nano /opt/hood/hoodsniper/.env.ohio

# 2nd run: checks the Alchemy key (eth_chainId 4663), builds the image (~5-10 min), starts the
# stack, waits for migrate+seed and starts the one-shot backfill
sudo HOOD_GIT_TOKEN=<token> bash /opt/hood/hoodsniper/infra/ohio/bootstrap.sh
```

The second run remembers the ref from the first. If you leave out the token on a private repo, it
warns and keeps the current checkout. To update the code later, run the same command again.

## Check it

```bash
hoodctl ps                 # postgres/indexer/tracker/agent/sniper "running (healthy)"; migrate "exited (0)"
hoodctl health             # /healthz: indexer lagBlocks small, sniper ok + feedBlocks rising, agent lastScout
hoodctl status             # = pnpm --filter @hood/db ctl status (kill switch, plays, armed, open, today's PnL)
hoodctl logs -f sniper     # feed connected, [paper] snipe planned / filled / closed
hoodctl logs -f backfill   # "backfill: logs mode …", then "blocks mode …", then "backfill: done"
hoodctl logs -f indexer agent
```

`hoodctl` re-runs itself with `sudo` when your user cannot reach Docker. The `ctl` commands
(`status`, `pnl`, `kill`, `resume`, `plays`, `play on|off <id>`, `events`) exec into the running
`tracker` container. If it is down, they start a one-off app container. That container has
`DATABASE_URL` and the workspace, and nothing else. You can do the same by hand:

```bash
sudo docker compose -f /opt/hood/hoodsniper/infra/ohio/compose.yml --env-file /opt/hood/hoodsniper/.env.ohio \
  exec tracker pnpm --filter @hood/db ctl status
```

The health ports are on localhost only. To use them from your laptop:
`ssh -i ~/.ssh/sniper-ohio.pem -L 8084:127.0.0.1:8084 ubuntu@$IP`, then open
`http://localhost:8084/healthz` (or `/metrics`, `/clock`).

## Where things land

| What | Where |
|---|---|
| Agent reports (`<yyyymmdd-hhmmss>-<slug>.csv` / `.md`) | `/opt/hood/reports` (`hoodctl reports`). Copy them with `scp -i … ubuntu@$IP:/opt/hood/reports/*.md .` after `sudo chmod -R o+rX /opt/hood/reports`, or use `sudo tar` |
| Paper snipes, positions, events | Postgres volume `hoodohio_pgdata`, tables `snipes` (`mode = 'paper'`), `events`, `feed_blocks` |
| Logs | `hoodctl logs <svc>` (json-file, 5 × 20 MB per container) |
| Secrets | `/opt/hood/hoodsniper/.env.ohio` only (0600, owner `hood`) |

## Reading paper PnL

```bash
hoodctl pnl 7              # per UTC day: mode, snipes, wins, realised PnL ETH; then per play
hoodctl status             # today's closed paper snipes and PnL, open paper positions
hoodctl events 50          # snipe planned / filled / closed / aborted, with reasons
hoodctl psql -c "select play_id, count(*), sum(realized_pnl_eth), avg(realized_pnl_eth) from snipes
                 where mode='paper' and status='closed' group by 1 order by 3 desc"
```

These numbers are pessimistic. `PAPER_FILL=last` fills behind every other buy of the +1 s block, at
the real 6.18 % tax and 1 % fee. The bankroll starts at `PAPER_BANKROLL_ETH=0.1` and grows with
realised paper PnL when a play uses `sizing.mode = bankroll`. Use the gate in RUNBOOK §7: at least
3 days and 10 paper snipes on the plays you would fund, positive PnL after tax and fees, no
unexplained aborts, and a fresh feed the whole time.

## Alchemy cost

Alchemy bills **compute units**: $0.52 per 1M CU on Pay-As-You-Go, 10,000 CU/s of throughput
included. Robinhood Chain makes about 10 blocks/s, or ~864k blocks/day. The live indexer reads
every block.

| Item | CU | Per day |
|---|---|---|
| indexer: `eth_getBlockByNumber` (20) + `eth_getBlockReceipts` (20) per block | 40 / block | ~35M |
| indexer: `newHeads` over WS (0.04 CU/byte, ~25-30 CU per header) | per block | ~22-26M |
| indexer: `debug_traceTransaction` (40) for creations and value calls to contracts, `getCode` / nonce for new wallets | per tx | a few M |
| sniper (Pons-filtered log subscriptions, receipts at launches, reserves while positions are open), agent, Pons logs | | < 1M |
| **steady state** | | **≈ 60-65M CU ≈ $32/day ≈ $230/week** |
| same, with `INDEXER_NODE_WS=` (poll `eth_blockNumber` 1/s instead of `newHeads`) | | ≈ 38M CU ≈ $20/day ≈ $140/week |
| backfill, logs mode, 3 days (130 × 20k-block `eth_getLogs` + per-launch calls) | | < 1M, one-off |
| backfill, blocks mode, per day of chain (same 40 CU/block + traces) | | ≈ 35-40M ≈ $20, one-off |

So a paper week costs roughly **$150-250** in Alchemy, and the steady per-block reads dominate.
The backfill is one-off and small next to that. The default 3-day logs backfill is almost free.
Each day of blocks-mode backfill costs about as much as one day of live indexing.

**Throughput limit.** `eth_getBlockReceipts` counts 500 CU/s against the throughput limit (billing
counts only 20), and `debug_traceTransaction` counts 1,000. The live indexer alone takes about half
of the 10,000 CU/s. That is why blocks-mode backfill is spaced at 100 ms per call (~5 blocks/s,
about 2 days of wall time per day of chain) and defaults to 1 day. HTTP 429s are retried with
backoff, so the cost of hitting the limit is speed, not data. If you want a 3-day trail quickly,
buy +5,000 CU/s for the week ($160/month, pro rata), then set `BACKFILL_RPC_MIN_INTERVAL_MS=40`
and `BACKFILL_BLOCKS_DAYS=3`. Watch usage in the Alchemy dashboard after the first hour and
extrapolate.

## Day-to-day

| Task | Command |
|---|---|
| Stop new paper entries / resume | `hoodctl kill "reason"` / `hoodctl resume` |
| Enable / disable a play | `hoodctl plays`, `hoodctl play on 3`, `hoodctl play off 3` |
| Run the nightly job or a scout pass now | `hoodctl nightly` / `hoodctl scout` |
| Start Telegram | Fill `TELEGRAM_*` in `.env.ohio`, then `hoodctl telegram`. To start it with the stack every time, uncomment `COMPOSE_PROFILES=telegram` |
| Re-run the backfill (e.g. more days) | Edit `BACKFILL_*` in `.env.ohio`, then `hoodctl backfill` |
| Change a setting | Edit `.env.ohio`, then `hoodctl up` (recreates only the changed services) |
| Update the code | `sudo HOOD_GIT_TOKEN=… bash /opt/hood/hoodsniper/infra/ohio/bootstrap.sh` |
| Stop everything (data kept) | `hoodctl down`. Containers restart on reboot (`restart: unless-stopped`) unless you do this |
| Back up the DB | `hoodctl compose exec -T postgres pg_dump -U hood -Fc hood > hood-$(date +%F).dump` |

## Going live later

Paper on this box proves the decision path. It does not prove that a burst lands first in the
+1 s block. For live trading (RUNBOOK §6-8):

1. Pass the paper gate (RUNBOOK §7).
2. Run the **live sniper on the host**, not in this compose file: `sudo HOOD_REPO_URL=…
   bash infra/executor/install-executor.sh` (optionally `HOOD_PIN_CPU=1`). It installs
   `hood-sniper.service` with low-latency sysctls, CPU pinning and `/opt/hood/hoodsniper/.env.executor`
   (0600). Bare Node on the host avoids the Docker network hop and lets you pin the burst thread.
   The live sniper sends to `rpc.mainnet` directly (~3 ms from us-east-2).
3. Postgres, indexer, tracker and agent **can stay in this compose stack**. In `.env.executor`,
   set `DATABASE_URL=postgres://hood:<POSTGRES_PASSWORD>@127.0.0.1:5432/hood` (Postgres is
   published on localhost), `NODE_HTTP` / `NODE_WS` = the Alchemy URLs, and
   `SEND_ENDPOINTS=https://rpc.mainnet.chain.robinhood.com,https://robinhood-mainnet.g.alchemy.com/v2/<key>`.
4. Generate the executor keys **on the box** (1 exit + 1 burst key per `MAX_CONCURRENT`), deploy
   `PonsSniper` with the cold wallet as owner, `setOperator` every key, and fund each key with gas
   and the contract with a few × buyEth (RUNBOOK §6.2-6.4). Put `SNIPER_CONTRACT` and
   `EXECUTOR_PRIVATE_KEYS` in `.env.executor`. Keys never go into `.env.ohio`.
5. Stop the paper sniper so two snipers do not share the DB: set `PAPER_SNIPER=0` in `.env.ohio`
   and run `hoodctl up`. Then set `EXECUTION_MODE=live` in `.env.executor` and run
   `sudo systemctl restart hood-sniper` (RUNBOOK §8: start at `buyEth=0.01`, `MAX_CONCURRENT=1`).
