# Money-path review (2026-10-28) – findings and status

Independent adversarial review of `contracts/src/PonsSniper.sol`,
`services/sniper/src/*`, `packages/core/src/clock.ts` and `packages/core/src/feed/*`,
each finding confirmed with a proof-of-concept. Status column is updated as fixes land.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| H1 | High | Launch detection accepts any tx with a launch-like selector regardless of `to`; `launchTokenFor` deployer is attacker-chosen; `playDeployers` set before confirmation → spoofed launch can trigger a buy or block a play (DoS for 21k gas) | accept only `to ∈ {factory, router}`; require `TokenLaunched.deployer == event.deployer` before signing; record play state only after confirmation; live plays need a non-spoofable matcher | fixed |
| H2 | High | A fill landing after an "exempt wallet sold" abort is dropped and never managed | any fill opens a position; aborted run → immediate exit | fixed |
| H3 | High | Positions only in memory; receipt errors swallowed → false "no fill" leaves tokens unmanaged; no rebuild on restart; stale pending rows block `maxConcurrent` | reconcile `bought(token)`/`balanceOf` at startup and after any no-fill; mode-filtered counts | fixed |
| H4 | High | Exit retries forever (60 txs / 20 ticks); no graduation handling (`AlreadyGraduated`) | capped retries with backoff, chain re-read, terminal stuck/graduated state + alert | fixed |
| M1 | Med | One nonce sequence for bursts and exits: failed member rejects the rest, abort leaves gaps, exits queue behind bursts | separate keys per burst and for exits; re-send same nonce to other endpoints; fill gaps | fixed |
| M2 | Med | Uncaught promise/frame errors crash the process (fallback path on a 429; malformed feed frame) | catch all, validate frames, process-level handlers | fixed |
| M3 | Med | `maxTaxBps ≥ 9900` disables the tax gate and slippage | zod max, clamp, contract `require` | fixed |
| M4 | Med | Operator key can drain the contract via a fake curve; deploy makes owner = operator | verify curve via `factory.getLaunchedToken`, `maxQuoteIn`, cold owner | fixed |
| M5 | Med | Reserve snapshot + log deltas without block ordering → phantom stop-loss | reserves at explicit block, ignore older logs | fixed |
| L1-L8 | Low | zero-size exit sells all; kill switch not re-checked at send; feed watchdog fooled by bogus frames; paper fills optimistic; paper rows affect live risk; 300k gas unverified; single-step ownership / owner unable to receive ETH; no balance pre-checks | see sniper README | fixed |

### Fix notes (2026-10-28) — regression tests

All rows above are fixed in code and covered by a regression test (contracts:
`contracts/test/sniper.test.ts`; sniper: `services/sniper/test/*`; core: `packages/core/test/*`).
Live mode still requires the re-review below.

| # | What changed | Regression test(s) |
|---|---|---|
| H1 | detector accepts only `tx.to ∈ {factory, router, LAUNCHERS}`; nothing is signed before the launch receipt shows one factory `TokenLaunched` with the matched deployer (`verifyLaunchReceipt`); team wallets from the curve's `SnipeTaxExempted` logs; play state recorded only on confirmation (`Risk.confirm`, `decision.confirmed` for restarts); live plays need `deployerIn`/`armedWallet` | detector `H1: spoofed launches › PoC5…`, `…only a hint…`, `…real receipt confirms…`; rules `H1: live plays need a non-spoofable matcher`; review-fixes `H1: … reverted launchTokenFor … the real launch still fires`, `… another deployer is refused`; store-db `L5 … H1 …` |
| H2 | any fill opens a position; a fill on an aborted run exits at once (`exempt_dump`), counted in daily loss; the row binding survives the abort | review-fixes `H2: … opens a position, exits immediately …` |
| H3 | "no fill" → member receipts re-read, then `bought(token)`/`balanceOf(sniper)`; unreadable chain → run stays unresolved and is retried; startup rebuilds positions / closes / fails rows of this mode and alerts; per-mode stats; nonce-gated, configurable receipt polling (`BURST_RECEIPT_POLL_MS`, `RECEIPT_POLL_MS`) | review-fixes `H3: …recovered from bought()/balanceOf()`, `…stays unresolved…`, `startup: rebuilds positions…`; executor `plans from the clock…` |
| H4 | exit rounds capped (`EXIT_MAX_ROUNDS`) with doubling backoff; chain re-read books sales; `graduated()` / `AlreadyGraduated` / `CurveCompleted` → terminal `graduated` + alert + `onGraduated` hook (v4 sale documented, not automated); `stuck` after the cap; periodic re-check closes swept positions | positions `H4: … PoC1 …`, `…receipt-less exit … booked from balanceOf`, `graduation: …`, `a CurveCompleted log …` |
| M1 | `EXECUTOR_PRIVATE_KEYS` (first = exit key, others = one burst slot each); per-key nonce sequences, locks and resync; members nobody accepted are re-sent once; unconsumed nonces filled with 0-value self-transfers | executor-keys `M1: …` (3 tests); executor `plans from the clock…` (filler) |
| M2 | every fire-and-forget promise caught (fallback, dump check, polls, ws callbacks); `handleFrame` never throws, messages validated; process-level `unhandledRejection`/`uncaughtException` handlers keep the process alive | review-fixes `M2: …` (3 tests); core feed `M2: malformed frames…`, feed-client `M2: handleFrame never throws…` |
| M3 | zod `maxTaxBps ≤ 5000`; clamp in `newRun` and in `planMinOut`; `MaxTaxTooHigh()` in the contract | contracts `M3: …`; core types `M3: …`; pricing `M3: …`; review-fixes `M3: …` |
| M4 | constructor takes the factory; `snipe`/`exit` require `factory.getLaunchedToken(token).curve == curve`; owner-set `maxQuoteIn`; deploy needs a cold `OWNER` + `OPERATORS`; live startup refuses a hot owner / non-operator key | contracts `M4: …`; review-fixes `L6 / live-mode gate: … hot owner …` |
| M5 | reserves read at an explicit block; trade logs at or below it ignored, later ones kept as deltas; live fills seeded at the fill block | positions `M5: …` |
| L1 | zero-size TP levels skipped; `exit(…, 0)` reverts `NothingToSell` (use `exitAll`); executors refuse zero-size exits | contracts `L1: …`; positions `L1: …` (2); executor-keys `L1: …` |
| L2 | kill switch accepts the telegram shapes; `sendCheck` at decide time, before the burst and in a guard right before the first send (live and paper) | review-fixes `L2: …` (3); executor-keys `L2: …` |
| L3 | liveness only on new in-order blocks; frames far from the head dropped until 3 consistent frames confirm a reset; the clock self-resets after a poisoned future timestamp | core feed-client `L3: …` (2); core clock `L3: a poisoned far-future timestamp…` |
| L4 | `PAPER_FILL=first` (optimistic) or `=last` (pessimistic); paper PnL documented as a bracket | review-fixes `L4: …` |
| L5 | stats and active rows filtered by mode (PgStore + MemoryStore) | store-db `L5: …` |
| L6 | live startup `eth_estimateGas` of `snipe()` on a recent curve vs the smallest preset gas limit; refuses to start (fail closed, `GAS_CHECK=0` to skip) | review-fixes `L6 / live-mode gate: …` (4) |
| L7 | two-step ownership; proceeds → `treasury` (default owner) with a 50k-gas call, held in the contract (`ProceedsHeld`) if refused; ArbSys deadline tested at chain id 4663 | contracts `L7: …` (4 incl. ArbSys) |
| L8 | cached contract / key balances checked before every burst (contract ≥ quoteIn, keys ≥ max(`MIN_GAS_BALANCE_ETH`, gasLimit × maxFee)); `low_balance` events | executor-keys `L8: …`; review-fixes `L8: …` |

