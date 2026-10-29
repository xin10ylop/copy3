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

## Path A: paper week on one Ohio box (Alchemy, no node)

Use this path to run the system in paper mode before you rent the Chicago box. One Ubuntu VM in
AWS us-east-2 runs Postgres, migrate+seed, the indexer, the tracker, the agent (`serve`) and the
sniper (`EXECUTION_MODE=paper`, `PAPER_FILL=last`, `PAPER_BANKROLL_ETH=0.1`). Telegram is
optional. Alchemy is `NODE_HTTP`/`NODE_WS` for every chain reader: it serves `debug_traceTransaction`
(callTracer), `newHeads` and 20k-block `eth_getLogs` on Robinhood Chain. The sniper's detection
source is still the public feed `wss://feed.mainnet.chain.robinhood.com`. Details, troubleshooting
and the full cost table: [`infra/ohio/README.md`](../infra/ohio/README.md).

**You need:** a VM with 2-4 vCPU, at least 4 GB RAM and a 50 GB gp3 root disk (`c7i.large` works,
`c7i.xlarge` is more comfortable), with a security group that allows 22/tcp only. You also need an
Alchemy Pay-As-You-Go app with Robinhood Chain enabled, an Anthropic key with a Console spend limit,
and a read-only GitHub token if the repo is private. Push the branch first: the box clones it.

```bash
# laptop
scp -i ~/.ssh/sniper-ohio.pem infra/ohio/bootstrap.sh ubuntu@<ip>:
ssh -i ~/.ssh/sniper-ohio.pem ubuntu@<ip>
# box, 1st run: Docker + compose, Node 22 + pnpm, /opt/hood/hoodsniper, .env.ohio (0600,
# POSTGRES_PASSWORD generated), chrony, swap if < 8 GB, ufw SSH-only. Then it STOPS (exit 2).
sudo HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_REPO_REF=<branch> HOOD_GIT_TOKEN=<ro token> bash bootstrap.sh
sudo nano /opt/hood/hoodsniper/.env.ohio          # ALCHEMY_KEY=<bare key>, ANTHROPIC_API_KEY=sk-ant-...
# 2nd run: checks the key (eth_chainId 4663), builds, `up -d`, waits for migrate+seed, starts the backfill once
sudo HOOD_GIT_TOKEN=<ro token> bash /opt/hood/hoodsniper/infra/ohio/bootstrap.sh
```

**Check it.** `hoodctl` is installed in `/usr/local/bin`. It wraps
`docker compose -f infra/ohio/compose.yml --env-file .env.ohio` and execs
`pnpm --filter @hood/db ctl …` inside the tracker container.
```bash
hoodctl ps                  # every service running (healthy); migrate exited (0)
hoodctl health              # /healthz of indexer (lagBlocks), tracker, agent (lastScout), sniper (ok, feed)
hoodctl status              # kill switch, plays (team-buy-0.1 enabled by the seed), armed, open, today's PnL
hoodctl logs -f sniper      # feed connected; [paper] snipe planned / filled / closed
hoodctl logs -f backfill    # logs mode for BACKFILL_DAYS (3), then blocks mode for BACKFILL_BLOCKS_DAYS (1)
```

**Reports and PnL.** Agent CSV and markdown reports land in `/opt/hood/reports` on the host
(`hoodctl reports`). For paper PnL, `hoodctl pnl 7` prints per day and per play (`mode = paper`).
`hoodctl events 50` shows each snipe's planned, filled, closed or aborted event with its reason.
`PAPER_FILL=last` fills behind every other buy of the +1 s block, so these numbers are the
pessimistic case. Judge them with the §7 gate.

**Alchemy cost.** Alchemy bills compute units (CU): $0.52 per 1M on Pay-As-You-Go, with
10,000 CU/s of throughput included. The chain makes ~10 blocks/s. For each block, the live
indexer calls `eth_getBlockByNumber` and `eth_getBlockReceipts` (20 + 20 CU) and receives a
`newHeads` event over WS (~25-30 CU at 0.04 CU/byte). Traces for value calls (40 CU each) come on
top. That adds up to about 60-65M CU/day, ≈ $32/day, ≈ $230 for a week.
`INDEXER_NODE_WS=` (empty) polls `eth_blockNumber` once a second instead of subscribing, which
brings it to ≈ $140/week. The backfill is a one-off. Logs mode for 3 days costs < 1M CU. Blocks
mode costs about one live day (~35-40M CU) per day of chain. **So the steady per-block reads, not
the backfill, are the bulk of the bill.** The free tier (30M CU/month) does not last a day. Blocks
mode is limited by throughput (`eth_getBlockReceipts` counts 500 CU/s against the limit), which is
why it is spaced at 100 ms per call and defaults to 1 day.

