# @hood/sniper — the hot path

Sequencer feed → launch detection → rules → risk → **launch receipt** → timed burst through
`PonsSniper` → position manager → recorder. Runs `live` (signs and sends) or `paper` (same
pipeline, simulated fills). Spec: `docs/ARCHITECTURE.md` §3 (timing model) and `docs/SPEC.md` §3.
Review findings and their status: `docs/REVIEW.md`.

```
feed (wss, deflate) ─► FeedClient ─► SequencerClock.ingest ─► LaunchDetector (tx.to ∈ launchers ∧ launch selector → ABI decode → sender)
                                                                  │
                                    Rules.evaluate (memory) ◄─────┘ ─► Risk.preCheck (memory) ─► slot reserved
                                                                  │
            TokenLaunched log (node ws) ─┬─► wakes ──► launch RECEIPT (polled every RECEIPT_POLL_MS)
                                         │              verifyLaunchReceipt: success, one factory TokenLaunched,
                                         │              deployer == matched deployer, team = SnipeTaxExempted logs
                                         │              ─► Rules.evaluatePlay + Risk.confirmCheck ─► Risk.confirm (play state)
                                                  ▼
                         getReserves (raced with launch-config reserves) ─► Risk.reserveCheck ─► minTokensOut
                                                  ▼
          Risk.sendCheck + backend.preflight (balances) ─► SequencerClock.planBurst
                                                  ▼
          LiveExecutor: free burst key, sign+schedule member by member, guard before the first send,
                        fan-out to SEND_ENDPOINTS (re-send once if nobody accepted), nonce-gated receipts
          PaperExecutor: fill at the first block of launch+1 s (PAPER_FILL=first|last)
                                                  ▼
          fill → Positions (any fill, even after an abort)     no fill (live) → chain truth: bought(token), balanceOf
                                                  ▼
                 Positions (reserve book at explicit blocks + trade-log deltas, exit state machine) ─► exit key
                                                  ▼
                                 Recorder ─► snipes / events / feed_blocks (@hood/db)
```

Nothing on the decide path touches the DB. The RPC calls on it are the launch receipt (needed to
prove the launch, H1) and `getReserves` on the new curve, which is not waited on for more than 5 ms
when the launch config's start reserves are known. Plays, armed candidates and settings are loaded
at start and refreshed on `NOTIFY plays_changed / armed_changed / settings_changed`.

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
   - `MaxTaxTooHigh()`: `maxTaxBps ≥ 9900` would disable the tax gate (M3; the service also clamps
     to 5000 and zod caps presets at 5000).
   - `NotOperator()`.
   - `AlreadyBought()`: a sibling already bought. 27.5 k gas.
   - `TaxTooHigh(tax)`: the member landed in a `T` block. 37.6 k gas.
   - `QuoteTooLarge(quoteIn, maxQuoteIn)` and `UnknownCurve()`: an operator key can only spend up to
     the owner-set `maxQuoteIn`, and only on the curve the immutable factory returns for the token
     (`getLaunchedToken(token).curve`) — a hot key cannot drain the contract (M4).
   - Otherwise it buys once and keeps the tokens, pre-approved to the curve. ~182 k gas (mock curve).

   Net effect: exactly one buy, in the earliest `T+1` block any member reaches. Reverted members cost
   dust (≈ 0.0000008 ETH each at 0.02 gwei).