Found sound: no exploitable reentrancy; exactly one buy per burst (`bought[token]`
set before external calls); tax check evaluated in the buy block; `NativeValueMismatch`
impossible by construction; approve/sell path works; funds cannot be bricked
(`sweepEth`/`sweepToken`/`rescue`); ArbSys deadline; generated ABI equals a fresh
compile; paper mode cannot sign; feed+log double detection cannot double buy;
burst clipping at +2 s correct; no unbounded memory on the hot path.

Verdict before fixes: paper mode safe (cannot move funds) but crashable and
optimistic; contract sound for its job; executor/position manager NOT ready for
live until H1-H4, M1-M3 are fixed. Live-mode gate: all High and Medium rows
"fixed" and re-reviewed.

## Verification pass (same day) – new findings after the fixes

All 17 original rows verified closed (M1, M4, L3 partial as noted below). Paper mode
is safe to run unattended (no signing path exists in paper mode; crash guards hold).
Live mode is blocked by the new rows marked **blocks live**.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| N1 | Med, blocks live | Live gate estimates gas on the newest launch, which may be ours (`AlreadyBought`), in its launch second (`TaxTooHigh`) or graduated → `process.exit(1)` before reconciliation; systemd crash-loops with a fresh position unmanaged | estimate on the newest unbought, zero-tax, non-graduated launch; run the gate after reconciliation and only block new entries | fixed |
| N2 | Med, blocks live | `stuck` becomes permanent after ~9 s of transient failures (3 rounds, 3 s/6 s backoff); no retry after recovery | retry broadcast/unknown failures indefinitely with capped backoff; `stuck` only for on-chain reverts at minOut=0; `recheck()` re-arms stuck positions that still hold a balance | fixed |
| N3 | Med-Low, blocks live | Rows aborted with members in flight are never reconciled; startup loads only pending/open rows → fill around a crash is orphaned | keep rows pending until the run ended, or load aborted rows with sent members | fixed |
| N4 | Med | A stolen operator key can still drain the working balance via the thief's own real launches (sandwich with minOut=0 and a 10 % creator tax); README claims otherwise | on-chain rolling spend budget; keep the contract balance at a few × buyEth; correct README | fixed |
| N5 | Med-Low, blocks live | Provisioned env/runbook are single-key (undoes M1): exits wait behind a burst's 15 s reconcile | refuse live with one key unless overridden; `EXECUTOR_PRIVATE_KEYS` in env template and RUNBOOK | fixed |
| N6 | Low | Successful exit not booked if the phase changed during the await → PnL wrong, can trip daily loss | book `res.ok` before checking the phase | fixed |
| N7 | Low | `onFinal` inserts a duplicate `snipes` row after `endRun` dropped the binding | update only, never insert | fixed |
| N8 | Low | Paper mode leaks slots on graduation (`recheck` live-only) → stalls after MAX_CONCURRENT graduations | run recheck in paper too | fixed |
| N9 | Low | Feed frame with a sequence jump < 50k poisons `lastBlock`; reconnects keep it (up to ~83 min blind) | bound the jump by elapsed time; reset head on stale reconnect | fixed |
| N10 | Low | Reverted `launchTokenFor` spoofs to the real factory reserve concurrency slots until their receipt is read | reserve the slot after confirmation | fixed |
| N11 | Low | `readSniper` reads `bought` and `balanceOf` at different blocks | read both at one block | fixed |
| N12 | Low | `reconcileRow` declares a pending row "no buy" before the burst's deadline block | wait for the deadline block | fixed |
| N13 | Low | `pollReserves` falls back to an unpinned snapshot when `getBlockNumber` fails | skip the tick instead | fixed |
| N14 | Low | No launchAndBuy receipt fixture; the router-passes-real-deployer assumption is unverified (fails closed) | capture a fixture with LIVE=1 and test | fixed |
| N15 | Low | Exit gas (incl. 50k treasury allowance) never estimated; `buyEth > maxQuoteIn` only warns | estimate once at startup; refuse the preset | fixed |
| N16 | Low | Waiting for the receipt costs the first +1 s block for launches late in their second | accept the node's ws `TokenLaunched` log matched on tx hash + deployer | fixed |

PoC scripts for every N row were produced by the reviewer (scratchpad `poc2/`).

### Fix notes, second pass (2026-10-28): regression tests

Sniper: `services/sniper/test/review-n.test.ts` unless noted. Contracts: `contracts/test/sniper.test.ts`.
Core: `packages/core/test/feed-client.test.ts`.

