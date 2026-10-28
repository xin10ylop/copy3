# Cherry Servers – Chicago box

One bare-metal server runs the nitro node, Postgres, the indexer, tracker, agent and the
Telegram bot. The executor runs in Ohio (`infra/executor/`). There are two ways to order it:

* `provision.sh` calls the API with curl and jq, checks stock, uploads your SSH key, sends the
  user-data and waits for `deployed`.
* `terraform/` is the same order through the `cherryservers/cherryservers` provider (validated
  against v1.6.1).

Both send `cloud-init.yaml`. It installs Docker and the compose plugin, builds `/data` as an md
RAID0 of both NVMe drives (the whole spare drive plus the free tail of the OS drive, XFS), clones
the repo, writes `.env` (0600), and enables `hood-snapshot`, `hood-stack`, `hood-backup.timer`
and `hood-healthcheck.timer`.

## Plan choice (API data, 2026-10-28)

The API returns prices in **EUR** by default. Add `?currency=USD` for dollars. The table in
RESEARCH §6 is in EUR.

| Plan slug | Cores | RAM | NVMe | NIC | EUR/mo | USD/mo | Chicago stock |
|---|---|---|---|---|---|---|---|
| `amd-ryzen-7950x` (**default**) | 16 | 128 GB | 2x1 TB | 3 Gbps | 199 | 232.83 | **0** |
| `amd-ryzen-9700x` | 8 | 96 GB | 2x1 TB | 10 Gbps | 189 | 221.13 | 1 |
| `amd-epyc-9124p` | 16 | 64 GB | 2x1 TB | 10 Gbps | 359 | 420.03 | 4 |
| `amd-epyc-9254p` | 24 | 192 GB | 2x1 TB | 10 Gbps | 409 | 478.53 | 1 |
| `amd-epyc-9554p` | 64 | 384 GB | 2x1 TB | 10 Gbps | 739 | 864.63 | 3 |
| `amd-epyc-9375F` | 32 | 384 GB | 2x1 TB + 2x4 TB | 3 Gbps | 989 | 1,157.13 | 0 |
| `amd-threadripper-pro-7975wx` | 32 | 768 GB | 2x1 TB + 2x4 TB | 3 Gbps | 1,249 | 1,461.33 | 8 |

Hourly billing is the API default (`cycle=hourly`, 7950X at $0.399/h ≈ $291/mo). `CHERRY_CYCLE=monthly`
costs the monthly price but is charged up front from the account balance.

**Default: AMD Ryzen 7950X.** It covers the node requirements (8+ cores, 128 GB recommended) at the
lowest price. It was **out of stock in Chicago** when we checked. `provision.sh` checks stock and
lists what is available. `--allow-fallback` picks the first in-stock plan from
`CHERRY_PLAN_FALLBACKS`. The 9700X is the like-for-like substitute: same disks, 96 GB RAM (above the
64 GB minimum), 10 Gbps NIC, $221/mo. With the 9700X, set `PG_SHARED_BUFFERS=12GB` and
`PG_EFFECTIVE_CACHE_SIZE=32GB`.

**Choose a 2x4 TB NVMe plan (EPYC 9375F, or the Threadripper PRO 7975WX that is in stock) when any of these holds:**

1. The pruned DB is above ~1.3 TB. That is ~65 % of the 1.86 TiB RAID0. It is 1.05 TB today and grows
   ≈160 GB/month, so this happens in about 2 months, and the box reaches 85 % in about 3-4 months.
2. You do not want to restore a fresh pruned snapshot every ~3 months. That restore takes a few hours
   of indexer downtime; the Ohio sniper keeps running on the public feed.
3. You want the full/archive (path) DB (1.1-1.5 TB, larger every week), or room for months of
   `eth_transfers`/`curve_trades` history and 14 daily dumps.
4. You want nitro's own `--init.latest`, which needs ≈2x the snapshot size free while it restores.

With 2x1 TB drives, `infra/node/run-node.sh snapshot` streams the restore, so its peak is only DB + 4 GiB.

## Usage

```bash
export CHERRY_AUTH_TOKEN=...  CHERRY_PROJECT_ID=...
infra/cherry/provision.sh --list-stock
HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_GIT_TOKEN=<read-only> \
HOOD_ENV_FILE=./.env.chicago infra/cherry/provision.sh --dry-run
HOOD_REPO_URL=... HOOD_ENV_FILE=./.env.chicago infra/cherry/provision.sh --allow-fallback
```

`HOOD_ENV_FILE` is optional. The server's metadata service exposes user-data, so if you would rather
not ship secrets that way, leave it out: the box then creates `.env` from
`infra/env/chicago.env.example` with random Postgres and Grafana passwords and waits for you to fill
in `L1_RPC_URL`, `L1_BEACON_URL`, `TELEGRAM_*` and `ANTHROPIC_API_KEY`. After that, run
`systemctl start hood-stack`.

## After deployment

```bash
ssh root@<ip> tail -f /var/log/cloud-init-output.log
ssh root@<ip> 'df -h /data; cat /proc/mdstat'
ssh root@<ip> journalctl -u hood-snapshot -u hood-stack -f
```