4. **Launch confirmation (spoof protection, reviewer H1).** A feed tx is only a launch candidate if
   it is sent **to** the factory, the launch router or a contract listed in `LAUNCHERS`, with a
   launch selector. Launch-shaped calldata sent anywhere else is ignored: anyone can put
   `launchTokenFor(…, deployer = <a wallet we follow>)` into a tx to their own contract. Even a
   candidate is only a hint: nothing is signed until its **receipt** shows a successful tx with
   exactly one `TokenLaunched` from the factory whose `deployer` equals the deployer the rules
   matched on (`verifyLaunchReceipt`). Token and curve come from that log, the team (exempt) wallets
   from the curve's `SnipeTaxExempted` logs in the same receipt, and the play is re-evaluated on the
   confirmed event. `stopAfter`, `firstBuyOnly` and the token cap are recorded only now
   (`Risk.confirm`), so a spoofed or reverted launch can neither trigger a buy nor block the real
   one. A confirmed run that never filled is un-counted for `stopAfter`; the deployer stays marked
   for `firstBuyOnly`.

   The launch deployer uses CREATE2 with salts from the launch params (verified by core), so the
   addresses are not predictable; the receipt arrives about 100–200 ms after sequencing and the
   `TokenLaunched` ws log wakes the receipt poll early. Everything else is prepared from the feed tx:
   decision, risk, quote, gas and warm connections. `ADDRESS_PREDICTION=nonce` keeps the original
   CREATE-nonce predictor (it self-disables after two mismatches); it never replaces the receipt.

   **Live plays need a non-spoofable matcher:** `armedWallet` or `deployerIn` (both bound to the tx
   signer / `TokenLaunched.deployer`). Plays that match only on `nameRegex`, `symbolRegex` or
   `teamWalletsAny` (chosen by whoever launches) arm paper runs only.
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
   5-second `eth_chainId` ping keeps warm and measures (RTT = minimum of the recent pings). Right
   before the first member leaves, the kill switch and the daily loss limit are checked again
   (memory only); if either tripped since the decision nothing is sent.
7. **Reconcile.** Receipts are polled gently: one `getTransactionCount(key, latest)` per
   `BURST_RECEIPT_POLL_MS` tick, and a receipt only for members whose nonce the chain has consumed.
   The fill (`Sniped` + `SnipeTaxCharged`) is reported as soon as it is seen; member statuses
   (`mined/reverted/dropped`) are finalised in the background. If the burst reports **no fill**,
   the member receipts are read once more and then the contract is asked (`bought(token)`,
   `token.balanceOf(sniper)`); tokens in the contract always become a position (reviewer H3). If the
   chain cannot be read the run stays `pending` (slot held, `snipe_unresolved` alert) and the
   reconcile timer retries every `RECONCILE_MS`.

Fallback: if a `TokenLaunched` log arrives whose tx the feed never showed, it waits 150 ms, then
rebuilds the launch from the node (only if that tx was sent to a launcher) and runs the same logic,
receipt confirmation included. Every fire-and-forget promise on these paths is caught; a 429 from
the node there is logged, never fatal (reviewer M2).

### Operator keys (multi-key setup, reviewer M1)

`EXECUTOR_PRIVATE_KEYS=exitKey,burstKey1,burstKey2,…` — every key is a `PonsSniper` operator with
its own nonce sequence:

- the **first** key only sends exits, so an exit never queues behind a burst's nonces;
- every further key is one **burst slot**: a burst holds its key from signing until its nonces are
  settled, so concurrent bursts never share a sequence. With all slots busy a new burst is refused
  (`no free burst key`); give at least `MAX_CONCURRENT` burst keys;
- a member that no endpoint accepted is re-sent once (same raw tx, same nonce) to every endpoint;
- after a burst or an exit, every nonce the key broadcast but the chain did not consume (a member
  rejected or dropped while a later one was accepted) is consumed with a 0-value self-transfer
  (21 k gas) so nothing stale can execute later; then the key resyncs from the chain;
- a single key (`EXECUTOR_PRIVATE_KEY`, legacy) is shared by exits and bursts and serialises them:
  an exit waiting for its receipt delays a burst. Not recommended for live.

Fund each key with gas (≥ `MIN_GAS_BALANCE_ETH`; a burst member reserves `gasLimit × maxFee` up
front). Before every burst the executor checks the cached balances (refreshed every
`BALANCE_POLL_MS` and after every burst/exit): contract ETH ≥ `quoteIn`, the burst key and the exit
key ≥ max(`MIN_GAS_BALANCE_ETH`, `gasLimit × maxFee`). A failing check aborts the burst and writes a
`low_balance` event (reviewer L8).