| # | What changed | Regression test(s) |
|---|---|---|
| N1 | **Candidate choice.** `ChainReader.recentLaunches` returns up to 8 recent factory launches. The gate estimates `snipe()` on the newest launch that is not bought by us, is past its taxed seconds (`launch ts + 3 < head ts`) and has not graduated. If the estimate fails, it tries the next candidate.<br>**Timing.** `main.ts` blocks new entries before `start()`. `LiveGate` runs after startup reconciliation and retries every `GATE_RETRY_MS` while the gate fails (`live_gate_failed` alert). `Risk.blockEntries` refuses only new snipes; positions keep being managed and exited. | `N1: PoC A: the estimate skips our own buy, a launch still in its taxed second and a graduated curve`; `…a failing gate keeps new entries blocked (retried) while positions are managed; passing unblocks`; `…a Sniper with blocked entries refuses the launch at decide time`; review-fixes `L6 / live-mode gate` (updated) |
| N2 | **Transient failures.** Failures without an on-chain verdict (broadcast or unknown errors, a timed-out receipt) are retried indefinitely. The backoff doubles and is capped at `EXIT_MAX_BACKOFF_MS` (60 s). After 3 such rounds an `exit_retrying` warning is raised.<br>**Stuck.** Only rounds that reverted on chain at `minQuoteOut = 0` count toward `EXIT_MAX_ROUNDS` → `stuck`.<br>**Re-arm.** `STUCK_REARM_MS` (5 min) after a position got stuck, `recheck()` re-arms it if it still holds tokens and its curve has not graduated (`position_rearmed`). This applies in live and paper mode. | `N2: PoC B: a 12 s endpoint outage is retried with a capped backoff and the exit lands after recovery`; `…only on-chain reverts at minQuoteOut = 0 lead to stuck; recheck re-arms…` |
| N3 | **Pending until the run ends.** An aborted run's row is written as `pending` until `endRun`.<br>**Legacy rows.** Rows already stored as `aborted` with a `sent` burst member are also loaded at startup and reconciled. This applies to `MemoryStore`/`inFlight` and to `PgStore` (`jsonb_array_elements`). | `N3: PoC C: the row stays pending until the run ends; a restart rebuilds the position…`; `…legacy rows written as aborted while a member was still sent are loaded too` |
| N4 | **Contract.** `PonsSniper` has an owner-set rolling spend budget (`maxSpendPerWindow` per `spendWindow`; `setSpendLimit`; `SpendLimitExceeded`; `0` = off). It is enforced in `snipe` after `maxQuoteIn`.<br>**Deploy.** Defaults are 4 × `maxQuoteIn` per 3600 s.<br>**Docs.** The README claim is corrected: a stolen operator key can lose at most the spend budget per window, bounded by the balance. The README and RUNBOOK say to keep the contract balance at a few × buyEth. The RUNBOOK also adds `setSpendLimit(0, 1)` to the compromised-key steps. | contracts `N4: a spend budget caps what operator keys can buy per window (stolen-key sandwich on its own launches)` (the window is decaying since NEW-5) |
| N5 | **Config.** Live mode refuses a single key unless `ALLOW_SINGLE_KEY=1`.<br>**Env template and RUNBOOK.** They now use `EXECUTOR_PRIVATE_KEYS` (exit key first, one burst key per concurrent snipe), generate 1 + 3 keys, have the owner send `setOperator` for each key, fund each key with gas, and rotate or revoke every key.<br>**Deploy.** `deploy.ts` defaults the deployer and `OPERATORS` to the keys in `EXECUTOR_PRIVATE_KEYS`. | review-fixes `config: EXECUTOR_PRIVATE_KEYS (first = exit key), legacy single key, duplicates refused` (N5 asserts) |
| N6 | `exit()` books `res.ok` (sale, PnL, close) before looking at the phase. | `N6: PoC H: CurveCompleted arrives before our exit receipt → the sale is booked, PnL is right` |
| N7 | `Recorder.update` (used by the executor's `onFinal`) only updates a bound row and never inserts. `snipe()` keeps the binding from `run.id`. | `N7: PoC D2: a dropped member keeps the burst open past endRun; onFinal updates the one row` |
| N8 | `recheck()` runs in paper mode too. A graduated paper position is closed with a simulated sale (`graduated(paper)`), which frees its slot. | `N8: PoC E: recheck closes a graduated paper position with a simulated sale and frees its slot` |
| N9 | **Forward cap.** A forward jump is accepted only up to `lastBlock + ceil(elapsed s × 12) + 100`. This applies per message, so one bogus message in a real frame is dropped alone.<br>**Head reset.** Two stale reconnects in a row mark the head suspect. The next reconnect then omits the replay header, and the first live frame resets the head. | core `N9: PoC I: a bogus far-future message inside a real frame is dropped…`; `…a whole frame 40 000 blocks ahead … is dropped; a real gap after a long silence is accepted`; `…a poisoned head … is reset by the second stale reconnect…` |
| N10 | The concurrency slot is reserved after the launch is confirmed (`execute`), not at decide time. `Risk.confirmCheck` re-checks `maxConcurrent`. `release` frees only a slot that was held. | `N10: PoC J: reverted launchTokenFor spoofs ahead of the real launch in the same block do not block it` |
| N11 | `readSniper` reads `bought()` and `balanceOf()` at one block number. | `N11: both eth_calls carry the same block number` |
| N12 | The decision stores `deadlineBlock`. `reconcileRow` leaves the row pending (`NotFinalYet`, info log) until the head passes it. | `N12: row stays pending while the head is below deadlineBlock; failed once it passed` |
| N13 | `pollReserves` skips the tick when `getBlockNumber` fails, instead of reading an unpinned snapshot. | `N13: pollReserves skips the tick when the block number cannot be read` |
| N14 | `services/sniper/test/launch-and-buy.test.ts` has two tests.<br>**LIVE=1 test.** It reads recent router `Launched` events and picks a launch sent to the router by an EOA. It asserts exactly one factory `TokenLaunched` with `deployer == tx.from` and that `verifyLaunchReceipt` accepts the launch. It saves `packages/core/test/fixtures/launch-and-buy-tx.json`.<br>**Offline test.** It checks the same on the saved fixture.<br>**Finding.** Launches made through a third-party launcher contract (`0x6319…cce2`, which calls the router) carry a different deployer. They still fail closed, as intended. | `N14 (LIVE=1): …TokenLaunched.deployer == tx.from…`; `N14 (offline): verifyLaunchReceipt accepts the router launch` |
| N15 | **Exit gas.** The gate estimates `exitAll()` with a state override that gives the contract a token balance and allowance. It fails if the estimate is above the exit gas limit. It warns if the estimate plus the 50k treasury allowance is above the limit, or if the estimate fails.<br>**Presets.** The gate reads `maxQuoteIn`. `decide` refuses a preset whose `buyEth` (or `sizing.maxEth`) exceeds it. | `N15: a preset buying more than the contract maxQuoteIn is refused at decide time`; `…the gate estimates exitAll with a balance override; an exit above the gas limit fails the gate` |
| N16 | **Log confirmation.** The node's ws `TokenLaunched` log confirms a launch as soon as it arrives. The log must come from a factory or router launch, be the only log for our deployer, and have a matching block. The receipt is still verified in the background: a contradiction aborts the run (`launch_receipt_mismatch`), and a missing receipt raises `launch_receipt_missing`.<br>**Ledger.** A node `CurveBuy` log wakes the launch-second confirmation at once. `SnipeTaxExempted` logs emitted during the launch second count as team exemptions. | `N16: fires before any receipt exists; the receipt is still verified in the background (contradiction → abort)`; `…two TokenLaunched logs for our deployer in one tx (ambiguous) wait for the receipt`; `…ledger: an exemption granted during the launch second … a log wakes the confirmation` |

## Third pass (reviewer round 3) – findings and status

Reviewer PoCs: scratchpad `poc3/` (a_fake_hint_minout, b_late_exemption, c_runtime_orphan,
d_missed_notify, e_spend_window). Re-run after the fixes: a — honest and attacked minTokensOut are
equal; b — the taxed buy stays a taxed buy and does not move the ledger price; c — the run stays
pending until the deadline, the late fill becomes a managed position and survives a restart; d and
e are superseded by the regression tests below (d waits 200 ms, the reload interval is 10 s;
e targets the old 6-argument `snipe`).

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| NEW-1 | Med, blocks live | `reservesAfter` / `priceMovingBuys` counted UNCONFIRMED feed hints and `confirmLaunchSecond` returns while other hints are pending: a feed-visible `curve.buy(3 ETH, minOut = max)` that reverts (gas only) loosened minTokensOut from 30 % to 89.6 % tolerated slippage. Variant: a buy that paid the 99 % tax, followed by `exemptFromSnipeTax` later in the second, counted as an untaxed team buy | price from CONFIRMED CurveBuy logs only (exact numbers); classify taxed vs untaxed by `CurveBuy.fee` (else exemption order); seeded generic presets get the k-based cap `maxEntryMcapEth = 4.2` | fixed |
| NEW-2 | Med-Low, blocks live | LISTEN without `onlisten`; postgres.js does not replay NOTIFYs missed during a reconnect → a `hoodctl kill` committed then is never seen | reload settings, plays and armed candidates on every (re)connect (`onlisten`) and periodically (settings 10 s, plays 60 s) | fixed |
| NEW-3 | Low-Med | Runtime "no fill" accepted after the receipt timeout + one `bought=false` read while head < `deadlineBlock`; a stalled sequencer then fills after the row is `failed`, which startup ignores | run kept unresolved (slot held) until a read past `deadlineBlock`; wall-clock deadline in `snipe` (`Expired` after launch ts + 3); startup sweep of `Sniped` events for orphaned balances | fixed |
| NEW-4 | Low | Nothing read the spend budget; exhausted, every member reverted `SpendLimitExceeded`, logged as "no burst member bought" without an alert | gate reads it (error below the largest preset buy, warning when off); decide-time refusal + `spend_budget_exhausted` alert; paper models it | fixed |
| NEW-5 | Low | Spend window was tumbling (2 × budget across a boundary) while the docs said rolling; `setSpendLimit(0,0)` (off) one keystroke from the buy stop `(0,1)` | decaying budget (`spent − budget × elapsed / window`, floored at 0, before adding); `window = 0` invalid; explicit `disableSpendLimit()` | fixed |
| NEW-6 | Low | `decide` refused every preset whose `sizing.maxEth` (default 0.3) > contract `maxQuoteIn` (deploy default 0.2): every bankroll play refused | clamp the size to min(maxEth, maxQuoteIn, remaining budget); refuse only a FIXED `buyEth` above maxQuoteIn; deploy default `MAX_QUOTE_IN_ETH` = 0.3; paper applies the same caps | fixed |
| NEW-7 | Low | A launch-receipt contradiction after the fill only alerted | `forceExit('launch_receipt_mismatch')` when a position exists; an in-flight fill after the abort exits with the same reason | fixed |
| NEW-8 | Low | `recentLaunches` asked for 36 000 blocks in one `eth_getLogs` (public RPCs cap ranges → gate failed closed forever without `NODE_HTTP`); gate results incl. `maxQuoteIn` cached forever | chunk every log scan to ≤ 10 000 blocks; re-read the contract config every `GATE_REFRESH_MS` (60 s), latest used at decide time | fixed |
| NEW-9 | Low | One exit key serves exits FIFO (undocumented) | documented; `EXIT_KEYS=n`: the first n keys serve exits (a free key first, else round-robin) | fixed |
| also | Low | `hoodctl status` showed `off` for kill-switch shapes the sniper treats as ON; paper did not accumulate daily loss at runtime; paper did not model maxQuoteIn / budget / contract balance; `feed_blocks` unbounded; `deploy.ts` header claimed a `FUND_ETH` default and did not verify maxQuoteIn / the spend parameters | see fix notes | fixed |

### Fix notes, third pass (2026-10-29): regression tests

Sniper: `services/sniper/test/review-r3.test.ts` unless noted. Contracts: `contracts/test/sniper.test.ts`.
DB: `packages/db/test/*`.

| # | What changed | Regression test(s) |
|---|---|---|
| NEW-1 | **Ledger** (`ledger.ts`). `reservesAfter` and `priceMovingBuys` use confirmed CurveBuy logs only, applied with their exact `quoteIn − fee − creator tax` / `tokensOut` (fee includes the snipe tax). Hints only wake the confirmation and drive the µs hint-stage match. A confirmed buy whose `fee` > 5 % of quoteIn paid the snipe tax and is never team/dev, whatever the recipient's later exemption. A log without a fee word falls back to the (block, logIndex) order of the `SnipeTaxExempted` log.<br>**Seed.** `genericPreset()` sets `maxEntryMcapEth = GENERIC_MAX_ENTRY_MCAP_ETH = 4.2` (2.5 × the 1.68 ETH start mcap; the video's +1 s entry ≈ 2.8 ETH). The cap goes on chain through the k-based minTokensOut, which no buy can move. Existing plays are not rewritten by the seed: `/preset <id> maxEntryMcapEth=4.2`. | launch-second `LaunchSecondLedger (unit) › NEW-1: a pending feed hint never prices — reservesAfter / priceMovingBuys use confirmed CurveBuy logs only`; `…› NEW-1: a buy that paid the 99 % launch-second tax is not a team buy when the wallet is exempted later in the second (CurveBuy.fee, else log order)`; `NEW-1: launch-second minTokensOut is priced on confirmed buys only (reviewer PoC A) › a reverting feed-visible fake buy pending at signing time cannot loosen minTokensOut (30 % stays 30 %)`; pricing `NEW-1: the seeded generic preset caps entry at 4.2 ETH mcap through k = Q·T — …`; db seed `NEW-1: the generic presets carry the k-based entry cap maxEntryMcapEth = 4.2 ETH (2.5 × the 1.68 ETH start mcap)` |
| NEW-2 | **Store.** `SniperStore.onChange(cb, onConnect)`: `PgStore` passes `onConnect` as postgres.js `onlisten` (called on every (re)LISTEN). This needs an optional third parameter in `Sql.listen` (`packages/db/src/sql.ts`, backward compatible).<br>**Sniper.** `reloadConfig('all')` runs on every (re)connect. A timer reloads settings every `SETTINGS_RELOAD_MS` (10 s) and plays + armed candidates every `PLAYS_RELOAD_MS` (60 s). | `NEW-2: config survives a lost NOTIFY (LISTEN reconnect) › PoC D: a kill switch committed while the LISTEN connection was down is applied on the (re)connect`; `…› without any reconnect signal the periodic reload picks up settings (10 s) and plays (60 s)`; store-db `NEW-2: onChange reports every (re)connect of the LISTEN connection (postgres.js onlisten) — PGlite once, a reconnecting client each time` |
| NEW-3 | **Runtime.** `settleNoFill` reads the chain head BEFORE `bought()`/`balanceOf()`. "No buy" is final only when that head is past `deadlineBlock`; otherwise the run stays in `unresolvedRuns` with its slot held. It is re-checked about when the head should pass the deadline, and by the reconcile timer. The startup `reconcileRow` reads the head first too, and treats `head ≤ deadlineBlock` as not final.<br>**Contract.** `snipe(…, deadlineBlock, deadlineTs)` reverts `Expired` when `block.timestamp > deadlineTs`. The executor passes launch ts + 3 (`SNIPE_DEADLINE_SECONDS`), and paper models it.<br>**Startup sweep.** `sweepOrphans` reads `Sniped` events since the checkpoint (`settings` `sniper_cursor:sniped_sweep:<contract>`; first run `SWEEP_LOOKBACK_BLOCKS` ≈ 1 day back; chunked). A token with a balance that no position, run or unresolved row manages becomes a position (`orphan_position_recovered`, error). Its newest failed/aborted row is reused, else a new row is written. The checkpoint advances only after a complete pass. | `NEW-3: a runtime "no fill" is final only once the chain head passed the deadline block › PoC C: a stalled sequencer (head below deadlineBlock) keeps the run unresolved with its slot; the late member fill becomes a position`; `…› once the head passed the deadline block with bought() = false the run fails and frees its slot`; `NEW-3: startup sweep of Sniped events — … › reuses the failed row of an orphaned buy, writes a row for one without any, skips sold-out tokens, and advances the checkpoint`; `…› the next startup scans only past the checkpoint and never adopts a token that a row already manages`; contracts `NEW-3: a member landing after the wall-clock deadline reverts Expired even while the block number is below its deadline (stalled sequencer)`; store-db `feed_blocks retention, sweep cursors and rows by token (NEW-3) on the real schema` |
| NEW-4 | **Chain.** `readSniperConfig` also reads `maxSpendPerWindow`, `spendWindow`, `spendLevel` and `spendUpdatedAt`.<br>**Gate.** It fails when the budget is below the largest preset buy (fixed `buyEth`, bankroll `min(maxEth, maxQuoteIn)`) and warns when the budget is off.<br>**Decide path.** `ContractLimits` (`limits.ts`) holds maxQuoteIn and a local model of the decaying budget; it lags the clock by 2 s, and our own fills are charged locally between chain reads. A remaining budget below quoteIn refuses the snipe with `spend_budget_exhausted` (error, at most every 10 min).<br>**Paper.** It models the same limits (`PAPER_MAX_QUOTE_IN_ETH`, `PAPER_MAX_SPEND_PER_WINDOW_ETH`, `PAPER_SPEND_WINDOW_SEC`). | `NEW-4: the contract spend budget is read and respected › the gate fails when the budget cannot cover the largest preset buy and warns when the budget is off`; `…› decide time: a remaining budget below quoteIn refuses the snipe with a spend_budget_exhausted alert (no burst member would have bought)`; `…› our own fill is charged locally until the next chain read (the next decision sees the smaller budget)`; `NEW-6: … › paper applies the same caps: maxQuoteIn clamp, spend budget and the contract balance (L8 twin)` |
| NEW-5 | **Contract.** `PonsSniper` keeps `spendLevel` / `spendUpdatedAt`. Before a buy the level drains by `maxSpend × elapsed / window` (floored at 0), and a buy must keep it ≤ `maxSpendPerWindow`. So at most B can be spent at once, and at most B × (1 + t / W) in any interval of t seconds. `spendAvailable()` is a view of what is left. `setSpendLimit` and the constructor refuse `window = 0` (`InvalidSpendWindow`). `disableSpendLimit()` (owner, `SpendLimitDisabled`) is the explicit off. `setSpendLimit` carries the decayed level over (0 when re-enabling).<br>**Docs.** README, RUNBOOK and the `deploy.ts` header are updated. | contracts `NEW-5: the spend budget decays continuously (no 2× burst across a window boundary); window 0 is invalid, "off" is an explicit disableSpendLimit()`; `N4: a spend budget caps what operator keys can buy per window …` (updated) |
| NEW-6 | **Sizing.** A bankroll size is clamped to `min(maxEth, maxQuoteIn, remaining budget)`, rounded down to 0.001 ETH (`sizing.clamped = 'contract'`). It is refused only below `minEth`. A fixed `buyEth` above maxQuoteIn is refused (N15 kept).<br>**Defaults.** The `deploy.ts` default `MAX_QUOTE_IN_ETH` is 0.3, equal to the preset default `sizing.maxEth`. The paper defaults are the same.<br>**Paper.** It also refuses when the simulated contract balance (`PaperBankroll.freeWeiExcluding`) is below quoteIn (`low_balance`, the L8 twin). | `NEW-6: sizes are clamped to the contract caps; only a FIXED buyEth above maxQuoteIn is refused › a bankroll play (maxEth 0.3 > maxQuoteIn 0.2) buys maxQuoteIn instead of being refused`; `…› a bankroll size is clamped to the remaining spend budget; below minEth it is refused with spend_budget_exhausted`; `…› paper applies the same caps: maxQuoteIn clamp, spend budget and the contract balance (L8 twin)`; review-n `N15: a preset buying more than the contract maxQuoteIn is refused at decide time` |
| NEW-7 | `verifyLaunchLater` handles a receipt that contradicts the log after the fill with `positions.forceExit(key, 'launch_receipt_mismatch')` (new `ExitReason`) and alerts with `filled: true`. Before the fill it aborts the run with `run.abortExit = 'launch_receipt_mismatch'`, so an in-flight fill exits with that reason. | `NEW-7: a launch receipt that contradicts the TokenLaunched log AFTER the fill › forces the position out (launch_receipt_mismatch) instead of only alerting`; `…› a member still in flight when the contradiction aborts the run exits with the same reason once it fills` |
| NEW-8 | **Chunked log scans.** `blockRanges` / `LOG_CHUNK_BLOCKS = 10 000` chunk every log scan: `recentLaunches` walks back newest first and stops at the limit, and `snipedLogs` reads oldest first.<br>**Gate refresh.** `LiveGate` takes `refresh` / `refreshMs` (`GATE_REFRESH_MS`, 60 s). While passing, it re-runs the config part of the gate (`gasCheck: false`), and `onResult` hands the latest maxQuoteIn and budget to the decide path. A config that now fails blocks entries and falls back to full checks. A failed read keeps the previous state. | `NEW-8: chunked log reads and a refreshed contract config › recentLaunches walks back in eth_getLogs ranges of ≤ 10 000 blocks (public RPCs refuse 36 000 at once)`; `…› while the gate passes the contract config is re-read every GATE_REFRESH_MS and the latest limits reach the decide path` |
| NEW-9 | `EXIT_KEYS=n` (config refuses n ≥ key count): `LiveExecutor.exitKeys` = the first n keys. `pickExitKey` takes a key with no exit queued or running (and gas, when another has it), else round-robin. The L8 check refuses a burst only when no exit key has gas. The README documents FIFO for one exit key. | `NEW-9: exit keys (EXIT_KEYS) › one exit key serves exits strictly FIFO; with EXIT_KEYS=2 concurrent exits go out at once on different keys`; `…› config: EXIT_KEYS must leave at least one burst key` |
| also | **hoodctl.** `ctl.ts` exports `killSwitchOn` (the exact shapes of `risk.ts`) and `status(sql, out)`. The CLI runs only as a script.<br>**Paper.** `Risk.onPositionClosed` / `bookRealized` accumulate in paper too (aggregates are per mode, L5). Paper also models maxQuoteIn, the budget and the contract balance (NEW-4/6).<br>**Retention.** `feed_blocks` keeps `FEED_BLOCKS_RETENTION_DAYS` (7); rows are deleted at most hourly from the reconcile timer (`SniperStore.pruneFeedBlocks`).<br>**Deploy.** The `deploy.ts` header has no `FUND_ETH` default (unset = no funding). `SPEND_WINDOW_SEC` must be ≥ 1, and the budget must be ≥ maxQuoteIn. After deploy the script verifies `maxQuoteIn`, `maxSpendPerWindow` and `spendWindow` besides owner, operator, factory and ArbSys. | db ctl `hoodctl status: kill switch › killSwitchOn accepts exactly the shapes the sniper risk gate accepts`; `…› status shows ON for every shape the sniper treats as ON (it showed "off" for true / "on" / 1 / {enabled:true})`; `paper mode accumulates its daily loss at runtime (it stops like live would) › a paper position closing at a loss counts toward the paper daily loss limit`; `feed_blocks retention (FEED_BLOCKS_RETENTION_DAYS, pruned from the reconcile timer) › drops rows older than the retention at most hourly`; store-db `feed_blocks retention, sweep cursors and rows by token (NEW-3) on the real schema`; `deploy.ts` is typechecked (not run by tests: no network) |

