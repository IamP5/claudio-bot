#!/bin/sh
# Proves the simulator pool's lease rules and writes the log to $1 (default docs/ux-program/evidence/step0-lease-proof.txt):
# five lease-holding jobs start at once against three devices, never more than three pool devices boot, the other two
# wait, all finish and every pool device ends shut down; then a lease with a heartbeat older than 10 minutes is
# reclaimed and a fresh one is not. Run from the repo root.
set -u
H=.claude/skills/verify-claudio-bot/bin/scenario.ts
out="${1:-docs/ux-program/evidence/step0-lease-proof.txt}"
base="${CLAUDIOBOT_VERIFY_DIR:-$(realpath "${TMPDIR:-/tmp}")/claudiobot-verify}"
logs="$(mktemp -d)"
booted() { xcrun simctl list devices booted | grep -c 'ClaudioBot-UX-' ; }

{
  echo "# Step 0 lease proof, $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## 1. Five jobs, three devices"
  echo
  bun "$H" pool status
  bun "$H" lease status
  echo
  pids=""
  for i in 1 2 3 4 5; do
    bun "$H" sim-job --label "job$i" --hold 60 >"$logs/job$i.log" 2>&1 &
    pids="$pids $!"
  done
  echo "started 5 jobs:$pids"
  max=0
  while :; do
    alive=0
    for p in $pids; do kill -0 "$p" 2>/dev/null && alive=$((alive + 1)); done
    n=$(booted)
    [ "$n" -gt "$max" ] && max=$n
    echo
    echo "### sample $(date -u +%H:%M:%S): $alive jobs alive, $n ClaudioBot-UX booted"
    xcrun simctl list devices booted | grep -E 'Booted' | sed 's/^ */  /'
    bun "$H" lease status | sed 's/^/  lease /'
    [ "$alive" -eq 0 ] && break
    sleep 10
  done
  echo
  echo "### job logs"
  for i in 1 2 3 4 5; do sed "s/^/  job$i | /" "$logs/job$i.log"; done
  echo
  echo "### after"
  xcrun simctl list devices | grep 'ClaudioBot-UX-' | sed 's/^ */  /'
  bun "$H" lease status
  echo "max ClaudioBot-UX booted at once: $max (limit 3)"
  [ "$max" -le 3 ] && [ "$(booted)" -eq 0 ] && echo "RESULT ok: at most 3 booted, all pool devices shut down at the end" || echo "RESULT FAILED"

  echo
  echo "## 2. Stale lease reclaim"
  echo
  mkdir -p "$base/leases/ClaudioBot-UX-1"
  printf '{"pid":99999,"label":"fake stale holder","token":"fake-stale","acquiredAt":"2026-01-01T00:00:00.000Z"}' >"$base/leases/ClaudioBot-UX-1/owner.json"
  touch "$base/leases/ClaudioBot-UX-1/heartbeat"
  touch -t "$(date -v-11M +%Y%m%d%H%M.%S)" "$base/leases/ClaudioBot-UX-1/heartbeat"
  echo "faked a lease on ClaudioBot-UX-1 with a heartbeat 11 minutes old:"
  bun "$H" lease status
  r=$(bun "$H" lease acquire --label reclaim-test --wait 30)
  echo "$r"
  dev=$(echo "$r" | sed -n 's/^LEASED device=\([^ ]*\) .*token=\(.*\)$/\1/p')
  tok=$(echo "$r" | sed -n 's/^LEASED .*token=\(.*\)$/\1/p')
  [ "$dev" = "ClaudioBot-UX-1" ] && echo "RESULT ok: the stale lease was reclaimed" || echo "RESULT FAILED: got $dev"
  bun "$H" lease release "$dev" --token "$tok"
  echo
  echo "a fresh lease is not reclaimed:"
  mkdir -p "$base/leases/ClaudioBot-UX-1"
  printf '{"pid":99999,"label":"fake fresh holder","token":"fake-fresh","acquiredAt":"2026-01-01T00:00:00.000Z"}' >"$base/leases/ClaudioBot-UX-1/owner.json"
  touch "$base/leases/ClaudioBot-UX-1/heartbeat"
  r=$(bun "$H" lease acquire --label fresh-test --wait 30)
  echo "$r"
  dev=$(echo "$r" | sed -n 's/^LEASED device=\([^ ]*\) .*token=\(.*\)$/\1/p')
  tok=$(echo "$r" | sed -n 's/^LEASED .*token=\(.*\)$/\1/p')
  [ "$dev" != "ClaudioBot-UX-1" ] && echo "RESULT ok: the fresh lease on ClaudioBot-UX-1 was left alone; got $dev" || echo "RESULT FAILED"
  bun "$H" lease release "$dev" --token "$tok"
  rm -rf "$base/leases/ClaudioBot-UX-1"
  bun "$H" lease status
} 2>&1 | tee "$out"
rm -rf "$logs"
