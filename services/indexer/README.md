# @hood/indexer

Turns Robinhood Chain blocks into the tables every other service reads: Pons V2
launches, curve trades, ERC-20 transfers of launched tokens, ETH transfers (plain,
contract creations and, with tracing, internal transfers), first-funding wallet rows,
and per-token metrics measured from the first taxed buyer. The live service runs in one of two
modes (`INDEXER_MODE`):

* `blocks` (code default): `BlockPipeline` reads every block + receipts (+ traces). Everything
  below, including ETH transfers and wallets. About 2 RPC calls per block, i.e. ~20 calls/s and
  ~1.7M+/day on Robinhood Chain (~10 blocks/s).
* `logs` (default in `infra/ohio`): `LogFollower` indexes `[checkpoint+1, head - CONFIRMATIONS]`
  through `eth_getLogs` ranges about once a second, with the same code as `backfill --mode logs`.
  Launches, curve trades, token transfers and metrics only. About 2-3 calls/s, see
  [Logs mode](#logs-mode).

`backfill` uses the log path over historical ranges.

## Run

```bash
pnpm db:migrate                                   # once, from the repo root
NODE_HTTP=http://127.0.0.1:8547 NODE_WS=ws://127.0.0.1:8548 \
DATABASE_URL=postgres://hood:hood@127.0.0.1:5432/hood TRACE_INTERNAL=1 \
pnpm --filter @hood/indexer start
curl localhost:8081/healthz                       # 200 while head - last block <= HEALTH_MAX_LAG_BLOCKS
```

| env | default | meaning |
|---|---|---|
| `NODE_HTTP` | required | JSON-RPC used for blocks, receipts, `eth_call`, nonces, traces |
| `INDEXER_MODE` | `blocks` | `blocks` = every block + receipts; `logs` = `eth_getLogs` ranges (no ETH transfers / wallets / traces), see [Logs mode](#logs-mode) |
| `NODE_WS` | unset (polling only) | `eth_subscribe` `newHeads` + `logs` (topic filter only, any address) |
| `WS_NEW_HEADS` | `1` | `0` = only the `logs` subscription; the head is polled once a second |
| `DATABASE_URL` | required | Postgres with the `packages/db` migrations applied |
| `START_BLOCK` | head | first block if there is no checkpoint yet |
| `TRACE_INTERNAL` | `0` | blocks mode: `1` = `debug_traceTransaction` (callTracer) for internal transfers. This needs your own node or Alchemy: the public RPC has no `debug_*`. Ignored in logs mode |
| `CONFIRMATIONS` | `0` | process only up to `head - CONFIRMATIONS` |
| `REORG_DEPTH` | `10` | blocks to roll back on a parent-hash mismatch (blocks) or before a `removed` log (logs) |
| `LOGS_INTERVAL_MS` / `LOGS_MIN_BLOCKS` | `1000` / `10` | logs mode: a range starts when this long passed since the last one or this many blocks are pending |
| `LOGS_CHUNK_BLOCKS` | `2000` | logs mode: max blocks per range (= per `eth_getLogs`) while catching up |
| `LOGS_TOKEN_WINDOW_HOURS` / `LOGS_ADDRESS_BATCH` | `6` / `100` | logs mode: Transfer logs are fetched for tokens launched within the window, this many addresses per `eth_getLogs` (one call per batch per range) |
| `RPC_MIN_INTERVAL_MS` | `0` | spacing between RPC calls. Use `>=150` on the public RPC, which answers 429. Calls retry with backoff either way |
| `HEALTH_PORT` / `HEALTH_MAX_LAG_BLOCKS` | `8081` / `600` | `/healthz`: `mode`, `lagBlocks` (head − last processed block), pipeline stats, `logs` (logs mode), `rpc` (requests sent per method since start) |
| `LOG_LEVEL` | `info` | pino level |

Every minute the service logs one line `rpc calls in the last minute` with the per-method
counts, the total and calls/s, so the provider budget can be watched in `docker logs`.

## Per block (`INDEXER_MODE=blocks`)

1. `eth_getBlockByNumber(n, true)` + `eth_getBlockReceipts(n)` (falls back to per-tx receipts). Receipts are the source of truth for logs, tx status and `contractAddress`. The WS `newHeads`/`logs` subscriptions only advance the head and cross-check log counts. Blocks are always processed in order from `checkpoint + 1`, so a dropped socket cannot create gaps, and `eth_blockNumber` is polled as a fallback.
2. **Reorgs**: if `parentHash` does not match the stored hash of `n-1`, everything at or after `n - REORG_DEPTH` is deleted (trades, token/ETH transfers, launches, wallets first seen there, the checkpoint) and re-indexed. Metrics of affected tokens are recomputed.
3. **Pons logs** (TokenLaunched, router Launched, CurveBuy/Sell, SnipeTaxCharged, SnipeTaxExempted, Initialized, CurveCompleted, LaunchSwept, PoolGraduated). Factory/router events are accepted only from the real factory/router. Curve events are accepted only from curves found in `launches` or whose `factory()` is the Pons factory.
4. **ERC-20 `Transfer`** logs emitted by launched tokens go to `token_transfers`. They are taken from the same receipts, filtered by the known-token set, so no extra subscription is needed.
5. **ETH transfers**, then **wallets**, then **token_metrics** for touched tokens.
6. One DB transaction (rows + `settings['indexer.checkpoint'] = {block, hash}`), then `NOTIFY transfers_block '<n>'` when the block had ETH transfers. The tracker wakes on this.

## Logs mode

`INDEXER_MODE=logs` runs `LogFollower` (`src/log-follower.ts`) instead of the per-block loop.
Each range goes through `processLogRange` (`src/log-range.ts`), which `backfill --mode logs` uses too:

1. `eth_getLogs` over the range with the indexed Pons topics (any address). Ranges the node rejects
   as too large are halved.
2. `eth_getBlockByNumber(b, true)` for each block that has Pons logs (timestamps, `tx.from`, launch
   calldata; Nitro returns `blockTimestamp = 0x0` in logs).
3. `eth_getLogs` for ERC-20 `Transfer` of tokens launched within `LOGS_TOKEN_WINDOW_HOURS` (6 h;
   blocks mode records transfers of every launched token forever), 100 addresses per call, plus a
   header for each block that only has such transfers. Later transfers (a dump many hours after
   launch) are not recorded.
4. `processEvents` → launches / curve_trades / token_transfers / token_metrics and one DB
   transaction that includes the checkpoint `{block: range end, hash}`.

Cadence: a range starts once `LOGS_INTERVAL_MS` passed since the last one or `LOGS_MIN_BLOCKS` are
pending, so about once a second at ~10 blocks/s. Catch-up after downtime runs `LOGS_CHUNK_BLOCKS`
ranges back to back. Ranges are strictly consecutive from the checkpoint, and a failed range is
retried whole, so no block range is ever skipped.

Head: `newHeads` (its hash and timestamp give the checkpoint header for free). When no head arrived
for 3 s (no WS, `WS_NEW_HEADS=0`, socket down) the head is polled with
`eth_getBlockByNumber('latest', false)` once a second.

Calls at steady state, per range (about one per second):

| | calls |
|---|---|
| Pons `eth_getLogs` | 1 |
| Transfer `eth_getLogs` | ⌈tokens launched in the window / 100⌉ (~17 launches/h observed: 6 h ≈ 1-2) |
| head poll (only without `newHeads`) | 1 |
| full block per block with Pons events | 1 each |
| header per block with only token transfers | 1 each |

So ≈ 2 calls/s with `newHeads` (3 without) plus the event blocks, against ~20/s in blocks mode.
The offline test (`test/log-follower.test.ts`, 401 blocks with 2 launches, 10 trades and 4 token
transfers, head moving 10 blocks per poll) makes 82 `eth_getLogs` + 6 full blocks + 2 headers
(+46 head polls without WS). Blocks mode makes 401 + 401 calls on the same blocks.
`eth_getBlockReceipts` and `debug_traceTransaction` are never called.

Guards:
* the `logs` subscription counts Pons logs per block. If `eth_getLogs` returns fewer for a block
  (a backend behind the head answers "no logs" instead of failing), the range is retried up to
  3 times before the `eth_getLogs` answer is accepted (`logs.logMismatches` in `/healthz`).
* a `removed` log for an indexed block rolls back from `block - REORG_DEPTH` (same rollback as
  blocks mode: rows, checkpoint, curve book; stale metrics recomputed) and re-indexes. Robinhood
  Chain is Nitro with a single sequencer, so this is a safety net.
* `CONFIRMATIONS` is honoured: ranges end at `head - CONFIRMATIONS`. With `CONFIRMATIONS > 0` and
  no `newHeads`, the range-end header costs one more call per range.

What logs mode does **not** produce, and who notices:
* `eth_transfers` and `wallets` stay empty for the blocks it indexed, and `TRACE_INTERNAL` is
  ignored. `NOTIFY transfers_block` is sent only for blocks with ETH transfers, so it never fires.
* **tracker**: does not crash. Its poll of `max(eth_transfers.block)` finds nothing new, so it arms
  no candidates and `armedWallet` (funding) plays stay idle. The sweep (fired / expired) and
  `/healthz` keep working.
* **agent**: launch, trade, token-transfer and metrics tools are unaffected. Funding tools
  (`get_wallet_funding`, `get_wallet_outgoing`, siblings, funder clustering) return empty or null
  for wallets that were first funded while logs mode ran, so the scout cannot propose new funder
  plays.
* **sniper / telegram**: unaffected. The sniper detects launches from the sequencer feed and reads
  plays, armed candidates and settings. Telegram reads `indexer.checkpoint`, which keeps advancing.
* `INDEXER_MODE=blocks` restores everything from the checkpoint on. Blocks indexed in logs mode do
  not get ETH transfers afterwards unless you run `backfill --mode blocks` over them.

## What each table gets

* **launches**: TokenLaunched joined with the launch tx calldata (`parseLaunchCall`: name, symbol, logo, creatorFeeRecipient, creatorTaxBps, explicit exemptions).
  * `launch_kind` is the entry point (`launchToken`, `launchAndBuy`, `launchTokenFor`, `unknown`). `dev_buy_quote` holds the router dev buy, or a CurveBuy inside the launch tx (0 = none).
  * `exemptions` = calldata exemptions ∪ every `SnipeTaxExempted` address. Post-launch `exemptFromSnipeTax` calls are appended later.
  * `start_price` = `phantomQuote() / launchSupply()`, which is the reserves before any trade (1.68e-9 ETH/token, so 1.68 ETH mcap for config 0). If that cannot be read, the first trade's quote/tokens is used.
  * `graduated` is set on CurveCompleted / LaunchSwept / PoolGraduated.
* **curve_trades**: one row per CurveBuy/CurveSell.
  * `trader` is the event's buyer/seller, which may be the router. `recipient` and `tx_from` attribute the trade.
  * `fee` is the trade fee **including the snipe tax**. `tax` is the **creator tax**. `snipe_tax` is the `SnipeTaxCharged` amount that precedes the CurveBuy in the same tx, paired by curve + recipient.
  * `price_after` is the spot price from cumulative reserves (`buy: q += quoteIn - fee - tax, t -= tokensOut`, `sell: q -= quoteOut + fee + tax, t += tokensIn`). This was verified exactly on 216 real trades and against live `getReserves()`. If reserves are unknown, quote/tokens is used.
  * `exempt` = trader, recipient or tx.from ∈ deployer ∪ creatorFeeRecipient ∪ exemptions.
* **token_transfers**: every `Transfer` of a launched token. It is used to spot the operator exit, where exempt wallets move tokens to a fresh dump wallet that then sells.
* **eth_transfers**:
  * `tx`: a successful top-level tx with value; `trace_addr = ''`.
  * `create`: a contract creation. Created by a top-level tx (`to = null`) or by an internal CREATE/CREATE2. Recorded **even with value 0**, so a contract can be traced back to its creator (the tracker's contract mode).
  * `internal`: a callTracer CALL/SELFDESTRUCT with value. `trace_addr` is the call path, e.g. `0,2`.
  * Reverted txs and reverted sub-calls are skipped.
  * Traced txs are: successful creations, value sent to an address with code, and 0-value calls to contracts created in the last ~36k blocks. Those last ones catch "sprayer" contracts that disperse ETH they already hold.
* **wallets**: the first incoming transfer of each new address.
  * Columns: `first_funder`, `first_funding_value`, `first_funding_tx`, `first_seen_*`.
  * `is_contract` comes from `eth_getCode`. EIP-7702 delegated EOAs count as EOAs.
  * `tx_count_at_first_funding` = `eth_getTransactionCount(addr, n-1)`. If that state is gone, `latest` is used near head, otherwise the value is null.
* **token_metrics**: `computeTokenMetrics(launch, trades, tokenTransfers)` in `src/metrics.ts`, which is pure.
  * **First taxed buyer**: the first buy whose tx carried a SnipeTaxCharged. If none did, the first buy whose recipient is not exempt. So the team's tax-free buys in the launch second are never the entry.
  * **Prices** are execution prices (quote/tokens), as on GMGN and in the video. Pass `{ priceBasis: 'spot' }` for reserve prices.
  * **Entry and peaks**: entry = the first taxed buy. `peakN_pct` and `mcapN` use the max price among trades with `ts - entry_ts <= N` for N ∈ {2, 5, 10, 30, 60}.
  * **`low_after_entry_pct`**: the minimum within 60 s.
  * **`tax_free_buy_count` / `tax_free_quote`**: buys with snipe_tax = 0 while the tax was active (< 3 s).
  * **`n_buys_60s` / `n_sells_60s`**: counted from launch.
  * **`exempt_sold_within_sec`**: seconds from launch to the first CurveSell involving an exempt wallet **or** Transfer out of an exempt wallet. Transfers to the curve, the token, zero or another exempt wallet do not count.
  * **`dump_wallets` / `operator_sell_eth`**: the dump wallets, and ETH from sells by exempt ∪ dump wallets. Both are written only if those columns exist (see Notes).
  * On the real Amlil play this gives: entry 0xc54d… at +1 s for 2.79e-9, +44 % @2 s, +222 % @5 s, +377 % @30 s, exit at +6 s.

## Backfill

```bash
# a block range (public RPC is fine: getLogs in <= 20k-block chunks, 150 ms spacing, retries)
NODE_HTTP=https://rpc.mainnet.chain.robinhood.com DATABASE_URL=… \
  pnpm --filter @hood/indexer backfill --from 100000000 --to 100300000
# the last N days (binary-searches the start block by timestamp)
pnpm --filter @hood/indexer backfill --since-days 3
# options: --to <block|latest> --chunk <=20000 --no-token-transfers --token-window-hours 24
#          --address-batch 100 --mode logs|blocks --dry-run (in-memory, no DB)
```

* `--mode logs` (default) fills launches, curve_trades (incl. snipe_tax), token_transfers and token_metrics. It shares `processLogRange` with the live logs mode.
  * It fetches one full block per block with Pons logs (for timestamps, `tx.from` and launch calldata). Nitro returns `blockTimestamp = 0x0` in `eth_getLogs`.
  * Token transfers are fetched for tokens launched within `--token-window-hours` before each chunk.
  * Ranges the node rejects as too large are halved automatically.
* `--mode blocks` runs the full per-block pipeline, including ETH transfers, wallets and traces with `TRACE_INTERNAL=1`. That is ~860k blocks/day, so use your own node.
* Re-runs are idempotent: rows are `ON CONFLICT DO NOTHING`, curves are re-hydrated from the DB, and duplicate trades are skipped in memory. Metrics are recomputed from all stored trades.
* Backfill does not touch the live checkpoint.

## Library (`import … from '@hood/indexer'`)

* `computeTokenMetrics(launch, trades, tokenTransfers?, opts?)` (pure).
* `fundingPath(sql, wallet, depth)`: wallet ← funder ← funder…, following each address's first funding, including `internal` and `create` hops.
* `siblingsOf(sql, funder, since)`: wallets funded by the funder in one of three ways:
  * directly;
  * through a contract it created;
  * through an internal transfer inside a tx it sent (public disperse).

  Contracts are excluded. `fresh` = first funding was this transfer at nonce 0.
* `incomingTransfers(sql, wallet)`.
* `BlockPipeline`, `PgStore`, `MemoryStore`, row types, `startHealthServer`.

## Tests

`pnpm --filter @hood/indexer test` runs offline:
* fixtures in `packages/core/test/fixtures`;
* PGlite through `packages/db/test/pglite.ts` with the real migrations.

`LIVE=1 pnpm --filter @hood/indexer test test/live` runs against the public RPC. It re-indexes the launch block, then log-backfills the curve and checks it ends at the live `getReserves()`.

`pnpm --filter @hood/indexer typecheck` checks `src` and `test`.

## Notes / limitations

* `token_metrics.dump_wallets` / `operator_sell_eth` are not in `0001_init.sql` yet. They are detected through `information_schema` and written only when present. Add them:

  ```sql
  alter table token_metrics add column dump_wallets text[] not null default '{}';
  alter table token_metrics add column operator_sell_eth double precision;
  ```
* The nonce "at the time" needs state at `n-1`, which only an archive node keeps for old blocks. On a non-archive node, old blocks get `null` and the tracker treats null as not fresh.
* Trades of curves launched before the indexed range are kept but have unknown exemptions. Their `price_after` falls back to quote/tokens unless `getReserves()` at `n-1` is available.
* `debug_traceTransaction` failures are logged and counted (`traceErrors` in `/healthz`). That tx's internal transfers are missed; the block is not retried.
