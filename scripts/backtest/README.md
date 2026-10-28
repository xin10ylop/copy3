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