**Going live later** (§6-8 apply unchanged):
1. Pass the §7 gate on this box.
2. Install the **live sniper on the host** with `infra/executor/install-executor.sh`: bare Node,
   low-latency sysctls, optional CPU pinning, no Docker network hop. Postgres, the indexer, the
   tracker and the agent can stay in this compose stack. In `.env.executor`, set
   `DATABASE_URL=postgres://hood:<POSTGRES_PASSWORD>@127.0.0.1:5432/hood`, `NODE_HTTP`/`NODE_WS`
   to the Alchemy URLs, and `SEND_ENDPOINTS=https://rpc.mainnet.chain.robinhood.com,<alchemy https url>`.
3. Generate the executor keys on the box, deploy `PonsSniper` with the cold owner, `setOperator`
   each key, and fund the keys and the contract (§6.2-6.4). Keys go in `.env.executor` only,
   never in `.env.ohio`.
4. Set `PAPER_SNIPER=0` in `.env.ohio` and run `hoodctl up`, so only one sniper uses the DB. Then
   set `EXECUTION_MODE=live` in `.env.executor` and run `systemctl restart hood-sniper` (§8).

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
Seed the always-on layer (idempotent; re-run after every deploy, it never overwrites a play or a
setting that exists):
```bash
sudo -u hood infra/compose.sh run --rm migrate pnpm --filter @hood/db seed
# or from a checkout: DATABASE_URL=postgres://… pnpm --filter @hood/db seed
```
It creates:
- operator `generic` (active) and play **`team-buy-0.1`, enabled**: `{ launchSecond: { minTeamBuyEth: 0.1 } }`
  (a tax-exempt non-deployer wallet bought ≥ 0.1 ETH in the launch second; Backtest #2: +8 % per
  snipe, positive on every out-of-sample day) with the backtested preset, `stopAfter` unlimited and
  `firstBuyOnly: false` (MAX_CONCURRENT and the daily loss limit are the caps);
- play `team-buy-0.05`, disabled (broader, not backtested on its own);
- `settings.kill_switch` = off and `settings.auto_approve` (below), only if absent.

"Enabled" is harmless while the executor runs `EXECUTION_MODE=paper` (the default): enabled plays
then produce paper snipes only. They trade real money once you switch to live in step 8.

