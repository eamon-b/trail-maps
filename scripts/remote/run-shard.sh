#!/usr/bin/env bash
#
# Build one world-contour shard on the remote box (issue #34).
#
# Fetches the shard's Copernicus GLO-30 DEM tiles, then runs
# scripts/build-contours-world.ts over the shard's cells (staged in
# data/tiles/contours-world/{shard}/) and merges them into
# public/data/tiles/world_{shard}.mbtiles.
#
# By default the whole thing is DETACHED (setsid nohup) and logged to
# logs/world-{shard}-{timestamp}.log, so it survives the ssh session dropping —
# a multi-day build must never be tied to a terminal. The script prints the PID
# and a tail command and exits immediately.
#
# Usage:
#   ./scripts/remote/run-shard.sh oceania              # detached, parallel = nproc-4
#   ./scripts/remote/run-shard.sh europe 24            # detached, parallel = 24
#   ./scripts/remote/run-shard.sh oceania --fg         # run attached (small shards, debugging)
#   ./scripts/remote/run-shard.sh oceania --no-fetch   # DEM already on disk
#   ./scripts/remote/run-shard.sh oceania --merge-only # redo just the tippecanoe merge
#   ./scripts/remote/run-shard.sh oceania --no-purge-dem
#
# Environment overrides:
#   MIN_FREE_DISK_GB   refuse to start below this much free space (default 500)
#   WARN_RAM_GB        warn below this much RAM (default 64)
#   BUILD_EXTRA_ARGS   extra args appended to build-contours-world.ts
#
# Resuming after a crash/OOM: just re-run the same command. Cells that finished
# wrote a `.done` marker and are skipped; the merge is redone from scratch.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

WORK_DIR="$PROJECT_ROOT/data/tiles/contours-world"
LOG_DIR="$PROJECT_ROOT/logs"
MIN_FREE_DISK_GB="${MIN_FREE_DISK_GB:-500}"
WARN_RAM_GB="${WARN_RAM_GB:-64}"

FOREGROUND=false
FETCH_DEM=true
PURGE_DEM=true
MERGE_ONLY=false
SHARD=""
PARALLEL=""

while [ $# -gt 0 ]; do
  case "$1" in
    --fg|--foreground) FOREGROUND=true; shift ;;
    --no-fetch) FETCH_DEM=false; shift ;;
    --no-purge-dem) PURGE_DEM=false; shift ;;
    --merge-only) MERGE_ONLY=true; FETCH_DEM=false; shift ;;
    --help|-h)
      sed -n '2,30p' "$0"
      exit 0
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
    *)
      if [ -z "$SHARD" ]; then
        SHARD="$1"
      elif [ -z "$PARALLEL" ]; then
        PARALLEL="$1"
      else
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [ -z "$SHARD" ]; then
  echo "Usage: $0 <shard> [parallel] [--fg] [--no-fetch] [--merge-only]" >&2
  exit 1
fi

# Shard and parallelism end up inside a generated runner script; keep them to
# characters that cannot mean anything to the shell.
if ! printf '%s' "$SHARD" | grep -Eq '^[A-Za-z0-9_-]+$'; then
  echo "Error: invalid shard name '$SHARD' (expected [A-Za-z0-9_-]+)." >&2
  exit 1
fi
if [ -n "$PARALLEL" ] && ! printf '%s' "$PARALLEL" | grep -Eq '^[1-9][0-9]*$'; then
  echo "Error: parallel must be a positive integer, got '$PARALLEL'." >&2
  exit 1
fi

# --- Preflight ---

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" > /dev/null 2>&1; then
    echo "Error: $command_name not found. $install_hint" >&2
    exit 1
  fi
}

require_command node "Run scripts/remote/bootstrap.sh first."
require_command npx "Run scripts/remote/bootstrap.sh first."
require_command gdalinfo "Run scripts/remote/bootstrap.sh first (needs gdal-bin)."
require_command tippecanoe "Run scripts/remote/bootstrap.sh first."
require_command setsid "Install util-linux (setsid), or use --fg."

