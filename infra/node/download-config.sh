#!/usr/bin/env bash
# Fetch the Robinhood Chain node config files (chain info + genesis) from the official CDN
# (docs/RESEARCH.md §1) into infra/node/config/, verify they parse and describe chain 4663.
#
#   infra/node/download-config.sh            # -> infra/node/config/*.json
#   CONFIG_DIR=/elsewhere infra/node/download-config.sh
set -euo pipefail

BASE_URL="${HOOD_NODE_CONFIG_BASE_URL:-https://cdn.robinhood.com/assets/generated_assets/hoodchain_docsite/chain-node-configs}"
CONFIG_DIR="${CONFIG_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/config}"
EXPECTED_CHAIN_ID=4663
FILES=(robinhood-chain-info.json robinhood-genesis.json)

log() { printf '[download-config] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
mkdir -p "$CONFIG_DIR"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

for f in "${FILES[@]}"; do
  log "GET $BASE_URL/$f"
  curl -fsSL --retry 5 --retry-delay 2 --connect-timeout 10 -o "$tmp/$f" "$BASE_URL/$f" \
    || die "download failed: $f"
  [[ -s "$tmp/$f" ]] || die "empty file: $f"
done

# Validate: JSON parses, chain info lists chain-id 4663, genesis has an alloc section.
validate() {
  local info="$1" genesis="$2"
  if command -v jq >/dev/null 2>&1; then
    jq -e --argjson id "$EXPECTED_CHAIN_ID" 'map(select(."chain-id" == $id)) | length == 1' "$info" >/dev/null \
      || die "chain info does not contain chain-id $EXPECTED_CHAIN_ID"
    jq -e '.alloc | type == "object"' "$genesis" >/dev/null || die "genesis has no alloc object"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -I - "$info" "$genesis" "$EXPECTED_CHAIN_ID" <<'PY' || die "config validation failed"
import json, sys
info, genesis, cid = sys.argv[1], sys.argv[2], int(sys.argv[3])
chains = json.load(open(info))
assert sum(1 for c in chains if c.get("chain-id") == cid) == 1, "chain-id missing"
assert isinstance(json.load(open(genesis)).get("alloc"), dict), "alloc missing"
PY
  else
    grep -q "\"chain-id\": *$EXPECTED_CHAIN_ID" "$info" || die "chain info does not mention chain-id $EXPECTED_CHAIN_ID"
  fi
}
validate "$tmp/robinhood-chain-info.json" "$tmp/robinhood-genesis.json"

for f in "${FILES[@]}"; do
  if [[ -f "$CONFIG_DIR/$f" ]] && ! cmp -s "$tmp/$f" "$CONFIG_DIR/$f"; then
    cp "$CONFIG_DIR/$f" "$CONFIG_DIR/$f.bak.$(date -u +%Y%m%dT%H%M%SZ)"
    log "$f changed upstream (previous copy kept as .bak) - read the Robinhood node docs before restarting"
  fi
  install -m 0644 "$tmp/$f" "$CONFIG_DIR/$f"
done
# The nitro container runs as uid 1000; the files only need to be world-readable.
chmod 0755 "$CONFIG_DIR"
log "ok: $(cd "$CONFIG_DIR" && sha256sum "${FILES[@]}" | tr '\n' ' ')"
