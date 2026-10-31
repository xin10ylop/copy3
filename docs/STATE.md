# Current state (31 Oct 2026)

One page that says what runs, where every setting lives, how to check it and what we know.
Everything else in `docs/` is history or reference. Times in Beirut (UTC+2) unless marked UTC.

## What runs

| Piece | Where | State |
|---|---|---|
| Live sniper | Ohio box, host service `hood-sniper` (`/opt/hood/hoodsniper/.env.executor`) | **live**, mode `live`, branch `claude/loving-wozniak-z508mk` |
| PonsSniper contract | `0x476ffafaab21b6523d4701dd16748bfb1b5a4dc7` | owner = cold Phantom wallet `0x9b19…ba55`, 3 operator keys (generated on the box), treasury = the contract (profits compound), **max 0.005 ETH per buy, 0.02 ETH per hour** (raise = redeploy) |
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
| entry | first block of T+1 s (6.18 % tax), burst 16 sends 8 ms apart from −120 ms before the boundary, deadline T+1 only | preset `burst`, env `SNIPE_DEADLINE_SECONDS=1` | late fills (+7…+29 blocks) were all losses; the backtest only ever enters at T+1 |
| re-price | reserves re-read before the first send with whatever time is left (`REPRICE_LEAD_MS=250`) | env | helper-contract team buys reached the logs after the decision → SlippageExceeded reverts |
| size | bankroll mode, 0.002–0.003 ETH per buy (bankroll × 0.35 / 2) | `plays.preset.sizing`, set by `golive.sh live` | test size until live confirms the per-block model |
| exits | trailing +50 % / −20 %, **stop loss 20 %** (on sell value vs cost), timeout 60 s, dump exit on an exempt wallet's **transfer-out** (not on its sells) | `plays.preset` (`trailing`, `stopLossPct`, `timeoutSec`, `exitIfExemptSellsPct` empty) | the backtest's exits; stop 20 rated best in the per-trade sweep, stays until the per-block refit says otherwise (it found nothing better) |
| team cool-off | 5 min after a loss, same team wallets skipped; survives a restart | env `TEAM_COOLOFF_MIN=5` | serial relaunches (TUSK ×5); backtest +1.1 ETH/month |
| entry cap | market cap ≤ 4.2 ETH after the launch second | preset `maxEntryMcapEth` | the graduation threshold |
| concurrency | 3 positions, one burst key each | env `MAX_CONCURRENT=3` | a 4th key is needed to raise it |

## Daily routine

```
hoodctl trades 1        # every run of the last 24 h with the note that explains it (abort reason, exit reading, decision latency)
hoodctl race 1          # where our sends landed vs the first T+1 block (race win rate)
sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh status   # service, feed, counters, kill, plays, bankroll
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
Re-evaluated per block (exits checked after each block, the sell landing one block later):

| our rule, first in block, 0.07 ETH buys | month |
|---|---|
| per-trade (the original figure) | +25.2 ETH |
| per-block, realistic | **+4.8 ETH** (bounds +4.6 … +5.8) |
| per-block, last 10 days of the window (19–28 Oct) | +5.0 ETH (≈ +0.5/day) |

Per-block walk-forward refit of the exits found nothing better than the current preset out of sample.
Buy size: return per trade falls with size (1.66 % at 0.07, 1.35 % at 0.2, 0.65 % at 0.5); the useful
top is 0.2–0.3 ETH per buy on this data.

**Race.** 20 of 33 live sends first in block (61 %). Losses: 3 to a faster bot in the same block, 10 to
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

Realistic expectation at 0.07 per buy: first in block ≈ +0.5 ETH/day at ~90 launches/day; × ⅓ at the
current race rate; × volume/90. Not the +24.7 ETH/month quoted before 31 Oct.

## Open work

1. Measure the race after 4c7451b (`decided … ms` notes, `hoodctl race`); a decision later than ~600 ms lands late.
2. Confirm the per-block model on a few live days before sizing up; then redeploy the contract with a higher `maxQuoteIn` and a 4th key.
3. Rotate the Alchemy and Anthropic keys (the current ones were pasted in chat).
4. Keep counting qualifying launches per day; if the market stays at 20–40/day, size expectations to it.

## History of the fixes (30–31 Oct)

dump exit on transfers only (not team sells) · deadline T+1 · re-price before send (+ always, with whatever
time is left) · 600k gas · receipts and reserves raced via the sequencer RPC · reserve book that cannot
double count · 5-min team cool-off (restart-safe) · daily loss base = total bankroll, then removed ·
stop 40 → 20 · helper-contract buys as feed hints · exit-signal reading and abort reason in `hoodctl trades` ·
timestamps in `HOOD_TZ` · nightly auto-disable off.