`settings.auto_approve` decides whether a play the scout proposes waits for your Approve button:
```json
{"enabled": true, "minCoins": 10, "minExpectancyEth": 0.002, "minWinRate": 0.35, "maxConcurrentPlays": 20}
```
A proposal is enabled automatically (`play_auto_approved` in Telegram) when its backtest has at
least `minCoins` simulated snipes, an expectancy ≥ `minExpectancyEth` per snipe and a win rate ≥
`minWinRate`, and fewer than `maxConcurrentPlays` plays are enabled. Anything else arrives as a card
with Approve/Reject as before. Turn it off with
`… psql -c "update settings set value = jsonb_set(value, '{enabled}', 'false') where key = 'auto_approve'"`.
Only scout proposals are auto-approved; `/play <ca>` results always wait for you.

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
`SCOUT_INTERVAL_MIN`, and the nightly job at `NIGHTLY_HOUR_UTC`, default 03:00 UTC) and telegram.
The nightly job re-backtests every enabled play over the last `REFIT_DAYS` (3) of indexed launches,
writes a refit preset when it beats the current one by more than `REFIT_MARGIN_ETH` (needs
`REFIT_MIN_COINS` = 20 simulated snipes), disables a play whose realised expectancy over its last
30 snipes (paper or live, at least 10) or whose refit expectancy is ≤ 0, and blacklists operators
whose last 5 matching launches all lost (`deployerNotIn` / `teamWalletsNotIn` on the generic plays).
Each change arrives in Telegram (`play_refit`, `play_auto_disabled`, `operator_blacklisted`). Run it
by hand with `infra/compose.sh exec agent pnpm --filter @hood/agent start nightly`. After editing `.env`:
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
2. **Executor keys.** The sniper needs one **exit key** plus one **burst key** per concurrent
   snipe (`MAX_CONCURRENT`, default 3), all in `EXECUTOR_PRIVATE_KEYS` with the exit key first.
   Live mode refuses a single key, because exits would wait behind bursts on one nonce
   (`ALLOW_SINGLE_KEY=1` overrides that, for tests only). Generate the keys on the executor and
   never copy them anywhere else. The example makes 1 + 3 keys:
   ```bash
   cd /opt/hood/hoodsniper && sudo -u hood -H pnpm --filter @hood/contracts exec node --input-type=module -e \
     "import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';const ks=Array.from({length:4},()=>generatePrivateKey());\
      process.stdout.write('EXECUTOR_PRIVATE_KEYS='+ks.join(',')+'\n');\
      ks.forEach((k,i)=>console.error(i?'burst'+i:'exit ',privateKeyToAccount(k).address))" \
     | sudo tee -a .env.executor >/dev/null
   ```
   Delete the empty `EXECUTOR_PRIVATE_KEYS=` line from the template, so the generated line is
   the only one. Note the printed addresses: they are the operators in step 3 and the gas
   accounts in step 4.
3. **Deploy.** The owner is the cold wallet. Every key in `EXECUTOR_PRIVATE_KEYS` becomes an
   operator: the script deploys from the first key (the exit key; set `EXECUTOR_PRIVATE_KEY` to use
   another deployer), and the constructor makes it the first operator. Every `exit` forwards its
   sale proceeds straight to the owner (the treasury), so profits never sit on a hot key.
   `MAX_QUOTE_IN_ETH` caps one snipe. `MAX_SPEND_PER_WINDOW_ETH` (default 4 × `MAX_QUOTE_IN_ETH`) per
   `SPEND_WINDOW_SEC` (default 3600) is a decaying budget: at most that much at once, refilling
   continuously at `MAX_SPEND_PER_WINDOW_ETH / SPEND_WINDOW_SEC` per second (`SpendLimitExceeded`). Both
   bound what a stolen operator key can lose by buying its own launches with the contract's ETH.
   The owner can change them later with `setMaxQuoteIn` and `setSpendLimit` (a window of 0 is
   refused; turning the budget off is the separate `disableSpendLimit()`).
   ```bash
   deploy() { sudo -u hood -H bash -c "cd /opt/hood/hoodsniper && set -a && . ./.env.executor && set +a && $*"; }
   deploy OWNER=<cold wallet> MAX_QUOTE_IN_ETH=0.1 DRY_RUN=1 pnpm --filter @hood/contracts run deploy   # predicted address
   deploy OWNER=<cold wallet> MAX_QUOTE_IN_ETH=0.1 pnpm --filter @hood/contracts run deploy             # prints SNIPER_CONTRACT=0x…
   ```
   The script prints `setOperator(<key>, true)` calldata for every other key (and `setTreasury`
   calldata if `TREASURY` is set). Send each one **from the cold owner**: a burst key that is not
   an operator reverts every snipe. Use `pnpm … run deploy`. Plain `pnpm deploy` is a pnpm built-in.
   The deploy script refuses any chain id other than 4663, and checks owner, operator and
   `arbBlockNumbers` after deploying. The
   compiled bytecode lives in `contracts/src/generated/`; run `pnpm --filter @hood/contracts build`
   first if it is missing.