BUILD_SCRIPT="$PROJECT_ROOT/scripts/build-contours-world.ts"
FETCH_SCRIPT="$PROJECT_ROOT/scripts/fetch-dem-copernicus.ts"
if [ ! -f "$BUILD_SCRIPT" ]; then
  echo "Error: $BUILD_SCRIPT not found — wrong checkout or wrong branch?" >&2
  exit 1
fi
if [ "$FETCH_DEM" = true ] && [ ! -f "$FETCH_SCRIPT" ]; then
  echo "Error: $FETCH_SCRIPT not found — wrong checkout or wrong branch?" >&2
  exit 1
fi

mkdir -p "$WORK_DIR" "$LOG_DIR"

# Disk: the shard's DEM (100-200 GB), its FlatGeobuf tiers, and tippecanoe's
# temp spill (tens of GB) all live under the project root. Running out mid-merge
# leaves an unusable half-written mbtiles.
free_kb="$(df -Pk "$PROJECT_ROOT" | awk 'NR==2 {print $4}')"
free_gb=$(( free_kb / 1024 / 1024 ))
if [ "$free_gb" -lt "$MIN_FREE_DISK_GB" ]; then
  echo "Error: only ${free_gb} GB free on the filesystem holding $PROJECT_ROOT" >&2
  echo "(need >= ${MIN_FREE_DISK_GB} GB: shard DEM + tiers + tippecanoe temp spill)." >&2
  echo "Free space, move the checkout to the NVMe volume, or lower MIN_FREE_DISK_GB." >&2
  exit 1
fi

ram_gb=$(( $(awk '/^MemTotal:/ {print $2}' /proc/meminfo) / 1024 / 1024 ))
if [ "$ram_gb" -lt "$WARN_RAM_GB" ]; then
  echo "⚠ Only ${ram_gb} GB RAM (recommended >= ${WARN_RAM_GB} GB)."
  echo "  The tippecanoe merge is RAM-bound: on a 15 GB laptop the 248-cell"
  echo "  Australia merge spent ~20 h clustering after ~4 h of tiling, and the"
  echo "  OOM killer kills detached builds without a word in the log."
  echo "  Add swap on the NVMe and expect a much longer merge."
fi

# tippecanoe's -t temp dir is set by the build script to the work dir; make sure
# that is NOT a tmpfs (it spills tens of GB and would blow the RAM budget).
work_fstype="$(df -PT "$WORK_DIR" | awk 'NR==2 {print $2}')"
case "$work_fstype" in
  tmpfs|ramfs)
    echo "Error: $WORK_DIR is on $work_fstype (RAM-backed)." >&2
    echo "tippecanoe spills tens of GB of sort files there. Move the checkout" >&2
    echo "to a real disk before building." >&2
    exit 1
    ;;
esac

if [ -z "$PARALLEL" ]; then
  PARALLEL="$(nproc --ignore=4)"
  [ "${PARALLEL:-0}" -ge 1 ] || PARALLEL=1
fi

BUILD_ARGS=(--shard "$SHARD" --parallel "$PARALLEL")
if [ "$PURGE_DEM" = true ]; then BUILD_ARGS+=(--purge-dem); fi
if [ "$MERGE_ONLY" = true ]; then BUILD_ARGS+=(--merge-only); fi
if [ -n "${BUILD_EXTRA_ARGS:-}" ]; then
  # shellcheck disable=SC2206  # deliberate word splitting: caller-supplied argv
  BUILD_ARGS+=(${BUILD_EXTRA_ARGS})
fi

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOG_FILE="$LOG_DIR/world-${SHARD}-${TIMESTAMP}.log"
PID_FILE="$LOG_DIR/world-${SHARD}.pid"

echo "Shard:      $SHARD"
echo "Parallel:   $PARALLEL"
echo "Fetch DEM:  $FETCH_DEM"
echo "Purge DEM:  $PURGE_DEM"
echo "Work dir:   $WORK_DIR ($work_fstype, ${free_gb} GB free)"
echo "RAM:        ${ram_gb} GB"
echo "Log:        $LOG_FILE"
echo ""

