#!/usr/bin/env bash
#
# Resilient resume for the grid-tile R2 upload.
#
# Unlike upload-tiles.sh (which runs under `set -e` and aborts the whole run on
# the first failed object), this script:
#   * checks the public R2 URL to find which objects are ACTUALLY missing,
#     so already-uploaded cells are skipped (no wasted re-uploads);
#   * uploads each missing object with a couple of retries;
#   * does NOT abort on a single failure — it records it and keeps going,
#     then prints a summary of anything still missing at the end.
#
# Usage:
#   ./scripts/upload-grid-resume.sh            # dry-run: list what's missing
#   ./scripts/upload-grid-resume.sh --upload   # actually upload the missing objects
#
# Requires: wrangler (authenticated via `wrangler login`), curl.

set -uo pipefail

BUCKET="aus-map-data"
GRID_DIR="public/data/tiles/grid"
PUBLIC_BASE="${PUBLIC_BASE:-https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev}"
RETRIES=3

DO_UPLOAD=0
[ "${1:-}" = "--upload" ] && DO_UPLOAD=1

if [ ! -d "$GRID_DIR" ]; then
  echo "Error: $GRID_DIR not found. Run from the repo root."
  exit 1
fi

# Emit "<local_path>\t<r2_key>\t<content_type>\t<cache_control>" for every
# object the grid upload is expected to contain.
enumerate_objects() {
  for cell in "$GRID_DIR"/E*_S*/; do
    [ -d "$cell" ] || continue
    cid=$(basename "$cell")
    for f in "$cell"*.mbtiles; do
      [ -f "$f" ] || continue
      printf '%s\tgrid/%s/%s\tapplication/octet-stream\tpublic, max-age=2592000\n' \
        "$f" "$cid" "$(basename "$f")"
    done
    if [ -f "$cell/manifest.json" ]; then
      printf '%s\tgrid/%s/manifest.json\tapplication/json\tpublic, max-age=3600\n' \
        "$cell/manifest.json" "$cid"
    fi
  done
  if [ -f "$GRID_DIR/index.json" ]; then
    printf '%s\tgrid/index.json\tapplication/json\tpublic, max-age=3600\n' \
      "$GRID_DIR/index.json"
  fi
}

is_present() {
  # HTTP 200 => object already in the bucket.
  local key="$1" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -I "$PUBLIC_BASE/$key")
  [ "$code" = "200" ]
}

put_object() {
  local src="$1" key="$2" ct="$3" cc="$4" attempt=1
  while [ "$attempt" -le "$RETRIES" ]; do
    if wrangler r2 object put "$BUCKET/$key" --remote --file "$src" \
        --content-type "$ct" --cache-control "$cc"; then
      return 0
    fi
    echo "    put failed (attempt $attempt/$RETRIES) for $key" >&2
    attempt=$((attempt + 1))
    sleep 3
  done
  return 1
}

missing=0
uploaded=0
failed=0
declare -a FAILED_KEYS=()

while IFS=$'\t' read -r src key ct cc; do
  if is_present "$key"; then
    continue
  fi
  missing=$((missing + 1))
  if [ "$DO_UPLOAD" -eq 0 ]; then
    echo "MISSING  $key"
    continue
  fi
  echo "Uploading $key ..."
  if put_object "$src" "$key" "$ct" "$cc"; then
    uploaded=$((uploaded + 1))
  else
    failed=$((failed + 1))
    FAILED_KEYS+=("$key")
  fi
done < <(enumerate_objects)

echo
echo "=================================================================="
if [ "$DO_UPLOAD" -eq 0 ]; then
  echo "DRY RUN: $missing object(s) still missing from the bucket."
  echo "Re-run with --upload to upload them."
else
  echo "Uploaded: $uploaded   Failed: $failed   (of $missing missing)"
  if [ "$failed" -gt 0 ]; then
    echo "Still failing (re-run to retry):"
    printf '  %s\n' "${FAILED_KEYS[@]}"
    exit 1
  fi
  echo "All missing grid objects uploaded."
fi
echo "=================================================================="
