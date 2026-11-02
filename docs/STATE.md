# Current state (1 Nov 2026)

One page that says what runs, where every setting lives, how to check it and what we know.
Everything else in `docs/` is history or reference. Times in Beirut (UTC+2) unless marked UTC.

## What runs

| Piece | Where | State |
|---|---|---|
| Live sniper | Ohio box, host service `hood-sniper` (`/opt/hood/hoodsniper/.env.executor`) | **live**, mode `live`, branch `claude/loving-wozniak-z508mk` |
| PonsSniper contract | `0x476ffafaab21b6523d4701dd16748bfb1b5a4dc7` | owner = cold Phantom wallet `0x9b19…ba55`, 3 operator keys (generated on the box), treasury = the contract (profits compound), **max 0.005 ETH per buy, 0.02 ETH per hour** (raise = redeploy) |
| Block source | public sequencer feed `wss://feed.mainnet.chain.robinhood.com` (+ `delayed-feed`) | **blocked since 1 Nov ~07:00 UTC**: Cloudflare answers 403 "this source address range has been blocked … connecting in a manner intended to exceed or evade this feed service's limits"; the notice also forbids moving to new IP space, so no Elastic-IP swap. The sniper takes blocks from **public-RPC `newHeads` websockets** (globalstake, publicnode, bloXroute; `FEED_HEADS_WSS`): every block pushed ~70 ms after sealing, full block fetched over the same socket (~100 ms behind the feed in all); Robinhood's own public RPC is NOT usable for this (its `latest` moves in ~500 ms batches, ≥ 650 ms late). The feed is retried with a 1–10 min backoff and takes over again the moment it delivers; see "Feed outage" below |
| Indexer, tracker, agent, Postgres | Ohio box, compose (`hoodctl`) | running; indexer in logs mode (`INDEXER_MODE=logs`, `WS_NEW_HEADS=0`). **No Alchemy since 2 Nov**: HTTP reads on Robinhood's official RPC (no log-result cap, 100 curves × 2000 blocks in ~170 ms), log subscriptions on publicnode's WS (Robinhood's RPC has no WS). Override: `NODE_HTTP_URL`, `NODE_WS_URL` in `.env.ohio`. The host sniper (golive.sh) reads on globalstake HTTP (publicnode rejects the live gate's eth_estimateGas with "Invalid parameters") and subscribes to logs on publicnode WS (`SNIPER_NODE_HTTP`, `SNIPER_NODE_WS` to override); Alchemy is off its send list |
| Agent scout | compose `agent`, every 15 min | on, proposals only. **Auto-approve off** since 1 Nov (DB `settings.auto_approve.enabled = false`): its stats are per-trade backtests (≈ 5× too optimistic) and an approved play would compete for the 3 burst keys. Re-enable only after a per-block check of the play |
| Agent nightly refit / auto-disable / blacklist | compose `agent` | **off** (`NIGHTLY_HOUR_UTC=-1` in `.env.ohio`). It disabled the live play on 31 Oct 03:00 UTC on pre-fix losses. Turn on only with a known-good rolling window |
| Paper sniper | compose | off (`PAPER_SNIPER=0`); one sniper per database |
| Telegram | compose profile | off, not wanted |
| Daily loss limit | DB `settings.daily_loss_limit_pct` | **100 % = off** (removed 31 Oct; it blocked two trades worth +0.0006 ETH) |
| Kill switch | DB `settings.kill_switch` | off (`hoodctl kill "why"` / `hoodctl resume`) |

## The one enabled play

