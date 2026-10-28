# HoodSniper: risk register

An honest list of what can lose money, keys or access, and what we do about each item. Likelihood
and impact are our judgement for a small operator running this stack as designed (L/M/H).
"Residual" is what is left after the mitigations.

The baseline expectation: most memecoin snipers lose money, and any edge here decays. Our edge
rests on three things: proximity plus burst timing, choosing operators whose history pays after
tax and fees, and exiting mechanically. Each of the three can disappear without warning.
Paper-trade first, start small, keep the loss limits on.

| # | Risk | L | I | Main mitigations | Residual |
|---|---|---|---|---|---|
| 1 | Losing the latency race to Ohio bots and to the operator's own team | H | H | Executor in us-east-2 (~3 ms vs 27 ms from Chicago); feed decode before execution; timed burst across the second boundary; sub-ms clock | We still lose many races. Exempt team wallets can never be beaten. |
| 2 | Operator changes behaviour (new funder, decoys, bigger exempt buys, stops the pattern) | H | M-H | Scout re-checks plays; per-play `stopAfter`, expiry of armed wallets (48 h); backtest re-fits; human approval of every play | Each play has a shelf life. Expect to retire plays. |
| 3 | Rug or dump into the first taxed block (we buy the top) | M-H | H | `abortIfExemptSellInLaunchBlock`, `exitIfExemptSellsPct`, `maxEntryMcapEth`, stop loss, trailing stop, timeout; only plays whose history shows peaks after the first taxed entry | A dump in the same block as our buy cannot be avoided; size per snipe accordingly. |
| 4 | Pons changes tax or launch parameters, or ships a new version | M | H | Sniper reads `snipeTaxStartBps/Seconds` at start; RUNBOOK §10 check; burst only fires when `currentSnipeTaxBps(this) <= maxTaxBps` on-chain | A changed curve ABI or a V3 launchpad stops the bot until the code is updated (it fails closed). |
| 5 | Sequencer downtime, reorgs, ordering-policy change (e.g. Timeboost) | L-M | H | Feed + delayed feed + node logs; kill switch; indexer reorg depth; monitor for an express-lane auction | Open positions cannot exit while the chain is stopped. Timeboost would remove the FCFS edge. |
| 6 | Key custody: hot key theft, sharing keys with third-party bots | M | H | Owner/operator split (proceeds go to the cold owner); key only on the executor in a 0600 env file, systemd hardening; small working balance; never paste keys into Telegram bots | Loss is limited to the contract working balance plus the EOA gas balance. |
| 7 | Robinhood Chain terms of service, launchpad rules, legality of sniping in your jurisdiction | M | H | Read the Robinhood Chain and Pons terms before going live; no wash trading or market manipulation; get legal advice | Addresses can be blocked or censored; legal exposure varies by country. |
| 8 | Tax reporting (many short-lived disposals) | H | M | Every snipe is recorded (`snipes`: buy, tax, sells, realized PnL); export monthly; consult a tax professional | Record-keeping burden; gas is not in the PnL rows. |
| 9 | Smart-contract risk in PonsSniper | M | H | Small, single-purpose contract, tests, owner-only admin; RESEARCH §7 checks (arg order, contract callers) before funding; small balance | Unaudited. A bug or wrong curve encoding can lose the working balance. |
| 10 | Loss limits misconfigured or too loose | M | M-H | `DAILY_LOSS_LIMIT_ETH` (UTC day) trips the kill switch; `MAX_CONCURRENT`; `/preset` refuses buyEth above `TELEGRAM_MAX_BUY_ETH`; daily summary | Realized-only accounting: an open position can still lose more than the limit. |
| 11 | Infrastructure: disk fills, L1/beacon outage, single Chicago box, backups | M | M | Streamed snapshot restore, disk alerts at 80/90 %, 14 daily dumps, healthcheck alerts, Ohio sniper independent of the node | Indexer and agent downtime during restores; Postgres is a single point of failure for records. |
| 12 | Agent errors: hallucinated links, prompt injection via token names/descriptions, cost overrun | M | M | Rule: no link without an on-chain transfer path; proposals are disabled until a human approves; per-run cost caps plus a Console spend limit; HTML-escaped output | A plausible but wrong play can still get approved: read the CSV. |
| 13 | Telegram account or bot token compromise | L-M | M-H | Admin allow-list by numeric user id; bot holds no keys; `/kill` is the most powerful command; revoke via BotFather | A thief with the token cannot command the bot, but can impersonate it to you. |

