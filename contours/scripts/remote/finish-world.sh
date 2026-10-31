#!/usr/bin/env bash
#
# The world build's last stage, unattended: wait for every shard drive-world.sh
# is merging, free the intermediates, join the shards into world.pmtiles,
# validate it, and upload it (the 2026-10 rebuild, #135).
#
#   setsid nohup bash contours/scripts/remote/finish-world.sh > logs/finish.log 2>&1 < /dev/null &
#
# Start it any time after drive-world.sh; it waits. While it waits it converts
# each merged shard to .pmtiles (what --join joins; it reuses a conversion
# newer than its shard), so only the last shard's convert is on the critical
# path. Events in logs/drive-events.log: FINAL-WAIT, SHARD-CONVERT-START|OK|FAILED,
# FINAL-ABORT, FINAL-CLEANUP, JOIN-START|OK|FAILED, VALIDATE-OK|FAILED,
# UPLOAD-WORLD-START|OK|FAILED.
#
# Disk: --join first converts the shards to .pmtiles (~0.9x the shard total),
# then tile-join writes world.mbtiles (~ the shard total) and pmtiles convert
# a temp file of similar size plus world.pmtiles, all while the shard files
# exist. So the DEM and every merged shard's tiers and batches (2.3 TB of
# tiers on the 2026-10 run) are deleted first; set KEEP_DEM=1 while anything
# else (an offline-pack build) still reads data/dem-glo30.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../../.."
# shellcheck disable=SC1091
[ -f /etc/profile.d/geo.sh ] && . /etc/profile.d/geo.sh

read -r -a SHARDS <<< "${SHARDS:-oceania asia-east north-america asia-west africa europe south-america central-america rest iceland}"
EV=logs/drive-events.log
MARK=logs/markers
mkdir -p "$MARK"
ev() { echo "$(date -u +%FT%TZ) $*" >> "$EV"; }
fail() { ev "VALIDATE-FAILED $*"; exit 1; }
T=public/data/tiles
PS=$T/pmtiles-shards
mkdir -p "$PS"

# Same paths and temp-name convention as build-contours-world.ts --join.
convert_shard() {
  local s="$1"
  ev "SHARD-CONVERT-START $s"
  if pmtiles convert "$T/world_$s.mbtiles" "$PS/world_$s.pmtiles.tmp" > "logs/convert-$s.log" 2>&1 \
      && mv "$PS/world_$s.pmtiles.tmp" "$PS/world_$s.pmtiles"; then
    ev "SHARD-CONVERT-OK $s $(du -h "$PS/world_$s.pmtiles" | cut -f1)"
  else
    ev "SHARD-CONVERT-FAILED $s (--join retries it)"
  fi
}

ev "FINAL-WAIT"
while true; do
  done_n=0
  for s in "${SHARDS[@]}"; do
    if [ -f "$MARK/merge-$s.failed" ]; then ev "FINAL-ABORT merge of $s failed"; exit 1; fi
    if [ -f "$MARK/merge-$s.ok" ]; then
      done_n=$((done_n + 1))
      if [ ! -f "$MARK/convert-$s.started" ]; then touch "$MARK/convert-$s.started"; convert_shard "$s" & fi
    fi
  done
  [ "$done_n" = "${#SHARDS[@]}" ] && break
  sleep 120
done
wait

before=$(df -B1G --output=avail . | tail -1)
[ "${KEEP_DEM:-0}" = 1 ] || rm -rf data/dem-glo30
for s in "${SHARDS[@]}"; do rm -rf "data/tiles/contours-world/$s"; done
after=$(df -B1G --output=avail . | tail -1)
ev "FINAL-CLEANUP freed $((after - before)) GB, $after GB free"

ev "JOIN-START"
if ! npx tsx contours/scripts/build-contours-world.ts --join > logs/world-join.log 2>&1; then
  ev "JOIN-FAILED (tail: $(tail -1 logs/world-join.log | cut -c1-150))"; exit 1
fi
P=public/data/tiles/world.pmtiles
ev "JOIN-OK $(du -h "$P" | cut -f1)"

# Structure, zoom range, real tiles in three places, and the tier check: the
# Mt Sonder z9 tile must hold only 100 m contours (1,488 features on 2026-10).
pmtiles verify "$P" > logs/world-verify.log 2>&1 || fail "pmtiles verify"
pmtiles show "$P" > logs/world-show.txt 2>&1
{ grep -q "min zoom: 9" logs/world-show.txt && grep -q "max zoom: 15" logs/world-show.txt; } || fail "zoom range"
for zxy in "15 28450 18593" "12 2126 1459" "9 265 182"; do
  # shellcheck disable=SC2086  # z x y as three arguments
  [ "$(pmtiles tile "$P" $zxy | wc -c)" -gt 100 ] || fail "empty tile $zxy"
done
read -r nfeat bad < <(tippecanoe-decode -c "$P" 9 444 290 2>/dev/null | grep -o '"elevation": *[0-9.-]*' \
  | awk -F: '{e=$2+0; n++; if (e%100!=0) bad++} END {print n+0, bad+0}')
{ [ "$nfeat" -gt 500 ] && [ "$bad" = 0 ]; } || fail "Mt Sonder z9: $nfeat features, $bad not on 100 m"
ev "VALIDATE-OK Mt Sonder z9 $nfeat features"

# The shard files and world.mbtiles only matter for a re-join; the archive
# validated (and --join already removed the converted shards).
rm -f "$T"/world_*.mbtiles "$T/world.mbtiles"

ev "UPLOAD-WORLD-START"
if ./scripts/remote/upload-world.sh > logs/upload-world.log 2>&1; then
  ev "UPLOAD-WORLD-OK"
else
  ev "UPLOAD-WORLD-FAILED (tail: $(tail -1 logs/upload-world.log | cut -c1-150))"
  exit 1
fi
