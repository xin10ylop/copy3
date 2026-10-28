#!/usr/bin/env bash
# Install (or update) the HoodSniper executor on a plain Ubuntu 22.04/24.04 host, ideally in
# AWS us-east-2 (Ohio), ~3 ms from the Robinhood Chain sequencer (docs/RESEARCH.md §1).
#
#   sudo HOOD_REPO_URL=https://github.com/<owner>/<repo> [HOOD_REPO_REF=main] \
#        [HOOD_GIT_TOKEN=<read-only token>] [HOOD_PIN_CPU=1] bash install-executor.sh
#
# What it does (idempotent; re-run to update code and units):
#   * Node 22 (official tarball, SHA-256 verified) + pnpm, system user "hood" (/opt/hood)
#   * clones/updates the repo to /opt/hood/hoodsniper and runs pnpm install --frozen-lockfile
#   * /opt/hood/hoodsniper/.env.executor from the template, mode 0600, never overwritten
#   * chrony tuned for sub-ms accuracy (Amazon Time Sync + ENA PTP clock when present)
#   * low-latency sysctls, optional CPU pinning (HOOD_PIN_CPU) with NIC IRQs moved off that CPU
#   * systemd: hood-sniper.service (Restart=always, LimitNOFILE) + per-minute health check timer
#   * ufw: SSH only
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.22.0}"
PNPM_VERSION="${PNPM_VERSION:-10.28.0}"
HOOD_USER=hood
HOOD_HOME=/opt/hood
HOOD_DIR="$HOOD_HOME/hoodsniper"
HOOD_REPO_URL="${HOOD_REPO_URL:-}"
HOOD_REPO_REF="${HOOD_REPO_REF:-main}"
HOOD_GIT_TOKEN="${HOOD_GIT_TOKEN:-}"
HOOD_PIN_CPU="${HOOD_PIN_CPU:-}"
ENV_FILE="$HOOD_DIR/.env.executor"