## Details

### 1. The latency race

The sequencer is first-come-first-served and sits in AWS us-east-2. Measured submission RTT: Ohio
3 ms, Virginia 18 ms, Chicago 27 ms. Blocks are about 100 ms apart. A Chicago-only setup is about a
quarter-block behind any Ohio competitor on every send. The snipe tax creates one narrow window: the
first block whose timestamp is `launch + 1 s` charges 6.18 %, the next second 0.19 %, after that 0.
Everyone who wants the cheap entry aims at the same instant.

- **Mitigations.** The executor runs in Ohio (`infra/executor/`). Launches are decoded from the raw
  sequencer feed before execution. The burst is `count` pre-signed txs spaced `spacingMs` around the
  predicted second boundary, and the helper contract makes it idempotent: one buy, the other members
  revert for about 30k gas. Chrony disciplines the clock against Amazon Time Sync and the ENA PTP
  clock, and the sniper calibrates the boundary from feed arrivals.
- **Not mitigated.** Exempt "team" wallets buy in the launch second with 0 tax, and you cannot beat
  them. Other bots in the same AZ can be as fast or faster. Paper mode cannot measure where our tx
  would land. Only the live canary (RUNBOOK §8) can.

### 2. Operator behaviour change

A play is a fingerprint of one operator's habits: funder, amount range, fresh wallets, team
wallets, naming, launch kind. Operators rotate funders, add decoys (same-name tokens that do
nothing), raise exempt buys, or simply stop. If enough copycats arrive, the operator has every
reason to change.

- **Mitigations.** Armed wallets expire (48 h default). `stopAfter` limits fills per play. The
  scout looks for new clusters every 15 minutes. The backtester re-scores a play on fresh history
  (`/backtest <id>`). Proposals stay disabled until a human approves them.
- **Watch for.** A falling win rate or expectancy in `/pnl` per play. Disable a play quickly
  (`/play_off`); re-enabling it is one tap.

### 3. Dump into the first taxed block

The operator profits by selling into the retail wave, and the first taxed buyers are that wave. If
exempt wallets sell in the launch block, or at `T+1` in the same block as our buy, we buy the top.

- **Mitigations.** `abortIfExemptSellInLaunchBlock` (default on) cancels the burst if an exempt
  wallet sells in the launch block. `exitIfExemptSellsPct` exits when the team dumps (CurveSell or
  a transfer to a dump wallet); its default of 0 exits on the first exempt outflow. Stop loss (40 %),
  the trailing stop (+50 %/-20 %) and the 60 s timeout cap the damage. These are the defaults the
  3-day walk-forward picked (`docs/BACKTEST.md`), and `null` turns an exit off per play.
  `maxEntryMcapEth` and `minQuoteReserveEth` skip launches that are already pumped. Plays are only
  approved when their history shows peaks after the first taxed entry.
- **Residual.** A same-block dump cannot be seen in time. Size `buyEth` so that a 40-100 % loss on
  one snipe is acceptable.

### 4. Pons parameter or contract changes

Measured on 2026-10-28: `snipeTaxStartBps = 9900`, `snipeTaxSeconds = 3`, fee 100 bps, launch fee
0.0005 ETH. The factory owner can likely change these values. The curve ABI (`buy`/`sell` argument
order), `maxInternalPriceImpactBps` and whitelisted launchers can also change, or a new launchpad
version can replace V2 (as V2 replaced V1).

