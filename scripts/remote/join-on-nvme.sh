#!/usr/bin/env bash
#
# Hybrid world-contour build, NVMe half: pull the batch mbtiles the (spinning
# disk) build box streamed to R2, tile-join them here, and produce + upload
# world.pmtiles.
#
# Why two boxes: tippecanoe writes its dedup mbtiles schema (map z/x/y ->
# hashed tile_id, images keyed by that hash), so tile-join's ordered scan is a
# random b-tree probe per tile. On a rotational array that ran at 1-3 MB/s
# (days per shard); on NVMe it is minutes. The cell work and tippecanoe tiling
# are CPU-bound and stay on whatever box is cheap per core.
#
# Prerequisites on this box: scripts/remote/bootstrap.sh (tippecanoe, pmtiles,
# node, rclone) and an rclone remote for R2 — see the setup notes at the top of
# scripts/remote/upload-world.sh. Everything below is resumable: rclone skips
# objects it already has, --join-batches only removes batches after success,
# and a shard that already has world_<shard>.mbtiles is not re-joined.
#
# Usage (from the repo root, ideally under `setsid nohup ... &`):
#   ./scripts/remote/join-on-nvme.sh              # pull + join + convert + validate + upload
#   ./scripts/remote/join-on-nvme.sh --pull-only  # just sync from R2 (run it early, overlaps the build box)
#   ./scripts/remote/join-on-nvme.sh --no-upload  # stop after validation
#
# Env:
#   RCLONE_REMOTE  rclone remote name  (default r2)
#   R2_BUCKET      bucket              (default aus-map-data)
#   BUILD_PREFIX   object prefix the build box uploaded to (default contours/world-build)
#   STAGE_DIR      local mirror of that prefix (default data/tiles/world-build)
#   OUTPUT_DIR     where shard/world files go (default public/data/tiles)
#
# Disk math (2026-09 estimates): batches ~1.1 TB + shards ~0.9 TB, then
# world.mbtiles (~0.9 TB) and world.pmtiles (~0.8 TB). Batches are deleted as
# each shard joins, so the peak is roughly 2.6 TB — rent >= 3 TB of NVMe.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-aus-map-data}"
BUILD_PREFIX="${BUILD_PREFIX:-contours/world-build}"
STAGE_DIR="${STAGE_DIR:-$PROJECT_ROOT/data/tiles/world-build}"
OUTPUT_DIR="${OUTPUT_DIR:-$PROJECT_ROOT/public/data/tiles}"
BUILD="npx tsx scripts/build-contours-world.ts"

PULL_ONLY=false
UPLOAD=true
while [ $# -gt 0 ]; do
  case "$1" in
    --pull-only) PULL_ONLY=true; shift ;;
    --no-upload) UPLOAD=false; shift ;;
    --help|-h) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

log() { echo "[$(date -u +%FT%TZ)] $*"; }

for c in rclone tile-join pmtiles node; do
  command -v "$c" > /dev/null 2>&1 || { echo "Error: $c not found — run scripts/remote/bootstrap.sh first" >&2; exit 1; }
done
rclone listremotes | grep -qx "${RCLONE_REMOTE}:" || { echo "Error: no rclone remote \"${RCLONE_REMOTE}\" (see upload-world.sh)" >&2; exit 1; }

# --- 1. Pull ---------------------------------------------------------------
# Sequential objects, so many transfers in flight is what fills the pipe.
log "pulling ${RCLONE_REMOTE}:${R2_BUCKET}/${BUILD_PREFIX} -> ${STAGE_DIR}"
mkdir -p "$STAGE_DIR" "$OUTPUT_DIR"
rclone copy --s3-no-check-bucket --transfers 8 --checkers 8 --stats 1m --stats-one-line \
  "${RCLONE_REMOTE}:${R2_BUCKET}/${BUILD_PREFIX}" "$STAGE_DIR"
log "pulled: $(du -sh "$STAGE_DIR" | cut -f1)"
if [ "$PULL_ONLY" = true ]; then
  ls -la "$STAGE_DIR"/shards "$STAGE_DIR"/batches/* 2>/dev/null || true
  exit 0
fi

# --- 2. Shards joined on the build box are used as they are -----------------
if [ -d "$STAGE_DIR/shards" ]; then
  for f in "$STAGE_DIR"/shards/world_*.mbtiles; do
    [ -e "$f" ] || continue
    if [ ! -e "$OUTPUT_DIR/$(basename "$f")" ]; then
      ln "$f" "$OUTPUT_DIR/$(basename "$f")" 2>/dev/null || cp "$f" "$OUTPUT_DIR/$(basename "$f")"
    fi
  done
fi

# --- 3. Join each shard's batches ------------------------------------------
# A shard both joined upstream and batched here keeps the upstream join.
for dir in "$STAGE_DIR"/batches/*/; do
  [ -d "$dir" ] || continue
  shard=$(basename "$dir")
  if [ -s "$OUTPUT_DIR/world_${shard}.mbtiles" ]; then
    log "shard $shard: world_${shard}.mbtiles already present, skipping its batches"
    continue
  fi
  n=$(ls "$dir"/batch-*.mbtiles 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] || { log "shard $shard: no batches, skipping"; continue; }
  log "shard $shard: joining $n batches ($(du -sh "$dir" | cut -f1))"
  $BUILD --shard "$shard" --join-batches --work-dir "$dir" --output-dir "$OUTPUT_DIR"
done

# --- 4. World join + PMTiles ------------------------------------------------
log "joining shards -> world.mbtiles -> world.pmtiles"
ls -la "$OUTPUT_DIR"/world_*.mbtiles
$BUILD --join --output-dir "$OUTPUT_DIR"

# --- 5. Validate (same checks as the runbook, section 6) -------------------
PM="$OUTPUT_DIR/world.pmtiles"
log "validating $PM"
pmtiles show "$PM"
pmtiles verify "$PM"
check_tile() {  # name z x y
  local bytes
  bytes=$(pmtiles tile "$PM" "$2" "$3" "$4" | wc -c)
  if [ "$bytes" -gt 100 ]; then
    echo "  ✓ $1 z$2/$3/$4: $bytes bytes"
  else
    echo "  ✗ $1 z$2/$3/$4: $bytes bytes" >&2
    return 1
  fi
}
# Mountains on five continents (coordinates verified against the Australia
# archive and the runbook); an empty one means a shard is missing.
check_tile "Mt Sonder (AU)"   15 28450 18593
check_tile "Mont Blanc"       12 2126 1459
check_tile "Alps z9 floor"     9 267 181
check_tile "Everest"          12 3037 1716
check_tile "Denali"           12 329 1116
check_tile "Aconcagua"        12 1251 2441
check_tile "Kilimanjaro"      12 2473 2082
log "validation passed: $(du -h "$PM" | cut -f1)"

# --- 6. Upload --------------------------------------------------------------
if [ "$UPLOAD" = true ]; then
  log "uploading via scripts/remote/upload-world.sh"
  PMTILES_FILE="$PM" RCLONE_REMOTE="$RCLONE_REMOTE" R2_BUCKET="$R2_BUCKET" "$SCRIPT_DIR/upload-world.sh"
  log "done — deploy the worker with the world source next (runbook section 7)"
else
  log "done (--no-upload); upload with scripts/remote/upload-world.sh"
fi
