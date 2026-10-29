# Backtest #1 – first look (one day of Pons V2 launches, 2026-10-28)

Data: every Pons V2 launch over the last 300k blocks (8.7 h), 808 ETH-paired
launches, all CurveBuy / CurveSell / SnipeTaxCharged / SnipeTaxExempted events,
real block timestamps (13,114 blocks fetched in JSON-RPC batches – the
`blockTimestamp` field of this RPC's logs is always `0x0`, do not trust it).
Scripts: scratchpad `backtest/fetch.py`, `bt.py` (to be ported into
`services/agent/src/backtest.ts`).

## Model (validated)

* Curve replay: constant product with virtual quote 1.68 ETH and 1e9 tokens;
  net quote in = quoteIn − 1 % fee − creator tax − snipe tax. Predicted
  tokensOut vs actual on 11,688 real buys: median error 5e-6, p95 6 %.
* Entry: we are the first buy in the first block with timestamp launch+1 s
  ("first"), paying 6.18 % snipe tax + 1 % fee + creator tax, 0.07 ETH.
  Variant "last": we are behind every other +1 s buyer.
* Exit: marginal-price triggers (TP, trailing, SL, timeout), realised through
  the sell formula minus 1 % fee and creator tax. Horizon 300 s, then sell.
* Not modelled yet: exit on exempt-wallet transfer-out (dump signal), gas
  (≈0.00001 ETH per tx), failed sells, our effect on other bots.

## Results, video preset (TP 150 %, trailing 100/25, SL 40 %, timeout 60 s), 0.07 ETH

| Segment (fingerprint) | n | win % | mean/trade | total ETH | first vs last in block |
|---|---|---|---|---|---|
| all launches | 808 | 22 | −0.0004 | −0.31 | last: −0.0028 |
| exempt team wallet bought in launch second | 93 | 37 | **+0.0047 (+6.8 %)** | +0.44 | last: −0.0014 |
| team buy ≥ 0.1 ETH | 61 | 52 | **+0.0108 (+15 %)** | +0.66 | last: +0.0025 |
| dev bought at launch (no team) | 490 | 28 | +0.0010 | +0.51 | last: −0.0016 |
| nobody bought at launch | 225 | 4 | −0.0056 | −1.26 | last: −0.0058 |

Median trade is −0.007 ETH (the round-trip cost on a dead launch); profit comes
from the ~15 % of launches that run. Being first in the +1 s block is the whole
edge: losing the race turns the team segment negative.

Liquidation-value peaks after a first-in-block entry, team segment
(median / p75 / share ≥ +100 %): +2 s: 2 % / 14 % / 0 %; +10 s: 10 % / 31 % / 5 %;
+30 s: 16 % / 49 % / 14 %; +60 s: 25 % / 60 % / 16 %. Far below the video's
hand-picked coins – this segment is "any team buy", not a curated operator.

## Out-of-sample (chronological 60/40 split)

| Segment | preset | in-sample mean | OOS mean (n) |
|---|---|---|---|
| team | best of grid (TP150, trail 50/20, SL30, t/o 60) | +0.0069 | +0.0041 (38) |
| team | video preset | +0.0047 | +0.0051 (38) |
| team | fit on last 40 % → test first 60 % | +0.0074 | +0.0018 (55) |
| all | best of grid (trail 50/20, t/o 120) | +0.0015 | +0.0003 (324) |
| no launch buy | any | −0.0055 | −0.0051 (90) |

Operator clustering (launches sharing exempt wallets / deployer): 616
clusters, one operator launched 44 coins in 1.6 h (+0.36 ETH total, 27 % win),
another 16 (+0.16, 56 % win). Selecting operators with ≥3 in-sample launches
and positive in-sample PnL and trading their later launches: n = 12, −0.12 ETH.
Too few to conclude; a multi-day dataset is being fetched.

## Conclusions so far

1. The mechanics in the video are real and reproducible on-chain; the
  operator fingerprint (exempt team buy in the launch second) has positive
  expectancy in and out of sample on this day, ≈ +7 % per trade at 0.07 ETH,
  with heavy right skew.
2. Everything hinges on winning the +1 s block: the Ohio executor and the
  burst are not optional.
3. One day and n ≈ 40 OOS is not evidence of a durable edge. Next:
  3-day dataset (running), per-operator history, dump-signal exit, and the
  funding-trail fingerprint once the indexer has internal transfers.

---

# Backtest #2 – three days (2026-10-25 → 2026-10-28)

Data: 3,734 ETH-paired Pons V2 launches over 69.4 h (2.4M blocks), every curve
trade, 64,011 real block timestamps, ERC-20 transfers for the 1,435 tokens whose
launch had non-deployer exemptions (198 launches with an observed exempt-wallet
transfer-out = operator dump). Scripts in `scripts/backtest/`.
Fix vs #1: `CurveBuy.fee` already contains the snipe tax (no double subtraction).

Competition check: 1,079 launches had at least one taxed buy at +1 s; 176 launches
had 8 or more buys in that second. "First in block" is therefore optimistic exactly
on the launches bots care about; the "last" rows below bracket the other extreme.

## Video preset (TP150, trailing 100/25, SL40, timeout 60), 0.07 ETH

| Segment | n | win % | mean/trade | total ETH | +dump exit | if last in block |
|---|---|---|---|---|---|---|
| all launches | 3734 | 22 | −0.0014 | −5.40 | −5.25 | −0.0038 |
| team wallet bought in launch second | 448 | 33 | **+0.0026 (+3.7 %)** | +1.16 | +1.18 | −0.0024 |
| team buy ≥ 0.1 ETH | 268 | 46 | **+0.0058 (+8.3 %)** | +1.56 | +1.48 | −0.0009 |
| dev bought, no team | 2609 | 23 | −0.0014 | −3.76 | −3.63 | −0.0038 |
| nobody bought at launch | 677 | 7 | −0.0041 | −2.81 | −2.80 | −0.0050 |

Dump timing: the first exempt-wallet transfer-out happens at a **median of 4 s**
after launch (p10 4 s, p90 63 s). Most of the move is over by then; the trailing
stop and the dump exit are what capture it.

## Walk-forward (fit on all previous days, test on the next day), 0.07 ETH

| Segment | test day | n | fitted preset | OOS mean | OOS total | video preset OOS |
|---|---|---|---|---|---|---|
| team | 10-27 | 170 | no TP, trail 50/20, no SL, t/o 30, dump exit | +0.0042 | +0.72 | +0.0030 |
| team | 10-28 | 152 | no TP, trail 50/20, SL 40, t/o 60 | +0.0011 | +0.17 | +0.0008 |
| team ≥ 0.1 | 10-27 | 95 | TP150, trail 50/20, SL 40, t/o 60 | +0.0041 | +0.39 | +0.0035 |
| team ≥ 0.1 | 10-28 | 86 | no TP, trail 50/20, SL 40, t/o 60 | +0.0062 | +0.54 | +0.0062 |
| all | 10-27 | 1223 | trail 50/20, SL 40, t/o 60, dump | +0.0025 | +3.01 | −0.0009 |
| all | 10-28 | 1210 | trail 50/20, no SL, t/o 60, dump | +0.0000 | +0.05 | −0.0010 |

Every team-segment fold is positive out of sample; the per-trade edge is 1-6 % of
the buy size. The fitted preset is stable across folds: **no fixed take-profit,
trailing stop armed at +50 % with a 20 % pull-back, 40 % stop loss, 60 s timeout,
exit on exempt transfer-out**. These are now the defaults in `Preset`.

## Operators (clusters by shared exempt wallets / deployer)

2,654 clusters, 2,429 singletons. The largest operator launched 201 coins in
62 h: +2.29 ETH total at 0.07 ETH per snipe (31 % win, median peak +43 %). Others:
116 launches −0.78 ETH; 32 launches +0.28 ETH (59 % win); 19 launches +0.09 (74 %).
Selecting operators with ≥ 3 prior launches, positive PnL and ≥ 40 % win rate and
trading their next-day launches: +0.0029/trade (n=41) and +0.0044/trade (n=125).
Restricting that to launches with a team buy was negative on both days (n=19, 47).
Operator history helps, but the team-buy fingerprint and the operator's history
are not additive on this sample.

## What this means

* Expectancy at 0.07 ETH on the team-buy fingerprint: ≈ +0.1 to +0.7 ETH per day
  with 150-170 snipes/day, **if** we are first in the +1 s block. Losing the race
  flips it negative, so the Ohio executor and the burst are the product.
* Size: the 1-day sensitivity showed flat ROI up to 0.3 ETH (impact is modelled);
  the operator's own exits and other bots are not modelled reacting to us.
* Not yet modelled: gas (~0.00002 ETH per snipe, negligible), failed sells,
  partial fills, our effect on the dump timing.
* Next: run the sniper in paper mode in Ohio for a week with `PAPER_FILL=last`
  as the pessimistic bracket, compare with these numbers, then size up.

## Daily distribution (bootstrap from the 3-day data, best preset, 0.07 ETH)

Preset: no fixed TP, trailing 50/20, SL 40 %, timeout 60 s, dump exit. "Race win"
= share of launches where we are first in the +1 s block (the rest filled last).

| Signal | snipes/day | actual full days (ETH) | race win | P(losing day) | median day | p10 / p90 |
|---|---|---|---|---|---|---|
| team buy ≥ 0.1 ETH | ~93 | +0.91, +0.62, +0.48 | 100 % | 1 % | +0.65 | +0.28 / +1.11 |
| | | | 75 % | 3 % | +0.51 | +0.15 / +0.94 |
| | | | 50 % | 10 % | +0.35 | −0.00 / +0.78 |
| any team buy | ~155 | +1.29, +1.22, +0.14 | 100 % | 2 % | +0.85 | +0.27 / +1.65 |
| | | | 75 % | 7 % | +0.66 | +0.06 / +1.42 |
| | | | 50 % | 17 % | +0.44 | −0.11 / +1.21 |

Per-trade win rate is 52 % (≥ 0.1 signal) / 38 % (any team buy); the median trade
is a small loss and the day is carried by the runners. Scale linearly with size up to
the ~0.3 ETH impact ceiling.

---

# Backtest #3 – thirty days (2026-09-28 → 2026-10-28), full data via Alchemy

Data: 82,192 launches (60,484 ETH-paired) over 30.0 days, 2.0M curve events, 943k
block timestamps (94 % of the needed set; the rest errored on the RPC and those
launches are skipped), ERC-20 transfers for all 29k tokens with team exemptions
(2,062 observed dumps). Replay sanity: tokensOut error 0.0 on every day, snipe-tax
ratio at +1 s exactly 0.0618 every day (the Pons parameters did not change during
the month). Raw results: `docs/backtest-month-results.txt`; per-launch rows:
`docs/backtest-month-per-launch.csv.gz`. Scripts: `scripts/backtest/`.

## Market shape

Launch volume fell from ~5,100/day (end of September) to ~1,000/day (last week).
Mean number of taxed buyers in the +1 s second dropped from 1.3 to 0.4-0.8 mid-month
and rose back to 1.4-1.6 in the last week (more bots). Team-buy launches: ~290/day
early, ~170/day now.

## Month totals at 0.07 ETH, best preset (no TP, trail 50/20, SL 40, t/o 60, dump exit)

| Segment | n | first in block | last in block | mean/trade (first) | negative days (first) |
|---|---|---|---|---|---|
| all launches | 60,484 | −120.6 ETH | −272.7 | −0.0020 | 9 / 31 |
| any team buy | 9,022 | **+22.3 ETH** | −19.1 | +0.0025 | 10 / 31 |
| team buy ≥ 0.1 ETH | 4,989 | **+14.8 ETH** | −16.7 | +0.0030 | 7 / 31 |
| team buy ≥ 0.2 ETH | 3,882 | +11.4 ETH | −15.4 | +0.0029 | 8 / 31 |
| dev bought, no team | 37,744 | −82.3 | −177.2 | −0.0022 | – |
| nobody bought | 13,718 | −60.5 | −76.4 | −0.0044 | – |

Threshold: 0.05-0.15 ETH minimum team buy gives the same +0.003/trade; ≥ 0.5 ETH
collapses to +0.0006. Dev-buy size alone never reaches positive expectancy.

## Weekly walk-forward (fit on all previous weeks, test the next week)

Team ≥ 0.1: +0.0003, +0.0028, +0.0072, +0.0085, +0.0054 ETH/trade in the five test
weeks — positive every week, and the fitted preset was identical every week (no TP,
trailing 50/20, SL 40, timeout 60, dump exit). The video preset was negative in two
of five weeks for the broad team segment.

## Daily distribution (bootstrap over the month, 0.07 ETH)

| Signal | race win | P(losing day) | median day | p10 / p90 |
|---|---|---|---|---|
| team ≥ 0.1 (~161/day) | 100 % | 12 % | +0.44 ETH | −0.04 / +1.01 |
| | 75 % | 31 % | +0.19 | −0.28 / +0.74 |
| | 50 % | 58 % | −0.07 | −0.48 / +0.46 |
| any team (~291/day) | 100 % | 9 % | +0.67 | +0.04 / +1.48 |
| | 50 % | 49 % | +0.01 | −0.55 / +0.69 |

The three-day numbers were an unusually good stretch; over the month the per-trade
edge is about +4 % of size and it needs a high race win rate to stay positive.

## Operators

39,670 clusters, one factory with 5,123 launches (+14.3 ETH over the month at
0.07, 31 % win) and one toxic team-buy operator with 639 launches, 0 % win,
−4.2 ETH — which is why the nightly blacklist exists. Operator selection
walk-forward (≥ 5 prior launches, positive, ≥ 40 % win), trading their next week's
launches: +0.0033, −0.0014, +0.0098, +0.0015, +0.0115 ETH/trade; last week +1.66 ETH
on 144 trades. Operator selection carries a higher per-trade edge than the generic
fingerprint and is the layer the scout automates.

## What changes in the defaults

* Keep `team-buy-0.1` as the always-on play; the ≥ 0.05 variant adds trades at the
  same edge and can be enabled after the paper week.
* Operator blacklisting is not optional: one operator alone would have cost 4.2 ETH.
* Expectation to plan with: at 0.07 ETH, +0.3 to +0.5 ETH on a typical day *if* we
  win most races, with one losing day in roughly eight; scale by size.
