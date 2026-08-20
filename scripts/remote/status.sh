#!/usr/bin/env bash
#
# Progress summary for the world contour build (issue #34).
#
# Prints, for the work dir data/tiles/contours-world:
#   - per-shard completed cells (.done markers) vs the shard's total land cells
#   - the shard mbtiles / world.mbtiles / world.pmtiles that exist, with sizes
#   - running build processes (fetch, gdal, tippecanoe, tile-join, pmtiles)
#   - free disk + memory
#   - the tail of the newest log in logs/
#
# Safe to run at any time; read-only.
#
# Usage:
#   ./scripts/remote/status.sh
#   ./scripts/remote/status.sh --tail 60     # more log lines
#   ./scripts/remote/status.sh --no-log      # skip the log tail

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WORK_DIR="$PROJECT_ROOT/data/tiles/contours-world"
DEM_DIR="$PROJECT_ROOT/data/dem-glo30"
OUTPUT_DIR="$PROJECT_ROOT/public/data/tiles"
LOG_DIR="$PROJECT_ROOT/logs"
GRID_MODULE="$PROJECT_ROOT/scripts/lib/world-grid.ts"

TAIL_LINES=20
SHOW_LOG=true

while [ $# -gt 0 ]; do
  case "$1" in
    --tail) TAIL_LINES="$2"; shift 2 ;;
    --no-log) SHOW_LOG=false; shift ;;
    --help|-h) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

hr() { printf '%s\n' "----------------------------------------------------------------"; }

echo "World contour build status — $(date -Is)"
echo "Work dir: $WORK_DIR"
hr

# --- Cells ---

done_total=0
if [ -d "$WORK_DIR" ]; then
  done_total="$(find "$WORK_DIR" -maxdepth 2 -name '*.done' | wc -l)"
fi
fgb_total=0
if [ -d "$WORK_DIR" ]; then
  fgb_total="$(find "$WORK_DIR" -maxdepth 2 -name '*_z*.fgb' | wc -l)"
fi

echo "Cells"
echo "  completed (.done markers): $done_total"
echo "  tier files (*_z*.fgb):     $fgb_total   (4 per completed cell)"

# Per-shard totals need the shard definitions, which live in the TypeScript
# grid module. Ask node for them; if the module is missing or its exports have
# moved, fall back to the filesystem-only counts above instead of failing.
shard_report=""
if [ -f "$GRID_MODULE" ] && command -v npx > /dev/null 2>&1; then
  helper="$(mktemp --suffix=.mts)"
  trap 'rm -f "$helper"' EXIT
  cat > "$helper" <<'HELPER'
// Per-shard done/total, derived from the world grid module + the work dir.
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

const gridModule = process.env.GRID_MODULE!;
const workDir = process.env.WORK_DIR!;
const demDir = process.env.DEM_DIR!;

const grid: Record<string, any> = await import(pathToFileURL(gridModule).href);
const enumerate = grid.enumerateWorldCells;
const shardFor = grid.shardForCell;
if (typeof enumerate !== 'function' || typeof shardFor !== 'function') {
  process.exit(3); // exports moved — caller falls back
}

// Land mask: the cached Copernicus tile list, when it is present. Without it
// every grid cell counts, which inflates the totals with ocean.
let landTiles: Set<string> | null = null;
const listPath = path.join(demDir, '.tileList.txt');
if (fs.existsSync(listPath)) {
  const text = fs.readFileSync(listPath, 'utf8');
  landTiles = typeof grid.parseTileListNames === 'function'
    ? grid.parseTileListNames(text)
    : new Set<string>(
        text.split('\n')
          .map((line) => (line.match(/([NS]\d{2})_00_([EW]\d{3})/) ?? []).slice(1, 3).join(''))
          .filter((name) => name.length > 0)
      );
}

const hasLand = (cell: any): boolean => {
  if (!landTiles || typeof grid.dem1DegTiles !== 'function' || typeof grid.demTileName !== 'function') {
    return true;
  }
  return grid.dem1DegTiles(cell).some((t: any) => landTiles!.has(grid.demTileName(t)));
};

const done = new Set(
  fs.existsSync(workDir)
    // Cells are staged per shard (workDir/{shard}/{cellId}.done), so walk
    // subdirectories rather than just the top level.
    ? fs.readdirSync(workDir, { recursive: true })
        .map((f) => path.basename(String(f)))
        .filter((f) => f.endsWith('.done'))
        .map((f) => f.replace(/\.done$/, ''))
    : []
);

const totals = new Map<string, { total: number; done: number }>();
for (const cell of enumerate()) {
  if (!hasLand(cell)) continue;
  let shard = 'unknown';
  try {
    shard = shardFor(cell) ?? 'unknown';
  } catch {
    shard = 'unknown';
  }
  const entry = totals.get(shard) ?? { total: 0, done: 0 };
  entry.total++;
  if (done.has(cell.id)) entry.done++;
  totals.set(shard, entry);
}