**Still open after the third pass.**
- The live gate still needs the re-review of these rows.
- The contract ABI changed (`snipe` has a 7th argument; budget storage renamed `spendLevel` / `spendUpdatedAt`). An already deployed PonsSniper must be **re-deployed**: the new service cannot drive the old contract.
- Plays seeded before NEW-1 need `maxEntryMcapEth` set by hand.
- `infra/` env templates do not list the new variables yet; they all have safe defaults.

## Fourth pass (reviewer round 4, final) – findings and status

The verifier confirmed NEW-1 … NEW-9 closed and found the rows below. Reviewer PoCs are in scratchpad
`poc4/`, rerun after the fixes:
- `a_dust_orphan`: nothing adopted, `orphan_dust_ignored`; the day's PnL stays +0.02 (it was −0.05).
- `c_dust_stuck`: no position, 0 slots, 0 exit txs.
- `b_cap_tolerance`: the capped preset now tolerates at most the 30 % slippage, less near the cap.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| R4-1 | Med | The orphan sweep re-adopted any balance (dust, a 1-wei transfer by anyone) at the full original quoteIn → a closed +0.02 trade became −0.05 for the day; unsellable dust went `stuck`, held a slot and fired reverted exits every 5 min | newest row `closed` → alert only; otherwise adopt at cost 0 with no daily-loss booking; dust (< 0.5 % of the tokens bought, or worth less than the exit gas) ignored; adopted orphans hold no slot | fixed |
| R4-2 | Low-Med | "No buy is final" ignored `deadlineTs` and read the head separately from the block `readSniper` read at → slot held forever on a stale node without an alert; on a load-balanced RPC a final "no buy" from a lagging backend while the position is real | `readSniper` returns the block (and timestamp) it read at; final only when THAT block > `deadlineBlock` or its ts > `deadlineTs`; `snipe_unresolved_long` after 2 min; the sweep runs every `SWEEP_INTERVAL_MS` (5 min) | fixed |
| R4-3 | Low | `maxEntryMcapEth` replaced the slippage bound (tolerated 44–55 % at typical entries) | minTokensOut = max(cap bound, slippage bound on the confirmed-reserves quote) | fixed |
| R4-4 | Low | A receipt-less (`unknown`) exit was retried on another key / nonce → both sells could execute | the same raw tx is re-sent on its key and nonce until final; no filler or resync over it; a replayed landing corrects a chain-estimated sale instead of booking twice | fixed |
| R4-5 | Low | An older periodic config load could overwrite a newer NOTIFY load (kill switch off again for ≤ 10 s) | generation counter per config kind; a load finishing after a newer one is dropped | fixed |
| R4-6 | Low | Budget not reserved across concurrent runs; a gate refresh wiped local charges | reserve quoteIn at decide time, release on no fill, charge on fill; a chain read keeps charges newer than its `spendUpdatedAt` | fixed |
| R4-7 | Low | Fixed 10 k-block `eth_getLogs` chunks, no halving on range errors (gate closed forever on 1–5 k caps; the sweep never advanced) | the chunk halves on a range error down to 500 (rate limits excluded); the sweep checkpoint advances per chunk | fixed |
| R4-8 | Low/info | `*_RELOAD_MS` accepted 0 (tight loop); the gate's budget check counted fixed presets above maxQuoteIn; a reverting fake team-buy hint used up the launch (`lg.decided` stayed true); the retention delete had no `ts` index; `removed` logs were not honoured | minimums 1 s / 5 s (`SWEEP_INTERVAL_MS` ≥ 10 s); those presets are ignored; a refuted launch-second confirmation re-opens the ledger (≤ 3×, burst window still applies); migration `0002_feed_blocks_ts_idx.sql`; `removed` logs dropped from getLogs / ws / receipts | fixed |

