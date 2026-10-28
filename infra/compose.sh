#!/usr/bin/env bash
# Thin wrapper so every compose call uses the repo-root .env for interpolation and the
# infra/docker-compose.yml project, no matter which directory you call it from.
#
#   infra/compose.sh up -d                       # node, postgres, migrate, indexer, tracker, agent, telegram
#   infra/compose.sh --profile executor up -d    # + sniper on this box (only if not using the Ohio executor)
#   infra/compose.sh --profile monitoring up -d  # + prometheus, grafana, exporters
#   infra/compose.sh logs -f telegram
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${HOOD_ENV_FILE:-$ROOT/.env}"
args=(-f "$ROOT/infra/docker-compose.yml")
if [[ -f "$ENV_FILE" ]]; then
  args+=(--env-file "$ENV_FILE")
else
  echo "compose.sh: $ENV_FILE not found (copy infra/env/chicago.env.example to .env)" >&2
fi
exec docker compose "${args[@]}" "$@"