log() { printf '\033[1m[executor]\033[0m %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo)"
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || log "WARNING: tested on Ubuntu 22.04/24.04 only (found ${PRETTY_NAME:-unknown})"

# ---------------------------------------------------------------------------------- packages
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl git jq xz-utils chrony ufw wireguard-tools ethtool

# ---------------------------------------------------------------------------------- node + pnpm
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
git_auth=()
if [[ -n "$HOOD_GIT_TOKEN" ]]; then
  git_auth=(-c "http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' "$HOOD_GIT_TOKEN" | base64 -w0)")
fi
as_hood() { sudo -u "$HOOD_USER" -H "$@"; }
if [[ ! -d "$HOOD_DIR/.git" ]]; then
  [[ -n "$HOOD_REPO_URL" ]] || die "HOOD_REPO_URL is required for the first install"
  log "cloning $HOOD_REPO_URL"
  as_hood git "${git_auth[@]}" clone -q "$HOOD_REPO_URL" "$HOOD_DIR"
fi
log "checking out $HOOD_REPO_REF"
as_hood git -C "$HOOD_DIR" "${git_auth[@]}" fetch -q --tags origin "$HOOD_REPO_REF"
as_hood git -C "$HOOD_DIR" checkout -q FETCH_HEAD
log "pnpm install"
(cd "$HOOD_DIR" && as_hood env CI=true pnpm install --frozen-lockfile --reporter=silent)

# ---------------------------------------------------------------------------------- secrets
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 -o "$HOOD_USER" -g "$HOOD_USER" "$HOOD_DIR/infra/env/executor.env.example" "$ENV_FILE"
  log "created $ENV_FILE from the template (EXECUTION_MODE=paper) - fill it in"
fi
chown "$HOOD_USER:$HOOD_USER" "$ENV_FILE"
chmod 0600 "$ENV_FILE"

# ---------------------------------------------------------------------------------- clock
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
    log "enabled the ENA PTP clock module option - reboot, then re-run this script to use /dev/ptp0"
  fi
fi
if (( is_aws == 0 )); then
  # Not on AWS: the link-local Amazon source is unreachable; use NTS-authenticated public servers.
  sed -i 's/^server 169.254.169.123.*/server time.cloudflare.com iburst nts minpoll 4 maxpoll 6 prefer/; s/^pool time.aws.com.*/pool 2.ubuntu.pool.ntp.org iburst minpoll 6 maxpoll 8 maxsources 3/' \
    /etc/chrony/chrony.conf
fi
systemctl restart chrony
systemctl enable chrony >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------------- kernel/net
install -m 0644 "$HOOD_DIR/infra/executor/sysctl-executor.conf" /etc/sysctl.d/90-hood-executor.conf
sysctl --system >/dev/null

# ---------------------------------------------------------------------------------- units
log "installing systemd units"
install -m 0644 "$HOOD_DIR/infra/executor/hood-sniper.service" /etc/systemd/system/hood-sniper.service
install -m 0644 "$HOOD_DIR/infra/executor/hood-executor-healthcheck.service" /etc/systemd/system/
install -m 0644 "$HOOD_DIR/infra/executor/hood-executor-healthcheck.timer" /etc/systemd/system/
dropin=/etc/systemd/system/hood-sniper.service.d
if [[ -n "$HOOD_PIN_CPU" ]]; then
  ncpu="$(nproc --all)"
  [[ "$HOOD_PIN_CPU" =~ ^[0-9]+$ && "$HOOD_PIN_CPU" -lt "$ncpu" ]] || die "HOOD_PIN_CPU must be a CPU index < $ncpu"
  others="$(seq 0 $((ncpu - 1)) | grep -vx "$HOOD_PIN_CPU" | paste -sd, -)"
  [[ -n "$others" ]] || die "need at least 2 CPUs to pin"
  mkdir -p "$dropin"
  printf '[Service]\nCPUAffinity=%s\n' "$HOOD_PIN_CPU" > "$dropin/10-cpu.conf"
  # Keep NIC interrupts (and irqbalance) away from the sniper's CPU.
  cat > /usr/local/sbin/hood-irq-affinity <<IRQ
#!/usr/bin/env bash
# Generated by install-executor.sh: steer all IRQs to CPUs $others (sniper pinned to $HOOD_PIN_CPU).
for f in /proc/irq/[0-9]*/smp_affinity_list; do echo "$others" > "\$f" 2>/dev/null || true; done
IRQ
  chmod 0755 /usr/local/sbin/hood-irq-affinity
  cat > /etc/systemd/system/hood-irq-affinity.service <<'UNIT'
[Unit]
Description=HoodSniper - keep IRQs off the sniper CPU
After=network-online.target
Before=hood-sniper.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/hood-irq-affinity

[Install]
WantedBy=multi-user.target
UNIT
  systemctl disable --now irqbalance >/dev/null 2>&1 || true
  systemctl daemon-reload
  systemctl enable --now hood-irq-affinity.service >/dev/null
  log "pinned hood-sniper to CPU $HOOD_PIN_CPU, IRQs on CPU(s) $others"
else
  rm -f "$dropin/10-cpu.conf"
fi
systemctl daemon-reload
systemctl enable hood-sniper.service hood-executor-healthcheck.timer >/dev/null
systemctl start hood-executor-healthcheck.timer

# ---------------------------------------------------------------------------------- firewall
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw --force enable >/dev/null

# ---------------------------------------------------------------------------------- start
db_url="$(sed -n 's/^DATABASE_URL=//p' "$ENV_FILE" | tail -n 1)"
mode="$(sed -n 's/^EXECUTION_MODE=//p' "$ENV_FILE" | tail -n 1)"
if [[ -n "$db_url" && "$db_url" != *CHANGE_ME* ]]; then
  log "restarting hood-sniper (EXECUTION_MODE=${mode:-unset})"
  systemctl restart hood-sniper.service
  sleep 5
  systemctl --no-pager --lines=15 status hood-sniper.service || true
else
  log "not starting: fill in $ENV_FILE (DATABASE_URL, SNIPER_CONTRACT, EXECUTOR_PRIVATE_KEY), then: systemctl start hood-sniper"
fi

# ---------------------------------------------------------------------------------- report
log "clock: $(chronyc tracking 2>/dev/null | awk -F': ' '/^(Reference ID|System time)/{printf "%s; ", $2}')"
log "TCP connect RTT to the sequencer RPC (expect 1-3 ms from us-east-2):"
for _ in 1 2 3 4 5; do
  curl -s -o /dev/null -m 5 -w '  %{time_connect}s\n' https://rpc.mainnet.chain.robinhood.com || true
done
log "done. logs: journalctl -u hood-sniper -f"