### Exits (Positions)

- **Price.** A `getReserves` snapshot is read at an **explicit block number** (`RESERVES_POLL_MS`;
  live fills are seeded with the reserves at the fill block). CurveBuy/CurveSell logs at or below
  the snapshot block are already contained in it and ignored; later ones are kept as deltas
  (buy `Q += quoteIn − fee − tax`, where `fee` already includes the snipe tax). Reserves =
  snapshot + deltas above it, so a lagging or leading snapshot can never count a trade twice
  (reviewer M5: no phantom stop loss).
- **Mark.** The mark is the liquidation value per token, `quoteSell(holding)/holding`. The entry is
  the effective price paid, including tax and fees. PnL is therefore what a sale would actually
  realise.
- **Rules.** In priority order: operator dump, stop loss, trailing stop (arms at `activatePct`,
  exits on a `dropPct` pullback from the peak), timeout, then the TP ladder (`sellPct` of the
  remaining position; a level whose share rounds to 0 tokens is skipped — a 0-token exit is never
  sent and the contract refuses it, reviewer L1). Whole-position exits use `exitAll`.
- **Operator dump.** On AMLIL the team never sold from the exempt wallets; they transferred
  180 M tokens to a fresh wallet in 13 batches. Two sources are watched:
  - the feed: an exempt wallet calling `transfer`/`transferFrom` on the token or `sell` on the
    curve (fastest);
  - node `Transfer` logs with `from ∈ exempt` and `to ∉ exempt`, which also catch batch contracts.

  The cumulative outflow, as a share of the team's holding (`balanceOf` baseline via multicall),
  is compared with `exitIfExemptSellsPct` (default `0`: exit on the first exempt transfer-out/sell).
- **Fill after an abort (reviewer H2).** "Exempt wallet sold in the launch second" cancels the
  members not sent yet; members already in flight can still fill. Any fill opens a position; on an
  aborted run it is exited at once (`exempt_dump`) and its PnL counts toward the daily loss limit.
- **Exit retries (reviewer H4).** One round = up to 3 attempts at 15 %, 40 % and 100 % slippage.
  A failed round re-reads the chain: `balanceOf(sniper)` books any sale the chain shows (e.g. a
  receipt timeout that did sell; quote estimated from the book), `curve.graduated()` ends in the
  `graduated` phase. Otherwise the next round waits `EXIT_BACKOFF_MS`, doubling per round; after
  `EXIT_MAX_ROUNDS` failed rounds the position is `stuck`. At most `3 × EXIT_MAX_ROUNDS` exit txs
  are ever sent for one position.

### Graduation and stuck positions

`graduated` and `stuck` are terminal: no more exit txs, an `error` event (`position_graduated` /
`position_stuck`) for telegram, the snipe row stays `open` with the reason in `notes`, the position
keeps its `MAX_CONCURRENT` slot and shows in `/healthz` (`positions[].phase`) and
`sniper_positions_terminal`.

- **graduated** (CurveCompleted log, `graduated() == true` or `AlreadyGraduated()`): the curve no
  longer trades; the liquidity is in the Uniswap v4 pool. Sweep the tokens with the owner key
  (`PonsSniper.sweepToken(token, cold, 0)`) and sell them on v4 (PoolManager
  `0x8366…0951`, Pons hook `0xe5e7…e044`). An automated v4 sale can be plugged into
  `Positions` via the `onGraduated` hook (not implemented).
- **stuck**: inspect the last error in `notes`, fix the cause (gas, RPC, curve), then either restart
  the service (startup reconciliation re-adopts the position and retries) or sell manually.
- Either way, once the chain shows `balanceOf(sniper) == 0` the reconcile timer (`RECONCILE_MS`)
  closes the position (proceeds booked as 0, `position_closed_externally` event; the realised loss
  is conservative).