DB row `plays.name = 'team-buy-0.1'` (the name is historical: the seed created it with 0.1; renaming
it would make the next bootstrap's seed create a second, enabled `team-buy-0.1`, so the name stays).

| Setting | Value | Where | Why |
|---|---|---|---|
| trigger | team buys ≥ **0.02 ETH** from ≥ **2** tax-exempt non-deployer wallets in the launch second | `plays.trigger.launchSecond` (`minTeamBuyEth`, `minTeamBuyers`) | 30-day backtest: 0.02 + 2 wallets is the only widening that adds launches without losing; single-wallet teams and dev-only launches lose |
| idle exempt | **≥ 1 exempted wallet (SnipeTaxExempted, deployer excluded) did not buy in the launch second** | `plays.trigger.launchSecond.minIdleExempt` | every exempted wallet buying at once is the bundle that dumps within seconds. Corrected month: 0 idle −0.9 %/trade (26 % quick dumps), ≥ 1 idle +15.3 %/trade, 55 % wins, a quarter of the trades. Out of sample (31 Oct – 2 Nov, 54 launches): 0 idle −7.5 %/trade with all 16 quick dumps, ≥ 1 idle +19.3 %/trade, 71 % wins. Our own 43 live buys: kept 15 → 10 wins, +19.3 %; skipped 28 → 3 wins, −10.5 % (all HF, every quick dump) |
| stake by idle | **idle 1–3 → ½ stake, 4–9 → 1¼, 10+ → 2×** (after the bankroll/fixed size, before the contract cap) | `plays.preset.sizing.idleTiers` | 2 Nov, month + holdout per block, lag 6, after costs: same total stake (mean ×0.99), +28 % profit (+63 % since 18 Oct), worst day −430 → −308, walk-forward +12.8 → +15.5 % per unit staked, 100 % of day bootstraps better. Idle 2–3 lost money in 3 of 7 windows, 10+ won in all. At 0.05 ETH stakes the top tier buys 0.1 ETH: redeploy with `MAX_QUOTE_IN_ETH=0.1` or the contract cap clamps it. `golive.sh live` merges into `sizing` (keeps the tiers) |
| entry | first block of T+1 s (6.18 % tax), burst **40 sends 3 ms apart** from −120 ms before the boundary, deadline T+1 only; fee cap 0.2 gwei (chain price 0.02) | preset `burst`, `maxFeeGwei`; env `SNIPE_DEADLINE_SECONDS=1` | late fills (+7…+29 blocks) were all losses; denser spray for the same-block races; the 1 gwei cap made the gas preflight refuse a launch on 31 Oct |
| re-price | reserves re-read before the first send with whatever time is left (`REPRICE_LEAD_MS=250`) | env | helper-contract team buys reached the logs after the decision → SlippageExceeded reverts |
| size | bankroll mode, 0.002–0.003 ETH per buy (bankroll × 0.35 / 2) | `plays.preset.sizing`, set by `golive.sh live` | test size until live confirms the per-block model |
| exits | **trailing: arms at +20 % on sell value (≈ +30 % price), sells on a 15 % pullback**; **stop loss 20 %** (on sell value vs cost); timeout 60 s; dump exit on an exempt wallet's **transfer-out** (not on its sells) | `plays.preset` (`trailing`, `stopLossPct`, `timeoutSec`, `exitIfExemptSellsPct` empty) | per-block month: trail 30/15 (price) beats 50/20 in every window (+7.9 vs +6.1 month, +5.0 vs +4.5 last 10 days); stop 20 unchanged |
| team cool-off | 5 min after a loss, same team wallets skipped; survives a restart | env `TEAM_COOLOFF_MIN=5` | serial relaunches (TUSK ×5); backtest +1.1 ETH/month |
| loss-streak pause | **4 losses in a row → no new entries for 10 min**; a win resets the count; survives a restart | env `LOSS_STREAK_PAUSE=4`, `LOSS_STREAK_PAUSE_MIN=10` | 1 Nov: "HF" relaunched 7× in 29 min with a fresh deployer and fresh team wallets each time (the wallet cool-off cannot see it), each −8 to −10 %. Month, per block (`scripts/backtest/pause_rules.py`): +16 % (12.0 → 14.0 per 0.1 ETH buy), better than no pause in every week, 20 days better vs 6 worse, both halves, low-volume days too. Pause after 2 losses: helps the first half, loses the second. Blocking a symbol after a loss: neutral (81 same-symbol clusters in the month; their relaunches net ≈ 0 because PRVO 6/7, KMA 5/6, SLEEV 6/6 won) |
| entry cap | market cap ≤ 4.2 ETH after the launch second | preset `maxEntryMcapEth` | the graduation threshold |
| concurrency | 3 positions, one burst key each | env `MAX_CONCURRENT=3` | a 4th key is needed to raise it |

## Daily routine

An **epoch** (`hoodctl epoch now "why"`) makes `trades` / `race` / `pnl` / `status` count from a moment; set on 31 Oct 15:14 Beirut ("race fix live"). `hoodctl trades 3 all` shows every row.

```
hoodctl trades          # every run since the epoch with the note that explains it (abort reason, exit reading, decision latency); `hoodctl trades 1` = last 24 h
hoodctl race 1          # where our sends landed vs the first T+1 block (race win rate)
sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh status   # service, feed, counters, kill, plays, bankroll
hoodctl health          # live sniper on :8090: blocks per source, heads sockets up, rpcFallback (should be "off")
curl -s localhost:8090/healthz | jq '{ok, feed: .feed.currentUrl, blocks, heads, fallback}'
```

Qualifying launches per day (the market's volume; the strategy's income is proportional to it):
`scripts/backtest/daily_count.sql` — `hoodctl psql -f` is not available, paste the query into `hoodctl psql -c "…"`.

Update the box to the pushed branch (rebuilds the compose image, restarts compose; then the live sniper):
```
sudo bash /opt/hood/hoodsniper/infra/ohio/bootstrap.sh && sudo systemctl restart hood-sniper
```
Change a setting without a restart: plays and settings are read from the DB on change (NOTIFY);
`.env.executor` changes need `sudo systemctl restart hood-sniper`; `.env.ohio` changes need `hoodctl compose up -d <service>`.

## What we know (numbers)

**The 30-day backtest (28 Sep – 28 Oct) was evaluated per trade; the bot can only act per block.**
Re-evaluated per block (exits checked after each block, the sell landing one block later), **in the
bot's own units** (sell value vs cost, as `hoodctl trades` prints it; the simulator's rules were checked
against `position-logic.ts` on 31 Oct):

