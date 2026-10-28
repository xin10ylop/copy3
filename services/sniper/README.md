# @hood/sniper — the hot path

Sequencer feed → launch detection → rules → risk → timed burst through `PonsSniper` →
position manager → recorder. Runs `live` (signs and sends) or `paper` (same pipeline, simulated
fills). Spec: `docs/ARCHITECTURE.md` §3 (timing model) and `docs/SPEC.md` §3.

```
feed (wss, deflate) ─► FeedClient ─► SequencerClock.ingest ─► LaunchDetector (prefilter → ABI decode → sender)
                                                                  │
                                    Rules.evaluate (memory) ◄─────┘ ─► Risk.preCheck (memory)
                                                                  │
            TokenLaunched log (node ws) ─┬─► token/curve ◄────────┘     (CREATE2: not predictable, see below)
            receipt polling (20 ms) ─────┘        │
                                                  ▼
                         getReserves (raced with launch-config reserves) ─► Risk.reserveCheck ─► minTokensOut
                                                  ▼
          SequencerClock.planBurst ─► LiveExecutor: sign+schedule member by member ─► fan-out to SEND_ENDPOINTS
                                     PaperExecutor: fill at the first block of launch+1 s
                                                  ▼
                 Positions (CurveBuy/CurveSell/Transfer logs + feed calls + getReserves poll) ─► exit
                                                  ▼
                                 Recorder ─► snipes / events / feed_blocks (@hood/db)
```

Nothing on the decide path touches the DB. The only RPC on it is `getReserves` on the new curve,
and it is not waited on for more than 5 ms when the launch config's start reserves are known.
Plays, armed candidates and settings are loaded at start and refreshed on
`NOTIFY plays_changed / armed_changed / settings_changed`.

## How the burst works

The curve charges `snipeTax = 9900 >> ((elapsed·14)/3)` bps, where `elapsed = block.timestamp − launchedAt`
in whole seconds. That is 99 % in the launch second `T`, 6.18 % at `T+1`, 0.19 % at `T+2` and 0 from
`T+3`. The goal is to be first in the first block sealed with timestamp `T+1`.

1. **Clock.** Robinhood Chain seals about 10 blocks/s on a 100 ms grid that is phase-locked to the
   second. Live data shows a within-second arrival profile of
   `[0, 100, 198, 302, 401, 500, 597, 706, 807, 900]` ms. For every second the
   `SequencerClock` keeps the earliest feed arrival. The rolling minimum (120 s window, Theil–Sen
   drift fit only after 60 s of data) of `arrival − ts·1000` is the *boundary offset*, and
   `predictBoundaryMs(T+1)` is the local time at which the first `T+1` block is delivered. It also
   tracks the grid phase (circular median of `arrival mod 100`), a jitter estimate, and a lower
   bound from the last block of the previous second. A live sample from a non-Ohio host:
   offset 56 ms, jitter 23 ms, phase 57 ms.
2. **Schedule.** Member `i` is sent at `boundary(T+1) − rtt + startMs + i·spacingMs`, clipped so that
   the last send is `≤ boundary(T+2) − rtt` (landing at +2 s still pays only 0.19 %). Members whose
   time has already passed (late detection) collapse into one immediate send. With the default
   `{startMs: −120, spacingMs: 15, count: 10}` the burst starts one block (+20 ms) before the
   predicted first `T+1` seal, so the early members are already queued when the last `T` block
   seals, and it continues 15 ms past the seal.
3. **Idempotent contract.** Every member calls
   `PonsSniper.snipe(curve, token, quoteIn, minTokensOut, maxTaxBps, deadlineBlock)` with
   `msg.value = 0`; the contract pays from its own ETH balance. The checks run in this order:
   - `Expired()`: L2 block from `ArbSys` > deadline. 23 k gas.
   - `NotOperator()`.
   - `AlreadyBought()`: a sibling already bought. 27.5 k gas.
   - `TaxTooHigh(tax)`: the member landed in a `T` block. 37.6 k gas.
   - Otherwise it buys once and keeps the tokens, pre-approved to the curve. 172 k gas.

   Net effect: exactly one buy, in the earliest `T+1` block any member reaches. Reverted members cost
   dust (≈ 0.0000008 ETH each at 0.02 gwei).
4. **Token and curve addresses.** The launch deployer uses CREATE2 with salts from the launch
   params, which core verified live. The addresses therefore come from the `TokenLaunched` log (node
   ws subscription) or from the launch receipt (polled every `RECEIPT_POLL_MS`), whichever arrives
   first, about 100–200 ms after sequencing. Everything else is prepared from the feed tx: decision,
   risk, quote, nonces, gas and warm connections. `ADDRESS_PREDICTION=nonce` keeps the original
   CREATE-nonce predictor; it disables itself after two mismatches.