for (const [shard, { total, done: d }] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
  const pct = total ? ((d / total) * 100).toFixed(1) : '0.0';
  console.log(`${shard}\t${d}\t${total}\t${pct}`);
}
HELPER
  if shard_report="$(GRID_MODULE="$GRID_MODULE" WORK_DIR="$WORK_DIR" DEM_DIR="$DEM_DIR" \
        npx tsx "$helper" 2>/dev/null)"; then
    if [ -n "$shard_report" ]; then
      echo ""
      printf '  %-16s %8s %8s %8s\n' "shard" "done" "total" "pct"
      while IFS=$'\t' read -r shard d total pct; do
        [ -n "$shard" ] || continue
        printf '  %-16s %8s %8s %7s%%\n' "$shard" "$d" "$total" "$pct"
      done <<< "$shard_report"
      if [ ! -f "$DEM_DIR/.tileList.txt" ]; then
        echo "  (no land mask cached yet: totals count every grid cell, ocean"
        echo "   included, and shrink once $DEM_DIR/.tileList.txt exists)"
      fi
    fi
  else
    echo "  (per-shard totals unavailable — could not read $GRID_MODULE)"
  fi
  rm -f "$helper"
  trap - EXIT
else
  echo "  (per-shard totals unavailable — $GRID_MODULE not found)"
fi

# --- Artifacts ---

hr
echo "Artifacts"
found_artifact=false
shopt -s nullglob
artifacts=(
  "$WORK_DIR"/world_*.mbtiles
  "$OUTPUT_DIR"/world_*.mbtiles
  "$WORK_DIR"/world.mbtiles
  "$OUTPUT_DIR"/world.mbtiles
  "$OUTPUT_DIR"/world.pmtiles
)
shopt -u nullglob
for file in "${artifacts[@]}"; do
  [ -f "$file" ] || continue
  found_artifact=true
  printf '  %-52s %8s  %s\n' \
    "${file#"$PROJECT_ROOT"/}" \
    "$(du -h "$file" | cut -f1)" \
    "$(date -Is -r "$file")"
done
if [ "$found_artifact" = false ]; then
  echo "  (none yet)"
fi

# A merge that was killed leaves a growing-but-headerless file: an mbtiles/
# pmtiles whose header is written last is INVALID until the merge exits 0.
if [ -f "$OUTPUT_DIR/world.pmtiles" ]; then
  magic="$(od -An -tx1 -N8 "$OUTPUT_DIR/world.pmtiles" | tr -d ' \n')"
  if [ "$magic" = "504d54696c657303" ]; then
    echo "  ✓ world.pmtiles has a valid PMTiles v3 header"
  else
    echo "  ⚠ world.pmtiles has NO valid PMTiles header — incomplete/killed convert"
  fi
fi

# --- DEM cache ---

hr
echo "DEM cache ($DEM_DIR)"
if [ -d "$DEM_DIR" ]; then
  echo "  tiles: $(find "$DEM_DIR" -maxdepth 1 -name '*.tif' | wc -l)   size: $(du -sh "$DEM_DIR" | cut -f1)"
else
  echo "  (not created yet)"
fi

# --- Processes ---

hr
echo "Running processes"
proc_lines="$(pgrep -a -f 'build-contours-world|fetch-dem-copernicus|tippecanoe|tile-join|gdalwarp|gdal_contour|pmtiles convert' 2>/dev/null || true)"
if [ -n "$proc_lines" ]; then
  # One line per process, truncated: gdal command lines are enormous.
  echo "$proc_lines" | cut -c1-140 | sed 's/^/  /'
else
  echo "  (no build processes running)"
fi

for pid_file in "$LOG_DIR"/world-*.pid; do
  [ -f "$pid_file" ] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    echo "  driver $(basename "$pid_file" .pid): PID $pid alive"
  else
    echo "  driver $(basename "$pid_file" .pid): PID $pid NOT running (finished or killed)"
  fi
done

# --- Resources ---

hr
echo "Resources"
df -h "$PROJECT_ROOT" | sed 's/^/  /'
free -h | sed 's/^/  /'
if [ -r /var/log/kern.log ] || command -v journalctl > /dev/null 2>&1; then
  oom="$( (journalctl -k --since '2 days ago' 2>/dev/null || cat /var/log/kern.log 2>/dev/null) \
          | grep -ci 'Out of memory: Killed process' || true)"
  if [ "${oom:-0}" -gt 0 ]; then
    echo "  ⚠ $oom OOM kills in the last 2 days — check dmesg; the merge needs RAM+swap"
  fi
fi

# --- Newest log ---

if [ "$SHOW_LOG" = true ] && [ -d "$LOG_DIR" ]; then
  hr
  newest_log="$(find "$LOG_DIR" -maxdepth 1 -name 'world-*.log' -printf '%T@ %p\n' 2>/dev/null \
                | sort -nr | head -n1 | cut -d' ' -f2-)"
  if [ -n "$newest_log" ]; then
    echo "Newest log: ${newest_log#"$PROJECT_ROOT"/}  (last $TAIL_LINES lines)"
    tail -n "$TAIL_LINES" "$newest_log" | sed 's/^/  /'
  else
    echo "No logs in $LOG_DIR yet."
  fi
fi
