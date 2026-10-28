#!/usr/bin/env bash
# pg_dump the HoodSniper database to $BACKUP_DIR (default /data/backups) and keep the newest
# $BACKUP_KEEP (default 14) dumps. Run daily by hood-backup.timer.
#
#   infra/backup.sh                 # dump via the compose postgres container (or DATABASE_URL + local pg_dump)
#   infra/backup.sh --list          # list dumps
#   pg_restore -d "$DATABASE_URL" --clean --if-exists /data/backups/hood-<ts>.dump   # restore
#
# feed_blocks (clock-calibration samples) is dumped schema-only by default: it is large and is
# re-collected live. Chain-derived tables (launches, curve_trades, eth_transfers, ...) can be
# re-indexed with the indexer backfill; plays, snipes, settings, events and agent_runs cannot -
# copy the dumps off the box too (rsync/rclone to cold storage) for real disaster recovery.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
BACKUP_KEEP="${BACKUP_KEEP:-14}"
BACKUP_EXCLUDE_TABLE_DATA="${BACKUP_EXCLUDE_TABLE_DATA:-feed_blocks}"

log() { printf '[backup] %s\n' "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

env_get() { # KEY [default] from the environment or the repo .env (never eval'd)
  local key="$1" def="${2-}" val="${!1-}"
  if [[ -z "$val" && -f "$ROOT/.env" ]]; then
    val="$(sed -n "s/^${key}=//p" "$ROOT/.env" | tail -n 1)"
    val="${val%\"}"; val="${val#\"}"
  fi
  printf '%s' "${val:-$def}"
}

if [[ "${1:-}" == "--list" ]]; then
  find "$BACKUP_DIR" -maxdepth 1 -name 'hood-*.dump' -printf '%TY-%Tm-%Td %TH:%TM  %s bytes  %f\n' 2>/dev/null | sort
  exit 0
fi

[[ "$BACKUP_KEEP" =~ ^[0-9]+$ && "$BACKUP_KEEP" -ge 1 ]] || die "BACKUP_KEEP must be a positive integer"
umask 077
mkdir -p "$BACKUP_DIR"

PGUSER_="$(env_get POSTGRES_USER hood)"
PGDB_="$(env_get POSTGRES_DB hood)"
exclude=()
for t in $BACKUP_EXCLUDE_TABLE_DATA; do exclude+=("--exclude-table-data=$t"); done

ts="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/hood-$ts.dump"
tmp="$out.partial"
trap 'rm -f "$tmp"' EXIT

started=$(date +%s)
if "$ROOT/infra/compose.sh" ps --status running --services 2>/dev/null | grep -qx postgres; then
  log "pg_dump via compose postgres container -> $out"
  "$ROOT/infra/compose.sh" exec -T postgres \
    pg_dump -U "$PGUSER_" -d "$PGDB_" -Fc -Z 6 "${exclude[@]}" > "$tmp"
else
  url="$(env_get DATABASE_URL)"
  [[ -n "$url" ]] || die "postgres container not running and DATABASE_URL not set"
  command -v pg_dump >/dev/null 2>&1 || die "pg_dump not installed (apt install postgresql-client-16)"
  log "pg_dump via DATABASE_URL -> $out"
  pg_dump "$url" -Fc -Z 6 "${exclude[@]}" > "$tmp"
fi

[[ -s "$tmp" ]] || die "empty dump"
# Sanity: the archive must list its table of contents.
if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$tmp" >/dev/null || die "dump is not a readable custom-format archive"
fi
mv "$tmp" "$out"
trap - EXIT
log "ok: $(du -h "$out" | cut -f1) in $(( $(date +%s) - started )) s"

# Rotate: keep the newest $BACKUP_KEEP dumps (names sort chronologically: hood-<UTC ts>.dump).
shopt -s nullglob
dumps=("$BACKUP_DIR"/hood-*.dump)
excess=$(( ${#dumps[@]} - BACKUP_KEEP ))
for (( i = 0; i < excess; i++ )); do
  rm -f -- "${dumps[$i]}"
  log "rotated out $(basename "${dumps[$i]}")"
done