- **Mitigations.** The sniper reads the tax parameters at startup. The contract checks
  `currentSnipeTaxBps(this) <= maxTaxBps` on-chain for every burst member, so a parameter change
  makes bursts revert cheaply instead of overpaying. Curve calls live in one place
  (`_curveBuy/_curveSell`). RUNBOOK §10 has the eth_call check.
- **Residual.** A new ABI or launchpad stops trading until the code is updated (it fails closed).
  Re-run paper mode after any change.

### 5. Sequencer downtime, reorgs, ordering policy

Robinhood Chain has a single sequencer (Arbitrum Orbit). If it stops, nothing confirms. Open
positions cannot exit, and when the chain resumes the price may have gapped through the stop loss.
Soft-confirmed feed blocks are final in practice but can, in principle, be reorged. **Timeboost**
(Arbitrum's express-lane auction) exists in Nitro. If Robinhood Chain enables it, the auction winner
gets a time advantage on every block and FCFS proximity stops being enough.

- **Mitigations.** Primary feed, delayed feed and node logs as triggers. The indexer handles reorgs
  (`REORG_DEPTH`). The kill switch is one tap away. Watch the Robinhood docs and chain config for
  an express-lane auction contract.
- **Residual.** Gap risk while the chain is down. If Timeboost arrives, the strategy needs a
  rethink (bid, or stop).

### 6. Key custody

The video's TradeWiz hack is the cautionary tale: users gave a Telegram bot their private keys and
lost them. In this design:

- **No bot holds a key.** The Telegram service has no key and cannot send transactions. It only
  writes plays, presets and the kill switch to Postgres.
- **Owner/operator split.** The executor key is only an *operator* of PonsSniper. The owner is a cold
  hardware wallet, and every `exit` forwards its proceeds to the owner, so profits never accumulate
  on the hot key. The owner can revoke operators (`setOperator(key, false)`), sweep ETH/tokens, and
  call `rescue`. Guard the owner key accordingly.
- **Limited exposure.** The key exists only on the Ohio host, in `.env.executor` (0600, user
  `hood`), read by a hardened systemd unit (`ProtectSystem=strict`, `NoNewPrivileges`). It is never
  in the repo, Docker images, backups (Postgres has no keys) or user-data. Keep only the working
  balance (≈0.5 ETH) in the contract and gas money on the EOA.
- **Rotation.** Rotate the operator monthly and on any suspicion (RUNBOOK §9-10). Revoke the GitHub
  token used for provisioning. Access to the Chicago Postgres goes over WireGuard only.
- **Residual.** Root on the executor host is equivalent to the hot key, and the contract balance is
  at risk. Losing the owner key means losing control of the contract.

### 7. Terms of service, launchpad rules, legality

Robinhood operates the chain. Its terms, the Pons launchpad terms and local law may restrict
automated trading, sniping, MEV-like behaviour, or use from some jurisdictions. Addresses can be
blocked at the RPC, the bridge or the sequencer. Coordinated pumping, wash trading and spoofing are
illegal in many places, and nothing in this system should ever do them: it only takes the other
side of public launches.

- **Mitigations.** Read the current Robinhood Chain and Pons terms before going live, and re-read
  them after they change. Take legal advice for your jurisdiction. Keep records (risk 8).
- **Residual.** Regulatory and platform risk sits outside our control. This document is not legal
  advice.

### 8. Tax reporting

Each fill and each partial sell is a taxable event in most jurisdictions, and there can be dozens a
day. Snipe tax and curve fees change the cost basis.

- **Mitigations.** The `snipes` table stores every buy (quote in, tax paid, tokens), every sell
  (`sells` with tx hashes), the realized PnL and timestamps. Export it monthly; `/pnl 30` is a quick
  view. Gas is cheap (~0.00002 ETH per snipe) and is **not** in the realized PnL, so add it from the
  executor's transactions.
- **Residual.** You need a tax professional who understands on-chain trading.

### 9. Smart-contract risk (PonsSniper)

The contract is small (snipe, exit, admin) and tested in `contracts/test`, but it is **unaudited**.
Specific concerns:

- **Unverified curve call encoding.** The order of `buy`/`sell` arguments is not yet confirmed by
  eth_call against a live curve (RESEARCH §7.1). The curve might also reject contract callers
  (§7.2). Both must be verified before funding.
- **Untrusted curve address.** `snipe` sends `quoteIn` to whatever `curve` the operator passes. The
  sniper must only pass curves taken from a `TokenLaunched` log of the known factory, or from a
  verified CREATE prediction. Never pass a curve derived from untrusted calldata.
- **Unlimited approval.** `_approveMax(token, curve)` gives the curve an unlimited approval for that
  token only.
- **`rescue`.** An arbitrary call by the owner. It is powerful by design; protect the owner key.

- **Mitigations.** Small working balance, owner-only admin, cheap revert paths, and the paper-mode
  gate. Consider an external review before raising balances.
- **Residual.** A bug can lose the working balance.

### 10. Daily loss limits

`DAILY_LOSS_LIMIT_ETH` (default 0.5) counts **realized** PnL on the UTC day. When it is crossed,
the sniper stops opening positions. `settings.daily_loss_limit_eth` overrides it at runtime, and
`settings.kill_switch` (`/kill`) stops entries regardless.

- **Gaps.** An open position can lose beyond the limit before it closes. The limit resets at 00:00
  UTC, which may feel like the middle of your day. A too-high limit makes it decorative.
- **Practice.** Start live with 0.1 ETH. Never set the limit above what you would accept losing
  every day for a week. Read the daily summary.

### 11-13. Infrastructure, agent, Telegram

- **Disk.** The pruned DB is 1.05 TB and grows about 5.3 GB/day. A 2x1 TB box reaches 85 % in about
  3 months. Healthcheck alerts fire at 80/90 %. Restore a fresh snapshot quarterly, or use 2x4 TB.
- **L1 endpoints.** Without blob sidecars the node stalls. Beacon nodes prune blobs after ~18 days,
  so restore snapshots younger than that.
- **Single Chicago box.** Postgres is the system of record. Keep 14 daily dumps and copy them off
  the box. The Ohio sniper keeps trading if Chicago dies, but it cannot record results, so `/kill`
  if you lose visibility.
- **Agent.** Token names, symbols and descriptions are attacker-controlled text and reach the
  model. Treat them as data: the agent's tools are read-only except for `propose_play`, and
  proposals are disabled until approved. Every run has a cost cap; also set a monthly limit in the
  Anthropic Console.
- **Telegram.** The bot drops every update whose user id is not in `TELEGRAM_ADMIN_IDS`. Turn on
  two-step verification for the admin Telegram accounts. A leaked bot token lets someone send
  messages *as the bot* (phishing), but not run commands. Revoke it in BotFather if that happens.

## The paper-mode gate

No play gets real money until it passes this gate (RUNBOOK §7-8):

1. **Backtest** on indexed history: positive expectancy after 6.18 % tax, 1 % fee each way and
   slippage, on at least 3 coins of the fingerprint.
2. **Paper** for at least 3 days and at least 10 snipes: positive paper PnL within about half of
   the backtest's expectancy, no unexplained aborts or errors, a fresh feed, clock offset under
   1 ms.
3. **Live canary** at the smallest size (0.01 ETH, `MAX_CONCURRENT=1`, 0.1 ETH daily limit). Fills
   must land at +1 s (6.18 % tax paid), not +2 s, in most attempts.
4. **Scale gradually**, only while live results track paper.

Backtests overfit and paper fills are optimistic: paper assumes our tx is first in the first `T+1`
block. Each step exists to catch a different lie.