### Fix notes, fourth pass (2026-10-29): regression tests

Sniper: `services/sniper/test/review-r4.test.ts` unless noted.

| # | What changed | Regression test(s) |
|---|---|---|
| R4-1 | **Classification.** `handleOrphan` sorts each unmanaged balance into one of three cases:<br>• Dust: `dustReason` is either < 0.5 % of `Sniped.tokensOut`, or `quoteSell` value < gasLimit × gas price. The balance is ignored with an info event `orphan_dust_ignored`.<br>• The newest row is `closed`: `orphan_balance_on_closed_row` (warn) only.<br>• Otherwise `adoptOrphan`: cost basis 0, entry price from the `Sniped` event (for the exit rules), `run.orphan = true` and `run.slot = false`. Its newest non-closed row is reused, else a new row is written.<br>**Risk.** `Risk.adoptPosition(…, holdSlot = false)`. On close, `Risk.onPositionClosed(0, false)`: no slot is freed and no daily-loss PnL is booked. | `R4-1: … › PoC A/C: 1 token-wei sent to the contract after a closed trade is dust — not adopted, no row, no slot, no exit, no daily-loss booking`; `…› a real balance on a token whose newest row is CLOSED is alerted only`; `…› a balance worth less than the exit gas is dust even above 0.5 % of the tokens bought`; `…› a real orphan (failed row) is adopted at cost 0: no slot, and its close books nothing to the daily loss`; review-r3 sweep test updated |
| R4-2 | **Chain read.** `SniperHolding.block` / `blockTs` come from `ViemChain.readSniper`, which reads the latest header, then both calls at that number.<br>**Finality.** `settleNoFill` and the startup `reconcileRow` judge "no buy" on that block (> `deadlineBlock`) or its timestamp (> `deadlineTs`, stored in the decision). A head read before is only the fallback for a client without a block.<br>**Alerts.** `snipe_unresolved_long` (error, once per run) fires after 2 min.<br>**Sweep.** The orphan sweep runs every `sweepIntervalMs` (`SWEEP_INTERVAL_MS`, default 5 min) from its checkpoint, with no overlap. | `R4-2: … › a load-balanced RPC whose head is past the deadline but whose read came from a lagging backend keeps the run pending`; `…› a read whose block timestamp is past deadlineTs is final even below deadlineBlock`; `…› a run unresolved for more than 2 min raises snipe_unresolved_long`; `…› the orphan sweep also runs periodically from its checkpoint`; review-n `N11: both eth_calls carry the same block number` (updated) |
| R4-3 | **Pricing.** `planMinOut` returns `max(capOut, slippageOut)`, plus `basis`, `capOut` and `slippageOut`. Slippage applies to the reserves the decision priced on: config plus confirmed buys, or getReserves.<br>**Paper e2e.** The AMLIL fill tests now use the video's `slippageBps: 9000`: a deployerIn play prices on pre-team reserves. The existing "30 % fails on AMLIL" test is unchanged. | pricing `R4-3: minTokensOut is the STRICTER of the mcap cap and the slippage bound (the cap alone tolerated 44-55 %)`; `maxEntryMcapEth turns into an on-chain minTokensOut…` and `NEW-1: … do not move the cap bound` (updated) |
| R4-4 | **Executor.** On `unknown`, `LiveExecutor.pendingExits` keeps {key, nonce, raw, hash} per position. The next `exit()` for that position calls `resumeExit`, which returns the receipt's result (`replayed`, with the original `all`) if one exists. If the nonce went to another tx, it returns "dropped" (not unknown). Otherwise it re-sends the same raw tx and waits again.<br>**Settle.** `settle` neither fills nor resyncs over a pending nonce; it re-sends that raw tx instead. `pickExitKey` avoids keys holding one.<br>**Positions.** A replayed result corrects the matching estimated chain sale. | `R4-4: … › the retry re-sends the identical raw tx on the same key even with another exit key free; the late landing is reported once`; `…› if the pending nonce went to another tx, nothing was sold by it and a fresh exit follows`; `…› positions: a replayed result for tokens the chain re-read already booked corrects that sale instead of booking it twice` |
| R4-5 | `loadConfig(kind)` takes a generation number when it starts and drops its result if a newer one already applied. This covers NOTIFY, periodic and reconnect loads. An armed-candidate removal from a NOTIFY payload advances the armed generation. | `R4-5: … › a slow periodic settings read that started before a kill-switch NOTIFY does not turn the kill switch off again` |
| R4-6 | `ContractLimits`: `reserve`/`release` per run (in `decide` / `endRun`); `onFill` releases the reservation and charges at the fill's block time. `set()` keeps charges whose ts > the chain's `spendUpdatedAt`, and `available()` replays them and deducts reservations. | `R4-6: … › a decided run reserves its quoteIn …; a no-fill releases it`; `…› a gate refresh keeps local charges newer than the chain's last spend`; review-r3 NEW-4 charge test (updated) |
| R4-7 | `scanChunks` walks a range ascending or descending. On a range error (`isRangeError`; 429 / rate limits excluded) it halves the chunk, retries, and keeps the learnt size (`ViemChain.logChunk`); the floor is `MIN_LOG_CHUNK_BLOCKS = 500`. `recentLaunches` and `snipedLogs` use it. `snipedLogs(…, onChunk)` lets the sweep process and checkpoint each chunk, stopping at the first unreadable one. | `R4-7: … › an RPC capping eth_getLogs at 2 000 blocks: recentLaunches halves 10 000 → 1 250 and succeeds; removed logs are dropped`; `…› scanChunks stops halving at the 500-block floor and rethrows other errors untouched`; `…› the sweep advances its checkpoint after every good chunk …`; review-r3 NEW-8 ranges test (updated) |
| R4-8 | **Config.** Zod minimums apply: `SETTINGS_RELOAD_MS ≥ 1000`, `PLAYS_RELOAD_MS ≥ 5000`, `SWEEP_INTERVAL_MS ≥ 10 000`.<br>**Gate.** It takes `fixedBuysEth` and ignores those above maxQuoteIn in the budget check.<br>**Ledger.** `confirmLaunchSecond` marks a refutation (no pending hints left), which resets `lg.decided` and re-evaluates (≤ 3 re-opens per ledger).<br>**Migration.** `packages/db/migrations/0002_feed_blocks_ts_idx.sql`.<br>**Logs.** `live()` drops logs with `removed: true` from `getLogs`, ws watchers and receipts. | `R4-8: … › SETTINGS_RELOAD_MS < 1 s and PLAYS_RELOAD_MS < 5 s are refused`; `…› the budget check ignores a fixed preset above maxQuoteIn`; launch-second `R4-8: a reverting fake team-buy hint no longer uses up the launch — a real confirmed team buy later in the second still fires`; db migrations `R4-8: 0002 adds the feed_blocks(ts) index …`; the removed-log case is in the R4-7 recentLaunches test |

