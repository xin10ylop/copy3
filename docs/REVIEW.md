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
| N4 | **Contract.** `PonsSniper` has an owner-set rolling spend budget (`maxSpendPerWindow` per `spendWindow`; `setSpendLimit`; `SpendLimitExceeded`; `0` = off). It is enforced in `snipe` after `maxQuoteIn`.<br>**Deploy.** Defaults are 4 × `maxQuoteIn` per 3600 s.<br>**Docs.** The README claim is corrected: a stolen operator key can lose at most the spend budget per window, bounded by the balance. The README and RUNBOOK say to keep the contract balance at a few × buyEth. The RUNBOOK also adds `setSpendLimit(0, 1)` to the compromised-key steps. | contracts `N4: a rolling spend budget caps what operator keys can buy per window (stolen-key sandwich on its own launches)` |
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
