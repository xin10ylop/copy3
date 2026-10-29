#!/usr/bin/env bash
# Path A: one Ohio box (AWS us-east-2, Ubuntu 22.04/24.04) running the whole PAPER stack against
# Alchemy, no own node: postgres, migrate+seed, indexer, tracker, agent (serve), sniper (paper),
# optional telegram. See infra/ohio/README.md and docs/RUNBOOK.md "Path A".
#
#   sudo HOOD_REPO_URL=https://github.com/<owner>/<repo> [HOOD_REPO_REF=main] \
#        [HOOD_GIT_TOKEN=<read-only token>] bash bootstrap.sh
#
# Idempotent: re-run it to update the code and restart the stack (the ref of the last successful
# fetch is remembered in /opt/hood/state/repo.ref; HOOD_SKIP_BACKFILL=1 skips the first backfill).
# What it does:
#   * Docker CE + compose/buildx plugins (official apt repo), Node 22 (SHA-256 verified) + pnpm
#   * system user "hood", /opt/hood, clones/updates the repo to /opt/hood/hoodsniper
#   * /opt/hood/hoodsniper/.env.ohio from infra/env/ohio.env.example (0600, never overwritten,
#     POSTGRES_PASSWORD generated), then STOPS until ALCHEMY_KEY and ANTHROPIC_API_KEY are filled in
#   * chrony tuned like the executor (Amazon Time Sync, ENA PTP clock when present)
#   * a swap file on boxes with < 8 GB RAM (the image build and tsc need headroom)
#   * ufw: SSH only (every compose port binds to 127.0.0.1)
#   * checks the Alchemy key (eth_chainId = 4663), builds the image, `compose up -d`, starts the
#     one-shot backfill once, installs /usr/local/bin/hoodctl
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.22.0}"
PNPM_VERSION="${PNPM_VERSION:-10.28.0}"
HOOD_USER=hood
HOOD_HOME=/opt/hood
HOOD_DIR="$HOOD_HOME/hoodsniper"
HOOD_STATE="$HOOD_HOME/state"
HOOD_REPO_URL="${HOOD_REPO_URL:-}"
HOOD_REPO_REF="${HOOD_REPO_REF:-$(cat /opt/hood/state/repo.ref 2>/dev/null || echo main)}"
HOOD_GIT_TOKEN="${HOOD_GIT_TOKEN:-}"
HOOD_SKIP_BACKFILL="${HOOD_SKIP_BACKFILL:-}"
ENV_FILE="$HOOD_DIR/.env.ohio"
CHAIN_ID_HEX=0x1237   # 4663

log() { printf '\033[1m[ohio]\033[0m %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"
# shellcheck source=/dev/null
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || log "WARNING: tested on Ubuntu 22.04/24.04 only (found ${PRETTY_NAME:-unknown})"

# ---------------------------------------------------------------------------------- packages
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git jq xz-utils chrony ufw openssl

# ---------------------------------------------------------------------------------- docker
if ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
  log "installing Docker CE + compose/buildx plugins"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME:?} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1
log "$(docker --version), $(docker compose version)"

# ---------------------------------------------------------------------------------- node + pnpm
# Same as infra/executor/install-executor.sh: host tools for later (LIVE sniper on the host).
arch="$(dpkg --print-architecture)"
case "$arch" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) die "unsupported arch $arch" ;; esac
if [[ "$(command -v node >/dev/null 2>&1 && node -v || true)" != "v$NODE_VERSION" ]]; then
  log "installing node v$NODE_VERSION"
  tmp="$(mktemp -d)"
  tarball="node-v$NODE_VERSION-linux-$narch.tar.xz"
  curl -fsSL -o "$tmp/$tarball" "https://nodejs.org/dist/v$NODE_VERSION/$tarball"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "node tarball checksum mismatch"
  tar -xJf "$tmp/$tarball" -C /usr/local --strip-components=1 --no-same-owner
  rm -rf "$tmp"
fi
if [[ "$(command -v pnpm >/dev/null 2>&1 && pnpm --version || true)" != "$PNPM_VERSION" ]]; then
  log "installing pnpm $PNPM_VERSION"
  npm install -g "pnpm@$PNPM_VERSION" >/dev/null
fi
log "node $(node -v), pnpm $(pnpm --version)"

# ---------------------------------------------------------------------------------- user + repo
if ! id "$HOOD_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$HOOD_HOME" --create-home --shell /usr/sbin/nologin "$HOOD_USER"
fi
chmod 0750 "$HOOD_HOME"
install -d -m 0750 -o root -g root "$HOOD_STATE"
git_auth=()
if [[ -n "$HOOD_GIT_TOKEN" ]]; then
  git_auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$HOOD_GIT_TOKEN" | base64 -w0)")
