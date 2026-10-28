#!/usr/bin/env bash
# Robinhood Chain nitro node helper (standalone docker, same flags as infra/docker-compose.yml).
#
#   infra/node/run-node.sh snapshot   # stream the latest pruned snapshot into $DATA_ROOT/nitro (run once)
#   infra/node/run-node.sh start      # docker run the node (container "hood-nitro") with --init.url/--init.latest if set
#   infra/node/run-node.sh print      # print the docker run command instead of running it
#   infra/node/run-node.sh status     # local head vs public RPC head, eth_syncing
#   infra/node/run-node.sh stop
#
# Use EITHER this script's "start" OR the compose "nitro" service, never both on one data dir.
# The usual flow on the Cherry box is: download-config.sh -> run-node.sh snapshot -> compose.sh up -d.
#
# Env (read from the environment first, then from the repo-root .env):
#   L1_RPC_URL, L1_BEACON_URL   Ethereum mainnet execution RPC + beacon API (blob sidecars)   [start]
#   DATA_ROOT=/data             nitro data lives in $DATA_ROOT/nitro (mounted at /home/user/.arbitrum)
#   NITRO_IMAGE                 default offchainlabs/nitro-node:v3.12.2-5f02f3f (>= snapshot's nitroVersion)
#   NITRO_INIT_URL              explicit snapshot URL for nitro's own --init.url (needs ~2x snapshot size free)
#   NITRO_INIT_LATEST           e.g. "pruned": nitro resolves the latest snapshot itself (also ~2x disk)
#   SNAPSHOT_BASE               default https://robinhood-snapshots.offchainlabs.com
#   SNAPSHOT_KIND               default pruned (others: full-path, archive-path)
#   SNAPSHOT_PREFIX             override, e.g. ".../robinhood%20chain/2026-10-20-eac7b324/pruned.tar"
#   SNAPSHOT_CHUNK_MB=2048      range-request chunk size used by "snapshot" (resumable per chunk)
#   snapshot options: --dry-run (list parts + disk check), --force (wipe existing DB), --no-verify,
#                     --if-missing (exit 0 when a complete DB is already there; used by hood-snapshot.service)
#   NITRO_BIND=127.0.0.1        host address the RPC ports are published on
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_DIR="$ROOT/infra/node/config"
CONTAINER=hood-nitro
PUBLIC_RPC_DEFAULT=https://rpc.mainnet.chain.robinhood.com
CHAIN_DIR_NAME=robinhood   # --persistent.chain => /home/user/.arbitrum/robinhood/nitro