| our rule, first in block, 0.07 ETH buys | month | last 10 days | low-volume days (≤ 60 launches) | high-volume days |
|---|---|---|---|---|
| original exits (trail 50/20, stop 40 on price), per trade | +25.2 ETH | | | |
| original exits, per block | +4.8 ETH | | | |
| **current exits (trail arm 20 / drop 10, stop 20, timeout 60, dump exit), per block** | **+8.9 ETH**, 41 % wins, 8 losing days of 31 | **+5.0 ETH** | **+0.17 / day** | **+0.31 / day** |

Stop 20–30 are within noise of each other (20 best on the last 10 days and on low-volume days); no stop is
worse. Team threshold 0.15–0.2 raises the win rate to 48–50 % and cuts losing days to 5–6, but costs 40 %
of the low-volume-day result, so 0.02 stays. Later entries (survivors at +10…+30 s) and post-dump entries
lose in every variant: on this launchpad the only positive-expectation entry is the first block after the
tax drops, on team launches. Chain-replay numbers quoted per launch with a price-based stop are looser
than the bot (a 20 % stop on sell value ≈ a 10 % stop on price); use `scripts/backtest/audit_trades.py`
(bot units) for any live-vs-model comparison.

**Race.** Before the fix: 20 of 33 live sends first in block (61 %). After it (31 Oct, from 15:14 Beirut): decisions in 24–200 ms (helper and proxy buys decoded from the feed), first in block 6 of 7. Losses: 3 to a faster bot in the same block, 10 to
late decisions (helper-contract team buys were only known from node logs 300–1 100 ms after the launch).
The backtest's edge is very race-sensitive: ≈ first-in-block value × ⅓ at 61 %. Fix shipped 31 Oct
(4c7451b): helper buys decoded from the feed; `hoodctl trades` notes "decided N ms after the launch
block arrived" — the number to watch.

