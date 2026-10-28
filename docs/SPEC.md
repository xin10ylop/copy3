# SPEC – contracts between packages/services

All code TypeScript (ES2022, `"type": "module"`, strict), Node 22, pnpm workspaces.
Shared deps: `viem` (EVM), `ws` (websocket), `postgres` (postgres.js), `zod`
(config validation), `pino` (logging), `vitest` (tests), `@electric-sql/pglite`
(tests only), `@anthropic-ai/sdk` (agent), `grammy` (telegram).
Each package: `src/`, `test/`, `package.json` with `build` (tsc), `test` (vitest run),
`typecheck`. Root scripts run them across the workspace. Lint = `tsc --noEmit`.

## 1. packages/core (`@hood/core`)

* `addresses.ts` – every address from RESEARCH §3, lower-cased, as `const`.
* `abis/` – viem human-readable ABIs: `curveAbi`, `factoryAbi`, `routerAbi`,
  `tokenAbi`, `sniperAbi` (helper contract), event-only `ponsEventsAbi`.
* `feed/decoder.ts` – `decodeFeedFrame(text) → FeedBlock[]` where
  `FeedBlock = { block: number, timestamp: number, txs: DecodedTx[], receivedAt: number }`,
  `DecodedTx = { hash, from (recovered lazily), to, value, nonce, input, selector, raw }`.
  Must handle kinds 3 (batch of 4), 4, 0/1 (ignore), compressed 7 (skip + log).
  Sender recovery (`recoverTransactionAddress`) only on demand (hot path filters by
  `to`/selector first). Unit tests use the captured frame in `test/fixtures/`.
* `pons/launch.ts` – `parseLaunchCall(tx) → LaunchCall | null` (selectors
  `f35abbcf`, `a72101af`, `d6a0eef5`, `f85f8e41`; returns name, symbol, logo,
  creatorFeeRecipient, creatorTaxBps, exemptions, pairToken, launchConfigId,
  devBuyQuoteIn (router), deployer (explicit for `launchTokenFor`, else tx.from)).
  `parseTokenLaunchedLog(log)`, `parseCurveTradeLog(log)`.
* `pons/curve.ts` – pure math: `priceFromReserves`, `mcapFromReserves(quote, token)`
  (`supply = 1e9`), `snipeTaxBps(elapsedSec, startBps=9900, seconds=3)`,
  `quoteBuy(reserves, quoteIn, feeBps, taxBps) → tokensOut`,
  `quoteSell(reserves, tokensIn, feeBps) → quoteOut`, `minOutWithSlippage`.
* `pons/addresses.ts` – `predictLaunchAddresses(deployerNonce) → {token, curve}`
  (CREATE formula) + a test against the measured launch in RESEARCH §3.
* `clock.ts` – `SequencerClock`: feeds `(blockTimestamp, localArrivalMs)`; exposes
  `predictBoundaryMs(ts)` = local wall-clock ms at which the sequencer clock ticks
  to `ts`, using min-filtered offsets; `burstSchedule(launchTs, preset.burst)`.
* `types.ts` – `Play`, `PlayTrigger`, `Preset`, `ArmedCandidate`, `Snipe`,
  `Position` zod schemas (see §4) and inferred types.
* `eth.ts` – `makeClients(env)` → viem public (http+ws) clients for node + public RPC.

## 2. packages/db (`@hood/db`)

`migrations/0001_init.sql` … applied by `pnpm db:migrate` (simple runner that
records applied files in `schema_migrations`). `createDb(url)` returns
`postgres.Sql`. `test/pglite.ts` runs the same SQL on PGlite for unit tests.

Tables (snake_case, timestamps `timestamptz`, addresses `text` lower-case,
wei amounts `numeric(78,0)`, prices `double precision` in ETH units):

