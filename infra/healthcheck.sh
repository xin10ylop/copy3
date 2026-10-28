#!/usr/bin/env bash
# HoodSniper health checks. Prints one line per check (OK/WARN/FAIL) and exits 1 on any FAIL.
#
#   infra/healthcheck.sh                 # auto role: "chicago" if the compose stack exists, else "executor"
#   infra/healthcheck.sh --role executor # Ohio host: hood-sniper.service, /healthz, clock offset, send RPC
#   infra/healthcheck.sh --alert         # also push FAIL/WARN changes (and recovery) to Telegram admins
#
# Chicago checks: /data disk usage, nitro head vs public RPC head, postgres, compose containers.
# Executor checks: systemd unit, sniper /healthz, chrony offset, public RPC reachability + RTT.
# Tunables: HC_DISK_WARN=80 HC_DISK_FAIL=90 HC_MAX_NODE_LAG=50 (blocks, ~100 ms each)
#           HC_MAX_CLOCK_OFFSET_MS=1 HC_REALERT_MIN=30 SNIPER_HEALTH_URL=http://127.0.0.1:8080/healthz
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROLE=""
ALERT=0
while (( $# )); do
  case "$1" in
    --role) ROLE="${2:?--role needs chicago|executor}"; shift 2 ;;
    --alert) ALERT=1; shift ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 64 ;;
  esac
done

env_get() { # KEY [default]: environment, then .env, then .env.executor (never eval'd)
  local key="$1" def="${2-}" val="${!1-}" f
  for f in "$ROOT/.env" "$ROOT/.env.executor"; do
    [[ -z "$val" && -r "$f" ]] || continue
    val="$(sed -n "s/^${key}=//p" "$f" | tail -n 1)"
    val="${val%\"}"; val="${val#\"}"
  done
  printf '%s' "${val:-$def}"
}

DATA_ROOT="$(env_get DATA_ROOT /data)"
PUBLIC_RPC="$(env_get PUBLIC_RPC https://rpc.mainnet.chain.robinhood.com)"
NODE_HTTP_LOCAL="${HC_NODE_HTTP:-http://127.0.0.1:8547}"
HC_DISK_WARN="${HC_DISK_WARN:-80}"
HC_DISK_FAIL="${HC_DISK_FAIL:-90}"
HC_MAX_NODE_LAG="${HC_MAX_NODE_LAG:-50}"
HC_MAX_CLOCK_OFFSET_MS="${HC_MAX_CLOCK_OFFSET_MS:-1}"
HC_REALERT_MIN="${HC_REALERT_MIN:-30}"
SNIPER_HEALTH_URL="${SNIPER_HEALTH_URL:-http://127.0.0.1:$(env_get HEALTH_PORT 8080)/healthz}"
STATE_DIR="${HC_STATE_DIR:-/var/lib/hood}"

if [[ -z "$ROLE" ]]; then
  if [[ -f "$ROOT/.env" ]] && command -v docker >/dev/null 2>&1 \
     && "$ROOT/infra/compose.sh" ps --services >/dev/null 2>&1; then
    ROLE=chicago
  else
    ROLE=executor
  fi
fi

RESULTS=()
FAILED=0
record() { # level name detail
  RESULTS+=("$1 $2: $3")
  [[ "$1" == FAIL ]] && FAILED=1
  return 0
}

rpc_block() { # url -> decimal block number or empty
  local hex
  hex="$(curl -fsS -m 5 -H 'Content-Type: application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' "$1" 2>/dev/null \
    | sed -n 's/.*"result":"\(0x[0-9a-fA-F]*\)".*/\1/p')" || true
  [[ -n "$hex" ]] && printf '%d' "$((hex))"
  return 0
}

check_disk() {
  local path="$1" pct
  [[ -d "$path" ]] || { record WARN disk "$path does not exist"; return 0; }
  pct="$(df -P "$path" | awk 'NR==2{gsub("%","",$5); print $5}')"
  if (( pct >= HC_DISK_FAIL )); then record FAIL disk "$path ${pct}% used (restore a fresh pruned snapshot or grow NVMe)"
  elif (( pct >= HC_DISK_WARN )); then record WARN disk "$path ${pct}% used"
  else record OK disk "$path ${pct}% used"; fi
}

check_node_lag() {
  local local_n public_n lag
  local_n="$(rpc_block "$NODE_HTTP_LOCAL")"
  public_n="$(rpc_block "$PUBLIC_RPC")"
  if [[ -z "$local_n" ]]; then record FAIL node "no eth_blockNumber from $NODE_HTTP_LOCAL"; return 0; fi
  if [[ -z "$public_n" ]]; then record WARN node "local head $local_n, public RPC unreachable"; return 0; fi
  lag=$(( public_n - local_n ))
  if (( lag > HC_MAX_NODE_LAG )); then record FAIL node "lagging $lag blocks (~$((lag / 10)) s) local=$local_n public=$public_n"
  else record OK node "head $local_n, lag $lag blocks"; fi
}

check_postgres() {
  # shellcheck disable=SC2016  # expanded inside the postgres container
  if "$ROOT/infra/compose.sh" exec -T postgres sh -c 'pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"' >/dev/null 2>&1; then
    record OK postgres "accepting connections"
  else
    record FAIL postgres "pg_isready failed"
  fi
}