**Volume.** Qualifying launches per day: 56–116 in the backtest's last ten days; 58 on 29 Oct, 35 on 30 Oct,
~20 on 31 Oct (Saturday). Weekends are the low days; every dip in the month recovered within two days.
No filter widening adds volume at the same quality except 0.02 + 2 wallets (applied).

**Live vs backtest (30 Oct, 40 runs replayed from the chain, per block):** live −0.0066 ETH; with all fixes at
our real race positions +0.0009; backtest rule at our positions +0.0010; first in block +0.0034.
The four trades run on the fixed code (TUSK 21:14, ENGINE, BELIEF, APPLE) match the backtest row for row.

Realistic expectation at 0.07 per buy, current exits: first in block ≈ +0.3 ETH/day on busy days (~90 launches), ≈ +0.17 on thin days; × the race rate (≈ 85 % after the 31 Oct fixes); not the +24.7 ETH/month quoted before 31 Oct.

## Open work

1. Measure the race after 4c7451b (`decided … ms` notes, `hoodctl race`); a decision later than ~600 ms lands late.
2. Confirm the per-block model on a few live days before sizing up; then redeploy the contract with a higher `maxQuoteIn` and a 4th key.
3. Rotate the Alchemy and Anthropic keys (the current ones were pasted in chat).
4. Keep counting qualifying launches per day; if the market stays at 20–40/day, size expectations to it.

## Send endpoints (1 Nov)

CABAL 21:11 and ASHEN 22:20: the first burst member left −130 / −19 ms before the T+1 boundary to
both send endpoints (Robinhood RPC, Alchemy) and was included 1.5–1.8 s later (Expired), while two
other bots' buys landed in the first T+1 block; the account nonce matched (no gap), base fee 0.02 gwei
(cap 0.2), and the blocks before ours carried 57–98 txs after a steady ~33 (a forwarding backlog
released at once). Burst members carry consecutive nonces, so a late member 0 holds the whole burst.
`SEND_ENDPOINTS` now also fans out to the sequencer itself (`sequencer.mainnet.chain.robinhood.com`,
send-only: it refuses reads, so it is never first — the first endpoint serves RTT and nonce reads),
bloXroute and globalstake. Every member goes to every endpoint concurrently; the fastest path wins.

## The month backtest had a data bug (found 1 Nov)

`transfers.json` of the month dataset covered every token only for 28 Sep – 1 Oct; from 2 Oct on only
19–71 % (the fetch skipped batch items that came back with an error, without retrying: fixed in
`scripts/backtest/fetch_timestamps_transfers.py`). Those launches had no team-dump events, so the
simulated bot held through dumps the real bot exits on (one launch: +371 % in the dataset, −0.7 % on
the chain). Rebuilt from chain transfer logs for all 4 646 qualifying launches (928 changed) and
validated against an independent chain replay of 26 and 27 Oct (identical, launch by launch):

| | per trade | month (per 0.1 ETH buy) |
|---|---|---|
| old dataset | +3.10 % | +12.0 |
| corrected | +2.52 % | +9.8 |
| corrected, trailing 20/10 instead of 20/15 | | +12.6 (better in both halves) |

The edge is real in the corrected month but concentrated in 15–28 Oct (≈ +10 %/trade); 28 Sep – 14 Oct
≈ +0.8 %. From the chain, every qualifying launch, live rule: 29 Oct −0.6 %, 30 Oct +0.6 %, 31 Oct –
1 Nov −2.2 % per trade; the live bot's own trades match that replay within ~1.4 points. So the fade is
in the market (qualifying launches/day also fell from ~100 to ~30), not in the bot.

The loss-streak pause (4 → 10 min) is about neutral on corrected data (+14 % month, second half −0.1).
Operator keys from deployer funding (traced for all month deployers): the big funding routes are public
services (`0xe68d0bbc…` funded 603 launches by 600 deployers), not operators; no key worth building.



