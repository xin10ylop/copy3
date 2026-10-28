# HoodSniper runbook: from zero to live

This is the operator's path from nothing to a live sniper, followed by daily operations and the
incident playbook. Facts come from `RESEARCH.md`, layout from `ARCHITECTURE.md` §5. Every risk
mentioned here is expanded in `RISKS.md`. Commands assume the repo lives at `/opt/hoodsniper` on the
Chicago box and `/opt/hood/hoodsniper` on the Ohio executor.

Topology:

```
Cherry Servers, Chicago (bare metal)                         AWS us-east-2, Ohio (c7i.large)
  nitro node, Postgres, indexer, tracker, agent, telegram     sniper (feed → rules → burst → exits)
  infra/docker-compose.yml + systemd units                    infra/executor/install-executor.sh
             └──────────── WireGuard 10.66.0.0/24 (Postgres, node fallback) ───────────┘
                                                              └─ ~3 ms ─► rpc.mainnet (sequencer, Ohio)
```

---

## 1. Accounts and providers

| Need | What exactly | Notes |
|---|---|---|
| Cherry Servers | Account, API key, project id, SSH key | Monthly billing (`CHERRY_CYCLE=monthly`) is charged up front from the account balance. Top up first, or start hourly. |
| Ethereum L1 endpoints | Mainnet **execution RPC** and a **beacon API that serves blob sidecars** (`/eth/v1/beacon/blob_sidecars/{slot}`) | Nitro reads batches from blobs. A plain RPC is not enough. Any paid provider with a beacon add-on works (QuickNode, Chainstack, dRPC, Alchemy …); confirm blob support with one curl. Beacon nodes keep blobs for ~18 days, so the snapshot you restore must be younger than that. |
| Telegram | Bot token from @BotFather, your numeric user id (from @userinfobot) | Put the id in `TELEGRAM_ADMIN_IDS`. Only those ids can use the bot. |
| Anthropic | API key for `claude-opus-5-5` | Set a **monthly spend limit** in the Console. The agent also caps each run (`AGENT_MAX_COST_USD`, default $8). |
| GitHub | Fine-grained **read-only** token for this repo (if it is private) | Used once for the clone. Revoke it after provisioning. |
| Cold wallet | A hardware-wallet EOA you control | It becomes the `owner` of PonsSniper and receives every sale's proceeds. |
| Optional: AWS | An account to run the executor in **us-east-2** | About 3 ms from the sequencer, against 27 ms from Chicago (RESEARCH §1). |
| Optional: relay | e.g. BlockRazor, **only if** it offers a Robinhood Chain endpoint | We have not verified one exists. If it does, append it to `SEND_ENDPOINTS` and compare landing blocks in paper and canary runs. |

Never give private keys to Telegram bots or other third parties. The TradeWiz hack in the video is
the reason this project exists.

## 2. Provision the Chicago box and run the node

1. **Check stock.** The default plan (Ryzen 7950X) was out of stock in Chicago on 2026-10-28.
   ```bash
   export CHERRY_AUTH_TOKEN=… CHERRY_PROJECT_ID=…
   infra/cherry/provision.sh --list-stock
   ```
2. **Prepare `.env`.** Start from `infra/env/chicago.env.example`. Fill in `L1_RPC_URL`,
   `L1_BEACON_URL`, `POSTGRES_PASSWORD` (`openssl rand -hex 24`), `TELEGRAM_*`, `ANTHROPIC_API_KEY`
   and `GRAFANA_ADMIN_PASSWORD`. You can embed this file in user-data (`HOOD_ENV_FILE`), or leave it
   out and fill `/opt/hoodsniper/.env` over SSH later. User-data is readable from the server's
   metadata service, which is why the second option exists.
