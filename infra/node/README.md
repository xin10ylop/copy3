# Robinhood Chain node (Arbitrum Nitro)

Our own full node gives the indexer `debug_traceTransaction` (internal ETH transfers), a
WebSocket for `newHeads`/`logs` without public rate limits, and a fallback send endpoint.
Flags come from the Robinhood node docs (see `docs/RESEARCH.md` §1); the compose service and
`run-node.sh` use the same set.

| Item | Value |
|---|---|
| Image | `offchainlabs/nitro-node:v3.12.2-5f02f3f` (override with `NITRO_IMAGE`) |
| Chain | id 4663, info + genesis JSON from the Robinhood CDN (`download-config.sh`) |
| Data dir | `$DATA_ROOT/nitro` → `/home/user/.arbitrum`, DB in `robinhood/nitro/` (`--persistent.chain=robinhood`) |
| Ports | 8547 HTTP (`net,web3,eth,debug,arb`), 8548 WS (`net,web3,eth,debug`), 6070 metrics; published on `NITRO_BIND` (127.0.0.1) |
| Upstreams | `L1_RPC_URL` (Ethereum execution RPC), `L1_BEACON_URL` (beacon API **with blob sidecars**), sequencer feed + delayed feed, forwarding target `rpc.mainnet` |

**Image version.** RESEARCH lists `v3.11.2-3599aca` from the Robinhood docs. The current pruned
snapshot (2026-10-20) was written by `v3.12.1-rc.2`, and Docker Hub's newest stable tag on
2026-10-28 is `v3.12.2-5f02f3f`. An older nitro may refuse a database written by a newer one, so we
default to `v3.12.2`. Before you upgrade, check the Robinhood node docs for the required version.
Some ArbOS upgrades force a minimum version.

## Steps

```bash
infra/node/download-config.sh                 # chain info + genesis -> infra/node/config/
sudo infra/node/run-node.sh snapshot --dry-run # list parts, check free space
sudo infra/node/run-node.sh snapshot          # stream + verify the latest pruned snapshot (1-3 h)
infra/compose.sh up -d nitro                  # or: infra/node/run-node.sh start (standalone)
infra/node/run-node.sh status                 # local head vs public head
```

## Snapshot and disk sizing (measured 2026-10-28 from the snapshot explorer API)

| Snapshot | Date | Size | Parts |
|---|---|---|---|
| Pruned (hash) | 2026-10-20 | **1,051 GB** | 2 (`pruned.tar.part0000/0001`) |
| Pruned (hash) | 2026-10-09 | 993 GB | 2 |
| Full (path) | 2026-10-25 | 1,106 GB | 3 |
| Archive (path) | 2026-10-20 | 1,536 GB | 3 |

* Growth: about **5.3 GB/day** (≈160 GB/month), going by the two pruned snapshots.
* The tar root is the contents of the nitro DB directory (`./nodes`, `./arbitrumdata`,
  `./l2chaindata`, …), so `run-node.sh snapshot` extracts into `$DATA_ROOT/nitro/robinhood/nitro/`.
* Nitro's own `--init.url` / `--init.latest` downloads the whole archive before it extracts. That
  needs archive + DB ≈ **2.2 TB** at the same time, which does **not** fit the 2x1 TB RAID0 of the
  Ryzen plans (≈1.86 TiB usable). `run-node.sh snapshot` streams resumable 2 GiB range chunks into
  `tar` and checks each part against its published `.sha256`, so its peak is DB + 4 GiB.
* The Robinhood docs ask for NVMe of 2x chain + 20 % (≈2.5 TB today). A 2x1 TB box starts at about
  55 % full (DB plus ~50-100 GB of Postgres) and reaches 85 % in roughly 3-4 months. At that point,
  restore a fresh pruned snapshot (a few hours of downtime for the indexer only; the sniper keeps
  running on the public feed), or move to a plan with 2x4 TB NVMe (see `infra/cherry/README.md`).

## Sync expectations

* Snapshot download at 100-300 MB/s takes 1-3 h. The 7950X has a 3 Gbps NIC; the 9700X/EPYC plans
  have 10 Gbps.
* Catch-up from the snapshot date: nitro replays the feed and L1 batches much faster than the
  chain's ~10 blocks/s. Plan on a few hours for a week-old snapshot. `run-node.sh status` shows the
  lag, and `infra/healthcheck.sh` alerts when it exceeds 50 blocks (~5 s).
* The L1 endpoints must serve blobs (`/eth/v1/beacon/blob_sidecars`). A plain execution RPC is not
  enough. Without blobs, nitro stalls when it validates batches.