From ~07:00 UTC both feed hosts refuse the box's handshake with HTTP 403 (Cloudflare, "source address
range blocked … intended to exceed or evade this feed service's limits"; the same notice says routing
new IP space is not permitted, so we do not rotate the IP: the RPC the bot sends through is the next
thing they would block). Before f39dd75 the bot only saw launches from the node's logs 13–22 s late
(one trade, HUNCH, decided 13.7 s late and lost).

**Block sources now** (all deliver through one ordered gate, `block-gate.ts`; the first with a block owns it):

| Source | Lag of the first block of a second (measured 1 Nov) | Role |
|---|---|---|
| sequencer feed (`FEED_URL`) | ~20–40 ms | primary; 403 since 1 Nov, retried with a 1–10 min backoff, takes over the moment it delivers |
| public-RPC `newHeads` sockets (`FEED_HEADS_WSS`: globalstake, publicnode, bloXroute) | head ~70 ms + one fetch ~30–45 ms | **what runs now**; a block the feed delivered is never fetched, so it costs nothing while the feed works |
| RPC poll of `FAST_RPC[0]` (drpc) every 97 ms | ~90–160 ms | last resort, on only after 2 s without a block from the others (`fallback.active`) |
| Robinhood public RPC `latest` | **≥ 650 ms** (updates in ~500 ms batches) | not a block source any more; still the send endpoint and raced for receipts |

Ledger side effect (fixed in 48cc230): with no block stream the ledger counted every exempt-wallet
buy of the next 13–21 s as a launch-second team buy (TRADECRAFT 09:00/09:02 decided on team buys the
chain doesn't have; both aborted as too late). A late log with an unknown block timestamp is now looked
up before it counts (`ledger_ts_lookups` on /healthz).

DWRK 14:52 (fixed in the commit after 48cc230): one helper tx bought 0.725 ETH for 5 team wallets;
the trigger matched at its 2nd node log and the minimum was priced on 2 of the 5 buys, so all 4 sends
landed but reverted (SlippageExceeded, out 0.529 M < min 0.568 M; the trade would have lost 11 % to the
dump exit). Now a tx known from some of its logs has its receipt fetched (all logs at once) before
pricing and again at the re-price, the re-price reads the ledger after its RPC await, and a 'latest'
reserves read takes the most advanced fast endpoint instead of the first (Robinhood's RPC answers first
from Ohio but is ≥ 650 ms stale).

First trades on the heads source: CAGEBOUT 14:06 and PITSWAN 14:20, decided 110 / 99 ms, first in
block, −8.2 % / −10.0 % at the timeout; the chain replay of the live rule gives −8.0 % / −9.8 %.

Cost in the race: the launch block arrives ~100 ms later than from the feed, so a launch in the last
~0.1–0.2 s of its second may be decided too late for the first T+1 block; the rest are unaffected
(`hoodctl trades` prints "decided N ms after the launch block arrived (source)"). Load on the public
nodes: 3 subscriptions + ~10 block fetches/s on one of them. If every socket is down (`heads.connected`
0) the poller takes over; if that also errors (`fallback.errors` rising) the bot is blind: `hoodctl kill`.

## History of the fixes (30–31 Oct)

dump exit on transfers only (not team sells) · deadline T+1 · re-price before send (+ always, with whatever
time is left) · 600k gas · receipts and reserves raced via the sequencer RPC · reserve book that cannot
double count · 5-min team cool-off (restart-safe) · daily loss base = total bankroll, then removed ·
stop 40 → 20 · helper-contract buys as feed hints · exit-signal reading and abort reason in `hoodctl trades` ·
timestamps in `HOOD_TZ` · nightly auto-disable off · helper (0x6f49227e) and proxy (0x240acbf8) team buys decoded from the feed · burst 40 × 3 ms · fee cap 0.2 gwei · trailing 20/15 (20/10 recommended 1 Nov, corrected month) · epoch · (1 Nov) feed 403 backoff · blocks from public-RPC newHeads sockets + RPC poll as last resort · late ledger logs timestamp-checked · auto-approve off.
