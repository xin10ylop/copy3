#!/usr/bin/env bash
# Order the HoodSniper Chicago box from Cherry Servers via the public API
# (POST /v1/projects/{projectId}/servers) with cloud-init user-data, then wait until it is deployed.
#
#   export CHERRY_AUTH_TOKEN=...   # portal: Settings -> API keys
#   export CHERRY_PROJECT_ID=...   # portal: project URL / GET /v1/teams/{team}/projects
#   HOOD_REPO_URL=https://github.com/<owner>/<repo> HOOD_ENV_FILE=./.env.chicago infra/cherry/provision.sh
#   infra/cherry/provision.sh --dry-run        # stock check + rendered request, no order
#   infra/cherry/provision.sh --list-stock     # Chicago bare-metal plans in stock with >= 64 GB RAM
#   infra/cherry/provision.sh --render > ud.yaml   # print the rendered cloud-init only
#
# Env:
#   CHERRY_PLAN=amd-ryzen-7950x   default plan (16c/128 GB/2x1 TB NVMe; EUR 199 = USD 232.83 / month)
#   CHERRY_PLAN_FALLBACKS="amd-ryzen-9700x amd-epyc-9254p amd-epyc-9554p"   tried in order with --allow-fallback
#   CHERRY_REGION=US-Chicago   CHERRY_IMAGE=ubuntu_24_04_64bit   CHERRY_HOSTNAME=hood-chi-1
#   CHERRY_CYCLE=hourly        "monthly" is cheaper but is charged up front from the account balance
#   CHERRY_OS_PARTITION_GB=100 OS partition; the rest of that NVMe joins the /data RAID0
#   CHERRY_SSH_KEY_IDS="123,456"  or  SSH_PUBLIC_KEY_FILE=~/.ssh/id_ed25519.pub (uploaded if new)
#   HOOD_REPO_URL (required), HOOD_REPO_REF=main, HOOD_GIT_TOKEN (optional fine-grained read-only token)
#   HOOD_ENV_FILE  optional complete .env (see infra/env/chicago.env.example) embedded in user-data.
#                  NOTE: user-data is readable from the server's metadata service; leave it out and
#                  fill /opt/hoodsniper/.env over SSH if you prefer.
set -euo pipefail

API="${CHERRY_API:-https://api.cherryservers.com/v1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHERRY_PLAN="${CHERRY_PLAN:-amd-ryzen-7950x}"
CHERRY_PLAN_FALLBACKS="${CHERRY_PLAN_FALLBACKS:-amd-ryzen-9700x amd-epyc-9254p amd-epyc-9554p}"
CHERRY_REGION="${CHERRY_REGION:-US-Chicago}"
CHERRY_IMAGE="${CHERRY_IMAGE:-ubuntu_24_04_64bit}"
CHERRY_HOSTNAME="${CHERRY_HOSTNAME:-hood-chi-1}"
CHERRY_CYCLE="${CHERRY_CYCLE:-hourly}"
CHERRY_OS_PARTITION_GB="${CHERRY_OS_PARTITION_GB:-100}"
SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE:-$HOME/.ssh/id_ed25519.pub}"
HOOD_REPO_REF="${HOOD_REPO_REF:-main}"
DRY=0; FALLBACK=0; LIST=0; RENDER=0

for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --allow-fallback) FALLBACK=1 ;;
    --list-stock) LIST=1 ;;
    --render) RENDER=1 ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown option $a" >&2; exit 64 ;;
  esac
done

