#!/bin/bash
# Maintenance window, 07:40 and 19:40 Beijing (zhaoshu-maint-window.timer): stop the running B-line workers
# (their memory grows ~100MB per worker per day; SIGTERM checkpoints the task), register up to MAX new free
# pool hosts while they are stopped, then start the same workers again.
set -uo pipefail
umask 077
LIB=/usr/local/lib/zhaoshu
NODE=/opt/node24/bin/node
CF=/var/lib/zhaoshu-download-b/control/registry.json
HD=/var/lib/zhaoshu-download-b/shared-rate-data/hosts
MAX=5
TS=$(date +%Y%m%d-%H%M%S)
RUNNING=()
LISTF= ERRF= DONE=
redact() { sed -E 's/[A-Za-z0-9_+\/=-]{32,}/<redacted>/g' | grep -viE 'authority|epoch|rootid|token|secret|cookie'; }
active_ids() { systemctl list-units --no-legend --state=active 'zhaoshu-download-b@*' | grep -oE 'zhaoshu-download-b@[0-9]+' | cut -d@ -f2 | sort -n; }
start_running() { for i in "${RUNNING[@]}"; do systemctl start --no-block "zhaoshu-download-b@$i"; done; }
cleanup() { rm -f "$LISTF" "$ERRF" "$DONE"; }

exec 9> /run/zs-maint.lock
flock -w 600 9 || { echo "skip: maintenance lock busy"; exit 0; }
for f in "$LIB" "$LIB/register-hosts.mjs" "$LIB/pool-unregistered.mjs" "$(readlink -f "$0")"; do
  [ -n "$(find "$f" -maxdepth 0 -user root ! -perm /022)" ] || { echo "ABORT: $f must be root-owned and not group/world-writable"; exit 1; }
done
mapfile -t RUNNING < <(active_ids)
[ "${#RUNNING[@]}" -gt 0 ] || { echo "skip: no worker running"; exit 0; }
trap cleanup EXIT
LISTF=$(mktemp /tmp/zs-window-list-XXXXXX); ERRF=$(mktemp /tmp/zs-window-err-XXXXXX)
chmod 644 "$LISTF"
if ! runuser -u zsdownload -- timeout 120 "$NODE" "$LIB/pool-unregistered.mjs" "$MAX" > "$LISTF" 2> "$ERRF"; then
  echo "warn: host listing failed; restarting workers only"; : > "$LISTF"
fi
redact < "$ERRF" | tail -n 3
if grep -qvxE '[a-z0-9.-]+' "$LISTF"; then echo "warn: unexpected host list; restarting workers only"; : > "$LISTF"; fi
N=$(grep -c . "$LISTF")
echo "ts=$TS running=${#RUNNING[@]} to-register=$N $(paste -sd' ' "$LISTF")"

trap 'start_running; cleanup' EXIT
timeout 240 systemctl stop 'zhaoshu-download-b@*'
left=$(active_ids | wc -l)
echo "active-after-stop=$left at=$(date +%T)"
if [ "$left" != 0 ]; then echo "ABORT: workers still active; no registration"; exit 1; fi
if [ "$N" -gt 0 ]; then
  BK=/root/zhaoshu-backfill/poolreg-window-$TS
  if mkdir -p -m 700 "$BK" && cp -p "$CF" "$BK/registry.json" && ls "$HD" > "$BK/hosts-before.txt" && cp "$LISTF" "$BK/list.txt"; then
    DONE=$(mktemp /tmp/zs-window-done-XXXXXX); chown zsdownload "$DONE"
    timeout 600 runuser -u zsdownload -- "$NODE" "$LIB/register-hosts.mjs" "$LISTF" \
      "window-$TS: free host listed in pool-artifact hosts[] and an enabled engine source_url, absent from registry with no host dir under data root; maintenance window, all workers stopped" \
      "$DONE" > "$BK/register.log" 2>&1
    echo "register-rc=$?"
    redact < "$BK/register.log" | tail -n 15
    cp "$DONE" "$BK/registered.tsv"
    echo "registered=$(grep -c . "$BK/registered.tsv") hosts-total=$(ls "$HD" | wc -l) backup=$BK"
  else
    echo "ABORT registration: backup to $BK failed"
  fi
fi
start_running
trap cleanup EXIT
n=0
for i in $(seq 1 30); do sleep 4; n=$(active_ids | wc -l); [ "$n" -ge "${#RUNNING[@]}" ] && break; done
echo "active-after-start=$n/${#RUNNING[@]} at=$(date +%T)"