fi
as_hood() { sudo -u "$HOOD_USER" -H "$@"; }
if [[ ! -d "$HOOD_DIR/.git" ]]; then
  [[ -n "$HOOD_REPO_URL" ]] || die "HOOD_REPO_URL is required for the first run (https://github.com/<owner>/<repo>)"
  log "cloning $HOOD_REPO_URL"
  as_hood env GIT_TERMINAL_PROMPT=0 git "${git_auth[@]}" clone -q "$HOOD_REPO_URL" "$HOOD_DIR"
fi
log "checking out $HOOD_REPO_REF"
if as_hood env GIT_TERMINAL_PROMPT=0 git -C "$HOOD_DIR" "${git_auth[@]}" fetch -q --tags origin "$HOOD_REPO_REF"; then
  as_hood git -C "$HOOD_DIR" checkout -q FETCH_HEAD
  printf '%s\n' "$HOOD_REPO_REF" > "$HOOD_STATE/repo.ref"
else
  # e.g. a private repo re-run without HOOD_GIT_TOKEN: keep going with what is checked out
  log "WARNING: git fetch of $HOOD_REPO_REF failed (private repo without HOOD_GIT_TOKEN?); using the current checkout"
fi
log "at $(as_hood git -C "$HOOD_DIR" log -1 --format='%h %s')"
[[ -f "$HOOD_DIR/infra/ohio/compose.yml" ]] || die "$HOOD_REPO_REF has no infra/ohio/compose.yml (wrong HOOD_REPO_REF?)"

# reports land here (the container user "node" is uid 1000)
REPORTS_DIR_DEFAULT="$HOOD_HOME/reports"