**Still open after the fourth pass.**
- **Orphan accounting.** An adopted orphan reports its proceeds as PnL on its row (cost basis 0). The original spend of a row written off at runtime is therefore not in any row's PnL. The alert names the token and the previous row.
- **Exit-key backlog.** A pending receipt-less exit holds its key's nonce. With one exit key, later exits queue behind it until it is final (`settle` keeps re-sending it). `EXIT_KEYS ≥ 2` avoids this.

## Production finding (live paper box): launches through third-party launcher contracts

About 50 % of real Pons launches go through launcher contracts. On the live paper box, 3 h, 52
launches: `0x6319…cce2` (16, unknown selector `0xf955751f`), `0x9dcc…3961` (8, launchAndBuy-shaped),
plus one-offs. H1's calldata filter (tx.to ∈ {factory, router, LAUNCHERS} + a launch selector) never
saw them, so the generic launch-second play missed half the market.

**H1 note.** H1's guarantee is "nothing is signed for a launch the factory did not emit for that
deployer". It now has a second, equally strong source: the factory's own `TokenLaunched` log.
- The original concern was **calldata-derived** deployers from arbitrary contracts. A factory log is
  not that, and the receipt is still verified before signing.
- `deployerIn` / `armedWallet` plays may therefore match log-originated launches.
- Calldata sent to a launcher contract is never decoded for the deployer.
- A `TokenLaunched`-shaped log from any other emitter is ignored.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| P-1 | Med | Launches through third-party launcher contracts invisible to the sniper (H1 calldata filter) | log-originated launches built from the factory `TokenLaunched` log + receipt (`origin: 'log'`, `launcher`); ledger, rules, receipt confirmation and the T+1 burst unchanged; default `LAUNCHERS` = the two observed contracts (early path from the feed, any selector); `origin` / `launcher` persisted in the decision | fixed |

