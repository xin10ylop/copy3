# HoodSniper – architecture

Goal: replicate and beat the workflow in the video (Claude "play finder" → Packet
Tracker funding-trail watch → TradeWiz dev-snipe preset) with our own stack:
faster detection (sequencer feed, not an explorer), tighter execution (timed burst
into the first 6.18 %-tax second), data-driven presets (backtested per operator),
and automated play discovery by an Opus 5.5 agent.

## 1. What the "play" actually is (the logic from the video, formalised)

An *operator* runs a repeated launch pattern on Pons V2:

1. A **funder** ("sprayer") wallet sends a few hundredths of an ETH to one or more
   **fresh** wallets, directly or through a throw-away disperse contract
   (internal transfers). Observed ranges 0.01-0.015 ETH and 0.057-0.174 ETH.
2. Seconds to hours later a fresh wallet **launches** a token on Pons V2. Three
   sub-patterns:
   * **Dev buys at launch** (`launchAndBuy`): the deployer is tax-exempt, so the
     dev's own buy executes at launch with 0 tax. Classic copy-trade target.
   * **Dev never buys; the "team" buys**: the deployer calls plain `launchToken`;
     the `creatorFeeRecipient` and/or explicit `snipeTaxExemptions` wallets (which
     were gas-funded one second earlier and whose buy money sits in a contract made
     seconds earlier) buy in the launch second tax-free. A wallet copy-trade can
     never be armed in time; the launch itself is the only trigger.
   * **Decoys then the real one**: one dev wallet spams same-name tokens that do
     nothing, then a *fresh* wallet (funded by the same funder) launches the same
     name and it runs. The fresh-wallet funding + name match is the trigger.
3. Retail cannot buy in the launch second (99 % tax). The first *taxed* buyer lands
   at +1 s paying 6.18 %. That buyer's entry (≈ 10-13k USD mcap in the video) is
   the realistic entry for anyone. Operator coins then do +100 % in 2-5 s and
   +200-400 % within 30-60 s, after which the operator sells into the retail wave.
4. Profit comes from being the first taxed buyer and exiting within seconds using
   take-profit / trailing stop / stop loss derived from the operator's history.

So a *play* = `{operator fingerprint → trigger rules, preset}` and the system
has three jobs: **discover** plays, **arm** them, **execute** them.

## 2. Why we can be faster than TradeWiz + Packet Tracker

| Step | Video stack | Ours |
|---|---|---|
| Detect funding of a fresh wallet | Packet Tracker polling an explorer | Own node + feed: every ETH transfer (incl. internal via `debug_trace`) indexed in real time; candidate armed within one block |
| Detect launch | TradeWiz sees the dev's tx | We decode the raw signed tx from the **sequencer feed** (before execution), know deployer, name, symbol, exemptions, dev-buy size; receipt from own node ~100-200 ms later as ground truth |
| Decide | fixed per-wallet task | rules engine over indexed state: armed wallet, funder graph, team wallets, name regex, launch kind, dev-buy size, curve economics – all in memory |
| Send | one tx ~1 s after launch, "tax protection 10 %" | **timed burst** of pre-signed txs through a helper contract, spaced across the predicted second boundary, each reverting cheaply unless tax ≤ max and not already bought; sent from an Ohio host 3 ms from the sequencer |
| Exit | TP/SL polled by bot | position manager on 100 ms blocks, sees exempt-wallet sells in the feed, trailing stop at block granularity |
| Presets | eyeballed from CSV | backtested per operator from the indexed trade history, re-fitted continuously |
| Discovery | manual + Claude chat | Opus 5.5 agent with DB/RPC tools, on demand (`/play <CA>`) and as a scout that scans every launch for runners and unravels the operator |

## 3. Timing model (the core of execution)

* The curve computes `elapsed = block.timestamp - launchedAt` in whole seconds.
  Launch block timestamp = `T`. Any block with timestamp `T` → 99 % tax. The first
  block with timestamp `T+1` → 6.18 %. `T+2` → 0.19 %. `T+3` → 0.
* Nitro seals a block every ~100 ms; all txs queued since the previous seal share the
  new block's timestamp (the sequencer clock at seal time). So the race is: be first
  in the queue after the last `T` block seals. That instant is unknown to the
  10-100 ms, so we **burst**: `k` txs with consecutive nonces, spaced `spacingMs`
  apart, starting `startMs` before the predicted boundary.
* Each burst tx calls `PonsSniper.snipe(curve, token, quoteIn, minTokensOut, maxTaxBps, deadlineBlock)`.
  The contract (a) reverts if `curve.currentSnipeTaxBps(this) > maxTaxBps`
  (landed in a `T` block – cheap revert, ~30k gas ≈ 0.0000006 ETH), (b) reverts if
  `bought[token]` is already set (landed after a successful sibling), (c) otherwise
  buys with `minTokensOut`, records `bought[token]`, keeps tokens in the contract
  (pre-approved to the curve for instant sells), and emits `Sniped`.
  Net effect: exactly one buy, in the earliest `T+1` block we can reach, regardless
  of which burst member hits it. Reverted members cost dust.
