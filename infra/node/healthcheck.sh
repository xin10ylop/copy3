#!/usr/bin/env bash
# Container healthcheck for the nitro node (mounted read-only into the container by
# infra/docker-compose.yml). Healthy == eth_blockNumber answers with a hex result.
# Uses curl when the image has it, otherwise a raw HTTP request over bash's /dev/tcp.
set -euo pipefail
PORT="${1:-8547}"
BODY='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
resp=""
if command -v curl >/dev/null 2>&1; then
  resp="$(curl -fsS -m 5 -H 'Content-Type: application/json' --data "$BODY" "http://127.0.0.1:${PORT}/")"
else
  exec 3<>"/dev/tcp/127.0.0.1/${PORT}"
  printf 'POST / HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n%s' \
    "${#BODY}" "$BODY" >&3
  resp="$(timeout 5 cat <&3 || true)"
  exec 3>&-
fi
if [[ "$resp" == *'"result":"0x'* ]]; then
  exit 0
fi
echo "eth_blockNumber failed: ${resp:0:200}" >&2
exit 1
