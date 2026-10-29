#!/usr/bin/env bash
# HoodSniper — go live on the Ohio box in four commands (RUNBOOK §6-8, Path A).
#
#   sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh install            # host sniper service + .env.executor + 3 keys
#   sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh spread             # one Phantom send to the exit key → gas to every key
#   sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh deploy OWNER=0x…   # PonsSniper with the cold owner, funded from the exit key
#   sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh live               # stop the paper sniper, start the live one
#   sudo bash /opt/hood/hoodsniper/infra/ohio/golive.sh status | stop | paper
#
# Sizes (override with env vars on the command line):
#   KEY_FUND_ETH=0.0012      gas per executor key (3 keys: 1 exit + MAX_CONCURRENT burst)
#   CONTRACT_FUND_ETH=0.018  working balance to send to the contract from the owner wallet
#   MAX_QUOTE_IN_ETH=0.005   on-chain cap per snipe; MAX_SPEND_PER_WINDOW_ETH=0.02 per hour
#   BUY_MIN_ETH=0.002 BUY_MAX_ETH=0.003 BUY_FRACTION=0.35   play sizing (bankroll mode)
#   MAX_CONCURRENT=2 DAILY_LOSS_PCT=50
#
# The owner wallet never touches this box. Funding the contract = a plain transfer to it;
# withdrawing = a 0 ETH transfer from the owner to it (sweeps everything back to the owner).
set -euo pipefail

HOOD_HOME=/opt/hood
HOOD_DIR="$HOOD_HOME/hoodsniper"
HOOD_STATE="$HOOD_HOME/state"
OHIO_ENV="$HOOD_DIR/.env.ohio"
EXEC_ENV="$HOOD_DIR/.env.executor"
HOODCTL="$HOOD_DIR/infra/ohio/hoodctl"
RPC="${RPC_URL:-https://rpc.mainnet.chain.robinhood.com}"

KEY_FUND_ETH="${KEY_FUND_ETH:-0.0012}"
CONTRACT_FUND_ETH="${CONTRACT_FUND_ETH:-0.018}"
MAX_QUOTE_IN_ETH="${MAX_QUOTE_IN_ETH:-0.005}"
MAX_SPEND_PER_WINDOW_ETH="${MAX_SPEND_PER_WINDOW_ETH:-0.02}"
BUY_MIN_ETH="${BUY_MIN_ETH:-0.002}"
BUY_MAX_ETH="${BUY_MAX_ETH:-0.003}"
BUY_FRACTION="${BUY_FRACTION:-0.35}"
MAX_CONCURRENT="${MAX_CONCURRENT:-2}"
DAILY_LOSS_PCT="${DAILY_LOSS_PCT:-50}"
HEALTH_PORT="${HEALTH_PORT:-8090}"
PLAY_NAME="${PLAY_NAME:-team-buy-0.1}"