4. **Fund.** Bridge ETH to Robinhood Chain with the official bridge (an L1 deposit takes about
   10-15 minutes).
   - **Each executor key** (the exit key and every burst key) pays its own gas. Fund each one
     with about 0.01 ETH. 0.01 ETH covers about 2,500 burst transactions at 0.02 gwei. A key below the
     gas floor (`MIN_GAS_BALANCE_ETH`) raises `low_balance`. A burst is refused if its burst key or
     the exit key is that low, so positions can always be exited.
   - The **PonsSniper contract** holds the buy capital. Keep its working balance at **a few ×
     buyEth**, roughly buyEth × MAX_CONCURRENT × 2 (0.5 ETH at most for the default play). The
     on-chain caps bound each snipe and each window. The balance bounds everything else a stolen
     operator key could reach, so do not park the bankroll there. Send it from the cold wallet, or
     with `FUND_ETH=0.5` during deploy.
   - Because proceeds go to the owner, the contract balance shrinks with every buy. Top it up from
     the cold wallet. Daily ops (§9) shows how.
   - **Small bankroll, compounding.** Start at 0.01 ETH with ~0.1 ETH in the contract; the size
     follows the balance. Set `sizing` on the play (`/preset <id> sizing.mode=bankroll`, or edit the
     preset: `{"mode":"bankroll","fraction":0.25,"minEth":0.01,"maxEth":0.3}`): each buy is
     `contract balance × 0.25 / MAX_CONCURRENT`, clamped to 0.01–0.3 ETH, rounded down to 0.001 ETH.
     Have the owner call `setTreasury(<PonsSniper address>)` so exit proceeds stay in the contract
     and compound (otherwise they go to the owner and the bankroll only shrinks). Leave
     `DAILY_LOSS_LIMIT_ETH` unset: the daily loss limit is then `DAILY_LOSS_LIMIT_PCT` (15 %) of the
     balance at the start of the UTC day. 0.01 ETH is the floor: gas (~0.00004 ETH per burst plus the
     exit) is ~6 % of the expected +0.0008 ETH there; the tax and fees scale with size, so the edge
     does not. Keep `maxEth` ≤ the contract's `maxQuoteIn`.
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

1. `/preset <id> buyEth=0.01` (or bankroll sizing with ~0.1 ETH in the contract, which buys the
   0.01 ETH floor until the balance grows; paper-test it first with `PAPER_BANKROLL_ETH=0.1`), keep
   `MAX_CONCURRENT=1`, and set `DAILY_LOSS_LIMIT_ETH=0.1` in `.env.executor` (or leave it unset for
   15 % of the bankroll).
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
| Daily | Glance at `/plays` and `/armed`, and approve or reject the proposed plays that `auto_approve` left for you. Read the nightly `play_refit` / `play_auto_disabled` / `operator_blacklisted` messages; re-enable a play with `/play_on <id>` only if you disagree. Health alerts arrive in Telegram from `hood-healthcheck.timer` (Chicago) and `hood-executor-healthcheck.timer` (Ohio). |
| Daily | Update `settings.eth_usd` if ETH moved more than ~5 % (USD columns only). |
| Weekly | **Profits.** Proceeds already sit in the cold owner wallet. Refill the contract's working balance from it, and record the realized PnL for taxes (`/pnl 7`, the `snipes` table). If you deployed with the hot key as owner, sweep it now: `PonsSniper.sweepEth(cold, 0)` from the owner. |
| Weekly | `infra/backup.sh --list`, copy the newest dump off the box (rclone/rsync), and run `df -h /data`. |
| Monthly | **Rotate the executor keys** (all of them: the exit key and every burst key). Generate a new set (step 6.2). From the owner call `setOperator(new, true)` for each new key and fund each new key with gas. Switch `EXECUTOR_PRIVATE_KEYS` in `.env.executor` and restart. Then call `setOperator(old, false)` for **every** old key and move each old EOA's dust. Also rotate the Telegram token (BotFather `/revoke`) and the Anthropic key if anyone else had access. |
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
- **Executor key or host compromised.** Treat **every** key in `EXECUTOR_PRIVATE_KEYS` as stolen,
  because they share one env file. From the cold owner, call `setOperator(key, false)` for each
  key, then `sweepEth(cold, 0)`. Optionally call `setSpendLimit(0, 1)` first, so no buy can
  pass while you work. Rotate all keys (§9), rebuild the host and revoke the WireGuard peer. Until
  the keys are revoked, the spend budget and `maxQuoteIn` bound the loss.
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

## Telegram is optional

Start the bot only if you want push notifications or chat approvals
(`docker compose --profile telegram up -d telegram`). Without it, use
`pnpm --filter @hood/db ctl …` (status, pnl, kill, resume, plays, play on/off,
events). Proposed plays that fail `auto_approve` simply stay disabled.