```
launches(token pk, curve, deployer, launcher (tx.to), launch_kind ('launchToken'|'launchAndBuy'|'launchTokenFor'; a dev buy = dev_buy_quote > 0), creator_fee_recipient, creator_tax_bps,
         name, symbol, logo, pair_token, launch_config_id, graduation_threshold numeric, exemptions text[],
         dev_buy_quote numeric, block bigint, ts, tx_hash, tx_from, start_price, start_mcap_eth,
         graduated bool default false, created_at)
curve_trades(id bigserial pk, token, curve, block, ts, tx_hash, log_index, side ('buy'|'sell'),
         trader (CurveBuy.buyer/seller), recipient, tx_from, quote numeric, tokens numeric, fee numeric, tax numeric,
         price_after double, seconds_since_launch int, exempt bool, unique(tx_hash, log_index))
token_metrics(token pk, first_taxed_buyer, first_taxed_ts, first_taxed_block, first_taxed_price, first_taxed_mcap_eth,
         tax_free_buy_count int, tax_free_quote numeric, ath_price, ath_ts, ath_mcap_eth,
         peak2_pct, peak5_pct, peak10_pct, peak30_pct, peak60_pct, mcap2, mcap5, mcap10, mcap30, mcap60,
         low_after_entry_pct (max drawdown within 60 s), n_buys_60s, n_sells_60s, exempt_sold_within_sec,
         dump_wallets text[], operator_sell_eth double (ETH), updated_at)
token_transfers(id bigserial pk, token, block, ts, tx_hash, log_index, from_addr, to_addr, value numeric, unique(tx_hash, log_index))
eth_transfers(id bigserial pk, block, ts, tx_hash, trace_addr text, from_addr, to_addr, value numeric,
         kind ('tx'|'internal'|'create'), unique(tx_hash, trace_addr))
wallets(address pk, first_seen_block, first_seen_ts, first_funder, first_funding_value numeric, first_funding_tx,
         is_contract bool, tx_count_at_first_funding int, labels jsonb default '{}')
operators(id serial pk, name, notes, status ('candidate'|'active'|'retired'), created_by, created_at)
plays(id serial pk, operator_id, name, enabled bool, trigger jsonb, preset jsonb, created_by, created_at, updated_at,
         stats jsonb default '{}')
armed_candidates(id bigserial pk, play_id, wallet, source_funder, funded_value numeric, funded_tx, armed_at,
         expires_at, status ('armed'|'fired'|'expired'|'disarmed'), unique(play_id, wallet))
snipes(id bigserial pk, play_id, token, curve, decided_at, decision jsonb, mode ('live'|'paper'),
         burst jsonb (array of {nonce, hash, sentAt, endpoint, status, block, ts}), buy_block, buy_ts, quote_in numeric,
         tokens_out numeric, tax_paid numeric, entry_price double, status ('pending'|'open'|'closed'|'failed'|'aborted'),
         sells jsonb, realized_pnl_eth double, closed_at, notes text)
feed_blocks(block pk, ts, arrival_ms bigint, n_txs int)       -- clock calibration + latency stats
agent_runs(id bigserial pk, kind ('play'|'scout'|'backtest'), input jsonb, report_md text, csv_path text,
         proposed_play jsonb, cost_usd double, created_at)
settings(key pk, value jsonb)                                   -- kill switch, daily loss, eth_usd
events(id bigserial pk, ts, level, source, type, payload jsonb)  -- everything notable; telegram tails this
```
NOTIFY channels: `plays_changed`, `armed_changed`, `snipe_events`, `settings_changed`.

## 3. Services

### indexer
Env: `NODE_WS`, `NODE_HTTP`, `DATABASE_URL`, `START_BLOCK` (backfill from),
`TRACE_INTERNAL=1`. Subscribes `newHeads` + `logs` for factory/router topics and
all `CurveBuy/CurveSell/SnipeTax*` topics (filter by topic only, any address);
for each block also scans txs for ETH value transfers; traces (callTracer) any
value-carrying tx whose `to` has code or that creates a contract, to extract
internal transfers. Maintains `token_metrics` incrementally (peaks relative to
first taxed buyer; `exempt` = recipient in launch exemptions ∪ deployer ∪
creator_fee_recipient). Backfill command: `pnpm indexer backfill --from <block>`
using `eth_getLogs` in ranges (public RPC allowed ranges of 20k blocks worked).

### tracker
Env: `DATABASE_URL`. Listens to new `eth_transfers`; for every enabled play with
`trigger.armedWallet`, if `from ∈ funders` (or `from` is a contract created in the
same tx by a funder – "contract mode"), `value ∈ [minEth,maxEth]`, and the
recipient is fresh (`wallets.tx_count_at_first_funding == 0` and no prior
transfers) when `freshOnly`, insert `armed_candidates` (expires after
`maxAgeSec`, default 48 h) and NOTIFY. Also writes `wallets` rows and funder
graph helpers (`fundingPath(wallet, depth)`).

### sniper (hot path)
Env: `FEED_URL`, `FEED_URL_SECONDARY`, `NODE_WS`, `SEND_ENDPOINTS` (comma list,
first = primary), `DATABASE_URL`, `EXECUTOR_PRIVATE_KEYS`, `SNIPER_CONTRACT`,
`EXECUTION_MODE=live|paper`, `MAX_GAS_PRICE_GWEI`, `DAILY_LOSS_LIMIT_ETH`.
Loop: feed frame → decode → for each tx: if launch call → build `LaunchEvent`
(+ predicted addresses) → `rules.evaluate(event)` → if match and risk checks
pass → `executor.burst(plan)`; on `TokenLaunched` log from node (ws) confirm
addresses or trigger if feed missed it. Position manager: after `Sniped`, every
new block compute price from `getReserves` (multicall) and feed trades; sell via
`PonsSniper.exit(curve, token, tokensIn, minOut)` when TP/trailing/SL/timeout or
when an exempt wallet sells ≥ X % of its holding (configurable). All decisions
and tx hashes written to `snipes`; NOTIFY `snipe_events`.
Paper mode: identical path, but instead of sending it records the planned burst
and simulates fill at the first `T+1` block's post-trade price with 618 bps tax.