3. **Order the server.** Use `provision.sh`, or `infra/cherry/terraform/`, which does the same thing.
   ```bash
   HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_GIT_TOKEN=<read-only> \
   HOOD_ENV_FILE=./.env.chicago infra/cherry/provision.sh --dry-run
   HOOD_REPO_URL=… HOOD_GIT_TOKEN=… HOOD_ENV_FILE=./.env.chicago infra/cherry/provision.sh --allow-fallback
   ```
   Bare metal takes 10-30 minutes to deploy. Then cloud-init builds the `/data` RAID0, installs
   Docker, clones the repo, writes `.env` (0600), downloads the node config, and starts
   `hood-snapshot` and `hood-stack`.
4. **Watch the bootstrap and the snapshot restore.**
   ```bash
   ssh root@<ip> tail -f /var/log/cloud-init-output.log
   ssh root@<ip> 'cat /proc/mdstat; df -h /data'          # RAID0 of both NVMe, ~1.9 TB on 2x1 TB
   ssh root@<ip> journalctl -u hood-snapshot -f            # streams 1,051 GB, 2 parts, sha256-checked
   ```
   - **Expected time.** The pruned snapshot (1.05 TB, 2026-10-20) streams in 1-3 hours at
     100-300 MB/s. After that, nitro catches up from the snapshot date, which takes a few hours for
     a week-old snapshot.
   - **Disk sizing check.** `df -h /data` should read about 1.05 TB used of ≈1.9 TB (≈55-60 %).
     The chain grows about 5.3 GB/day, so 85 % arrives in roughly 3 months. If the snapshot is
     already above ~1.25 TB, or you do not want to re-restore every quarter, pick a 2x4 TB plan
     (see `infra/cherry/README.md`).
5. **Check that the node is in sync.**
   ```bash
   sudo -u hood /opt/hoodsniper/infra/node/run-node.sh status   # lag should drop to < 10 blocks
   sudo -u hood /opt/hoodsniper/infra/compose.sh logs -f nitro
   ```
   If nitro logs show blob or parent-chain errors, your beacon endpoint does not serve blobs. See
   §10, "Node lagging".

## 3. Postgres, migrations and a 14-day backfill

`hood-stack` runs `migrate` (packages/db migrations) before any app service starts. To check:
```bash
cd /opt/hoodsniper && sudo -u hood infra/compose.sh ps -a         # migrate: exited (0)
sudo -u hood infra/compose.sh exec postgres psql -U hood -d hood -c '\dt'
```
Set the ETH/USD rate used for USD columns, then update it when the price moves a lot:
```bash
sudo -u hood infra/compose.sh exec postgres psql -U hood -d hood -c \
  "insert into settings(key,value) values('eth_usd','3500') on conflict (key) do update set value=excluded.value"
```
Backfill. It is idempotent and does not move the live indexer's checkpoint, so it can run
alongside the indexer:
```bash
# launches, curve trades, token transfers, metrics for 14 days (getLogs, fast)
sudo -u hood infra/compose.sh run --rm indexer pnpm --filter @hood/indexer backfill --since-days 14
# ETH transfers + wallets + internal traces (funding trails), heavy: ~860k blocks/day.
# Use the own node, no throttle; start with 3-7 days and extend while the agent works.
sudo -u hood infra/compose.sh run --rm -e RPC_MIN_INTERVAL_MS=0 -e TRACE_INTERNAL=1 indexer \
  pnpm --filter @hood/indexer backfill --since-days 3 --mode blocks
```
Logs mode for 14 days takes minutes to an hour. Blocks mode runs at node speed: several hours per
few days of chain.

## 4. Start the services

`hood-stack` already started nitro, postgres, indexer, tracker, agent (`serve`: scout every
`SCOUT_INTERVAL_MIN`) and telegram. After editing `.env`:
```bash
sudo systemctl reload hood-stack          # compose up -d --build
sudo -u hood infra/compose.sh ps          # every service running, healthy
sudo -u hood infra/compose.sh logs -f indexer tracker agent telegram
echo COMPOSE_PROFILES=monitoring | sudo tee /etc/hood/stack.env && sudo systemctl reload hood-stack   # optional Grafana
```
In Telegram, send `/start` and `/status`. You should see the feed (once the sniper writes
`feed_blocks`), the node head against the public head, the indexer checkpoint, the kill switch
state and today's PnL. If the bot does not answer, check the logs:
`infra/compose.sh logs telegram` (an invalid token or admin id shows up there).

