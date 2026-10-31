# Standalone backtest (public RPC, no node needed)

Reproduces docs/BACKTEST.md. Run from an empty working directory (files are written there):

```
python3 fetch_events.py 2400000            # launches + curve events for the last N blocks (~2.8 days)
python3 fetch_timestamps_transfers.py      # real block timestamps (log blockTimestamp is 0x0 on this RPC) + exempt-wallet token transfers
python3 backtest.py                        # segments, walk-forward by day, operator clusters -> results.txt
```

The public RPC rate-limits (429); the scripts back off and are resumable (`block_ts.json`,
`transfers.json`). Model: constant-product curve replay (virtual quote 1.68 ETH, 1e9
tokens; net in = quoteIn − fee − creatorTax, `CurveBuy.fee` already contains the snipe
tax), entry as first (or last) buy in the first +1 s block paying 6.18 % snipe tax,
exits on marginal-price triggers realised through the sell formula. The same logic lives
in TypeScript in `services/agent/src/backtest.ts` and runs on the indexed database.

## Per-block tools (31 Oct 2026)

The scripts above act inside blocks and overstate the edge (docs/BACKTEST.md, correction). Use these:

```
python3 sim_block.py DATA_DIR band|sizes|grid|hours   # per-block backtest over the month dataset (same files as run_chain.sh/phase2.py)
RPC_URL=… python3 replay_window.py START_TS END_TS     # chain replay of a UTC window: qualifying launches, backtest and live rule per block
RPC_URL=… python3 audit_trades.py trades.json          # every live run vs the chain, three ways, with our real race position
daily_count.sql                                        # qualifying launches per day from the indexer DB
```
Loading the month (1.5 GB of events) takes ~5 min and ~4 GB of RAM.