5. **minTokensOut.**
   - With `maxEntryMcapEth`: the output at the cap price, using the curve invariant `k = Q·T`. The
     buy then reverts on-chain if the launch-second team buys pushed the price past the cap.
   - Otherwise: `slippageBps` below the expected output at the worst tax the preset allows
     (618 bps for `maxTaxBps` 1000).

   Note that the AMLIL team bought 18 % of supply in the launch second, which moved the price +49 %.
   A 30 % slippage limit against launch reserves fails there; this is covered by a paper e2e test.
   Prefer `maxEntryMcapEth`, or a slippage of 8000–9000 like the video.
6. **Send.** Members are signed (0.73 ms each) and scheduled one at a time, so the first send is
   never waiting for the rest. `setTimeout` runs to `SPIN_MS` before the target, then a busy-wait.
   Each raw tx goes to every `SEND_ENDPOINTS` URL over keep-alive `node:http(s)` agents that a
   5-second `eth_chainId` ping keeps warm and measures (RTT = minimum of the recent pings).
7. **Reconcile.** Receipts are polled for every member. The fill (`Sniped` + `SnipeTaxCharged`) is
   reported as soon as it is seen, and member statuses (`mined/reverted/dropped`) are finalised in
   the background. The local nonce resyncs from `eth_getTransactionCount(latest)` when nothing is in
   flight, which covers dropped or skipped members.

Fallback: if a `TokenLaunched` log arrives whose tx the feed never showed, it waits 150 ms, then
rebuilds the launch from the node and runs the same logic.

### Exits (Positions)

- **Price.** Prices come from CurveBuy/CurveSell logs (exact reserve deltas: buy
  `Q += quoteIn − fee − tax`, where `fee` already includes the snipe tax) plus a `getReserves`
  poll every `RESERVES_POLL_MS`.
- **Mark.** The mark is the liquidation value per token, `quoteSell(holding)/holding`. The entry is
  the effective price paid, including tax and fees. PnL is therefore what a sale would actually
  realise.
- **Rules.** In priority order: operator dump, stop loss, trailing stop (arms at `activatePct`,
  exits on a `dropPct` pullback from the peak), timeout, then the TP ladder (`sellPct` of the
  remaining position).
- **Operator dump.** On AMLIL the team never sold from the exempt wallets; they transferred
  180 M tokens to a fresh wallet in 13 batches. Two sources are watched:
  - the feed: an exempt wallet calling `transfer`/`transferFrom` on the token or `sell` on the
    curve (fastest);
  - node `Transfer` logs with `from ∈ exempt` and `to ∉ exempt`, which also catch batch contracts.

  The cumulative outflow, as a share of the team's holding (`balanceOf` baseline via multicall),
  is compared with `exitIfExemptSellsPct`. Use `1` to exit on the first batch.
- **Exit retries.** Exits call `PonsSniper.exit` with up to 3 attempts, at 15 %, 40 % and then
  100 % slippage.

## Environment

| Var | Default | Meaning |
|---|---|---|
| `EXECUTION_MODE` | `paper` | `live` signs and sends; `paper` simulates |
| `FEED_URL` | `wss://feed.mainnet.chain.robinhood.com` | primary sequencer feed (the server **requires permessage-deflate**) |
| `FEED_URL_SECONDARY` | – | comma list of fallback feeds (e.g. own node relay, `wss://delayed-feed.mainnet.chain.robinhood.com`); duplicates are dropped by sequence number, reconnects request replay from the next block |
| `NODE_HTTP` | – | node for reads: `getReserves`, receipts, nonce (falls back to `PUBLIC_RPC`). Use the lowest-latency endpoint from the executor host |
| `NODE_WS` | – | node ws for `TokenLaunched` and token/curve log subscriptions (without it: receipt polling + `getReserves` polling) |
| `PUBLIC_RPC` | `https://rpc.mainnet.chain.robinhood.com` | fallback read endpoint |
| `SEND_ENDPOINTS` | `NODE_HTTP` or `PUBLIC_RPC` | comma list; every burst member goes to all of them; the first is used for RTT |
| `DATABASE_URL` | – | Postgres (`@hood/db`). Required in live mode; without it paper mode uses an in-memory store |
| `PLAYS_FILE` | – | JSON array of plays (SPEC §4 shape) for DB-less paper runs |
| `EXECUTOR_PRIVATE_KEY` | – | live only; operator/owner of the PonsSniper contract; chmod 600 env file on the executor host |
| `SNIPER_CONTRACT` | – | live only; deployed PonsSniper address |
| `MAX_GAS_PRICE_GWEI` | `1` | global cap: blocks snipes when L2 gas price is above it and clamps every preset's `maxFeeGwei` |
| `DAILY_LOSS_LIMIT_ETH` | `0.5` | realised live loss (UTC day) that stops new snipes |
| `MAX_CONCURRENT` | `3` | pending + open snipes |
| `RTT_MS` | `0` | fixed RTT to the sequencer; `0` = measured against the first send endpoint |
| `DEADLINE_BLOCKS` | `40` | L2 blocks after the launch block after which members revert with `Expired()` (~4 s) |
| `HEALTH_PORT` | `8081` | `/healthz`, `/metrics`, `/clock` |
| `LOG_LEVEL` | `info` | pino level |
| `ADDRESS_PREDICTION` | `none` | `nonce` = CREATE prediction (Pons V2 uses CREATE2, so it self-disables) |
| `RESERVES_POLL_MS` | `500` | `getReserves` resync for open positions |
| `RECEIPT_POLL_MS` | `20` | launch receipt polling while waiting for the curve address |
| `ADDRESS_TIMEOUT_MS` | `1500` | give up waiting for token/curve (also bounded by `boundary(T+2)`) |
| `CLOCK_WINDOW_MS` | `120000` | clock estimation window |
| `SPIN_MS` | `1.5` | busy-wait before each scheduled send |
| `MAX_LAUNCH_AGE_MS` | `2500` | ignore launches whose feed block arrived later than this after its second (replays) |