# The fetch and the build run as one sequential unit so a single detached
# session covers both (the DEM download for a shard is itself hours long).
run_pipeline() {
  echo "=== $(date -Is) world shard '$SHARD' start (parallel=$PARALLEL) ==="
  if [ "$FETCH_DEM" = true ]; then
    echo "--- fetching Copernicus GLO-30 DEM for shard $SHARD ---"
    npx tsx "$FETCH_SCRIPT" --shard "$SHARD"
  fi
  echo "--- building contours for shard $SHARD ---"
  npx tsx "$BUILD_SCRIPT" "${BUILD_ARGS[@]}"
  echo "=== $(date -Is) world shard '$SHARD' finished ok ==="
}

if [ "$FOREGROUND" = true ]; then
  cd "$PROJECT_ROOT"
  run_pipeline 2>&1 | tee -a "$LOG_FILE"
  exit "${PIPESTATUS[0]}"
fi

rm -f "$PID_FILE"

# The detached job is a generated script rather than an inline `bash -c` blob:
# it is readable in the log dir next to its log, and re-runnable by hand if the
# operator wants to repeat exactly what ran.
RUNNER="$LOG_DIR/world-${SHARD}-${TIMESTAMP}.sh"
# The single quotes are deliberate: $$ / $(date) / $status must be evaluated
# when the generated runner executes, not now.
# shellcheck disable=SC2016
{
  echo '#!/usr/bin/env bash'
  echo '# Generated by scripts/remote/run-shard.sh — safe to re-run by hand.'
  echo 'set -uo pipefail'
  printf 'echo $$ > %q\n' "$PID_FILE"
  printf 'cd %q || exit 1\n' "$PROJECT_ROOT"
  printf 'echo "=== $(date -Is) world shard %s start (parallel=%s) ==="\n' "$SHARD" "$PARALLEL"
  if [ "$FETCH_DEM" = true ]; then
    printf 'echo "--- fetching Copernicus GLO-30 DEM for shard %s ---"\n' "$SHARD"
    printf 'npx tsx %q --shard %s || exit $?\n' "$FETCH_SCRIPT" "$SHARD"
  fi
  printf 'echo "--- building contours for shard %s ---"\n' "$SHARD"
  printf 'npx tsx %q' "$BUILD_SCRIPT"
  printf ' %q' "${BUILD_ARGS[@]}"
  printf '\n'
  echo 'status=$?'
  printf 'echo "=== $(date -Is) world shard %s exit status: $status ==="\n' "$SHARD"
  echo 'exit $status'
} > "$RUNNER"
chmod +x "$RUNNER"

# Detached: new session (setsid) + no HUP + no controlling terminal, so the
# build outlives the ssh connection. Everything goes to the log file; stdin is
# /dev/null so nothing can block on a prompt.
setsid nohup "$RUNNER" > "$LOG_FILE" 2>&1 < /dev/null &

# The pid we want is the one *inside* the new session, which the wrapper writes
# to $PID_FILE; $! is the short-lived setsid parent.
build_pid=""
for _ in $(seq 1 50); do
  if [ -s "$PID_FILE" ]; then
    build_pid="$(cat "$PID_FILE")"
    break
  fi
  sleep 0.2
done

if [ -z "$build_pid" ]; then
  echo "⚠ Could not read the build PID from $PID_FILE — check the log:"
  echo "    tail -f $LOG_FILE"
  exit 0
fi

cat <<EOF
Started detached: PID $build_pid (session leader, survives logout)

  Runner:  $RUNNER
  Follow:  tail -f $LOG_FILE
  Status:  ./scripts/remote/status.sh
  Stop:    kill $build_pid          # then re-run this command to resume
                                    # (cells with .done markers are skipped)

Do NOT kill it during the tippecanoe merge unless you must: the mbtiles/pmtiles
header is written last, so a killed merge leaves an INVALID output file. Re-run
with --merge-only to redo just that step.
EOF
