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