* Clock model: the executor keeps an estimate of the sequencer's second boundary
  from the feed (`localArrival − minObservedLatency` for the first block of each new
  second, min-filtered) plus the measured RTT to the RPC. Config
  `burst = {startMs: -120, spacingMs: 15, count: 10}` by default; tuned from
  `feed_blocks` statistics and from where our winning tx landed.
* Fallback: if the feed path is down, the executor fires on the `TokenLaunched`
  log from the node with the same burst logic.
* Nonce handling: burst txs are sent in nonce order over one keep-alive connection
  to each endpoint (own node, public RPC, optional relay); the Nitro sequencer holds
  too-high nonces for ~1 s so slight reordering is tolerated. After the burst the
  executor reconciles the nonce from the chain.
* Why a helper contract and not raw curve calls: without it, every burst member
  that lands after the first success would buy again (multi-buy), and a member
  landing in a `T` block would either pay 99 % or revert only through slippage.
  The contract makes the burst idempotent and the tax check explicit.
  Must-verify: the curve does not restrict `msg.sender` to EOAs (RESEARCH §7.2).

## 4. Components (monorepo, TypeScript, pnpm workspaces)

```
packages/core      addresses, ABIs, feed decoder, curve math, play/preset types, clock model (pure, unit-tested)
packages/db        Postgres schema + migrations + typed query helpers (postgres.js); PGlite for tests
services/indexer   node WS → launches, curve trades, ETH transfers (plain + traced internal), wallets, per-token metrics/peaks
services/tracker   funding-trail watcher: funder rules → armed candidates (+ "fresh" checks), expiry, notifications
services/sniper    HOT PATH: feed decoder + rules engine + executor (burst) + position manager (TP/trailing/SL/timeout) + nonce/key mgmt
services/agent     Opus 5.5 play finder + scout + backtester: tools over DB/RPC, writes reports + CSV, proposes plays
services/telegram  bot: commands, approvals, notifications, daily PnL
contracts/         PonsSniper.sol (solc-js build, Hardhat/EDR tests, deploy script)
infra/             docker-compose (nitro node, postgres, services), Cherry Servers provisioning (API/Terraform), Ohio executor unit, backups, monitoring
docs/              RESEARCH.md, ARCHITECTURE.md, SPEC.md, RUNBOOK.md, RISKS.md
```

### Data flow

```
sequencer feed ──► sniper (decode launches, armed match, burst) ──► RPC/sequencer
      │                    ▲ in-memory rules (plays, armed, team wallets)
own nitro node ──► indexer ─► Postgres ◄─ tracker (arms candidates) ◄─ plays (approved via Telegram)
                              ▲  ▲
                              │  └── agent (play finder / scout / backtest) ─► reports, CSV, proposed plays
                              └───── telegram (commands, notifications)
```

Postgres `LISTEN/NOTIFY` channels (`plays_changed`, `armed_changed`, `snipe_events`)
push config changes to the sniper's memory; the hot path never queries the DB
while deciding.

## 5. Deployment topology

* **Cherry Servers, Chicago** (bare metal, e.g. Ryzen 7950X 16c/128 GB/2x1 TB NVMe,
  $199/mo; go EPYC 9375F with 10 TB if the pruned snapshot is > 1.5 TB):
  nitro full node (`debug` API on, feed primary + delayed secondary), Postgres,
  indexer, tracker, agent, telegram, Grafana/Prometheus.
* **Ohio executor** (the edge): the `sniper` service is self-contained (feed +
  in-memory rules + signer). It should run in AWS us-east-2 (a `c7i.large`-class
  VM, ~$60/mo) or any Ohio host; it talks to the Chicago Postgres over TLS only for
  config sync and to record results, and sends txs to `rpc.mainnet` directly (3 ms)
  plus our own node (fallback). If the user insists on Cherry-only, run it on the
  Chicago box and accept ~24 ms (~¼ block) of disadvantage; the burst still works.
* **L1 endpoints** for the nitro node: a paid Ethereum mainnet RPC + beacon (e.g.
  QuickNode/Alchemy/dRPC) – running our own L1 is out of scope.
* Secrets: executor key in an env file with 0600 perms on the executor only; the
  `PonsSniper` contract is owned by that EOA; profits swept to a cold wallet by a
  `sweep` command. Never share private keys with Telegram bots (TradeWiz lost
  users' keys in the hack the video mentions).

## 6. Risk controls (all enforced in code, defaults in SPEC.md)

per-play: max buy ETH, max concurrent positions, stop-after-N, cool-down after a
loss, daily loss limit (global kill switch), min quote reserve / max mcap at entry,
abort if any exempt wallet *sold* in the launch block, abort if `maxTaxBps` not met,
timeout sell, trailing stop, hard stop loss, max gas price, nonce reconciliation,
dry-run mode (`EXECUTION_MODE=paper`) that logs the would-be burst and simulated PnL.

## 7. Honest expectations

This is a latency race against other bots in Ohio and against the operators
themselves, who can change pattern, exempt-buy larger, or dump into the first taxed
block. The edge comes from (1) proximity + burst timing, (2) selecting operators
whose history shows a positive expectancy after 6.18 % tax + 1 % fee + slippage,
(3) exiting mechanically. Paper-trade every play before funding it; the backtester
and `paper` mode exist for exactly this.