log() { printf '\033[1m[golive]\033[0m %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"
[[ -f "$OHIO_ENV" ]] || die "$OHIO_ENV missing: run infra/ohio/bootstrap.sh first"
as_hood() { sudo -u hood -H "$@"; }
env_get() { sed -n "s/^$2=//p" "$1" | tail -n 1; }
env_set() { # file key value — replace or append, keeps 0600
  local f="$1" k="$2" v="$3"
  if grep -qE "^$k=" "$f"; then sed -i "s|^$k=.*|$k=$v|" "$f"; else printf '%s=%s\n' "$k" "$v" >>"$f"; fi
}
rpc() { curl -sS -m 15 -X POST -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC"; }
balance_eth() { rpc eth_getBalance "[\"$1\",\"latest\"]" | python3 -c 'import sys,json; r=json.load(sys.stdin).get("result","0x0"); print(int(r,16)/1e18)'; }
node_db() { (cd "$HOOD_DIR/packages/db" && as_hood node --input-type=module -e "$1"); }
addr_of() { node_db "import {privateKeyToAccount} from 'viem/accounts'; console.log(privateKeyToAccount('$1').address)"; }
# send_eth <from private key> <to address> <eth>: a plain transfer on Robinhood Chain (4663), waits for the receipt
send_eth() {
  node_db "import {createWalletClient,createPublicClient,http,parseEther} from 'viem'; import {privateKeyToAccount} from 'viem/accounts';
const chain={id:4663,name:'Robinhood Chain',nativeCurrency:{name:'Ether',symbol:'ETH',decimals:18},rpcUrls:{default:{http:['$RPC']}}};
const account=privateKeyToAccount('$1'); const w=createWalletClient({account,chain,transport:http('$RPC')}); const pc=createPublicClient({chain,transport:http('$RPC')});
const hash=await w.sendTransaction({to:'$2',value:parseEther('$3')}); const r=await pc.waitForTransactionReceipt({hash,timeout:60000});
console.log(r.status+' '+hash)"
}

cmd="${1:-help}"; shift || true
for kv in "$@"; do case "$kv" in *=*) export "${kv%%=*}=${kv#*=}" ;; esac; done

write_exec_env() {
  local alchemy_key alchemy_host pg keys contract mode
  alchemy_key="$(env_get "$OHIO_ENV" ALCHEMY_KEY)"; alchemy_host="$(env_get "$OHIO_ENV" ALCHEMY_HOST)"; pg="$(env_get "$OHIO_ENV" POSTGRES_PASSWORD)"
  [[ -n "$alchemy_key" && -n "$pg" ]] || die "ALCHEMY_KEY / POSTGRES_PASSWORD missing in $OHIO_ENV"
  alchemy_host="${alchemy_host:-robinhood-mainnet.g.alchemy.com}"
  keys=""; contract=""; mode=paper
  if [[ -f "$EXEC_ENV" ]]; then
    keys="$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)"; contract="$(env_get "$EXEC_ENV" SNIPER_CONTRACT)"; mode="$(env_get "$EXEC_ENV" EXECUTION_MODE)"; mode="${mode:-paper}"
  fi
  umask 077
  cat >"$EXEC_ENV.tmp" <<EOF
# written by infra/ohio/golive.sh — the live sniper on this host (systemd hood-sniper.service)
EXECUTION_MODE=$mode
MAX_GAS_PRICE_GWEI=1
DAILY_LOSS_LIMIT_PCT=$DAILY_LOSS_PCT
MAX_CONCURRENT=$MAX_CONCURRENT
EXECUTOR_PRIVATE_KEYS=$keys
SNIPER_CONTRACT=$contract
FEED_URL=wss://feed.mainnet.chain.robinhood.com
FEED_URL_SECONDARY=wss://delayed-feed.mainnet.chain.robinhood.com
SEND_ENDPOINTS=https://rpc.mainnet.chain.robinhood.com,https://$alchemy_host/v2/$alchemy_key
NODE_WS=wss://$alchemy_host/v2/$alchemy_key
NODE_HTTP=https://$alchemy_host/v2/$alchemy_key
PUBLIC_RPC=https://rpc.mainnet.chain.robinhood.com
DATABASE_URL=postgres://hood:$pg@127.0.0.1:5432/hood
HEALTH_PORT=$HEALTH_PORT
LOG_LEVEL=info
EOF
  install -m 0600 -o hood -g hood "$EXEC_ENV.tmp" "$EXEC_ENV"; rm -f "$EXEC_ENV.tmp"
}

print_keys() {
  local keys i=0 addr
  keys="$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)"
  log "executor keys (gas only; send $KEY_FUND_ETH ETH on Robinhood Chain to EACH address):"
  IFS=',' read -ra arr <<<"$keys"
  for k in "${arr[@]}"; do
    addr="$(addr_of "$k")"
    printf '  %-6s %s   balance %s ETH\n' "$([[ $i -eq 0 ]] && echo exit || echo burst$i)" "$addr" "$(balance_eth "$addr")" >&2
    i=$((i + 1))
  done
}

case "$cmd" in
  install)
    ref="$(cat "$HOOD_STATE/repo.ref" 2>/dev/null || echo main)"
    url="$(as_hood git -C "$HOOD_DIR" remote get-url origin)"
    log "installing the host sniper service (branch $ref)"
    HOOD_REPO_URL="$url" HOOD_REPO_REF="$ref" bash "$HOOD_DIR/infra/executor/install-executor.sh"
    systemctl stop hood-sniper.service 2>/dev/null || true
    write_exec_env
    if [[ -z "$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)" ]]; then
      n=$((MAX_CONCURRENT + 1))
      log "generating $n executor keys on this box (1 exit + $MAX_CONCURRENT burst); they are written only to $EXEC_ENV"
      keys="$(node_db "import {generatePrivateKey} from 'viem/accounts'; console.log(Array.from({length:$n},()=>generatePrivateKey()).join(','))")"
      env_set "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS "$keys"
    fi
    [[ "$(env_get "$EXEC_ENV" EXECUTION_MODE)" == live ]] && systemctl start hood-sniper.service || true
    print_keys
    total="$(python3 -c "print(round($KEY_FUND_ETH*($MAX_CONCURRENT+1) + $CONTRACT_FUND_ETH + 0.0005, 6))")"
    log "next: send $total ETH from Phantom to the EXIT address above (one transfer), then: sudo bash $HOOD_DIR/infra/ohio/golive.sh spread"
    ;;
  spread)
    # one Phantom transfer to the EXIT key (KEY_FUND_ETH × keys + CONTRACT_FUND_ETH + a little), then this
    # hands KEY_FUND_ETH to every burst key; the contract is funded from the exit key by `deploy`.
    [[ -f "$EXEC_ENV" ]] || die "run 'golive.sh install' first"
    keys="$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)"; IFS=',' read -ra arr <<<"$keys"; first="${arr[0]}"; exit_addr="$(addr_of "$first")"
    n=${#arr[@]}; need="$(python3 -c "print(round($KEY_FUND_ETH*$n + $CONTRACT_FUND_ETH + 0.0005, 6))")"
    bal="$(balance_eth "$exit_addr")"
    log "exit key $exit_addr holds $bal ETH (needs ~$need ETH for $n keys × $KEY_FUND_ETH + contract $CONTRACT_FUND_ETH)"
    python3 -c "import sys; sys.exit(0 if float('$bal') >= $KEY_FUND_ETH*($n-1) + 0.0002 else 1)" || die "send ~$need ETH from Phantom to $exit_addr first, then run spread again"
    for k in "${arr[@]:1}"; do
      to="$(addr_of "$k")"; b="$(balance_eth "$to")"
      if python3 -c "import sys; sys.exit(0 if float('$b') >= $KEY_FUND_ETH*0.9 else 1)"; then log "$to already holds $b ETH"; continue; fi
      log "sending $KEY_FUND_ETH ETH → $to"; send_eth "$first" "$to" "$KEY_FUND_ETH" >&2
    done
    print_keys
    log "next: sudo bash $HOOD_DIR/infra/ohio/golive.sh deploy OWNER=<your cold wallet>"
    ;;
  deploy)
    [[ -n "${OWNER:-}" ]] || die "usage: golive.sh deploy OWNER=0x<cold wallet address>"
    [[ "$OWNER" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "OWNER is not an address"
    [[ -f "$EXEC_ENV" ]] || die "run 'golive.sh install' first"
    keys="$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)"; [[ -n "$keys" ]] || die "no EXECUTOR_PRIVATE_KEYS in $EXEC_ENV (run install)"
    first="${keys%%,*}"; deployer="$(addr_of "$first")"; bal="$(balance_eth "$deployer")"
    python3 -c "import sys; sys.exit(0 if float('$bal') >= 0.0003 else 1)" || die "exit key $deployer holds $bal ETH; it pays the deploy gas — send it $KEY_FUND_ETH ETH first"
    if [[ -n "$(env_get "$EXEC_ENV" SNIPER_CONTRACT)" && "${REDEPLOY:-0}" != 1 ]]; then
      die "SNIPER_CONTRACT is already set ($(env_get "$EXEC_ENV" SNIPER_CONTRACT)); pass REDEPLOY=1 to deploy another"
    fi
    fund=""
    if python3 -c "import sys; sys.exit(0 if float('$bal') >= $CONTRACT_FUND_ETH + 0.0008 else 1)"; then fund="$CONTRACT_FUND_ETH"; fi
    log "deploying PonsSniper: owner $OWNER, operators = all $(( $(tr -cd ',' <<<"$keys" | wc -c) + 1 )) keys, treasury = the contract (compounding), maxQuoteIn $MAX_QUOTE_IN_ETH ETH, $MAX_SPEND_PER_WINDOW_ETH ETH/h${fund:+, funding $fund ETH from the exit key}"
    out="$(cd "$HOOD_DIR" && as_hood env EXECUTOR_PRIVATE_KEYS="$keys" OWNER="$OWNER" MAX_QUOTE_IN_ETH="$MAX_QUOTE_IN_ETH" MAX_SPEND_PER_WINDOW_ETH="$MAX_SPEND_PER_WINDOW_ETH" RPC_URL="$RPC" ${fund:+FUND_ETH="$fund"} pnpm --filter @hood/contracts run deploy 2>&1 | tee /dev/stderr)"
    contract="$(sed -n 's/^SNIPER_CONTRACT=//p' <<<"$out" | tail -n 1)"
    [[ "$contract" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "deploy did not print SNIPER_CONTRACT (see output above)"
    env_set "$EXEC_ENV" SNIPER_CONTRACT "$contract"
    log "SNIPER_CONTRACT=$contract written to $EXEC_ENV"
    log "contract balance now $(balance_eth "$contract") ETH (top up any time with a plain transfer from the owner wallet)"
    log "next: sudo bash $HOOD_DIR/infra/ohio/golive.sh live"
    ;;
  live)
    [[ -f "$EXEC_ENV" ]] || die "run 'golive.sh install' first"
    contract="$(env_get "$EXEC_ENV" SNIPER_CONTRACT)"; [[ "$contract" =~ ^0x[0-9a-fA-F]{40}$ ]] || die "no SNIPER_CONTRACT: run 'golive.sh deploy OWNER=…' first"
    cbal="$(balance_eth "$contract")"
    python3 -c "import sys; sys.exit(0 if float('$cbal') >= float('$BUY_MIN_ETH') * 2 else 1)" || die "contract $contract holds $cbal ETH; send $CONTRACT_FUND_ETH ETH to it from the owner wallet first"
    keys="$(env_get "$EXEC_ENV" EXECUTOR_PRIVATE_KEYS)"; IFS=',' read -ra arr <<<"$keys"
    for k in "${arr[@]}"; do
      addr="$(addr_of "$k")"; b="$(balance_eth "$addr")"
      python3 -c "import sys; sys.exit(0 if float('$b') >= 0.0003 else 1)" || die "key $addr holds $b ETH of gas; send it $KEY_FUND_ETH ETH first"
    done
    log "play sizing: bankroll mode, $BUY_MIN_ETH–$BUY_MAX_ETH ETH per buy, fraction $BUY_FRACTION; daily-loss override removed"
    "$HOODCTL" psql -q -c "update plays set preset = preset || '{\"buyEth\": $BUY_MIN_ETH, \"sizing\": {\"mode\": \"bankroll\", \"fraction\": $BUY_FRACTION, \"minEth\": $BUY_MIN_ETH, \"maxEth\": $BUY_MAX_ETH}}'::jsonb where name = '$PLAY_NAME'" >/dev/null
    "$HOODCTL" psql -q -c "delete from settings where key = 'daily_loss_limit_eth'" >/dev/null
    "$HOODCTL" resume >/dev/null 2>&1 || true
    log "stopping the paper sniper in compose (PAPER_SNIPER=0): one sniper per database"
    env_set "$OHIO_ENV" PAPER_SNIPER 0
    (cd "$HOOD_DIR/infra/ohio" && "$HOODCTL" compose up -d --remove-orphans >/dev/null)
    env_set "$EXEC_ENV" EXECUTION_MODE live
    env_set "$EXEC_ENV" DAILY_LOSS_LIMIT_PCT "$DAILY_LOSS_PCT"
    env_set "$EXEC_ENV" MAX_CONCURRENT "$MAX_CONCURRENT"
    systemctl restart hood-sniper.service
    log "live sniper started; contract $contract balance $cbal ETH"
    sleep 8
    "$0" status
    ;;
  paper)
    log "back to paper: stopping the host sniper, starting the compose paper sniper"
    systemctl stop hood-sniper.service 2>/dev/null || true
    [[ -f "$EXEC_ENV" ]] && env_set "$EXEC_ENV" EXECUTION_MODE paper
    env_set "$OHIO_ENV" PAPER_SNIPER 1
    (cd "$HOOD_DIR/infra/ohio" && "$HOODCTL" compose up -d >/dev/null)
    "$HOODCTL" status
    ;;
  stop)
    log "kill switch on (no new entries), then stopping the live sniper"
    "$HOODCTL" kill golive-stop >/dev/null 2>&1 || true
    systemctl stop hood-sniper.service
    log "stopped. Open positions are resumed on the next start; to withdraw everything send 0 ETH from the owner wallet to the contract"
    ;;
  status)
    systemctl --no-pager --lines=0 status hood-sniper.service 2>/dev/null | sed -n '1,3p' >&2 || true
    if curl -sf -m 3 "http://127.0.0.1:$HEALTH_PORT/healthz" >/tmp/golive-health.$$ 2>/dev/null; then
      python3 - "/tmp/golive-health.$$" <<'EOF'
import json,sys
h=json.load(open(sys.argv[1])); c=h.get('counters',{}); f=h.get('feed',{})
print(f"mode {h.get('mode')}  feed {f.get('currentUrl')} {f.get('blocksPerSec',0):.1f} blocks/s failovers {f.get('failovers')}  last error {h.get('lastError')}")
print("counters:", {k:c.get(k) for k in ('launches_seen','decisions','fills','closed','aborted','failed','race_sent','race_first_in_block','race_early','race_late','bankroll_eth','daily_loss_limit_eth')})
EOF
    else
      log "no /healthz on :$HEALTH_PORT yet (starting? see: journalctl -u hood-sniper -n 50)"
    fi
    rm -f /tmp/golive-health.$$
    [[ -f "$EXEC_ENV" ]] && { c="$(env_get "$EXEC_ENV" SNIPER_CONTRACT)"; [[ -n "$c" ]] && log "contract $c balance $(balance_eth "$c") ETH"; }
    "$HOODCTL" status 2>/dev/null || true
    log "logs: sudo journalctl -u hood-sniper -f     race: hoodctl race 1     pnl: hoodctl pnl 2"
    ;;
  *)
    sed -n '2,20p' "$0" >&2
    ;;
esac