log() { printf '[run-node] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# Read KEY from the repo .env unless it is already set in the environment (no eval of the file).
env_default() {
  local key="$1" def="${2-}" val
  if [[ -n "${!key-}" ]]; then return 0; fi
  val=""
  if [[ -f "$ROOT/.env" ]]; then
    val="$(sed -n "s/^${key}=//p" "$ROOT/.env" | tail -n 1)"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
  fi
  printf -v "$key" '%s' "${val:-$def}"
  export "${key?}"
}

env_default DATA_ROOT /data
env_default NITRO_IMAGE offchainlabs/nitro-node:v3.12.2-5f02f3f
env_default NITRO_BIND 127.0.0.1
env_default NITRO_INIT_URL ""
env_default NITRO_INIT_LATEST ""
env_default L1_RPC_URL ""
env_default L1_BEACON_URL ""
env_default PUBLIC_RPC "$PUBLIC_RPC_DEFAULT"
SNAPSHOT_BASE="${SNAPSHOT_BASE:-https://robinhood-snapshots.offchainlabs.com}"
SNAPSHOT_KIND="${SNAPSHOT_KIND:-pruned}"
SNAPSHOT_PREFIX="${SNAPSHOT_PREFIX:-}"
SNAPSHOT_CHUNK_MB="${SNAPSHOT_CHUNK_MB:-2048}"
SNAPSHOT_CHUNK_BYTES="${SNAPSHOT_CHUNK_BYTES:-$((SNAPSHOT_CHUNK_MB * 1024 * 1024))}"
SNAP_WORK=""

NITRO_DATA="$DATA_ROOT/nitro"
NITRO_DB_DIR="$NITRO_DATA/$CHAIN_DIR_NAME/nitro"

nitro_flags() {
  [[ -n "$L1_RPC_URL" ]] || die "L1_RPC_URL is not set (Ethereum mainnet execution RPC)"
  [[ -n "$L1_BEACON_URL" ]] || die "L1_BEACON_URL is not set (beacon API with blob sidecars)"
  # shellcheck disable=SC2054  # commas belong to the --http.api/--ws.api values
  FLAGS=(
    --chain.id=4663
    --chain.info-files=/home/nitro/config/robinhood-chain-info.json
    --init.genesis-json-file=/home/nitro/config/robinhood-genesis.json
    --persistent.chain="$CHAIN_DIR_NAME"
    --parent-chain.connection.url="$L1_RPC_URL"
    --parent-chain.blob-client.beacon-url="$L1_BEACON_URL"
    --node.feed.input.url=wss://feed.mainnet.chain.robinhood.com
    --node.feed.input.secondary-url=wss://delayed-feed.mainnet.chain.robinhood.com
    --execution.forwarding-target=https://rpc.mainnet.chain.robinhood.com
    --http.addr=0.0.0.0 --http.port=8547 --http.vhosts='*' --http.corsdomain='*'
    --http.api=net,web3,eth,debug,arb
    --ws.addr=0.0.0.0 --ws.port=8548 --ws.origins='*'
    --ws.api=net,web3,eth,debug
    --metrics --metrics-server.addr=0.0.0.0 --metrics-server.port=6070
    --init.download-path=/home/user/.arbitrum/download
  )
  if [[ -n "$NITRO_INIT_URL" ]]; then
    FLAGS+=(--init.url="$NITRO_INIT_URL")
  elif [[ -n "$NITRO_INIT_LATEST" ]]; then
    FLAGS+=(--init.latest="$NITRO_INIT_LATEST" --init.latest-base="$SNAPSHOT_BASE/")
  fi
}

docker_cmd() {
  nitro_flags
  DOCKER_ARGS=(
    run -d --name "$CONTAINER" --restart unless-stopped --stop-timeout 300
    --ulimit nofile=1048576:1048576
    --log-opt max-size=50m --log-opt max-file=5
    -p "$NITRO_BIND:8547:8547" -p "$NITRO_BIND:8548:8548"
    -v "$NITRO_DATA:/home/user/.arbitrum"
    -v "$CONFIG_DIR:/home/nitro/config:ro"
    "$NITRO_IMAGE"
  )
}

rpc() { # rpc URL METHOD -> raw JSON response
  curl -fsS -m 10 -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":[]}" "$1"
}
hex_result() { sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p'; }

preflight_start() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  [[ -s "$CONFIG_DIR/robinhood-chain-info.json" && -s "$CONFIG_DIR/robinhood-genesis.json" ]] \
    || die "node config missing: run infra/node/download-config.sh first"
  mkdir -p "$NITRO_DATA"
  if docker ps --format '{{.Names}}' | grep -Eq '(^|[-_])nitro([-_]|$)' ; then
    die "a compose nitro container is already running on this host - use one or the other"
  fi
  if [[ ! -d "$NITRO_DB_DIR/l2chaindata" && -z "$NITRO_INIT_URL" && -z "$NITRO_INIT_LATEST" ]]; then
    log "WARNING: no database in $NITRO_DB_DIR and no snapshot configured: nitro will sync from genesis (days)."
    log "         run '$0 snapshot' first, or set NITRO_INIT_LATEST=pruned (needs ~2x snapshot size free)."
  fi
}

cmd_start() {
  preflight_start
  docker_cmd
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    log "removing old container $CONTAINER"
    docker rm -f "$CONTAINER" >/dev/null
  fi
  docker "${DOCKER_ARGS[@]}" "${FLAGS[@]}"
  log "started $CONTAINER - follow with: docker logs -f $CONTAINER"
}

cmd_print() {
  docker_cmd
  printf 'docker'
  printf ' %q' "${DOCKER_ARGS[@]}" "${FLAGS[@]}"
  printf '\n'
}

cmd_stop() { docker stop -t 300 "$CONTAINER" && docker rm "$CONTAINER"; }

cmd_status() {
  local local_hex public_hex local_n public_n
  local_hex="$(rpc "http://${NITRO_BIND/0.0.0.0/127.0.0.1}:8547" eth_blockNumber | hex_result || true)"
  public_hex="$(rpc "$PUBLIC_RPC" eth_blockNumber | hex_result || true)"
  [[ -n "$local_hex" ]] || die "local node does not answer on :8547"
  local_n=$((local_hex)); public_n=$(( ${public_hex:-0x0} ))
  printf 'local  head: %d\npublic head: %d\nlag: %d blocks (~%d ms at 100 ms/block)\n' \
    "$local_n" "$public_n" $((public_n - local_n)) $(((public_n - local_n) * 100))
  printf 'eth_syncing: %s\n' "$(rpc "http://${NITRO_BIND/0.0.0.0/127.0.0.1}:8547" eth_syncing | cut -c1-300)"
  df -h "$NITRO_DATA" | tail -n 1
}

# ---------------------------------------------------------------------------------------------
# snapshot: stream the multipart tar straight into the data dir. Nitro's own --init.url downloads
# the whole archive first and extracts afterwards, i.e. it needs archive + DB (~2.1 TB for the
# 2026-10-20 pruned snapshot) which does not fit a 2x1 TB RAID0. Here every part is fetched in
# resumable range chunks (prefetching the next chunk while the current one is untarred), hashed,
# and compared with the published <part>.sha256.
http_size() { # prints Content-Length or nothing on 404
  curl -fsSLI -m 30 "$1" 2>/dev/null | tr -d '\r' | awk 'tolower($1)=="content-length:"{n=$2} END{if(n!="")print n}'
}

resolve_prefix() {
  if [[ -n "$SNAPSHOT_PREFIX" ]]; then printf '%s' "$SNAPSHOT_PREFIX"; return; fi
  local latest dir
  latest="$SNAPSHOT_BASE/robinhood%20chain/latest-$SNAPSHOT_KIND.txt"
  dir="$(curl -fsSL -m 30 "$latest" | tr -d '\r\n')" || die "cannot read $latest"
  [[ -n "$dir" ]] || die "empty $latest"
  dir="${dir%/}"
  printf '%s/%s/%s.tar' "$SNAPSHOT_BASE" "${dir// /%20}" "$SNAPSHOT_KIND"
}

fetch_chunk() { # url start end out
  local url="$1" start="$2" end="$3" out="$4" want=$(( $3 - $2 + 1 )) try
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsSL --connect-timeout 20 --speed-time 60 --speed-limit 1048576 \
         -r "$start-$end" -o "$out" "$url" && [[ "$(stat -c %s "$out")" -eq "$want" ]]; then
      return 0
    fi
    log "chunk $start-$end of $(basename "$url") failed (try $try), retrying"
    sleep $((try * 3))
  done
  return 1
}

emit_part() { # url size workdir -> bytes on stdout
  local url="$1" size="$2" work="$3" chunk="$SNAPSHOT_CHUNK_BYTES"
  local start=0 next_pid="" cur="$work/chunk.a" nxt="$work/chunk.b" end
  end=$(( chunk - 1 < size - 1 ? chunk - 1 : size - 1 ))
  fetch_chunk "$url" 0 "$end" "$cur" || return 1
  while (( start < size )); do
    local nstart=$(( start + chunk ))
    if (( nstart < size )); then
      local nend=$(( nstart + chunk - 1 < size - 1 ? nstart + chunk - 1 : size - 1 ))
      fetch_chunk "$url" "$nstart" "$nend" "$nxt" & next_pid=$!
    else
      next_pid=""
    fi
    cat "$cur"
    rm -f "$cur"
    if [[ -n "$next_pid" ]]; then
      wait "$next_pid" || return 1
      local t="$cur"; cur="$nxt"; nxt="$t"
    fi
    start=$nstart
  done
}

cmd_snapshot() {
  local force=0 verify=1 dry=0 if_missing=0 a
  for a in "$@"; do
    case "$a" in
      --force) force=1 ;;
      --no-verify) verify=0 ;;
      --dry-run) dry=1 ;;
      --if-missing) if_missing=1 ;;
      *) die "unknown snapshot option: $a" ;;
    esac
  done
  # A restore that died half-way leaves this marker: its partial DB is ours to wipe.
  if [[ -f "$NITRO_DB_DIR/.hood-snapshot-incomplete" ]]; then
    log "previous restore did not finish - wiping the partial database"
    force=1
  elif [[ -d "$NITRO_DB_DIR/l2chaindata" && $if_missing -eq 1 ]]; then
    log "database present in $NITRO_DB_DIR - nothing to do"
    return 0
  fi
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -Eq '(^|[-_])nitro([-_]|$)'; then
    die "stop the nitro container before restoring a snapshot"
  fi
  if [[ -d "$NITRO_DB_DIR/l2chaindata" && $force -eq 0 ]]; then
    die "$NITRO_DB_DIR already holds a database (use --force to wipe and restore)"
  fi

  local prefix; prefix="$(resolve_prefix)"
  log "snapshot prefix: $prefix"
  local -a urls=() sizes=()
  local i=0 sz
  while :; do
    local u; u="$(printf '%s.part%04d' "$prefix" "$i")"
    sz="$(http_size "$u" || true)"
    [[ -n "$sz" ]] || break
    urls+=("$u"); sizes+=("$sz"); i=$((i + 1))
  done
  if (( ${#urls[@]} == 0 )); then
    sz="$(http_size "$prefix" || true)"
    [[ -n "$sz" ]] || die "no snapshot found at $prefix(.partNNNN)"
    urls=("$prefix"); sizes=("$sz")
  fi
  local total=0; for sz in "${sizes[@]}"; do total=$((total + sz)); done
  log "parts: ${#urls[@]}, total $((total / 1000000000)) GB"

  mkdir -p "$NITRO_DATA"
  local avail; avail=$(( $(df -P -k "$NITRO_DATA" | awk 'NR==2{print $4}') * 1024 ))
  local need=$(( total + total / 10 + 2 * SNAPSHOT_CHUNK_BYTES ))
  log "free on $(df -P "$NITRO_DATA" | awk 'NR==2{print $6}'): $((avail / 1000000000)) GB, need ~$((need / 1000000000)) GB"
  if (( dry == 1 )); then
    for idx in "${!urls[@]}"; do printf '%s\t%s\n' "${sizes[$idx]}" "${urls[$idx]}"; done
    return 0
  fi
  (( avail >= need || force == 1 )) || die "not enough disk for the extracted DB (+10%); see infra/node/README.md"

  if (( force == 1 )); then
    log "wiping $NITRO_DB_DIR"
    rm -rf "$NITRO_DB_DIR"
  fi
  mkdir -p "$NITRO_DB_DIR"
  printf 'source=%s\nstarted_at=%s\n' "$prefix" "$(date -u +%FT%TZ)" > "$NITRO_DB_DIR/.hood-snapshot-incomplete"
  SNAP_WORK="$(mktemp -d "$NITRO_DATA/.snapshot-work.XXXXXX")"
  trap 'rm -rf "$SNAP_WORK"' EXIT
  local work="$SNAP_WORK"

  log "streaming into $NITRO_DB_DIR (expect ~1-3 h at 100-300 MB/s)"
  (
    set -o pipefail
    for idx in "${!urls[@]}"; do
      emit_part "${urls[$idx]}" "${sizes[$idx]}" "$work" \
        | tee >(sha256sum | awk '{print $1}' > "$work/part$idx.actual")
    done
  ) | tar -x -f - -C "$NITRO_DB_DIR" --no-same-owner

  if (( verify == 1 )); then
    for idx in "${!urls[@]}"; do
      local waited=0 expected actual
      while [[ ! -s "$work/part$idx.actual" && $waited -lt 60 ]]; do sleep 1; waited=$((waited + 1)); done
      expected="$(curl -fsSL -m 30 "${urls[$idx]}.sha256" 2>/dev/null | awk '{print $1}' | head -n 1 || true)"
      actual="$(cat "$work/part$idx.actual" 2>/dev/null || true)"
      if [[ -z "$expected" ]]; then
        log "part $idx: no published sha256, skipping verification"
      elif [[ "$expected" != "$actual" ]]; then
        die "part $idx sha256 mismatch (expected $expected, got $actual): wipe $NITRO_DB_DIR and rerun"
      else
        log "part $idx sha256 ok"
      fi
    done
  fi
  printf 'source=%s\nrestored_at=%s\n' "$prefix" "$(date -u +%FT%TZ)" > "$NITRO_DB_DIR/.hood-snapshot"
  rm -f "$NITRO_DB_DIR/.hood-snapshot-incomplete"
  chown -R 1000:1000 "$NITRO_DATA" 2>/dev/null || log "chown 1000:1000 $NITRO_DATA failed - run as root"
  log "snapshot restored; start the node (compose.sh up -d nitro, or $0 start)"
}

[[ "${BASH_SOURCE[0]}" == "$0" ]] || return 0   # sourced (tests): define functions only

case "${1:-}" in
  start) shift; cmd_start "$@" ;;
  print) shift; cmd_print "$@" ;;
  stop) shift; cmd_stop "$@" ;;
  status) shift; cmd_status "$@" ;;
  snapshot) shift; cmd_snapshot "$@" ;;
  *) sed -n '2,25p' "$0"; exit 64 ;;
esac