**Fix notes.** The changes are in `sniper.ts`, `detector.ts`, `chain.ts`, `config.ts` and
`recorder.ts`:
- **Builder.** `Sniper.launchFromLog` polls the tx's receipt and requires exactly one factory
  `TokenLaunched`.
  - Deployer, token, curve, pair and config come from that log. Exemptions are the curve's
    `SnipeTaxExempted` logs, and the launch tx's own `CurveBuy` is classified by recipient (deployer → dev, another exempt wallet → team: the 0x6319… launcher pattern, see P-2).
  - Name, symbol and creator tax come from known-selector calldata, else from
    `ChainClient.tokenMeta` (token `name()` / `symbol()`, curve `creatorTaxBps()`).
  - A launch older than `MAX_LAUNCH_AGE_MS` is skipped (`log_launches_stale`).
- **Triggers.**
  - `onFeedBlock` starts the builder for every tx to a `LAUNCHERS` contract (any selector).
  - `onTokenLaunchedLog` (factory emitter only) starts it for a tx the feed did not classify: at
    once when the feed already showed the block, else after `fallbackDelayMs`. The old `fallbackLaunch`
    now delegates here, so it no longer requires a whitelisted `to`.
- **handleLaunch.** It opens a ledger for log-originated launches. Feed-decoded launches through a
  third-party launcher are left to the log path.
