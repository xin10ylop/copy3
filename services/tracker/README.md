# @hood/tracker

The funding-trail watcher, our replacement for Packet Tracker. When a watched
funder sends ETH in a configured range to a fresh wallet (directly, or through a
disperse contract), that wallet is armed for the play. The sniper keeps armed
wallets in memory and fires when one of them launches.

## Run

```bash
DATABASE_URL=postgres://hood:hood@127.0.0.1:5432/hood pnpm --filter @hood/tracker start
curl localhost:8082/healthz
```

| env | default | meaning |
|---|---|---|
| `DATABASE_URL` | required | same DB as the indexer |
| `HEALTH_PORT` | `8082` | `/healthz` is 200 while LISTEN is up and sweeps are running |
| `CONTRACT_MAX_AGE_BLOCKS` | `36000` | contract mode: a contract created by a funder counts for this many blocks (~1 h at 10 blocks/s). The same tx always counts |
| `SWEEP_INTERVAL_MS` | `60000` | expiry / fired / disarm sweep, plus a reload of plays |
| `POLL_MS` | `5000` | fallback poll of `max(eth_transfers.block)` in case a NOTIFY was missed |
| `INITIAL_LOOKBACK_BLOCKS` | `0` | on the first start (no checkpoint), also scan this many blocks before the newest transfer |
| `UNKNOWN_NONCE_IS_FRESH` | `0` | arm even if the indexer could not read the recipient's nonce at first funding |
| `LOG_LEVEL` | `info` | pino level |

## How it works

* **Wake-ups**:
  * `LISTEN transfers_block`: the indexer NOTIFYs the block number after committing a block that has ETH transfers.
  * The `POLL_MS` fallback poll.
  * `LISTEN plays_changed`, which reloads plays.

  Blocks are processed in order from `settings['tracker.checkpoint']`, and empty ranges are skipped. If the DB already holds history on the very first start, that history is not treated as new funding.
* **Plays**: enabled `plays` with `trigger.armedWallet` (`funders`, `minEth`, `maxEth`, `freshOnly`, `maxAgeSec`, `contractMode`). They are parsed with the `@hood/core` zod schemas.
* **Matching** is pure, in `src/match.ts`. A transfer arms `(play, recipient)` when all of these hold:
  1. **Funder**. One of:
     * `from` ∈ funders (`direct`);
     * in `contractMode`, `from` is a contract that a funder created (an `eth_transfers kind='create'` row) in the same tx or within `CONTRACT_MAX_AGE_BLOCKS` (`contract`);
     * in `contractMode`, it is an internal transfer inside a tx whose top-level sender is a funder, e.g. a public disperse contract (`sameTx`).
  2. **Value**: `value ∈ [minEth, maxEth]`, inclusive, compared in wei.
  3. **Recipient**: not a contract and not itself a funder.
  4. **Freshness** (`freshOnly`): no earlier `eth_transfers` rows touch the recipient, its first funding is this tx, and `wallets.tx_count_at_first_funding = 0`. An unknown nonce is not fresh unless `UNKNOWN_NONCE_IS_FRESH=1`.
  5. **Not a duplicate**: no `armed_candidates` row exists for `(play, wallet)` in any status.
* **Arm**:
  * `armCandidate` with `expires_at = now + maxAgeSec`, which defaults to 48 h.
  * `insertEvent('armed', {play, wallet, funder, via, valueEth, txHash, block, expiresAt, fundingPath})`.
  * `NOTIFY armed_changed`. The `packages/db` trigger already does this; the tracker sends an explicit NOTIFY only when no trigger is installed.
* **Sweep**, every minute:
  * A candidate whose wallet launched a token (as deployer, creator-fee recipient or exempt wallet) becomes `fired`.
  * Candidates past `expires_at` become `expired`.
  * Once a play reaches `preset.stopAfter` fired candidates, its remaining candidates become `disarmed`.

  Each change gets an event row (`candidate_fired`, `candidate_expired`, `candidate_disarmed`).

## Tables

Reads `eth_transfers`, `wallets`, `plays` and `launches`, all written by the indexer or Telegram/agent. Writes `armed_candidates`, `events` and `settings['tracker.checkpoint']`.

To arm on historical fundings after a backfill, lower the checkpoint:

```sql
update settings set value = '{"block": <from>}' where key = 'tracker.checkpoint';
```

Or start a fresh tracker with `INITIAL_LOOKBACK_BLOCKS`.

## `/watch` helper (for the Telegram bot)

```ts
import { buildWatchPlay, parseWatchCommand } from '@hood/tracker';
import { upsertPlay } from '@hood/db';

// "/watch 0xFunder 0.01 0.015 fresh amlo"
const { spec, presetFrom } = parseWatchCommand(args);       // presetFrom = 'amlo' (play id/name to clone the preset from)
const play = buildWatchPlay({ ...spec, preset: clonedPreset, createdBy: `tg:${userId}` });
await upsertPlay(sql, { name: play.name, enabled: play.enabled, trigger: play.trigger, preset: play.preset, createdBy: play.createdBy ?? null });
```

`buildWatchPlay({funder, minEth, maxEth, fresh, name, preset, contractMode, maxAgeSec, enabled})` returns a `@hood/core` `Play`. Defaults:
* `enabled: true`. Execution is still gated by the sniper's `EXECUTION_MODE`.
* `fresh: true`.
* `contractMode: true`.
* `maxAgeSec`: 48 h.
* `require: ['armedWallet']`.
* The SPEC preset defaults.

## Tests

`pnpm --filter @hood/tracker test`:
* table tests of the matcher: direct, contract mode (same tx, within N blocks, too old, wrong creator, off), same-tx disperse, out of range, inclusive bounds, not fresh (prior transfers, nonce, other first-funding tx, unknown nonce), contract or funder recipient, duplicate;
* `buildWatchPlay` / `parseWatchCommand`;
* end-to-end on PGlite with the real migrations: the indexer `PgStore` writes transfers, then the tracker arms, catches up, sweeps (fired → expired → disarmed) and NOTIFYs.
