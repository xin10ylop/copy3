# Money-path review (2026-10-28) – findings and status

Independent adversarial review of `contracts/src/PonsSniper.sol`,
`services/sniper/src/*`, `packages/core/src/clock.ts` and `packages/core/src/feed/*`,
each finding confirmed with a proof-of-concept. Status column is updated as fixes land.

| # | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| H1 | High | Launch detection accepts any tx with a launch-like selector regardless of `to`; `launchTokenFor` deployer is attacker-chosen; `playDeployers` set before confirmation → spoofed launch can trigger a buy or block a play (DoS for 21k gas) | accept only `to ∈ {factory, router}`; require `TokenLaunched.deployer == event.deployer` before signing; record play state only after confirmation; live plays need a non-spoofable matcher | fixing |
| H2 | High | A fill landing after an "exempt wallet sold" abort is dropped and never managed | any fill opens a position; aborted run → immediate exit | fixing |
| H3 | High | Positions only in memory; receipt errors swallowed → false "no fill" leaves tokens unmanaged; no rebuild on restart; stale pending rows block `maxConcurrent` | reconcile `bought(token)`/`balanceOf` at startup and after any no-fill; mode-filtered counts | fixing |
| H4 | High | Exit retries forever (60 txs / 20 ticks); no graduation handling (`AlreadyGraduated`) | capped retries with backoff, chain re-read, terminal stuck/graduated state + alert | fixing |
| M1 | Med | One nonce sequence for bursts and exits: failed member rejects the rest, abort leaves gaps, exits queue behind bursts | separate keys per burst and for exits; re-send same nonce to other endpoints; fill gaps | fixing |
| M2 | Med | Uncaught promise/frame errors crash the process (fallback path on a 429; malformed feed frame) | catch all, validate frames, process-level handlers | fixing |
| M3 | Med | `maxTaxBps ≥ 9900` disables the tax gate and slippage | zod max, clamp, contract `require` | fixing |
| M4 | Med | Operator key can drain the contract via a fake curve; deploy makes owner = operator | verify curve via `factory.getLaunchedToken`, `maxQuoteIn`, cold owner | fixing |
| M5 | Med | Reserve snapshot + log deltas without block ordering → phantom stop-loss | reserves at explicit block, ignore older logs | fixing |
| L1-L8 | Low | zero-size exit sells all; kill switch not re-checked at send; feed watchdog fooled by bogus frames; paper fills optimistic; paper rows affect live risk; 300k gas unverified; single-step ownership / owner unable to receive ETH; no balance pre-checks | see sniper README | fixing |

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