DB `settings` keys read at start and on `settings_changed`:
- `kill_switch`: `true` or `{"enabled":true}` blocks every new snipe.
- `daily_loss_limit_eth` and `max_concurrent` override the env values.

## Paper mode

No database, a plays file, and the public feed:

```bash
cat > /tmp/plays.json <<'EOF'
[{ "id": 1, "name": "shib dev",
   "trigger": { "deployerIn": ["0x81eb508048220493549302d8ea5ef73a3fde1784"] },
   "preset":  { "buyEth": 0.07, "maxTaxBps": 1000, "maxEntryMcapEth": 4,
                "takeProfits": [{ "pct": 150, "sellPct": 100 }],
                "trailing": { "activatePct": 100, "dropPct": 25 }, "stopLossPct": 40,
                "timeoutSec": 120, "exitIfExemptSellsPct": 1 } }]
EOF
PLAYS_FILE=/tmp/plays.json pnpm --filter @hood/sniper paper
curl -s localhost:8081/healthz | jq '.feed, .clock.offsetMs, .counters'
```

With `DATABASE_URL`, plays come from the `plays` table, and every decision, planned burst, fill,
sale and close is written to `snipes`, `events` and `feed_blocks`. Paper fills are simulated as
follows:

- **Buy:** at the first block with timestamp ≥ `T+1`, using the curve state *right before* that
  block (`eth_call` at `block−1`). Our simulated buy is first in that block. The cost model is the
  snipe tax for that second (618 bps), a 1 % fee and the creator tax from the launch params.
- **Sells:** `quoteSell` on the latest reserves.

The paper e2e test replays the real AMLIL trade sequence. Entry is 2.777e-9 ETH/token (the real
first taxed buyer averaged 2.79e-9), TP1 (+150 %) fires at +6.5 s, and 0.07 ETH realises
+0.107 ETH.

## Tuning `burst` from `feed_blocks` and results

`feed_blocks(block, ts, arrival_ms, n_txs)` is written for every feed block. `/metrics` exposes:
- `sniper_clock_second_offset_ms{ts}` for the last 20 seconds;
- `sniper_clock_within_second_ms{k}`;
- `sniper_clock_offset_ms`, `sniper_clock_jitter_ms` and `sniper_clock_phase_ms`.

```sql
-- first-arrival offset per second (what the clock min-filters); look at min / p50 / p95
WITH f AS (SELECT ts, min(arrival_ms) - extract(epoch FROM ts)::bigint * 1000 AS off
           FROM feed_blocks WHERE ts > now() - interval '1 hour' GROUP BY ts)
SELECT min(off), percentile_cont(0.5) WITHIN GROUP (ORDER BY off) p50,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY off) p95 FROM f;

-- within-second profile: arrival of the k-th block after the first block of its second
WITH b AS (SELECT ts, arrival_ms, row_number() OVER (PARTITION BY ts ORDER BY block) - 1 AS k,
                  min(arrival_ms) OVER (PARTITION BY ts) AS first FROM feed_blocks
           WHERE ts > now() - interval '1 hour')
SELECT k, percentile_cont(0.5) WITHIN GROUP (ORDER BY arrival_ms - first) FROM b GROUP BY k ORDER BY k;

-- where did our winning member land, and how many landed too early (TaxTooHigh) / too late?
SELECT id, token, buy_block,
       (SELECT array_agg(e->>'status' ORDER BY (e->>'nonce')::int) FROM jsonb_array_elements(burst) e) AS statuses,
       decision->'plan'->>'boundaryMs' AS boundary, decision->'plan'->>'rttMs' AS rtt
FROM snipes WHERE mode = 'live' ORDER BY id DESC LIMIT 20;
```