log() { printf '[provision] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }
for bin in curl jq base64; do command -v "$bin" >/dev/null 2>&1 || die "$bin is required"; done

api() { # METHOD PATH [JSON]
  local method="$1" path="$2" body="${3-}" args=()
  args=(-fsS -m 60 -X "$method" -H "Accept: application/json")
  [[ -n "${CHERRY_AUTH_TOKEN:-}" ]] && args+=(-H "Authorization: Bearer $CHERRY_AUTH_TOKEN")
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" --data "$body")
  curl "${args[@]}" "$API$path"
}

b64() { base64 | tr -d '\n'; }

# ---------------------------------------------------------------------------------- stock
plans_json="$(api GET "/plans?currency=USD")" || die "cannot list plans"
stock_of() { jq -r --arg p "$1" --arg r "$CHERRY_REGION" \
  '[.[] | select(.slug==$p) | .available_regions[] | select(.slug==$r) | .stock_qty][0] // 0' <<<"$plans_json"; }
price_of() { jq -r --arg p "$1" \
  '[.[] | select(.slug==$p) | .pricing[] | select(.unit=="Monthly") | .price][0] // "?"' <<<"$plans_json"; }

list_stock() {
  jq -r --arg r "$CHERRY_REGION" '
    .[] | select(.type=="baremetal") as $p
    | ($p.available_regions[] | select(.slug==$r) | .stock_qty) as $q
    | select($q > 0 and ($p.specs.memory.total // 0) >= 64)
    | [$p.slug, $q, ([$p.pricing[] | select(.unit=="Monthly") | .price][0]),
       ($p.specs.memory.total), ($p.specs.cpus.cores),
       ([$p.specs.storage[] | "\(.count)x\(.name)"] | join("+"))] | @tsv' <<<"$plans_json" \
  | sort -t$'\t' -k3,3n | awk -F'\t' 'BEGIN{printf "%-30s %5s %9s %6s %5s %s\n","plan","stock","USD/mo","RAM","cores","storage"}
                                     {printf "%-30s %5s %9.2f %6s %5s %s\n",$1,$2,$3,$4,$5,$6}'
}
if (( LIST == 1 )); then list_stock; exit 0; fi

plan="$CHERRY_PLAN"
if (( RENDER == 0 )) && [[ "$(stock_of "$plan")" -lt 1 ]]; then
  log "plan $plan is out of stock in $CHERRY_REGION"
  if (( FALLBACK == 1 )); then
    plan=""
    for p in $CHERRY_PLAN_FALLBACKS; do
      if [[ "$(stock_of "$p")" -ge 1 ]]; then plan="$p"; break; fi
    done
    [[ -n "$plan" ]] || { list_stock >&2; die "no fallback plan in stock"; }
    log "falling back to $plan"
  else
    list_stock >&2
    die "pick an in-stock plan (CHERRY_PLAN=...) or pass --allow-fallback"
  fi
fi
log "plan $plan in $CHERRY_REGION: stock $(stock_of "$plan"), USD $(price_of "$plan")/month (cycle: $CHERRY_CYCLE)"

# ---------------------------------------------------------------------------------- user-data
[[ -n "${HOOD_REPO_URL:-}" ]] || die "HOOD_REPO_URL is required"
bootstrap_env="$(
  printf 'HOOD_REPO_URL=%q\n' "$HOOD_REPO_URL"
  printf 'HOOD_REPO_REF=%q\n' "$HOOD_REPO_REF"
  printf 'HOOD_GIT_TOKEN=%q\n' "${HOOD_GIT_TOKEN:-}"
  printf 'HOOD_DIR=/opt/hoodsniper\n'
)"
dotenv_b64=""
if [[ -n "${HOOD_ENV_FILE:-}" ]]; then
  [[ -r "$HOOD_ENV_FILE" ]] || die "cannot read HOOD_ENV_FILE=$HOOD_ENV_FILE"
  grep -q '^POSTGRES_PASSWORD=.\+' "$HOOD_ENV_FILE" || die "$HOOD_ENV_FILE has no POSTGRES_PASSWORD"
  dotenv_b64="$(b64 < "$HOOD_ENV_FILE")"
fi
user_data="$(cat "$HERE/cloud-init.yaml")"
user_data="${user_data//"@@HOOD_BOOTSTRAP_ENV_B64@@"/"$(printf '%s\n' "$bootstrap_env" | b64)"}"
user_data="${user_data//"@@HOOD_DOTENV_B64@@"/"$dotenv_b64"}"
[[ "$user_data" != *"@@HOOD_"* ]] || die "unrendered placeholder left in cloud-init"
(( ${#user_data} < 65000 )) || log "WARNING: user-data is ${#user_data} bytes"
if (( RENDER == 1 )); then printf '%s\n' "$user_data"; exit 0; fi

# ---------------------------------------------------------------------------------- ssh keys
ssh_ids_json="[]"
if [[ -n "${CHERRY_SSH_KEY_IDS:-}" ]]; then
  ssh_ids_json="$(jq -cn --arg ids "$CHERRY_SSH_KEY_IDS" '$ids | split(",") | map(tonumber)')"
elif (( DRY == 0 )); then
  [[ -n "${CHERRY_AUTH_TOKEN:-}" ]] || die "CHERRY_AUTH_TOKEN is required"
  [[ -r "$SSH_PUBLIC_KEY_FILE" ]] || die "no SSH key: set CHERRY_SSH_KEY_IDS or SSH_PUBLIC_KEY_FILE"
  pub="$(awk '{print $1" "$2}' "$SSH_PUBLIC_KEY_FILE")"
  id="$(api GET /ssh-keys | jq -r --arg k "$pub" '[.[] | select((.key | split(" ")[0:2] | join(" ")) == $k) | .id][0] // empty')"
  if [[ -z "$id" ]]; then
    label="hoodsniper-$(whoami)-$(date +%s)"
    id="$(api POST /ssh-keys "$(jq -cn --arg l "$label" --arg k "$(cat "$SSH_PUBLIC_KEY_FILE")" '{label:$l, key:$k}')" | jq -r .id)"
    log "uploaded SSH key $SSH_PUBLIC_KEY_FILE as id $id"
  fi
  ssh_ids_json="[$id]"
fi

body="$(jq -cn \
  --arg plan "$plan" --arg region "$CHERRY_REGION" --arg image "$CHERRY_IMAGE" \
  --arg hostname "$CHERRY_HOSTNAME" --arg cycle "$CHERRY_CYCLE" \
  --arg ud "$(printf '%s' "$user_data" | b64)" --argjson ssh "$ssh_ids_json" \
  --argjson osgb "$CHERRY_OS_PARTITION_GB" \
  '{plan:$plan, region:$region, image:$image, hostname:$hostname, ssh_keys:$ssh,
    os_partition_size:$osgb, user_data:$ud, cycle:$cycle, spot_market:false}')"

if (( DRY == 1 )); then
  log "dry run - request body (user_data truncated):"
  jq '.user_data |= (.[0:60] + "...")' <<<"$body"
  exit 0
fi

# ---------------------------------------------------------------------------------- order + wait
[[ -n "${CHERRY_AUTH_TOKEN:-}" && -n "${CHERRY_PROJECT_ID:-}" ]] || die "CHERRY_AUTH_TOKEN and CHERRY_PROJECT_ID are required"
resp="$(api POST "/projects/$CHERRY_PROJECT_ID/servers" "$body")" || die "order failed"
server_id="$(jq -r .id <<<"$resp")"
[[ "$server_id" =~ ^[0-9]+$ ]] || die "unexpected response: $resp"
log "ordered server $server_id ($plan); waiting for deployment (bare metal: 10-30 min)"

deadline=$(( $(date +%s) + 90 * 60 ))
status=""
while (( $(date +%s) < deadline )); do
  s="$(api GET "/servers/$server_id" || true)"
  status="$(jq -r '.status // "unknown"' <<<"$s" 2>/dev/null || echo unknown)"
  [[ "$status" == deployed ]] && break
  [[ "$status" == "failed deployment" ]] && die "deployment failed (server $server_id)"
  sleep 30
done
[[ "$status" == deployed ]] || die "timed out waiting for server $server_id (last status: $status)"
ip="$(jq -r '[.ip_addresses[] | select(.address_family==4 and .type=="primary-ip") | .address][0] // [.ip_addresses[] | select(.address_family==4) | .address][0]' <<<"$s")"
log "deployed: server $server_id, IPv4 $ip"
cat <<MSG
Next:
  ssh root@$ip 'tail -f /var/log/cloud-init-output.log'      # RAID, docker, clone, snapshot start
  ssh root@$ip 'journalctl -u hood-snapshot -u hood-stack -f'
  docs/RUNBOOK.md step 2 onwards.
MSG
