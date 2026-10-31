#!/usr/bin/env bash
#
# Drive every world shard through DEM fetch, cells and merge on one box, with
# no human in the loop (the 2026-10 rebuild, #135). Three concurrent stages:
#
#   fetch  - every shard's GLO-30 DEM, one shard at a time, retried: Node's
#            bundled HTTP client dies with an uncaught AssertionError
#            (undici Parser.finish) every few hundred tiles, which the
#            fetcher's own retries cannot catch. Downloads land via .part
#            files, so a crash costs nothing but a restart. DEM is never
#            purged (~485 GB for the world).
#   cells  - one shard at a time with --cells-only at CELL_PARALLEL, largest
#            first so the longest merges start earliest.
#   merges - a pool of up to MAX_MERGES `--merge-only` runs, each started as
#            soon as its shard's cells are done. A merge is mostly
#            single-threaded tippecanoe (~1-6 cores, 1-2.5 GB RSS), so merges
#            and the cell lane share the box rather than taking turns.
#
# Run it detached from the checkout on the NVMe volume:
#   setsid nohup bash contours/scripts/remote/drive-world.sh > logs/drive.log 2>&1 < /dev/null &
#   SHARDS="oceania europe" CELL_PARALLEL=28 bash contours/scripts/remote/drive-world.sh ...
#
# One line per event in logs/drive-events.log:
#   FETCH-OK|FETCH-RETRY|FETCH-FAILED <shard>, CELLS-START|OK|RETRY|FAILED <shard>,
#   CELL-LANE-DONE, MERGE-START|OK|RETRY|FAILED <shard>, MERGES-DONE, ALL-DONE
# Markers in logs/markers/ make a re-run resume where it stopped.
# contours/scripts/remote/finish-world.sh takes over from MERGES-DONE.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../../.."
# shellcheck disable=SC1091
[ -f /etc/profile.d/geo.sh ] && . /etc/profile.d/geo.sh

# Largest first (cells, then the multi-batch merges that are the long pole).
# The ice sheets are left out: huge and near-useless (see the runbook).
read -r -a SHARDS <<< "${SHARDS:-oceania asia-east north-america asia-west africa europe south-america central-america rest iceland}"
CELL_PARALLEL="${CELL_PARALLEL:-$(nproc --ignore=6)}"
MAX_MERGES="${MAX_MERGES:-6}"
FETCH_ATTEMPTS="${FETCH_ATTEMPTS:-25}"

LOGS=logs
EV=$LOGS/drive-events.log
MARK=$LOGS/markers
mkdir -p "$MARK"
ev() { echo "$(date -u +%FT%TZ) $*" >> "$EV"; }

fetch_all() {
  for s in "${SHARDS[@]}"; do
    [ -f "$MARK/fetch-$s.ok" ] && continue
    local ok=0
    for i in $(seq 1 "$FETCH_ATTEMPTS"); do
      if npx tsx scripts/fetch-dem-copernicus.ts --shard "$s" >> "$LOGS/fetch-$s.log" 2>&1; then ok=1; break; fi
      ev "FETCH-RETRY $s attempt $i"; sleep 20
    done
    if [ $ok = 1 ]; then touch "$MARK/fetch-$s.ok"; ev "FETCH-OK $s"
    else touch "$MARK/fetch-$s.failed"; ev "FETCH-FAILED $s"; fi
  done
}

cell_lane() {
  for s in "${SHARDS[@]}"; do
    [ -f "$MARK/cells-$s.ok" ] && continue
    while [ ! -f "$MARK/fetch-$s.ok" ]; do
      if [ -f "$MARK/fetch-$s.failed" ]; then touch "$MARK/cells-$s.failed"; ev "CELLS-FAILED $s (no DEM)"; continue 2; fi
      sleep 60
    done
    local ok=0
    for i in 1 2 3; do
      ev "CELLS-START $s attempt $i"
      if BUILD_EXTRA_ARGS=--cells-only ./scripts/remote/run-shard.sh "$s" "$CELL_PARALLEL" --fg --no-fetch --no-purge-dem \
          >> "$LOGS/cells-$s.log" 2>&1; then ok=1; break; fi
      ev "CELLS-RETRY $s (tail: $(tail -1 "$LOGS/cells-$s.log" | cut -c1-150))"; sleep 30
    done
    if [ $ok = 1 ]; then touch "$MARK/cells-$s.ok"; ev "CELLS-OK $s"
    else touch "$MARK/cells-$s.failed"; ev "CELLS-FAILED $s"; fi
  done
  touch "$MARK/cell-lane.done"; ev "CELL-LANE-DONE"
}

merge_one() {
  local s="$1" ok=0
  for i in 1 2 3; do
    ev "MERGE-START $s attempt $i"
    # --merge-only reuses any batch whose .done marker matches, so a retry
    # only re-tiles the batch that died.
    if ./scripts/remote/run-shard.sh "$s" 8 --merge-only --no-purge-dem --fg >> "$LOGS/merge-$s.log" 2>&1; then ok=1; break; fi
    ev "MERGE-RETRY $s (tail: $(tail -1 "$LOGS/merge-$s.log" | cut -c1-150))"; sleep 30
  done
  if [ $ok = 1 ]; then touch "$MARK/merge-$s.ok"; ev "MERGE-OK $s $(du -h "public/data/tiles/world_$s.mbtiles" | cut -f1)"
  else touch "$MARK/merge-$s.failed"; ev "MERGE-FAILED $s"; fi
}

merge_pool() {
  while true; do
    local running=0 pending=0
    for s in "${SHARDS[@]}"; do
      if [ -f "$MARK/merge-$s.started" ] && [ ! -f "$MARK/merge-$s.ok" ] && [ ! -f "$MARK/merge-$s.failed" ]; then
        running=$((running + 1))
      fi
    done
    for s in "${SHARDS[@]}"; do
      { [ -f "$MARK/merge-$s.ok" ] || [ -f "$MARK/merge-$s.failed" ] || [ -f "$MARK/merge-$s.started" ]; } && continue
      [ -f "$MARK/cells-$s.failed" ] && continue
      pending=$((pending + 1))
      if [ -f "$MARK/cells-$s.ok" ] && [ "$running" -lt "$MAX_MERGES" ]; then
        touch "$MARK/merge-$s.started"; running=$((running + 1))
        merge_one "$s" &
      fi
    done
    [ "$pending" = 0 ] && [ "$running" = 0 ] && break
    sleep 60
  done
  ev "MERGES-DONE"
}

# A merge that was running when a previous driver died has a .started marker
# but no result; let the pool start it again (--merge-only resumes batches).
for s in "${SHARDS[@]}"; do
  if [ -f "$MARK/merge-$s.started" ] && [ ! -f "$MARK/merge-$s.ok" ] && [ ! -f "$MARK/merge-$s.failed" ]; then
    rm -f "$MARK/merge-$s.started"
  fi
done

ev "DRIVER-START shards: ${SHARDS[*]} (cells x$CELL_PARALLEL, merges <= $MAX_MERGES)"
fetch_all &
cell_lane &
merge_pool &
wait
ev "ALL-DONE $(cd "$MARK" && ls ./*.failed 2>/dev/null | tr '\n' ' ')"