Rules of thumb:

- **`startMs`:** about `−(block interval + p95 jitter)`. Measured, that is about −100 − 20 = −120.
  - If the winning member is often index 0, start earlier.
  - If the first 4+ members routinely land in `T` (reverted `TaxTooHigh`), start later.
- **`spacingMs`:** at most half of the p50 jitter, so at least one member arrives within each half
  jitter. The default 15 ms suits a 20–30 ms jitter. In Ohio, with 3 ms RTT and lower jitter, try
  8–10 ms.
- **`count`:** `ceil((−startMs + 30) / spacingMs)`, so the burst runs about 30 ms past the
  predicted seal. Each extra member costs about 30 k gas of dust.
- **RTT:** compare `decision.plan.rttMs` with `burst[].sends[].doneAt − sentAt` on the primary
  endpoint. Set `RTT_MS` if the ping-based value is noisy.

## Going live (exact sequence)

1. Verify on chain. These items were confirmed by core:
   - `buy(quoteIn, minTokensOut, recipient)` with `msg.value == quoteIn`;
   - contract callers are allowed;
   - no buy splitting is needed;
   - the deployer uses CREATE2.

   Re-run `pnpm --filter @hood/core test` with `LIVE=1` on the executor host.
2. Run the DB migrations: `pnpm db:migrate`. Insert the play with `enabled=false`.
3. Create the executor key on the Ohio host, in an env file with `chmod 600`. Fund it with about
   0.01 ETH for gas.
4. Deploy the contract:
   - Dry run first:
     ```bash
     DRY_RUN=1 EXECUTOR_PRIVATE_KEY=… pnpm --filter @hood/contracts deploy
     ```
   - Then for real. This deploys, checks `owner`, `operators` and `arbBlockNumbers()==true`, and
     funds the contract:
     ```bash
     FUND_ETH=0.2 EXECUTOR_PRIVATE_KEY=… pnpm --filter @hood/contracts deploy
     ```
   - Set `SNIPER_CONTRACT`.
5. Paper-trade the play for at least one day with the same env (`EXECUTION_MODE=paper`):
   - check `/metrics`: `sniper_clock_ready 1`, `sniper_feed_gaps_total` flat, decode p99 < 2 ms;
   - check the `snipes` rows (fill price vs. the indexer's first taxed buyer, PnL).
6. Arm the kill switch (`settings.kill_switch = true`). Switch to `EXECUTION_MODE=live` with:
   - `SEND_ENDPOINTS` = Ohio public RPC first, then your node;
   - `MAX_GAS_PRICE_GWEI=0.1`;
   - `DAILY_LOSS_LIMIT_ETH` small;
   - a play with `buyEth` ≤ 0.02 and `stopAfter: 1`.

   Start the service and confirm `/healthz` is ok and `sniper_nonce` matches the chain.
7. Clear the kill switch (`settings.kill_switch = false`; the change propagates via NOTIFY) and
   enable the play.
8. After the first live snipe, inspect `snipes.burst`: which nonce mined, how many members reverted
   `TaxTooHigh` or `AlreadyBought`, and whether any were dropped. Re-tune `burst`, then raise
   `buyEth` and `stopAfter`.
9. Sweep profits regularly from the owner key: `PonsSniper.sweepEth(cold, 0)`. Exits already
   forward the proceeds to the owner.

Kill switch: set `settings.kill_switch` to `true` (live within milliseconds via NOTIFY). Open
positions keep being managed and exited.

## Tests

`pnpm --filter @hood/sniper test` runs all tests offline:

- **Detector:** replays the 40 captured frames, and runs the real launch tx built from fixture
  fields.
- **Rules:** a table test for every trigger field and the `require` AND-set.
- **Executor:** fake clock and endpoints; checks count, spacing, nonces, raw tx contents and
  idempotent reconciliation.
- **Positions:** TP, ladder, trailing +100 %/25 %, SL 40 %, timeout, and the dump signal via log
  and via the feed.
- **Paper e2e:** the AMLIL timeline.
- **PgStore:** runs against the real `@hood/db` migrations on PGlite.
- **Config and metrics.**

`pnpm --filter @hood/sniper typecheck` also typechecks the tests.
