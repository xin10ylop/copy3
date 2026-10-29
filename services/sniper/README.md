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
at start and refreshed on `NOTIFY plays_changed / armed_changed / settings_changed`. NOTIFY alone is
not trusted (NEW-2): postgres.js re-LISTENs after a reconnect but never replays what was sent
meanwhile (a `hoodctl kill` during a reconnect was lost), so everything is reloaded on every
(re)connect of the LISTEN connection (`onlisten`), settings every `SETTINGS_RELOAD_MS` (10 s) and
plays + armed candidates every `PLAYS_RELOAD_MS` (60 s).

A second entry point fires **later in the launch second**: launch-second plays
(`trigger.launchSecond`, e.g. the seeded `team-buy-0.1`) are matched by the per-launch
**launch-second ledger** as team buys land, then go through the same receipt → burst path. See
[Launch-second fingerprint](#launch-second-fingerprint-triggerlaunchsecond).

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
   `PonsSniper.snipe(curve, token, quoteIn, minTokensOut, maxTaxBps, deadlineBlock, deadlineTs)` with
   `msg.value = 0`; the contract pays from its own ETH balance. The checks run in this order:
   - `Expired()`: `block.timestamp > deadlineTs` (launch ts + 3, NEW-3) or the L2 block from
     `ArbSys` > `deadlineBlock`. The wall-clock deadline matters when the sequencer stalls: the L2
     block number does not advance while no blocks are produced, the timestamp does, so a member
     held back by a stall cannot buy minutes later. 23 k gas.
   - `MaxTaxTooHigh()`: `maxTaxBps ≥ 9900` would disable the tax gate (M3; the service also clamps
     to 5000 and zod caps presets at 5000).
   - `NotOperator()`.
   - `AlreadyBought()`: a sibling already bought. 27.5 k gas.
   - `TaxTooHigh(tax)`: the member landed in a `T` block. 37.6 k gas.
   - `QuoteTooLarge(quoteIn, maxQuoteIn)`, `SpendLimitExceeded(level, quoteIn, maxSpend)` and
     `UnknownCurve()`: an operator key can only spend up to the owner-set `maxQuoteIn` per snipe and
     within the **decaying spend budget** (NEW-5): a level that drains at
     `maxSpendPerWindow / spendWindow` per second and must stay ≤ `maxSpendPerWindow` after a buy —
     at most `maxSpendPerWindow` at once and `maxSpendPerWindow × (1 + t / spendWindow)` in any
     interval of t seconds (the earlier tumbling window let 2 × through across a window boundary).
     `spendAvailable()` returns what is left now. `setSpendLimit(max, window)` refuses `window = 0`
     (`InvalidSpendWindow`); `setSpendLimit(0, 1)` is the buy stop; turning the budget **off** is
     the separate owner call `disableSpendLimit()`. Buys only go to the curve the immutable factory
     returns for the token (`getLaunchedToken(token).curve`).
   - Otherwise it buys once and keeps the tokens, pre-approved to the curve. ~210 k gas (mock curve,
     first buy of a spend window; ~185 k afterwards).

   **What a stolen operator key can still do (N4).** It cannot send ETH anywhere, but it can launch
   real Pons tokens itself (0.0005 ETH each) and `snipe` them with `minTokensOut = 0`, sandwiching
   the buy and keeping a 10 % creator tax. Each such snipe costs at most `maxQuoteIn`; the decaying
   budget (`MAX_SPEND_PER_WINDOW_ETH` per `SPEND_WINDOW_SEC`, default 4 × `maxQuoteIn` per hour,
   owner-settable with `setSpendLimit`) caps the total at that amount at once plus the refill rate. **Keep the contract's working balance at a
   few × `buyEth`** (top it up from the cold owner), rotate keys on any suspicion and revoke a
   compromised key with `setOperator(key, false)` from the owner.

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
   addresses are not predictable; the receipt arrives about 100–200 ms after sequencing.
   **Whichever arrives first confirms (N16):** for a tx sent straight to the factory or the router,
   the node's `TokenLaunched` ws log (exactly one for the matched deployer, in the launch block) is
   accepted as confirmation — that call launches exactly one token and its calldata team set is
   what the factory exempts. The receipt is then still verified in the background: a contradiction
   aborts the run (an in-flight fill exits at once) and raises `launch_receipt_mismatch`; the
   receipt's `SnipeTaxExempted` set replaces the calldata set. Launches through a `LAUNCHERS`
   contract (could batch) and ambiguous logs wait for the receipt. Verified live (N14,
   `test/launch-and-buy.test.ts`, fixture `packages/core/test/fixtures/launch-and-buy-tx.json`): a
   launchAndBuy sent to the router has `TokenLaunched.deployer == tx.from`. Third-party launcher
   contracts also call the router (seen: `0x6319…cce2`, with a per-launch deployer); they are not
   candidates unless listed in `LAUNCHERS`. Everything else is prepared from the feed tx:
   decision, risk, quote, gas and warm connections. `ADDRESS_PREDICTION=nonce` keeps the original
   CREATE-nonce predictor (it self-disables after two mismatches); it never replaces the receipt.

   **Live plays need a non-spoofable matcher:** `armedWallet` or `deployerIn` (both bound to the tx
   signer / `TokenLaunched.deployer`), or a `launchSecond` rule that demands ETH (`minTeamBuyEth > 0`,
   `minTeamBuyers ≥ 1` or `minDevBuyEth > 0`): it is bound to real curve buys, proven by CurveBuy
   receipt logs of the receipt-proven curve before anything is signed. Plays that match only on
   `nameRegex`, `symbolRegex` or `teamWalletsAny` (chosen by whoever launches) arm paper runs only.
5. **minTokensOut** is the STRICTER (larger) of two bounds (R4-3):
   - slippage: `slippageBps` below the expected output at the reserves the decision priced on
     (launch config + CONFIRMED launch-second buys, or getReserves);
   - with `maxEntryMcapEth`: the output at the cap price, using the curve invariant `k = Q·T`. The
     buy then reverts on-chain if the launch-second team buys pushed the price past the cap. No buy
     can move `k` (fees leave the pool), so this bound does not depend on what the ledger believes
     happened in the launch second. The cap only ever tightens: alone it tolerated 44–55 % fewer
     tokens at typical entries. A `deployerIn` play prices on the pre-team reserves, so on a launch
     whose team buys lift the price (AMLIL +49 %) it needs a wide `slippageBps` (the video's 9000);
     launch-second plays price after the confirmed team buys and keep the default 30 %. The seeded generic plays use `maxEntryMcapEth = 4.2`
     (2.5 × the 1.68 ETH start mcap; the video's +1 s entry was ≈ 2.8 ETH, AMLIL's team lifted the
     price ~49 %, NEW-1). A database seeded earlier keeps its preset: set it with
     `/preset <id> maxEntryMcapEth=4.2`.
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
   reconcile timer retries every `RECONCILE_MS`. **"No buy" is final only when that read was pinned
   to a block past the burst's `deadlineBlock`, or to a block whose timestamp is past `deadlineTs`**
   (NEW-3, R4-2): `readSniper` reads `bought`/`balanceOf` at one block and reports it, so a
   load-balanced RPC whose head comes from a fresher backend cannot end a run on a stale read. Until
   then — a stalled sequencer, a backlog, a stale node — the run stays `pending` with its slot held
   and is re-checked about when the deadline should pass (and by the reconcile timer); after 2 min
   `snipe_unresolved_long` (error) fires. The executor's late `burst_final` write only ever
   updates the run's row (N7). A run holds a `MAX_CONCURRENT` slot only from the moment its launch
   is confirmed (N10: reverted spoofs to the real factory cannot fill the slots).

Fallback: if a `TokenLaunched` log arrives whose tx the feed never showed, it waits 150 ms, then
rebuilds the launch from the node (only if that tx was sent to a launcher) and runs the same logic,
receipt confirmation included. Every fire-and-forget promise on these paths is caught; a 429 from
the node there is logged, never fatal (reviewer M2).

### Operator keys (multi-key setup, reviewer M1)

`EXECUTOR_PRIVATE_KEYS=exitKey,burstKey1,burstKey2,…` — every key is a `PonsSniper` operator with
its own nonce sequence:

- an exit whose receipt does not arrive in time keeps its key, nonce and raw tx: the position's
  next attempt re-sends **that same tx** until it is final (mined → its result is booked once,
  correcting a sale the chain re-read already estimated; nonce taken by another tx → nothing was
  sold by it, a fresh exit follows). Re-signing on another key or nonce could sell twice (R4-4);
- the **first** key only sends exits, so an exit never queues behind a burst's nonces. With one
  exit key exits are strictly **FIFO**: each holds the key until its receipt (or
  `EXIT_RECEIPT_TIMEOUT_MS`), so a second position's stop loss waits behind the first exit.
  `EXIT_KEYS=n` makes the first n keys exit keys: a new exit takes a key with no exit queued or
  running (and gas), otherwise round-robin (NEW-9). The remaining keys are burst keys;
- every further key is one **burst slot**: a burst holds its key from signing until its nonces are
  settled, so concurrent bursts never share a sequence. With all slots busy a new burst is refused
  (`no free burst key`); give at least `MAX_CONCURRENT` burst keys;
- a member that no endpoint accepted is re-sent once (same raw tx, same nonce) to every endpoint;
- after a burst or an exit, every nonce the key broadcast but the chain did not consume (a member
  rejected or dropped while a later one was accepted) is consumed with a 0-value self-transfer
  (21 k gas) so nothing stale can execute later; then the key resyncs from the chain;
- a single key (`EXECUTOR_PRIVATE_KEY`, legacy) is shared by exits and bursts and serialises them:
  a stop-loss exit then waits behind a whole burst reconcile (up to ~18 s). **Live mode refuses to
  start with one key** unless `ALLOW_SINGLE_KEY=1` (N5).

Fund each key with gas (≥ `MIN_GAS_BALANCE_ETH`; a burst member reserves `gasLimit × maxFee` up
front). Before every burst the executor checks the cached balances (refreshed every
`BALANCE_POLL_MS` and after every burst/exit): contract ETH ≥ `quoteIn`, the burst key and at least
one exit key ≥ max(`MIN_GAS_BALANCE_ETH`, `gasLimit × maxFee`). A failing check aborts the burst and writes a
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
- **Exit retries (reviewer H4, N2).** One round = up to 3 attempts at 15 %, 40 % and 100 %
  slippage. A failed round re-reads the chain: `balanceOf(sniper)` books any sale the chain shows
  (e.g. a receipt timeout that did sell; quote estimated from the book), `curve.graduated()` ends in
  the `graduated` phase. Otherwise:
  - failures **without an on-chain verdict** (no endpoint accepted the tx, no receipt in time, RPC
    errors, paper slippage) are retried forever, the backoff doubling from `EXIT_BACKOFF_MS` up to
    `EXIT_MAX_BACKOFF_MS` (60 s); after 3 such rounds an `exit_retrying` warning is raised;
  - rounds whose `minQuoteOut = 0` attempt **reverted on chain** count toward `EXIT_MAX_ROUNDS`;
    after that many the position is `stuck`.
  A sale the chain confirmed is always booked, even if the position changed phase while it was in
  flight (N6).

### Graduation and stuck positions

`graduated` and `stuck` stop exit txs: an `error` event (`position_graduated` / `position_stuck`)
for telegram, the snipe row stays `open` with the reason in `notes`, the position keeps its
`MAX_CONCURRENT` slot and shows in `/healthz` (`positions[].phase`) and `sniper_positions_terminal`.

- **graduated** (CurveCompleted log, `graduated() == true` or `AlreadyGraduated()`): the curve no
  longer trades; the liquidity is in the Uniswap v4 pool. Sweep the tokens with the owner key
  (`PonsSniper.sweepToken(token, cold, 0)`) and sell them on v4 (PoolManager
  `0x8366…0951`, Pons hook `0xe5e7…e044`). An automated v4 sale can be plugged into
  `Positions` via the `onGraduated` hook (not implemented).
- **stuck** (only after `EXIT_MAX_ROUNDS` on-chain reverts at `minQuoteOut = 0`): the reconcile
  timer re-arms the position (`position_rearmed`, fresh rounds) `STUCK_REARM_MS` (5 min) after it
  got stuck, as long as the contract still holds the token and the curve has not graduated.
  Inspect the last error in `notes`; selling manually is always possible.
- Either way, once the chain shows `balanceOf(sniper) == 0` the reconcile timer (`RECONCILE_MS`)
  closes the position (proceeds booked as 0, `position_closed_externally` event; the realised loss
  is conservative).
- **Paper (N8):** a graduated paper position is closed by the reconcile timer with a simulated sale
  at the last book price (`graduated(paper)`), so graduations never leak `MAX_CONCURRENT` slots.

### Crash safety and restart (reviewer H3, M2)

- Startup reads every `pending`/`open` row **of this mode**: live rows are checked against the chain
  (`bought(token)`, `balanceOf(sniper)`): tokens held → the position is rebuilt (chain balance,
  recorded sales, preset from the row) and `position_rebuilt` is emitted; balance 0 after a buy →
  row `closed`; no buy or no token → row `failed` (`stale_snipe_failed`). Rows whose chain read fails
  stay unresolved and are retried. Paper rows are rebuilt from their own data. A rebuilt position
  keeps its original open time, so a timeout that expired while the service was down fires at once.
- **Orphan sweep (NEW-3, R4-1/2/7).** After that, in the background, and then every
  `SWEEP_INTERVAL_MS` (5 min), the contract's `Sniped` events since the stored checkpoint
  (`settings` key `sniper_cursor:sniped_sweep:<contract>`; the first run looks back
  `SWEEP_LOOKBACK_BLOCKS`, ~1 day) are checked for tokens the contract still holds that no
  position, run or unresolved row manages:
  - dust — under 0.5 % of the tokens bought, or worth less than an exit's gas (a 1-wei transfer by
    anyone) — is ignored (`orphan_dust_ignored`, info);
  - a token whose newest row is `closed` (PnL booked) is alerted only (`orphan_balance_on_closed_row`);
  - anything else becomes a position at **cost 0** that holds **no** `MAX_CONCURRENT` slot and
    books nothing to the daily loss (`orphan_position_recovered`, error); its newest row is reused
    (preset, notes) or a new one is written.
  The scan reads `eth_getLogs` in chunks that halve on a range error (10 000 → … → 500 blocks) and
  the checkpoint advances after every chunk whose tokens could all be read.
- A run aborted ("exempt wallet sold") while burst members are in flight keeps its row `pending`
  (reason in `notes`) until the run ends, so a restart in between reconciles it like any pending row
  (N3); legacy rows written as `aborted` with a member still `sent` are loaded too. A pending row is
  only declared "no buy" once the chain head has passed the burst's `deadlineBlock` (N12).
- `bought(token)` and `balanceOf(sniper)` are read at one block (N11); a reserves poll whose block
  number cannot be read is skipped instead of taking an unpinned snapshot (N13).
- Risk aggregates (`stopAfter`, daily loss, token cap, `firstBuyOnly`) are loaded per mode, so paper
  runs never affect live limits (reviewer L5); only open/closed or receipt-confirmed rows mark a
  token or a deployer.
- Unhandled rejections and uncaught exceptions are logged (`process_error` event) and the process
  keeps running; feed frames are validated and frame handling never throws.

## Launch-second fingerprint (`trigger.launchSecond`)

The always-on play. docs/BACKTEST.md #2: launches where a tax-exempt **non-deployer** ("team")
wallet buys ≥ 0.1 ETH in the launch second returned **+0.0058 ETH (+8.3 %) per 0.07 ETH snipe**
(n = 268, positive on every out-of-sample day); sniping every launch loses. No human has to name an
operator: `pnpm --filter @hood/db seed` creates the play `team-buy-0.1`
(`{ launchSecond: { minTeamBuyEth: 0.1 } }`, the backtested preset).

```ts
launchSecond?: {
  minTeamBuyEth?: number; maxTeamBuyEth?: number;  // Σ quote-in of team buys in second T
  minTeamBuyers?: number;                           // distinct team wallets that bought
  minDevBuyEth?: number; maxDevBuyEth?: number;     // launchAndBuy quote + buys to the deployer in second T
  requireNoDevBuy?: boolean;
}
deployerNotIn?: string[]     // blacklist: deployer or tx sender
teamWalletsNotIn?: string[]  // blacklist: exemptions ∪ creatorFeeRecipient
```

- **Team buy** = a curve buy in a block whose timestamp equals the launch block's, whose
  *recipient* (the snipe-tax exemption is per recipient) is in the launch's exempt set (deployer ∪
  `creatorFeeRecipient` ∪ the receipt's `SnipeTaxExempted` logs) and is not the deployer, outside
  the launch tx. **Dev buy** = the launchAndBuy quote (the launch tx's own CurveBuy) plus buys to the
  deployer. Same classification as the indexer, so the backtest and the live trigger agree.
- **Semantics.** `launchSecond` is always AND (as if in `require`); identity matchers keep their
  OR/require semantics. It can stand alone only when it demands ETH (`launchSecondIsMatcher`).
  The blacklists are AND filters for every play (the agent's nightly job maintains them on generic
  plays).
- **Ledger.** While at least one enabled play has `launchSecond`, every feed launch gets a
  `LaunchSecondLedger` (`src/ledger.ts`). Each feed block of second T adds hints: direct
  `curve.buy(quoteIn, minOut, recipient)` calls with `msg.value == quoteIn`, plus exempt outflows
  (`sell` / `transfer` / `transferFrom` by an exempt wallet, sender recovered off the decide path).
  Node `CurveBuy` / `CurveSell` / `Transfer` logs (ws) confirm buys and catch contract-routed ones.
  The curve address is CREATE2, so feed txs of the second are buffered and replayed once the launch
  receipt (polled for every launch, woken by the `TokenLaunched` ws log) or that log names it.
- **Decision (µs).** Every ledger change re-runs `rules.evaluate(event, now, ledger.stats())`
  (memory). A match schedules the burst for the T+1 boundary with `planBurst({ launchTs })`, exactly
  like an immediate match. One run per launch — except that a run whose matching hints were all
  REFUTED (e.g. a reverting fake team buy) re-opens the ledger (≤ 3 times), so a real confirmed team
  buy later in the second can still fire within the burst window (R4-8). A match is refused when an exempt outflow was already
  seen in the second and `abortIfExemptSellInLaunchBlock` is on.
- **Before signing (H1).** After the launch receipt, the minimums are re-checked against
  **confirmed** buys only: receipts of the pending hints are fetched until the play holds or
  `boundary(T+2) − rtt`. A reverted buy, or one without a CurveBuy from the curve, never counts
  (`launch_second_unconfirmed` counter, run aborted, play state untouched).
- **Last moment.** The send guard re-checks the play (maximums against everything seen, e.g. a
  later team buy above `maxTeamBuyEth`) and the exempt outflows right before the first member
  (paper: before the simulated fill).
- **Pricing.** `minTokensOut` is computed against the launch-config reserves **plus the CONFIRMED
  launch-second buys** (CurveBuy logs, applied with their exact quoteIn / tokensOut / fee / creator
  tax; team buys move the price: AMLIL +49 %), not the pre-team price. Feed hints never price
  (NEW-1): a deployer could send a feed-visible `curve.buy(3 ETH, minOut = max)` that reverts (gas
  only) and our minTokensOut would have absorbed a fake 3 ETH buy (30 % slippage became 89.6 %).
  A pending real buy that is not counted only makes minTokensOut stricter (a revert, not a loss).
- **Taxed or team (NEW-1).** A confirmed buy is classified by `CurveBuy.fee`, which includes the
  snipe tax: fee > 5 % of quoteIn = it paid the tax, whatever the recipient's exemption state now.
  A wallet exempted later in the second (`exemptFromSnipeTax`) is a team wallet for its later buys
  only; without a fee word the (block, logIndex) order of the exemption log decides.
- **Residual risk (accepted, it is the backtested game).** The operator really spent the ETH and
  can dump on us right after the +1 s block; exits (dump exit on the first exempt transfer-out,
  trailing 50/20, SL 40, 60 s timeout) are what the backtest measured. Not counted: buys through
  the trade router that the node's logs do not show before T+1. Like every play, a team buy late in the second
  (> ~T+800 ms) is confirmed only after the T+1 boundary, so the burst starts late (still 6.18 % or
  0.19 % tax, REVIEW N16).

## Sizing and compounding (`preset.sizing`)

```ts
sizing: { mode: 'fixed' | 'bankroll', fraction: 0.25, minEth: 0.01, maxEth: 0.3 }   // default mode 'fixed'
```

- `fixed` buys `buyEth` (unchanged behaviour).
- `bankroll` buys `clamp(bankroll × fraction / MAX_CONCURRENT, minEth, maxEth)`, **rounded down to
  0.001 ETH** (`src/sizing.ts`). Live, the bankroll is the PonsSniper contract's ETH balance the
  executor already caches for the L8 pre-check (memory, no RPC on the decide path; unknown → `minEth`).
  Paper, it is `PAPER_BANKROLL_ETH` + all realised paper PnL in the DB − ETH tied up in open paper
  runs, so paper compounding behaves like the contract would. The size used is the snipe row's
  `quote_in`, and `decision.sizing` records the bankroll, clamp and rule.
- **The edge does not depend on size**: snipe tax, fee and creator tax are proportional. Gas is not:
  ~0.00004 ETH per burst plus the exit. At **0.01 ETH** (the practical floor) the expected
  +0.0008 ETH per snipe pays ~6 % of it in gas; below that gas eats the edge.
- **Compounding rule.** Start at 0.01 ETH with ~0.1 ETH in the contract; the size follows the
  balance (0.1 × 0.25 / 3 = 0.008 → the 0.01 floor until the balance passes 0.12 ETH). For
  proceeds to compound, set the contract's treasury to the contract itself (`setTreasury(sniper)`
  from the owner); otherwise exits pay the owner and the bankroll only shrinks.
- **Contract caps (NEW-6).** A bankroll size is clamped to `min(maxEth, maxQuoteIn, remaining spend
  budget)` (rounded down to 0.001 ETH; `decision.sizing.clamped = 'contract'`); it is refused only
  if that leaves it below `minEth`. A `fixed` preset whose `buyEth` exceeds `maxQuoteIn` is refused
  at decide time (it could never buy, N15). A remaining spend budget below quoteIn refuses the
  snipe with a `spend_budget_exhausted` alert (NEW-4; at most every 10 min) instead of a burst whose
  members all revert `SpendLimitExceeded`. A decided run reserves its quoteIn until it fills or
  ends, so concurrent runs cannot all count on the same remaining budget; a chain refresh keeps
  our fills newer than the contract's last spend (R4-6). Live, the caps come from the gate's chain read
  (refreshed every `GATE_REFRESH_MS`) and our own fills are charged locally in between; paper uses
  `PAPER_MAX_QUOTE_IN_ETH` / `PAPER_MAX_SPEND_PER_WINDOW_ETH` / `PAPER_SPEND_WINDOW_SEC` (defaults =
  the deploy defaults 0.3 / 4 × / 3600 s), so paper refuses what live would.
- **Daily loss limit as a share of the bankroll.** With `DAILY_LOSS_LIMIT_ETH` unset, the limit is
  `DAILY_LOSS_LIMIT_PCT` (default 15 %) of the first bankroll figure of the UTC day (0.5 ETH until a
  balance is known). `settings.daily_loss_limit_eth` / `daily_loss_limit_pct` override at runtime.

## Preset defaults

From the 3-day walk-forward (`docs/BACKTEST.md`, Backtest #2):

| Field | Default | Notes |
|---|---|---|
| `buyEth` | `0.07` | the size in `fixed` sizing mode |
| `sizing` | `{mode: 'fixed', fraction: 0.25, minEth: 0.01, maxEth: 0.3}` | `bankroll` compounds (see above) |
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
| `minQuoteReserveEth`, `maxEntryMcapEth` | unset | the seeded generic plays set `maxEntryMcapEth: 4.2` (NEW-1) |

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
| `EXECUTOR_PRIVATE_KEYS` | – | live only; comma list of operator keys: **first = exit key**, the rest = one burst slot each (≥ 2 keys in live mode). Fund each with gas. chmod 600 env file on the executor host |
| `EXECUTOR_PRIVATE_KEY` | – | legacy single key (shared exit/burst sequence); live mode refuses it unless `ALLOW_SINGLE_KEY=1` (N5) |
| `SNIPER_CONTRACT` | – | live only; deployed PonsSniper address |
| `LAUNCHERS` | – | extra launcher contracts (Pons whitelisted launchers) accepted besides the factory and the launch router |
| `MAX_GAS_PRICE_GWEI` | `1` | global cap: blocks snipes when L2 gas price is above it, clamps every preset's `maxFeeGwei` and the gap fillers' fee |
| `DAILY_LOSS_LIMIT_ETH` | – | fixed realised live loss (UTC day) that stops new snipes (checked at decide time and right before the first send); unset = `DAILY_LOSS_LIMIT_PCT` |
| `DAILY_LOSS_LIMIT_PCT` | `15` | daily loss limit as % of the bankroll (contract ETH balance) at the start of the UTC day, when `DAILY_LOSS_LIMIT_ETH` is unset |
| `PAPER_BANKROLL_ETH` | `0.1` | paper mode: starting bankroll for `sizing.mode = 'bankroll'`; grows with realised paper PnL |
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
| `EXIT_MAX_ROUNDS` | `3` | exit rounds that reverted on chain at `minQuoteOut = 0` before `stuck` (transient failures never count, N2) |
| `EXIT_BACKOFF_MS` | `3000` | first backoff between exit rounds (doubles) |
| `EXIT_MAX_BACKOFF_MS` | `60000` | cap of that backoff for failures without an on-chain verdict (retried forever, N2) |
| `STUCK_REARM_MS` | `300000` | re-arm a `stuck` position that still holds tokens this long after it got stuck (N2) |
| `RECONCILE_MS` | `30000` | retry unresolved runs/rows, re-check graduated/stuck positions (re-arm / close; paper too) |
| `GAS_CHECK` | `1` | live startup `eth_estimateGas` of `snipe()` against a recent curve (L6); `0` skips it explicitly |
| `GAS_CHECK_LOOKBACK_BLOCKS` | `36000` | how far back to look for that curve (~1 h); read in `eth_getLogs` chunks of ≤ 10 000 blocks (public RPCs cap the range, NEW-8) |
| `ALLOW_HOT_OWNER` | `0` | allow an executor key to be the contract owner (refused by default, M4) |
| `ALLOW_SINGLE_KEY` | `0` | allow live mode with ONE executor key (refused by default, N5) |
| `GATE_RETRY_MS` | `60000` | retry the live gate while it fails (new entries blocked meanwhile, N1) |
| `GATE_REFRESH_MS` | `60000` | while the gate passes, re-read the contract config (owner, factory, operators, `maxQuoteIn`, spend budget); the decide path uses the latest; a changed config that fails blocks entries (NEW-8) |
| `EXIT_KEYS` | `1` | the first n keys of `EXECUTOR_PRIVATE_KEYS` serve exits (a free key first, else round-robin); must leave ≥ 1 burst key (NEW-9) |
| `SETTINGS_RELOAD_MS` | `10000` | re-read settings (kill switch, limits) whatever NOTIFY delivered (NEW-2); ≥ 1000. A load that finishes after a newer one is dropped (R4-5) |
| `PLAYS_RELOAD_MS` | `60000` | re-read plays and armed candidates (NEW-2); ≥ 5000 |
| `FEED_BLOCKS_RETENTION_DAYS` | `7` | `feed_blocks` rows older than this are deleted (hourly, from the reconcile timer); `0` keeps everything |
| `SWEEP_LOOKBACK_BLOCKS` | `864000` | live orphan sweep: how far back the first run scans `Sniped` events (~1 day); `0` = off (NEW-3) |
| `SWEEP_INTERVAL_MS` | `300000` | re-run the orphan sweep from its checkpoint this often (≥ 10 s, R4-2) |
| `PAPER_MAX_QUOTE_IN_ETH` | `0.3` | paper: the contract's `maxQuoteIn` to model (NEW-4/6) |
| `PAPER_MAX_SPEND_PER_WINDOW_ETH` | 4 × `PAPER_MAX_QUOTE_IN_ETH` | paper: the spend budget to model |
| `PAPER_SPEND_WINDOW_SEC` | `3600` | paper: its window; `0` = budget off |

DB `settings` keys read at start and on `settings_changed`:
- `kill_switch`: `true`, `"on"`, `"true"`, `1`, `{"on":true}`, `{"enabled":true}` or `{"killed":true,…}`
  (the shapes the telegram bot writes) block every new snipe — at decide time and again right
  before the first member is sent (reviewer L2). `hoodctl status` shows `ON` for exactly these.
- `daily_loss_limit_eth`, `daily_loss_limit_pct` and `max_concurrent` override the env values.

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
- **Refusals live would make:** the contract caps (`PAPER_MAX_QUOTE_IN_ETH`, the spend budget) at
  decide time, and the simulated contract balance (`PAPER_BANKROLL_ETH` + realised paper PnL − ETH
  in other open paper runs) below quoteIn right before the burst (`low_balance`). Set
  `PAPER_BANKROLL_ETH` to the balance the contract will hold (a fixed 0.07 ETH play on the default
  0.1 ETH holds one position at a time, like the contract would). Paper PnL counts toward the paper
  daily loss limit at runtime, exactly like live.

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
been re-reviewed. Config refuses live mode with a single executor key (N5, `ALLOW_SINGLE_KEY=1`
overrides). The gate (`liveStartupChecks` + `LiveGate`) runs **after** the startup reconciliation —
open positions are managed whatever it says — and **blocks only new entries** while it fails
(`new entries blocked: live gate: …` on refused snipes, `live_gate_failed` event), retrying every
`GATE_RETRY_MS` (N1). It checks:

- the `PonsSniper` owner is not one of the executor keys (cold owner, M4; `ALLOW_HOT_OWNER=1`
  overrides);
- the contract's `factory()` is the Pons V2 factory;
- every executor key is an operator;
- `eth_estimateGas` of a real `snipe()` fits the smallest preset `gasLimit` (L6; within 20 % →
  warning; impossible → blocked; `GAS_CHECK=0` skips). The curve is the newest recent launch that
  we have **not** bought, whose snipe tax is 0 (≥ 3 s old) and that has not graduated; up to 8
  candidates are tried (N1);
- `exitAll()` on the same curve (the contract given a balance by a state override, ERC-20 slots 0/1)
  fits the gas limit; estimate + the 50 k treasury allowance above it → warning; not estimable →
  warning (N15);
- a `fixed` preset that buys more than `maxQuoteIn` → warning; such presets are refused at decide
  time; a bankroll `maxEth` above it → warning (sizes are clamped);
- NEW-4: the spend budget (`maxSpendPerWindow`, `spendWindow`, `spendLevel`, `spendUpdatedAt`) is
  read: below the largest preset buy (fixed `buyEth` up to `maxQuoteIn` — a fixed preset above it
  never buys and is ignored here, R4-8 — bankroll `min(maxEth, maxQuoteIn)`) → blocked; budget off →
  warning.

While the gate passes it re-reads the contract config every `GATE_REFRESH_MS` (no gas estimates,
NEW-8): the decide path always uses the latest `maxQuoteIn` and budget; a config that now fails
(operator revoked, hot owner, budget too small) blocks entries until a full check passes; a read
that merely failed keeps the previous state.

At runtime: fewer burst keys than `MAX_CONCURRENT` logs a warning; balance pre-checks block bursts
(L8).

## Going live (exact sequence)

1. Verify on chain. These items were confirmed by core:
   - `buy(quoteIn, minTokensOut, recipient)` with `msg.value == quoteIn`;
   - contract callers are allowed;
   - no buy splitting is needed;
   - the deployer uses CREATE2.

   Re-run `pnpm --filter @hood/core test` with `LIVE=1` on the executor host.
2. Run the DB migrations: `pnpm db:migrate`, then `pnpm --filter @hood/db seed` (the generic
   `team-buy-0.1` play, enabled). Other plays: insert with `enabled=false`. A live trigger must use
   `deployerIn`, `armedWallet` or a `launchSecond` rule that demands ETH (non-spoofable matcher).
3. Keys: a **cold owner** (hardware wallet / Safe, never on the host) and, on the Ohio host, one
   exit key plus one burst key per concurrent snipe (`EXECUTOR_PRIVATE_KEYS=exit,burst1,burst2,…`
   in an env file with `chmod 600`). Fund each hot key with about 0.01 ETH for gas.
4. Deploy the contract. The constructor takes the owner, the first operator, the Pons V2 factory,
   `maxQuoteIn` and the rolling spend budget (`maxSpendPerWindow`, `spendWindow`; N4):
   - By default the script reads `EXECUTOR_PRIVATE_KEYS` from the sourced env file. It deploys from
     the first key and makes every key an operator; `EXECUTOR_PRIVATE_KEY=<deployer>` and
     `OPERATORS=` override that.
   - `MAX_SPEND_PER_WINDOW_ETH` (default 4 × `MAX_QUOTE_IN_ETH`) per `SPEND_WINDOW_SEC` (default
     3600, must be ≥ 1) is the decaying on-chain budget. `MAX_QUOTE_IN_ETH` defaults to 0.3 (the
     preset default `sizing.maxEth`). To run without a budget the owner calls `disableSpendLimit()`.
   - Dry run first:
     ```bash
     DRY_RUN=1 OWNER=<cold> MAX_QUOTE_IN_ETH=0.1 pnpm --filter @hood/contracts run deploy
     ```
   - Then for real. This deploys, checks `owner`, `operators`, `factory`, `arbBlockNumbers()==true`,
     `maxQuoteIn`, `maxSpendPerWindow` and `spendWindow`, funds the contract when `FUND_ETH` is set
     (no default: unset = no funding) and prints the `setOperator` (and optional `TREASURY` →
     `setTreasury`) calldata the cold owner must send for the other operators:
     ```bash
     FUND_ETH=0.2 MAX_QUOTE_IN_ETH=0.1 OWNER=<cold> pnpm --filter @hood/contracts run deploy
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
- **Rules:** a table test for every trigger field (including every `launchSecond` field, the hint
  vs confirm stages and the `deployerNotIn` / `teamWalletsNotIn` blacklists) and the `require`
  AND-set; live plays need `deployerIn`/`armedWallet`/an ETH-demanding `launchSecond`.
- **Launch second** (`test/launch-second.test.ts`): synthetic feed blocks — launch at T, a 0.19 ETH
  team buy in the block at T+300 ms → burst planned for the T+1 boundary; 0.06 + 0.05 crossing the
  threshold as the ledger grows; a contract-routed team buy seen only in the node CurveBuy log;
  below the threshold, non-exempt buyers, a reverted team buy
  (refused before signing), a blacklisted deployer and an exempt transfer-out never fire; paper
  fill with bankroll sizing; ledger unit tests (classification, hint/log de-dup, launchAndBuy,
  reserves after the team buys).
- **Sizing** (`test/sizing.test.ts`): fixed vs bankroll, clamps, 0.001 ETH rounding, unknown
  bankroll, paper bankroll growth and compounding, the bankroll-percentage daily loss limit.
- **Executor:** fake clock and endpoints; checks count, spacing, nonces, raw tx contents,
  idempotent reconciliation, separate exit/burst keys, re-send, gap filling, the last-moment kill
  switch and the balance pre-checks.
- **Positions:** TP, ladder, trailing, SL, timeout, the dump signal via log and via the feed, capped
  exit rounds with backoff, chain-booked sales, graduation, the explicit-block reserve book and
  zero-size TP levels.
- **Paper e2e:** the AMLIL timeline.
- **Review fixes:** orchestrator-level regression tests for every finding (spoofed launches, fill
  after abort, chain reconciliation and restart, crash paths, tax cap, kill switch, paper fill
  model, startup gate, balances): `review-fixes.test.ts` (round 1), `review-n.test.ts` (round 2),
  `review-r3.test.ts` (round 3: NEW-2…NEW-9; NEW-1 in `launch-second.test.ts`).
- **PgStore:** runs against the real `@hood/db` migrations on PGlite (incl. per-mode stats).
- **Config and metrics.**

`pnpm --filter @hood/sniper typecheck` also typechecks the tests.