# ---------------------------------------------------------------------------------- env file
env_get() { # KEY: last KEY=value line of the env file, quotes stripped (never sourced)
  local v
  v="$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "${v//[[:space:]]/}"
}
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 -o "$HOOD_USER" -g "$HOOD_USER" "$HOOD_DIR/infra/env/ohio.env.example" "$ENV_FILE"
  log "created $ENV_FILE from infra/env/ohio.env.example"
fi
chown "$HOOD_USER:$HOOD_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"
if [[ -z "$(env_get POSTGRES_PASSWORD)" ]]; then
  pw="$(openssl rand -hex 24)"
  if grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE"; then
    sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$pw/" "$ENV_FILE"
  else
    printf 'POSTGRES_PASSWORD=%s\n' "$pw" >> "$ENV_FILE"
  fi
  log "generated POSTGRES_PASSWORD in $ENV_FILE"
fi
reports_dir="$(env_get HOOD_REPORTS_DIR)"
reports_dir="${reports_dir:-$REPORTS_DIR_DEFAULT}"
install -d -m 0750 -o 1000 -g 1000 "$reports_dir"

# ---------------------------------------------------------------------------------- clock
# Same tuning as infra/executor/install-executor.sh (the sniper's burst timing is clock-based).
log "configuring chrony"
[[ -f /etc/chrony/chrony.conf.orig ]] || cp /etc/chrony/chrony.conf /etc/chrony/chrony.conf.orig 2>/dev/null || true
install -m 0644 "$HOOD_DIR/infra/executor/chrony.conf" /etc/chrony/chrony.conf
mkdir -p /etc/chrony/conf.d /etc/chrony/sources.d
is_aws=0
if grep -qi 'amazon' /sys/devices/virtual/dmi/id/sys_vendor 2>/dev/null \
   || grep -q '^i-' /sys/devices/virtual/dmi/id/board_asset_tag 2>/dev/null; then
  is_aws=1
fi
if [[ -e /dev/ptp0 ]] && grep -qi ena "/sys/class/ptp/ptp0/clock_name" 2>/dev/null; then
  echo 'refclock PHC /dev/ptp0 poll 0 delay 0.000010 prefer' > /etc/chrony/conf.d/hood-phc.conf
  log "ENA PTP hardware clock found: chrony will use /dev/ptp0"
elif (( is_aws == 1 )); then
  rm -f /etc/chrony/conf.d/hood-phc.conf
  if [[ ! -f /etc/modprobe.d/hood-ena-phc.conf ]]; then
    echo 'options ena phc_enable=1' > /etc/modprobe.d/hood-ena-phc.conf
    log "enabled the ENA PTP clock module option - it is used after the next reboot + re-run"
  fi
fi
if (( is_aws == 0 )); then
  sed -i 's/^server 169.254.169.123.*/server time.cloudflare.com iburst nts minpoll 4 maxpoll 6 prefer/; s/^pool time.aws.com.*/pool 2.ubuntu.pool.ntp.org iburst minpoll 6 maxpoll 8 maxsources 3/' \
    /etc/chrony/chrony.conf
fi
systemctl restart chrony
systemctl enable chrony >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------------- memory / disk
mem_mb="$(awk '/^MemTotal:/{print int($2/1024)}' /proc/meminfo)"
if (( mem_mb < 7500 )) && [[ -z "$(swapon --show --noheadings 2>/dev/null)" ]]; then
  log "RAM ${mem_mb} MB < 8 GB and no swap: creating a 4 GB /swapfile"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness = 10' > /etc/sysctl.d/90-hood-swap.conf
  sysctl -q -p /etc/sysctl.d/90-hood-swap.conf
fi
free_gb="$(df -BG --output=avail /var/lib/docker 2>/dev/null | tail -n 1 | tr -dc '0-9')"
if [[ -n "$free_gb" ]] && (( free_gb < 20 )); then
  log "WARNING: only ${free_gb} GB free for Docker. Image + 3-day backfill + a paper week want ~40 GB:"
  log "         grow the EBS root volume (gp3, 50 GB), then: sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1"
fi

# ---------------------------------------------------------------------------------- firewall
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null
log "ufw: $(ufw status | head -n 1) (SSH only; compose ports bind to 127.0.0.1)"

# ---------------------------------------------------------------------------------- hoodctl
install -m 0755 "$HOOD_DIR/infra/ohio/hoodctl" /usr/local/bin/hoodctl

# ---------------------------------------------------------------------------------- required secrets
missing=()
[[ -n "$(env_get ALCHEMY_KEY)" ]] || missing+=(ALCHEMY_KEY)
[[ -n "$(env_get ANTHROPIC_API_KEY)" ]] || missing+=(ANTHROPIC_API_KEY)
if (( ${#missing[@]} )); then
  cat >&2 <<MSG

$(printf '\033[1m')[ohio] STOP: fill in ${missing[*]} in $ENV_FILE, then re-run this script.$(printf '\033[0m')

  sudo nano $ENV_FILE        # or: sudo -u hood -H nano ...  (mode 0600, owner hood)
     ALCHEMY_KEY=<only the key from the Alchemy dashboard, not the URL>
     ANTHROPIC_API_KEY=sk-ant-...
  sudo bash $HOOD_DIR/infra/ohio/bootstrap.sh

Everything else in the file has working defaults (EXECUTION_MODE=paper; probe is opt-in, see README).
MSG
  exit 2
fi
alchemy_key="$(env_get ALCHEMY_KEY)"
[[ "$alchemy_key" =~ ^[A-Za-z0-9_-]+$ ]] || die "ALCHEMY_KEY must be the bare key (letters, digits, - and _), not a URL"
alchemy_host="$(env_get ALCHEMY_HOST)"
alchemy_host="${alchemy_host:-robinhood-mainnet.g.alchemy.com}"

# Check the key without echoing it: eth_chainId must be 4663 (0x1237).
chain_id="$(curl -fsS -m 10 -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
  "https://$alchemy_host/v2/$alchemy_key" 2>/dev/null | jq -r '.result // empty' || true)"
[[ "$chain_id" == "$CHAIN_ID_HEX" ]] \
  || die "Alchemy check failed (eth_chainId='${chain_id:-no answer}', want $CHAIN_ID_HEX): is ALCHEMY_KEY right and Robinhood Chain enabled on that Alchemy app?"
log "Alchemy OK (chain 4663)"
unset alchemy_key

# ---------------------------------------------------------------------------------- stack
compose() { docker compose -f "$HOOD_DIR/infra/ohio/compose.yml" --env-file "$ENV_FILE" "$@"; }
log "building the image and starting the stack (first build: ~5-10 min)"
compose up -d --build
log "waiting for migrate (+seed)"
for _ in $(seq 1 60); do
  state="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$(compose ps -a -q migrate)" 2>/dev/null || true)"
  [[ "$state" == "exited "* ]] && break
  sleep 5
done
[[ "${state:-}" == "exited 0" ]] || { compose logs --tail 50 migrate >&2; die "migrate/seed did not finish cleanly ($state)"; }

if [[ -z "$HOOD_SKIP_BACKFILL" && ! -f "$HOOD_STATE/backfill.started" ]]; then
  log "starting the one-shot backfill (hoodctl logs -f backfill)"
  compose --profile backfill up -d --no-deps backfill
  date -u +%FT%TZ > "$HOOD_STATE/backfill.started"
else
  log "backfill already started once ($(cat "$HOOD_STATE/backfill.started" 2>/dev/null || echo skipped)); re-run with: hoodctl backfill"
fi

sleep 5
compose ps
cat >&2 <<MSG

$(printf '\033[1m')[ohio] paper stack is up.$(printf '\033[0m')
  hoodctl ps                 # every service running; healthy after ~2 min
  hoodctl health             # /healthz of indexer, tracker, agent, sniper
  hoodctl status             # kill switch, plays, armed, open positions, today's PnL
  hoodctl pnl 7              # realised paper PnL per day and per play
  hoodctl logs -f sniper     # [paper] planned / filled / closed
  ls $reports_dir            # agent reports (CSV + markdown)
Update later: sudo bash $HOOD_DIR/infra/ohio/bootstrap.sh   (same command, idempotent)
MSG