### agent
Env: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `NODE_HTTP`, `REPORTS_DIR`.
`claude-opus-5-5`, adaptive thinking, effort `high`, streaming, tool runner with
`betaZodTool`, server-side fallbacks on. Tools: `get_token`, `get_trades`,
`get_token_metrics`, `get_wallet`, `get_wallet_funding` (incoming transfers +
depth-N path), `get_wallet_outgoing`, `list_tokens_by_deployer`,
`list_tokens_by_name` (regex), `list_recent_launches`, `list_runners` (filters on
peaks), `get_wallet_trades`, `backtest_play(trigger, preset, since)`,
`write_report(md)`, `write_csv(rows)`, `propose_play(play)`, `eth_usd()`.
CSV columns (match the video): `ca, dev_wallet, name, symbol, start_mcap_usd,
ath_mcap_usd, launch_time_utc, launch_time_et, tax_free, tax_free_buyers,
first_taxed_buyer, first_taxed_mcap_usd, p2_pct, p2_mcap, p5_pct, p5_mcap,
p10_pct, p10_mcap, p30_pct, p30_mcap, p60_pct, p60_mcap, funded_by, funded_eth,
launch_kind, dev_buy_eth, notes`.
Modes: `play <ca>` (unravel operator, report + CSV + proposed play),
`scout` (every N min: launches in the last window with `peak10_pct ≥ 100`, group
by funder/deployer fingerprint, unravel new operators, propose plays),
`backtest <play_id>` (expected PnL per snipe, win rate, best TP/trailing grid).
System prompt = the hunting method from the video (funding trail, exempt
wallets, first taxed buyer entry, peaks, decoys, sprayer contract mode) +
hard rule: never assert a link without an on-chain transfer path.

### telegram
Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `DATABASE_URL`. Commands:
`/play <ca>`, `/scout`, `/plays`, `/play_on <id>`, `/play_off <id>`,
`/watch <funder> <min> <max> [fresh] [play]`, `/armed`, `/positions`, `/pnl`,
`/kill` (global off), `/resume`, `/preset <play_id> key=value…`, `/status`.
Inline approve/reject buttons for proposed plays; notifications for armed,
snipe sent/filled/closed, errors, daily summary.

## 4. Config shapes (zod in core/types.ts)

```ts
Preset = {
  buyEth: number,              // 0.07
  maxTaxBps: number,           // 1000 (= "tax protection 10 %")
  slippageBps: number,         // 8000-9000 like the video; we default 3000 + impact-aware minOut
  burst: { startMs: number, spacingMs: number, count: number },   // -120, 15, 10
  gasLimit: number, maxFeeGwei: number, priorityFeeGwei: number,
  stopAfter: number,           // 1
  firstBuyOnly: boolean, tokenCap: boolean,
  takeProfits: { pct: number, sellPct: number }[],   // default [] (no fixed TP; backtested, see docs/BACKTEST.md)
  trailing: { activatePct: number, dropPct: number } | null, // default {50, 20}; null = off
  stopLossPct: number,         // 40
  timeoutSec: number | null,   // default 60; null = off
  minQuoteReserveEth?: number, maxEntryMcapEth?: number,
  abortIfExemptSellInLaunchBlock: boolean,
  exitIfExemptSellsPct: number | null,  // default 0 = exit on the first exempt transfer-out/sell; null = off
  sizing: { mode: 'fixed'|'bankroll', fraction: number, minEth: number, maxEth: number }
                               // default fixed (buyEth); bankroll = clamp(balance × fraction / MAX_CONCURRENT, min, max)
}
PlayTrigger = {
  armedWallet?: { funders: string[], minEth: number, maxEth: number, freshOnly: boolean, maxAgeSec: number, contractMode: boolean },
  deployerIn?: string[],
  teamWalletsAny?: string[],      // match launch exemptions ∪ creatorFeeRecipient
  nameRegex?: string, symbolRegex?: string,
  launchKind?: 'any'|'noDevBuy'|'devBuy',
  minDevBuyEth?: number, maxDevBuyEth?: number,
  launchSecond?: { minTeamBuyEth?, maxTeamBuyEth?, minTeamBuyers?, minDevBuyEth?, maxDevBuyEth?, requireNoDevBuy? },
                               // team/dev buys in the launch second; always AND; alone only when it demands ETH
  deployerNotIn?: string[], teamWalletsNotIn?: string[],   // blacklists (AND)
  require: ('armedWallet'|'deployerIn'|'teamWalletsAny'|'nameRegex'|'symbolRegex'|'launchSecond')[]  // AND-set; others are OR
}
```

## 5. Conventions
* No DB access on the sniper decision path; all state mirrored in memory via NOTIFY.
* Every service: `pnpm --filter <svc> start`, `pino` JSON logs, `/healthz` http.
* Money math in `bigint` wei; display helpers in core.
* Tests must not touch the network except files under `test/live/` (skipped unless `LIVE=1`).
* Commit messages: imperative, scoped (`sniper: …`).