check_containers() {
  command -v jq >/dev/null 2>&1 || { record WARN containers "jq not installed, skipped"; return 0; }
  local json svc state health expected=(nitro postgres indexer tracker agent telegram)
  json="$("$ROOT/infra/compose.sh" ps -a --format json 2>/dev/null | jq -sc 'flatten')" || json='[]'
  if [[ "$(jq -r '.[] | select(.Service=="sniper") | .Service' <<<"$json")" == sniper ]]; then expected+=(sniper); fi
  for svc in "${expected[@]}"; do
    state="$(jq -r --arg s "$svc" '[.[] | select(.Service==$s)][0].State // "missing"' <<<"$json")"
    health="$(jq -r --arg s "$svc" '[.[] | select(.Service==$s)][0].Health // ""' <<<"$json")"
    if [[ "$state" != running ]]; then record FAIL "container/$svc" "$state"
    elif [[ "$health" == unhealthy ]]; then record FAIL "container/$svc" "running but unhealthy"
    else record OK "container/$svc" "running${health:+ ($health)}"; fi
  done
}

check_sniper_unit() {
  if ! command -v systemctl >/dev/null 2>&1; then record WARN sniper "systemctl unavailable"; return 0; fi
  if systemctl is-active --quiet hood-sniper.service 2>/dev/null; then record OK sniper "hood-sniper.service active"
  else record FAIL sniper "hood-sniper.service $(systemctl is-active hood-sniper.service 2>/dev/null || true)"; fi
}

check_http() { # name url
  local code
  code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$2" 2>/dev/null)" || code=000
  if [[ "$code" == 200 ]]; then record OK "$1" "$2 200"; else record FAIL "$1" "$2 -> $code"; fi
}

check_clock() {
  command -v chronyc >/dev/null 2>&1 || { record WARN clock "chronyc not installed"; return 0; }
  local line secs ms
  line="$(chronyc tracking 2>/dev/null | awk -F': ' '/^System time/{print $2}')"
  secs="$(awk '{print $1}' <<<"$line")"
  [[ -n "$secs" ]] || { record WARN clock "chronyc tracking unavailable"; return 0; }
  ms="$(awk -v s="$secs" 'BEGIN{printf "%.3f", s * 1000}')"
  if awk -v m="$ms" -v lim="$HC_MAX_CLOCK_OFFSET_MS" 'BEGIN{exit !(m > lim)}'; then
    record FAIL clock "offset ${ms} ms > ${HC_MAX_CLOCK_OFFSET_MS} ms ($line)"
  else
    record OK clock "offset ${ms} ms"
  fi
}

check_public_rpc_rtt() {
  local t
  t="$(curl -s -o /dev/null -m 5 -w '%{time_connect}' "$PUBLIC_RPC" 2>/dev/null)" || t=""
  if [[ -z "$t" || "$t" == 0.000000 ]]; then record FAIL send-rpc "$PUBLIC_RPC unreachable"; return 0; fi
  record OK send-rpc "$PUBLIC_RPC tcp connect $(awk -v s="$t" 'BEGIN{printf "%.1f", s * 1000}') ms"
}

case "$ROLE" in
  chicago)
    check_disk "$DATA_ROOT"
    check_node_lag
    check_postgres
    check_containers
    ;;
  executor)
    check_sniper_unit
    check_http sniper-healthz "$SNIPER_HEALTH_URL"
    check_clock
    check_public_rpc_rtt
    ;;
  *) echo "unknown role $ROLE" >&2; exit 64 ;;
esac

printf '%s\n' "${RESULTS[@]}"

# ---- Telegram alerts (dedup: only on change, or every HC_REALERT_MIN minutes while failing) ----
send_telegram() {
  local token ids text id
  token="$(env_get TELEGRAM_BOT_TOKEN)"; ids="$(env_get TELEGRAM_ADMIN_IDS)"
  [[ -n "$token" && -n "$ids" ]] || { echo "alert: TELEGRAM_BOT_TOKEN/TELEGRAM_ADMIN_IDS not set" >&2; return 0; }
  text="$1"
  for id in ${ids//,/ }; do
    curl -fsS -m 10 "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=$id" --data-urlencode "text=$text" >/dev/null || echo "alert: send to $id failed" >&2
  done
}

if (( ALERT == 1 )); then
  mkdir -p "$STATE_DIR" 2>/dev/null || STATE_DIR="${TMPDIR:-/tmp}"
  state_file="$STATE_DIR/healthcheck-$ROLE.state"
  problems="$(printf '%s\n' "${RESULTS[@]}" | grep -E '^(FAIL|WARN) ' | sed 's/ [0-9][0-9.]* \(ms\|blocks\)//g' || true)"
  sig="$(printf '%s' "$problems" | sha256sum | cut -c1-16)"
  prev_sig=""; prev_ts=0
  if [[ -f "$state_file" ]]; then read -r prev_sig prev_ts < "$state_file" || true; fi
  now=$(date +%s)
  host="$(hostname -s 2>/dev/null || echo host)"
  if [[ -n "$problems" ]]; then
    if [[ "$sig" != "$prev_sig" ]] || (( now - prev_ts >= HC_REALERT_MIN * 60 )); then
      send_telegram "[ALERT] ${host} (${ROLE}) health:
$(printf '%s\n' "${RESULTS[@]}" | grep -E '^(FAIL|WARN) ')"
      echo "$sig $now" > "$state_file"
    fi
  elif [[ -n "$prev_sig" ]]; then
    send_telegram "[RECOVERED] ${host} (${ROLE}): all checks OK"
    rm -f "$state_file"
  fi
fi

exit "$FAILED"