- **Defaults.** `config.DEFAULT_LAUNCHERS` holds the two observed launchers; the `LAUNCHERS` env value
  extends it.
- **Persistence.** `snipes.decision.launch` gains `origin` and `launcher`.

Regression tests, all in `services/sniper/test/launcher.test.ts`:
- `a launcher-contract tx (to = 0x6319…, unknown selector) → launch from the factory log, ledger started, team buy confirmed → burst planned at T+1`
- `a launcher the config does not list is caught from the node ws TokenLaunched log (emitter = the factory)`
- `a TokenLaunched-shaped log whose emitter is not the factory is ignored (ws and receipt)`
- `a launcher launch for a deployerIn play matches via the log deployer — never via calldata naming another deployer`
- `a log-originated launch older than MAX_LAUNCH_AGE_MS is skipped like a stale feed launch`
- `config: the observed launchers are a documented default; LAUNCHERS extends it`

The existing H1 tests are unchanged and still pass.

**Open.** A batch launcher tx (several `TokenLaunched` in one receipt) is skipped, because one ledger
per tx cannot attribute the buys. The launch kind of an unknown-selector launch is recorded as
`launchTokenFor`.


### P-2 — the launch tx's own buy was always the dev buy (fixed)

Ohio paper night, 29 Oct 2026: the indexer counted 23 of 290 launches with team ≥ 0.1 ETH in the
launch second; the sniper matched 1. Trace: launcher contracts (0x6319…) launch for a fresh
deployer wallet while the tx sender, exempted in the same tx, buys 0.2–0.8 ETH *inside the launch
tx*. `LaunchSecondLedger.kindOf` returned `dev` for any buy in the launch tx, so `team-buy-0.1`
saw team 0 ETH. The backtest (bt_month.py) counts an exempt recipient ≠ deployer as team, launch
tx included — that is where its +14.8 ETH/month came from. Fix: classify by recipient only;
`LaunchEvent.devBuyRecipient` carries the launchAndBuy `recipient` / the receipt's CurveBuy
recipient so the pre-receipt hint is right too. Tests: `launch-second.test.ts` "classified by
recipient", `launcher.test.ts` "the observed 0x6319… pattern".

### F-1 — a stale primary feed went straight to the delayed feed (fixed)

28 stale timeouts in 6 h, each a 30 s detour onto `delayed-feed…` (every launch in those windows
lost). A stale primary now reconnects to the primary; the secondary is used after two
consecutive stale timeouts or a socket error/close. Tests: `feed-client.test.ts` "stale primary".

## Alchemy budget (Ohio paper box)

The live indexer read every block: `eth_getBlockByNumber(full)` + `eth_getBlockReceipts` per block
(+ `debug_traceTransaction` per value tx to a contract with `TRACE_INTERNAL=1`, + `getCode` /
nonce per new wallet, + an `eth_blockNumber` poll per second). At ~10 blocks/s that is ~21 calls/s,
**~1.8M calls/day** before traces, most of the Alchemy bill.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| A-1 | Med | Alchemy budget: live indexer reads every block (~21 calls/s, ~1.8M/day + traces) | `INDEXER_MODE=logs` (default in `infra/ohio`, code default `blocks`): `LogFollower` indexes `[checkpoint+1, head - CONFIRMATIONS]` about once a second through `processLogRange`, the path `backfill --mode logs` now shares: 1 Pons `eth_getLogs` + ⌈tokens launched in the last 6 h / 100⌉ Transfer `eth_getLogs` per range + 1 `eth_getBlockByNumber` per block with Pons events (+1 head poll/s without `newHeads`). ≈ 2-3 calls/s (~170-260k/day) + one call per block with Pons events, i.e. roughly 5-10× fewer calls depending on how many blocks carry Pons events; no receipts, no traces. Checkpoint in the same transaction; ranges ≤ 2,000 blocks when catching up; getLogs cross-checked against the WS logs subscription; a `removed` log rolls back through the existing rollback path. `/healthz` gains `mode`, `logs` and `rpc` (per-method counts) and a per-minute `rpc calls in the last minute` log line. **Trade-off**: no `eth_transfers`, `wallets` or traces in logs mode, so the tracker arms no candidates (`armedWallet` plays idle; it does not crash), the agent sees no new funding trails, and Transfer logs are kept only for tokens younger than `LOGS_TOKEN_WINDOW_HOURS`. Launches, trades, token transfers, metrics, the sniper and telegram are unaffected. `INDEXER_MODE=blocks` restores the funding graph from the checkpoint on. Next lever: `INDEXER_WS_NEW_HEADS=0` drops the `newHeads` stream (~22-26M CU/day, now the largest item) for a 1/s head poll | fixed |

Tests (`services/indexer/test/log-follower.test.ts`):
- 401 blocks with 2 launches, 10 trades and 4 token transfers, head +10 blocks per poll: launches,
  trades, token transfers and metrics are identical to the block pipeline's. Checkpoint = head,
  lag 0. Calls: 41 ranges, 82 `eth_getLogs`, 6 full blocks, 2 headers, 0 receipts, 0 traces
  (+46 head polls without WS). Block mode on the same blocks: 401 blocks + 401 receipts.
- a checkpoint 7,401 blocks behind: 4 consecutive ranges ≤ 2,000 blocks, each block exactly once.
- `eth_getLogs` short of the subscription → range retried; a `removed` log → rollback from
  `block - REORG_DEPTH` and identical rows after re-indexing.

### R-1 — daily-loss base sampled the free balance (fixed)

`Risk.setBankroll` takes the first bankroll figure of the UTC day as the base for
`DAILY_LOSS_LIMIT_PCT`. The sniper fed it the FREE balance (paper: start + realised − committed;
live: the contract's ETH, which drops while positions are open). Ohio, 29 Oct 2026: sampled with
three positions open → base 0.024 ETH on a 0.127 ETH bankroll → limit 0.0036 ETH, which a normal
losing streak trips. Now `Sniper.totalBankrollEth()` = free + cost basis of the open positions
(paper: `PaperBankroll.totalWei()`). Tests: `sizing.test.ts` "totalWei", `paper-e2e.test.ts`
(base stays 0.1 with 0.07 open).
