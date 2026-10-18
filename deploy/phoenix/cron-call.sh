#!/bin/bash
# 用法：cron-call.sh <路由路径> [max-time 秒，默认 330]
# CRON_SECRET 来自单元的 EnvironmentFile，经 stdin 交给 curl，不进 argv 与 journal。
set -euo pipefail
path="$1"; max="${2:-330}"
for _ in $(seq 1 30); do (exec 3<>/dev/tcp/127.0.0.1/3000) 2>/dev/null && break; sleep 2; done
printf 'Authorization: Bearer %s\n' "$CRON_SECRET" \
  | /usr/bin/curl -sS --fail-with-body --max-time "$max" -H @- "http://127.0.0.1:3000${path}"
echo