## 5. Discover a play and approve it

1. `/play <contract address>` for a coin that ran. The play finder runs in the background (minutes,
   a few dollars). The bot then sends a summary, the **CSV**, the **report**, and, if the operator
   fingerprint holds on at least 3 coins with a positive backtest, a **play card with Approve /
   Reject buttons**.
2. Read the CSV. The columns match the video: `ca, dev_wallet, name, start/ath mcap, launch time
   UTC/ET, tax_free, tax_free_buyers, first_taxed_buyer, first_taxed_mcap_usd, p2/p5/p10/p30/p60
   %/mcap, funded_by, funded_eth, launch_kind, dev_buy_eth, notes`. Then check:
   - The funding trail is real. The report must name an on-chain transfer path for every link.
   - The first-taxed-buyer entries cluster around a similar mcap (the realistic entry).
   - The peaks at 2-5 s after entry pay for 6.18 % tax + 1 % fee + slippage.
   - No coin dumped into the first taxed block (`exempt_sold_within_sec` ≤ 1).
3. Approve with the button or `/play_on <id>`. `/backtest <id>` re-checks a play on the indexed
   history. `/preset <id>` shows the play's preset; `/preset <id> key=value …` tunes it.
   - **Defaults.** These come from the 3-day walk-forward in `docs/BACKTEST.md` (Backtest #2):
     buy 0.07 ETH, `maxTaxBps` 1000 (the schema caps it at 5000), no fixed take-profit, trailing
     +50 %/-20 %, stop loss 40 %, timeout 60 s, and `exitIfExemptSellsPct=0` (exit on the first
     exempt-wallet transfer-out or sell).
   - **Examples.** `/preset 3 buyEth=0.02 trailing.activatePct=80 timeoutSec=90` and
     `/preset 3 tp=100:50,200:100`.
   - **Turning exits off.** `trailing=off`, `timeoutSec=none` and `exitIfExemptSellsPct=none`
     store `null`, which means that exit is off. Setting `trailing.activatePct` or
     `trailing.dropPct` turns trailing back on from the 50/20 default.
4. A known funder works without the agent:
   `/watch <funder> <minEth> <maxEth> [fresh|any] [name] [preset=<playId>]`. This is the Packet
   Tracker equivalent. It creates a **disabled** play with approval buttons.
5. `/plays` and `/armed` show what is live. The tracker arms fresh wallets as the funder pays them,
   and the bot announces each one.

## 6. Deploy PonsSniper and fund the executor

First close the open items in RESEARCH §7 (`buy`/`sell` argument order, contract callers allowed,
`maxInternalPriceImpactBps`). The contracts and sniper tasks own those checks
(`contracts/test`, live simulation). Do not fund anything before they pass.

1. **Executor host (Ohio).** Launch an Ubuntu 24.04 `c7i.large` in us-east-2, then run:
   ```bash
   sudo HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_GIT_TOKEN=<read-only> HOOD_PIN_CPU=1 \
        bash infra/executor/install-executor.sh
   ```
   This installs Node 22 and pnpm, `/opt/hood/hoodsniper/.env.executor` (0600, `EXECUTION_MODE=paper`),
   chrony with Amazon Time Sync (and the ENA PTP clock after one reboot), low-latency sysctls, CPU
   pinning and `hood-sniper.service`. The script prints the TCP connect RTT to `rpc.mainnet`. You
   want 1-3 ms. Then set up WireGuard with `infra/wireguard/*.example`, put `PG_BIND=10.66.0.1` and
   `NITRO_BIND=10.66.0.1` in the Chicago `.env`, and add the docker drop-in described in that
   file.
2. **Executor key.** Generate it on the executor and never copy it anywhere else:
   ```bash
   cd /opt/hood/hoodsniper && sudo -u hood -H pnpm --filter @hood/contracts exec node --input-type=module -e \
     "import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';const k=generatePrivateKey();\
      process.stdout.write('EXECUTOR_PRIVATE_KEY='+k+'\n');console.error('address',privateKeyToAccount(k).address)" \
     | sudo tee -a .env.executor >/dev/null
   ```
3. **Deploy.** The owner is the cold wallet; the operator is the executor key. Every `exit`
   forwards its sale proceeds straight to the owner, so profits never sit on the hot key.
   ```bash
   deploy() { sudo -u hood -H bash -c "cd /opt/hood/hoodsniper && set -a && . ./.env.executor && set +a && $*"; }
   deploy OWNER=<cold wallet> DRY_RUN=1 pnpm --filter @hood/contracts run deploy   # predicted address
   deploy OWNER=<cold wallet> pnpm --filter @hood/contracts run deploy             # prints SNIPER_CONTRACT=0x…
   ```
   Use `pnpm … run deploy`. Plain `pnpm deploy` is a pnpm built-in. The deploy script refuses any
   chain id other than 4663 and checks owner, operator and `arbBlockNumbers` after deploying. The
   compiled bytecode lives in `contracts/src/generated/`; run `pnpm --filter @hood/contracts build`
   first if it is missing.
4. **Fund.** Bridge ETH to Robinhood Chain with the official bridge (an L1 deposit takes about
   10-15 minutes).
   - The **executor EOA** needs gas only. 0.02 ETH covers about 5,000 burst transactions at
     0.02 gwei.
   - The **PonsSniper contract** holds the buy capital. Recommended working balance: **0.5 ETH**,
     which is roughly buyEth × MAX_CONCURRENT × 2 plus headroom. Send it from the cold wallet, or
     with `FUND_ETH=0.5` during deploy.
   - Because proceeds go to the owner, the contract balance shrinks with every buy. Top it up from
     the cold wallet. Daily ops (§9) shows how.
5. Put `SNIPER_CONTRACT=0x…` in `.env.executor`, check `DATABASE_URL` and `NODE_*` (WireGuard
   addresses), then `sudo systemctl restart hood-sniper && journalctl -u hood-sniper -f`.

## 7. Paper mode: at least 3 days

`EXECUTION_MODE=paper` runs the full path: feed, rules, a planned burst, and a fill simulated at the
first `T+1` block's pre-trade reserves with the real 618 bps tax and 1 % fee. Nothing is sent.

- The bot announces `[PAPER] SNIPE PLANNED`, `FILLED` and `CLOSED`. `/pnl 3` shows the
  **Paper** bucket.
- **Gate. Go live only when all of these hold:**
  1. At least 3 days and at least 10 paper snipes on the plays you will fund.
  2. Paper PnL is positive **after** tax and fees, and the win rate and expectancy are within about
     half of the play's backtest.
  3. No unexplained `aborted`/`failed` snipes and no error events.
  4. `/status` shows the feed fresh (last frame under 1 s ago) the whole time, and the clock offset
     stays under 1 ms (`infra/healthcheck.sh --role executor`).
- Paper mode cannot prove that the burst lands in the first `T+1` block. Step 8 checks that with
  real money at the smallest size.

## 8. Go live with a small buyEth

1. `/preset <id> buyEth=0.01`, keep `MAX_CONCURRENT=1`, and set `DAILY_LOSS_LIMIT_ETH=0.1` in
   `.env.executor`.
2. Set `EXECUTION_MODE=live` in `.env.executor`, then `sudo systemctl restart hood-sniper`.
3. Read the first fills. `tax paid … (6.18%)` and `+1 s after launch` mean the burst hit the first
   taxed second. `0.19 %` means it landed at `T+2`, which is late: tune `burst.startMs` /
   `burst.spacingMs` with `/preset`. Reverted burst members cost about 0.0000006 ETH each and are
   expected.
4. Scale `buyEth` toward the play's preset (0.05-0.07) only after about 20 live fills match the
   paper expectancy. Raise `DAILY_LOSS_LIMIT_ETH` with it.

## 9. Daily operations

| When | What |
|---|---|
| Every morning | Read the daily summary (sent at `TELEGRAM_DAILY_SUMMARY_HOUR`), `/status`, `/pnl 1`, `/positions`. |
| Daily | Glance at `/plays` and `/armed`, and approve or reject proposed plays. Health alerts arrive in Telegram from `hood-healthcheck.timer` (Chicago) and `hood-executor-healthcheck.timer` (Ohio). |
| Daily | Update `settings.eth_usd` if ETH moved more than ~5 % (USD columns only). |
| Weekly | **Profits.** Proceeds already sit in the cold owner wallet. Refill the contract's working balance from it, and record the realized PnL for taxes (`/pnl 7`, the `snipes` table). If you deployed with the hot key as owner, sweep it now: `PonsSniper.sweepEth(cold, 0)` from the owner. |
| Weekly | `infra/backup.sh --list`, copy the newest dump off the box (rclone/rsync), and run `df -h /data`. |
| Monthly | **Rotate the executor key.** Generate a new key (step 6.2). From the owner call `setOperator(new, true)`, switch `.env.executor`, restart, then `setOperator(old, false)` and move the old EOA's dust. Also rotate the Telegram token (BotFather `/revoke`) and the Anthropic key if anyone else had access. |
| On release | **Update the node.** Read the Robinhood node docs and the nitro release notes (some ArbOS upgrades force a version). Set `NITRO_IMAGE=…` in `.env`, run `infra/compose.sh pull nitro && infra/compose.sh up -d nitro`, then `run-node.sh status`. |
| On release | **Update the code.** Chicago: `git -C /opt/hoodsniper fetch && git checkout <ref> && systemctl reload hood-stack`. Ohio: re-run `install-executor.sh` (idempotent; it restarts the sniper). |
| Quarterly or at 85 % disk | Restore a fresh pruned snapshot: `systemctl stop hood-stack`, then `run-node.sh snapshot --force`, then `systemctl start hood-stack`. The Ohio sniper keeps running on the public feed. |

## 10. Incident playbook

Use `/kill <reason>` whenever you are unsure. It stops **new** entries (`settings.kill_switch`, which
the sniper reads through `settings_changed`). Open positions keep their exits. `/resume` undoes it.

- **Feed down / stale** (`/status` shows `feed … STALE`, or an executor health alert).
  1. The sniper switches to `FEED_URL_SECONDARY` (the delayed feed, about 500 ms behind) and then to
     `TokenLaunched` logs from the node. Entries arrive later and the 6.18 % second may be missed.
  2. Check from the executor:
     `node -e "const w=new WebSocket('wss://feed.mainnet.chain.robinhood.com');w.onmessage=()=>{console.log('ok');process.exit(0)}"`.
     If both feeds are down, the sequencer is down: `/kill` until blocks flow again (status page or
     public RPC head moving), then `/resume`.
- **Node lagging** (`run-node.sh status` lag over 50 blocks, or the Telegram health alert).
  1. Look for L1 errors: `infra/compose.sh logs --tail 200 nitro | grep -iE 'blob|parent|beacon|error'`.
     Errors here usually mean a beacon endpoint without blob support or a rate-limited L1 plan.
     Switch providers in `.env`, then `infra/compose.sh up -d nitro`.
  2. Check that `/data` is not full and that CPU/IO are not saturated by a `--mode blocks` backfill.
  3. The hot path does not need the node: feed plus the public RPC are enough. If the lag persists,
     point the sniper's `NODE_HTTP`/`NODE_WS` at `https://rpc.mainnet.chain.robinhood.com` and
     restart it.
- **Nonce stuck** (burst txs "nonce too high" or pending, no fills while launches match).
  1. `/kill`.
  2. `sudo systemctl restart hood-sniper`. The sniper reconciles its nonce from chain on start.
  3. Compare `eth_getTransactionCount(executor, "latest")` with `"pending"` on the public RPC. If they
     differ for more than a few seconds, send a 0-ETH self-transfer at the `latest` nonce to clear
     the gap. Nitro is first-come-first-served, so no fee bump is needed.
  4. `/resume`.
- **Kill switch tripped by the daily loss limit** (the bot reports `KILL SWITCH ON … daily loss`).
  Do not just resume. Read `/pnl 1` and the closed messages (reasons: stop loss? exempt wallets
  dumping?), then disable the losing play with `/play_off <id>`. The limit resets with the UTC day.
- **Flatten everything now.** Run `/kill`, then from the operator key call
  `PonsSniper.exitAll(curve, token, minQuoteOut)` for each open position listed by `/positions`. Use
  `minQuoteOut = 0` only if you accept any price.
- **Pons parameter change.** The sniper reads `snipeTaxStartBps()` and `snipeTaxSeconds()` from the
  factory at startup. To check them by hand:
  ```bash
  for sel in 0x50e25ac2 0x6783774b; do curl -s -H 'content-type: application/json' https://rpc.mainnet.chain.robinhood.com \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e\",\"data\":\"$sel\"},\"latest\"]}"; echo; done
  ```
  Expected values are `9900` (0x26ac) and `3`. If they changed: `/kill`, restart the sniper so it
  re-reads them, re-check `maxTaxBps`/burst timing in the presets, run paper mode again (§7), and
  only then `/resume`.
- **Sequencer downtime or reorg.** Blocks stop: positions cannot exit until blocks resume. When
  they do, check `/positions` and expect stop-loss exits. The indexer re-processes up to
  `REORG_DEPTH` blocks.
- **Executor key or host compromised.** From the cold owner: `setOperator(compromisedKey, false)`,
  then `sweepEth(cold, 0)`. Rotate the key (§9), rebuild the host, revoke the WireGuard peer.
- **Chicago box lost.** Provision a new one (§2). Restore Postgres from the latest off-box dump:
  `pg_restore -d "$DATABASE_URL" --clean --if-exists hood-<ts>.dump`. Then backfill the gap (§3).
  The Ohio sniper keeps trading meanwhile, but its writes fail until Postgres is back, so `/kill`
  if you cannot see positions.

## 11. Monthly cost

| Item | Choice | USD / month |
|---|---|---|
| Chicago server | Cherry Ryzen 7950X, monthly billing (EUR 199). Hourly: $0.399/h ≈ $291 | **232.83** |
| Alternative in stock | Ryzen 9700X (same disks) / Threadripper PRO 7975WX (2x4 TB) / EPYC 9375F (2x4 TB) | 221.13 / 1,461.33 / 1,157.13 |
| L1 RPC + beacon (blobs) | Paid plan with a beacon add-on (estimate; varies by provider and usage) | 50-150 |
| Ohio executor | AWS c7i.large on-demand, us-east-2 ($0.08925/h) + 30 GB gp3 + egress | ≈ 70 (≈ 45 with a 1-year savings plan) |
| Anthropic | Opus 5.5 at $4 / $20 per M input / output tokens. Play-finder runs are capped at $8 (`AGENT_MAX_COST_USD`). Estimate: 30 `/play` + ~60 scout investigations per month at ~$3 each | 150-400 (set a Console limit) |
| Gas | ≈0.00002 ETH per snipe (10-tx burst: ~9 cheap reverts + buy + 1-3 sells) at 0.02 gwei; 600 snipes/month at $3,500/ETH | ≈ 40 |
| Off-box backups | Object storage for 14 dumps (optional) | 1-5 |
| **Total** | Chicago + L1 + Ohio + Anthropic + gas | **≈ 545-900** |

Trading costs are separate from infrastructure and much larger per trade. At +1 s the snipe tax is
6.18 % of each buy (0.0043 ETH on 0.07 ETH, ≈ $15), plus a 1 % curve fee on both the buy and the
sell. These are already inside the realized PnL the bot reports.