### Crash safety and restart (reviewer H3, M2)

- Startup reads every `pending`/`open` row **of this mode**: live rows are checked against the chain
  (`bought(token)`, `balanceOf(sniper)`): tokens held → the position is rebuilt (chain balance,
  recorded sales, preset from the row) and `position_rebuilt` is emitted; balance 0 after a buy →
  row `closed`; no buy or no token → row `failed` (`stale_snipe_failed`). Rows whose chain read fails
  stay unresolved and are retried. Paper rows are rebuilt from their own data. A rebuilt position
  keeps its original open time, so a timeout that expired while the service was down fires at once.
- Risk aggregates (`stopAfter`, daily loss, token cap, `firstBuyOnly`) are loaded per mode, so paper
  runs never affect live limits (reviewer L5); only open/closed or receipt-confirmed rows mark a
  token or a deployer.
- Unhandled rejections and uncaught exceptions are logged (`process_error` event) and the process
  keeps running; feed frames are validated and frame handling never throws.

## Preset defaults

From the 3-day walk-forward (`docs/BACKTEST.md`, Backtest #2):

| Field | Default | Notes |
|---|---|---|
| `buyEth` | `0.07` | |
| `maxTaxBps` | `1000` | ≤ `5000` (zod); the schedule only takes 9900/618/19/0, PonsSniper refuses ≥ 9900 |
| `slippageBps` | `3000` | prefer `maxEntryMcapEth` (see minTokensOut) |
| `burst` | `{startMs: −120, spacingMs: 15, count: 10}` | |
| `gasLimit` / `maxFeeGwei` / `priorityFeeGwei` | `300000` / `1` / `0` | gas limit verified at live startup (L6) |
| `stopAfter` / `firstBuyOnly` / `tokenCap` | `1` / `true` / `false` | |
| `takeProfits` | `[]` | no fixed take profit; the trailing stop takes profit |
| `trailing` | `{activatePct: 50, dropPct: 20}` | `null` disables it |
| `stopLossPct` | `40` | |
| `timeoutSec` | `60` | |
| `exitIfExemptSellsPct` | `0` | exit on the first exempt-wallet transfer-out/sell |
| `abortIfExemptSellInLaunchBlock` | `true` | |
| `minQuoteReserveEth`, `maxEntryMcapEth` | unset | |

## Environment

| Var | Default | Meaning |
|---|---|---|
| `EXECUTION_MODE` | `paper` | `live` signs and sends; `paper` simulates |
| `FEED_URL` | `wss://feed.mainnet.chain.robinhood.com` | primary sequencer feed (the server **requires permessage-deflate**) |
| `FEED_URL_SECONDARY` | – | comma list of fallback feeds (e.g. own node relay, `wss://delayed-feed.mainnet.chain.robinhood.com`); duplicates are dropped by sequence number, reconnects request replay from the next block; liveness only counts new in-order blocks, frames far from the head are dropped until 3 consistent frames confirm a reset |
| `NODE_HTTP` | – | node for reads: receipts, `getReserves`, nonces, balances (falls back to `PUBLIC_RPC`). Use the lowest-latency endpoint from the executor host |
| `NODE_WS` | – | node ws for `TokenLaunched` and token/curve logs (without it: receipt polling + `getReserves` polling) |
| `PUBLIC_RPC` | `https://rpc.mainnet.chain.robinhood.com` | fallback read endpoint |
| `SEND_ENDPOINTS` | `NODE_HTTP` or `PUBLIC_RPC` | comma list; every raw tx goes to all of them; the first is used for RTT |
| `DATABASE_URL` | – | Postgres (`@hood/db`). Required in live mode; without it paper mode uses an in-memory store |
| `PLAYS_FILE` | – | JSON array of plays (SPEC §4 shape) for DB-less paper runs |
| `EXECUTOR_PRIVATE_KEYS` | – | live only; comma list of operator keys: **first = exit key**, the rest = one burst slot each. chmod 600 env file on the executor host |
| `EXECUTOR_PRIVATE_KEY` | – | legacy single key (shared exit/burst sequence; not recommended) |
| `SNIPER_CONTRACT` | – | live only; deployed PonsSniper address |
| `LAUNCHERS` | – | extra launcher contracts (Pons whitelisted launchers) accepted besides the factory and the launch router |
| `MAX_GAS_PRICE_GWEI` | `1` | global cap: blocks snipes when L2 gas price is above it, clamps every preset's `maxFeeGwei` and the gap fillers' fee |
| `DAILY_LOSS_LIMIT_ETH` | `0.5` | realised live loss (UTC day) that stops new snipes (checked at decide time and right before the first send) |
| `MAX_CONCURRENT` | `3` | pending + open snipes (incl. graduated/stuck positions) |
| `RTT_MS` | `0` | fixed RTT to the sequencer; `0` = measured against the first send endpoint |
| `DEADLINE_BLOCKS` | `40` | L2 blocks after the launch block after which members revert with `Expired()` (~4 s) |
| `HEALTH_PORT` | `8081` | `/healthz`, `/metrics`, `/clock` |
| `LOG_LEVEL` | `info` | pino level |
| `ADDRESS_PREDICTION` | `none` | `nonce` = CREATE prediction (Pons V2 uses CREATE2, so it self-disables) |
| `RESERVES_POLL_MS` | `500` | `getReserves` snapshot (at an explicit block) for open positions |
| `RECEIPT_POLL_MS` | `20` | launch receipt polling while confirming a launch (one receipt, decide path) |
| `BURST_RECEIPT_POLL_MS` | `200` | burst/exit receipt polling (one nonce read per tick + one receipt per landed member) |
| `EXIT_RECEIPT_TIMEOUT_MS` | `10000` | an exit without a receipt by then counts as failed; the chain decides what happened |
| `ADDRESS_TIMEOUT_MS` | `1500` | give up waiting for the launch receipt (also bounded by `boundary(T+2)`) |
| `CLOCK_WINDOW_MS` | `120000` | clock estimation window |
| `SPIN_MS` | `1.5` | busy-wait before each scheduled send |
| `MAX_LAUNCH_AGE_MS` | `2500` | ignore launches whose feed block arrived later than this after its second (replays) |
| `PAPER_FILL` | `first` | paper fill model: `first` in the +1 s block (optimistic) or `last` after its other buys (pessimistic) |
| `MIN_GAS_BALANCE_ETH` | `0.001` | per-key gas minimum (L8) |
| `BALANCE_POLL_MS` | `5000` | contract / key balance refresh |
| `EXIT_MAX_ROUNDS` | `3` | failed exit rounds before `stuck` |
| `EXIT_BACKOFF_MS` | `3000` | first backoff between exit rounds (doubles) |
| `RECONCILE_MS` | `30000` | retry unresolved runs/rows, re-check graduated/stuck positions |
| `GAS_CHECK` | `1` | live startup `eth_estimateGas` of `snipe()` against a recent curve (L6); `0` skips it explicitly |
| `GAS_CHECK_LOOKBACK_BLOCKS` | `36000` | how far back to look for that curve (~1 h) |
| `ALLOW_HOT_OWNER` | `0` | allow an executor key to be the contract owner (refused by default, M4) |

DB `settings` keys read at start and on `settings_changed`:
- `kill_switch`: `true`, `"on"`, `"true"`, `1`, `{"on":true}`, `{"enabled":true}` or `{"killed":true,…}`
  (the shapes the telegram bot writes) block every new snipe — at decide time and again right
  before the first member is sent (reviewer L2).
- `daily_loss_limit_eth` and `max_concurrent` override the env values.

## Paper mode

No database, a plays file, and the public feed:

```bash
cat > /tmp/plays.json <<'EOF'
[{ "id": 1, "name": "shib dev",
   "trigger": { "deployerIn": ["0x81eb508048220493549302d8ea5ef73a3fde1784"] },
   "preset":  { "buyEth": 0.07, "maxTaxBps": 1000, "maxEntryMcapEth": 4 } }]
EOF
PLAYS_FILE=/tmp/plays.json pnpm --filter @hood/sniper paper
PLAYS_FILE=/tmp/plays.json PAPER_FILL=last HEALTH_PORT=8082 pnpm --filter @hood/sniper paper   # pessimistic bracket
curl -s localhost:8081/healthz | jq '.feed, .clock.offsetMs, .counters'
```

With `DATABASE_URL`, plays come from the `plays` table, and every decision, planned burst, fill,
sale and close is written to `snipes`, `events` and `feed_blocks`. Paper fills are simulated as
follows:

- **Buy:** at the first block with timestamp ≥ `T+1`. The cost model is the snipe tax for that
  second (618 bps), a 1 % fee and the creator tax from the launch params. `PAPER_FILL` picks the
  curve state (reviewer L4):
  - `first` (default, optimistic): state right before that block (`eth_call` at `block−1`) — our
    buy is first in the block;
  - `last` (pessimistic): state at the end of that block — we are behind every other buy of the
    block.

  **Paper PnL is a bracket, not a forecast.** On the launches bots care about many taxed buys land
  in the first +1 s block (`docs/BACKTEST.md`: 176 launches with ≥ 8 buys in that second); run
  `first` and `last` side by side and expect live results in between, nearer `last` until the burst
  is tuned.
- **Sells:** `quoteSell` on the latest book.

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

## Live-mode gate

Live mode is allowed only when every High and Medium row of `docs/REVIEW.md` is `fixed` and has
been re-reviewed. The service enforces what it can at startup (`liveStartupChecks`) and refuses to
start otherwise:

- the `PonsSniper` owner is not one of the executor keys (cold owner, M4; `ALLOW_HOT_OWNER=1`
  overrides);
- the contract's `factory()` is the Pons V2 factory;
- every executor key is an operator;
- `eth_estimateGas` of a real `snipe()` against the most recent live curve fits the smallest preset
  `gasLimit` (L6; within 20 % → warning; estimate impossible → refused; `GAS_CHECK=0` skips);
- a preset `buyEth` above the contract's `maxQuoteIn` is a warning (those snipes would revert).

At runtime: a single executor key logs a warning; fewer burst keys than `MAX_CONCURRENT` logs a
warning; balance pre-checks block bursts (L8).

## Going live (exact sequence)

1. Verify on chain. These items were confirmed by core:
   - `buy(quoteIn, minTokensOut, recipient)` with `msg.value == quoteIn`;
   - contract callers are allowed;
   - no buy splitting is needed;
   - the deployer uses CREATE2.

   Re-run `pnpm --filter @hood/core test` with `LIVE=1` on the executor host.
2. Run the DB migrations: `pnpm db:migrate`. Insert the play with `enabled=false`. Its trigger must
   use `deployerIn` or `armedWallet` (live plays need a non-spoofable matcher).
3. Keys: a **cold owner** (hardware wallet / Safe, never on the host) and, on the Ohio host, one
   exit key plus one burst key per concurrent snipe (`EXECUTOR_PRIVATE_KEYS=exit,burst1,burst2,…`
   in an env file with `chmod 600`). Fund each hot key with about 0.01 ETH for gas.
4. Deploy the contract (constructor: owner, first operator, Pons V2 factory, `maxQuoteIn`):
   - Dry run first:
     ```bash
     DRY_RUN=1 EXECUTOR_PRIVATE_KEY=<deployer> OWNER=<cold> OPERATORS=<exit>,<burst1>,<burst2> pnpm --filter @hood/contracts deploy
     ```
   - Then for real. This deploys, checks `owner`, `operators`, `factory` and
     `arbBlockNumbers()==true`, funds the contract and prints the `setOperator` (and optional
     `TREASURY` → `setTreasury`) calldata the cold owner must send for the other operators:
     ```bash
     FUND_ETH=0.2 MAX_QUOTE_IN_ETH=0.1 EXECUTOR_PRIVATE_KEY=<deployer> OWNER=<cold> OPERATORS=<exit>,<burst1>,<burst2> pnpm --filter @hood/contracts deploy
     ```
   - Send the printed calldata from the owner. Set `SNIPER_CONTRACT`.
   - Exit proceeds go to the `treasury` (default: the owner); if it cannot take ETH they stay in
     the contract (`ProceedsHeld`) and `sweepEth` moves them. Keep enough ETH in the contract for
     the next `buyEth` (the L8 pre-check refuses a burst otherwise), or set the treasury to the
     contract itself to compound.
5. Paper-trade the play for at least one day with the same env (`EXECUTION_MODE=paper`), with
   `PAPER_FILL=first` and `=last`:
   - check `/metrics`: `sniper_clock_ready 1`, `sniper_feed_gaps_total` flat, decode p99 < 2 ms;
   - check the `snipes` rows (fill price vs. the indexer's first taxed buyer, PnL bracket).
6. Arm the kill switch (`settings.kill_switch = true`). Switch to `EXECUTION_MODE=live` with:
   - `SEND_ENDPOINTS` = Ohio public RPC first, then your node;
   - `MAX_GAS_PRICE_GWEI=0.1`;
   - `DAILY_LOSS_LIMIT_ETH` small;
   - a play with `buyEth` ≤ 0.02 and `stopAfter: 1`.

   Start the service; it refuses to start unless the live-mode gate passes. Confirm `/healthz` is
   ok and `sniper_nonce` matches the chain.
7. Clear the kill switch (`settings.kill_switch = false`; the change propagates via NOTIFY) and
   enable the play.
8. After the first live snipe, inspect `snipes.burst`: which nonce mined, how many members reverted
   `TaxTooHigh` or `AlreadyBought`, and whether any were dropped (and filled by a self-transfer:
   `nonce_gap` event). Re-tune `burst`, then raise `buyEth` and `stopAfter`.
9. Watch the `events` table / telegram for `position_graduated`, `position_stuck`,
   `low_balance`, `fill_recovered_from_chain`, `snipe_unresolved` and act on them (see above).

Kill switch: set `settings.kill_switch` to `true` (live within milliseconds via NOTIFY; re-checked
right before the first send). Open positions keep being managed and exited.

## Tests

`pnpm --filter @hood/sniper test` runs all tests offline:

- **Detector:** replays the 40 captured frames, runs the real launch tx built from fixture fields,
  and rejects spoofed launches (calldata to a non-launcher, reverted / foreign-deployer receipts).
- **Rules:** a table test for every trigger field and the `require` AND-set; live plays need
  `deployerIn`/`armedWallet`.
- **Executor:** fake clock and endpoints; checks count, spacing, nonces, raw tx contents,
  idempotent reconciliation, separate exit/burst keys, re-send, gap filling, the last-moment kill
  switch and the balance pre-checks.
- **Positions:** TP, ladder, trailing, SL, timeout, the dump signal via log and via the feed, capped
  exit rounds with backoff, chain-booked sales, graduation, the explicit-block reserve book and
  zero-size TP levels.
- **Paper e2e:** the AMLIL timeline.
- **Review fixes:** orchestrator-level regression tests for every finding (spoofed launches, fill
  after abort, chain reconciliation and restart, crash paths, tax cap, kill switch, paper fill
  model, startup gate, balances).
- **PgStore:** runs against the real `@hood/db` migrations on PGlite (incl. per-mode stats).
- **Config and metrics.**

`pnpm --filter @hood/sniper typecheck` also typechecks the tests.
