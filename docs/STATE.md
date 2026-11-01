# Current state (1 Nov 2026)

One page that says what runs, where every setting lives, how to check it and what we know.
Everything else in `docs/` is history or reference. Times in Beirut (UTC+2) unless marked UTC.

## What runs

| Piece | Where | State |
|---|---|---|
| Live sniper | Ohio box, host service `hood-sniper` (`/opt/hood/hoodsniper/.env.executor`) | **live**, mode `live`, branch `claude/loving-wozniak-z508mk` |
| PonsSniper contract | `0x476ffafaab21b6523d4701dd16748bfb1b5a4dc7` | owner = cold Phantom wallet `0x9b19…ba55`, 3 operator keys (generated on the box), treasury = the contract (profits compound), **max 0.005 ETH per buy, 0.02 ETH per hour** (raise = redeploy) |
| Block source | public sequencer feed `wss://feed.mainnet.chain.robinhood.com` (+ `delayed-feed`) | **blocked since 1 Nov ~07:00 UTC**: Cloudflare answers 403 "this source address range has been blocked … connecting in a manner intended to exceed or evade this feed service's limits"; the notice also forbids moving to new IP space, so no Elastic-IP swap. The sniper runs on the **RPC fallback**: `eth_getBlockByNumber(latest)` on the sequencer RPC every 97 ms (~50 ms behind the feed on average; skipped blocks are fetched by number), feed retried with a 1–10 min backoff; see "Feed outage" below |
| Indexer, tracker, agent, Postgres | Ohio box, compose (`hoodctl`) | running; indexer in logs mode (`INDEXER_MODE=logs`, `WS_NEW_HEADS=0`) to keep Alchemy usage low |
| Agent scout | compose `agent`, every 15 min | on (proposes operator plays; auto-approve needs ≥ 10 coins, ≥ 35 % wins, ≥ 0.002 ETH/snipe) |
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
| entry | first block of T+1 s (6.18 % tax), burst **40 sends 3 ms apart** from −120 ms before the boundary, deadline T+1 only; fee cap 0.2 gwei (chain price 0.02) | preset `burst`, `maxFeeGwei`; env `SNIPE_DEADLINE_SECONDS=1` | late fills (+7…+29 blocks) were all losses; denser spray for the same-block races; the 1 gwei cap made the gas preflight refuse a launch on 31 Oct |
| re-price | reserves re-read before the first send with whatever time is left (`REPRICE_LEAD_MS=250`) | env | helper-contract team buys reached the logs after the decision → SlippageExceeded reverts |
| size | bankroll mode, 0.002–0.003 ETH per buy (bankroll × 0.35 / 2) | `plays.preset.sizing`, set by `golive.sh live` | test size until live confirms the per-block model |
| exits | **trailing: arms at +20 % on sell value (≈ +30 % price), sells on a 15 % pullback**; **stop loss 20 %** (on sell value vs cost); timeout 60 s; dump exit on an exempt wallet's **transfer-out** (not on its sells) | `plays.preset` (`trailing`, `stopLossPct`, `timeoutSec`, `exitIfExemptSellsPct` empty) | per-block month: trail 30/15 (price) beats 50/20 in every window (+7.9 vs +6.1 month, +5.0 vs +4.5 last 10 days); stop 20 unchanged |
| team cool-off | 5 min after a loss, same team wallets skipped; survives a restart | env `TEAM_COOLOFF_MIN=5` | serial relaunches (TUSK ×5); backtest +1.1 ETH/month |
| entry cap | market cap ≤ 4.2 ETH after the launch second | preset `maxEntryMcapEth` | the graduation threshold |
| concurrency | 3 positions, one burst key each | env `MAX_CONCURRENT=3` | a 4th key is needed to raise it |

## Daily routine

An **epoch** (`hoodctl epoch now "why"`) makes `trades` / `race` / `pnl` / `status` count from a moment; set on 31 Oct 15:14 Beirut ("race fix live"). `hoodctl trades 3 all` shows every row.

```
hoodctl trades 1        # every run of the last 24 h with the note that explains it (abort reason, exit reading, decision latency)
hoodctl race 1          # where our sends landed vs the first T+1 block (race win rate)
sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh status   # service, feed, counters, kill, plays, bankroll
hoodctl health          # live sniper on :8090 (rpcFallback "ON (n blocks)" while the feed is blocked, feedUrl when it is back)
curl -s localhost:8090/healthz | jq '{ok, feed: .feed.currentUrl, fallback}'
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

## Feed outage (1 Nov)

From ~07:00 UTC both feed hosts refuse the box's handshake with HTTP 403 (Cloudflare, "source address
range blocked … intended to exceed or evade this feed service's limits"; the same notice says routing
new IP space is not permitted, so we do not rotate the IP: the sequencer RPC, which the bot also sends
through, is the next thing they would block). Before f39dd75 the bot only saw launches from the node's
logs 13–22 s late (one trade, HUNCH, decided 13.7 s late and lost). Since f39dd75 (deployed 07:27 UTC):

- the feed client backs off 1 min, doubling to 10, after a refused handshake instead of knocking every 5 s;
- while the feed is down for > 2 s the sniper polls `latest` on the sequencer RPC (`FEED_FALLBACK_POLL_MS`,
  default 97, deliberately not a multiple of the 100 ms seal grid, so the clock's boundary estimate is
  not phase-locked to the poll; `FEED_FALLBACK_AFTER_MS=2000`); blocks a slow poll skipped are fetched
  by number and delivered in order; the poller is off the moment the feed delivers a block again;
- `/healthz` stays `ok` on fallback blocks and shows `fallback: {active, polls, blocks, caughtUp, gaps, errors}`;
  `hoodctl health` checks the live unit on :8090 (not the compose paper sniper on :8084).

Cost in the race: the launch block arrives ~50 ms later on average than from the feed (0–97 ms), so a
launch in the last ~150 ms of its second may be decided too late for the first T+1 block; the rest are
unaffected. Public RPC load: ~10 requests/s. If the RPC also starts refusing (`fallback.errors` rising,
`hoodctl health` FAIL), the bot is blind: stop it (`hoodctl kill`) rather than let it enter on stale state.

## History of the fixes (30–31 Oct)

dump exit on transfers only (not team sells) · deadline T+1 · re-price before send (+ always, with whatever
time is left) · 600k gas · receipts and reserves raced via the sequencer RPC · reserve book that cannot
double count · 5-min team cool-off (restart-safe) · daily loss base = total bankroll, then removed ·
stop 40 → 20 · helper-contract buys as feed hints · exit-signal reading and abort reason in `hoodctl trades` ·
timestamps in `HOOD_TZ` · nightly auto-disable off · helper (0x6f49227e) and proxy (0x240acbf8) team buys decoded from the feed · burst 40 × 3 ms · fee cap 0.2 gwei · trailing 20/15 · epoch · (1 Nov) feed 403 backoff + RPC block fallback.
