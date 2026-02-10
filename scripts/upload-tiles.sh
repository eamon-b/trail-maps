#!/usr/bin/env bash
#
# Upload built tile files to Cloudflare R2.
#
# Prerequisites:
#   1. Install wrangler: npm install -g wrangler
#   2. Authenticate: wrangler login
#
# Usage:
#   ./scripts/upload-tiles.sh                  # Upload all trails
#   ./scripts/upload-tiles.sh bibbulmun        # Upload one trail
#   ./scripts/upload-tiles.sh --grid           # Upload all grid tiles
#   ./scripts/upload-tiles.sh --grid E114_S34  # Upload one grid cell
#
# The script reads from public/data/tiles/ (the build output directory)
# and uploads to the aus-map-data R2 bucket.

set -euo pipefail

BUCKET="aus-map-data"
TILES_DIR="public/data/tiles"
GRID_DIR="$TILES_DIR/grid"

if ! command -v wrangler &> /dev/null; then
  echo "Error: wrangler CLI not found. Install with: npm install -g wrangler"
  exit 1
fi

if [ ! -d "$TILES_DIR" ]; then
  echo "Error: $TILES_DIR does not exist. Run build:tiles first."
  exit 1
fi

upload_file() {
  local src="$1"
  local dest="$2"
  local content_type="$3"
  local cache_control="$4"

  echo "  Uploading $dest ($content_type)"
  wrangler r2 object put "$BUCKET/$dest" \
    --remote \
    --file "$src" \
    --content-type "$content_type" \
    --cache-control "$cache_control"
}

upload_trail() {
  local trail_id="$1"
  local trail_dir="$TILES_DIR/$trail_id"

  if [ ! -d "$trail_dir" ]; then
    echo "Error: No tiles found for trail '$trail_id' at $trail_dir"
    exit 1
  fi

  echo "Uploading tiles for $trail_id..."

  for mbtiles in "$trail_dir"/*.mbtiles; do
    [ -f "$mbtiles" ] || continue
    local filename
    filename=$(basename "$mbtiles")
    upload_file "$mbtiles" "$trail_id/$filename" \
      "application/octet-stream" \
      "public, max-age=2592000"
  done

  if [ -f "$trail_dir/manifest.json" ]; then
    upload_file "$trail_dir/manifest.json" "$trail_id/manifest.json" \
      "application/json" \
      "public, max-age=3600"
  fi

  echo "Done: $trail_id"
}

# Upload root manifest if it exists
upload_root_manifest() {
  if [ -f "$TILES_DIR/manifest.json" ]; then
    echo "Uploading root manifest..."
    upload_file "$TILES_DIR/manifest.json" "manifest.json" \
      "application/json" \
      "public, max-age=3600"
  fi
}

# --- Grid tile upload functions ---

upload_grid_cell() {
  local cell_id="$1"
  local cell_dir="$GRID_DIR/$cell_id"

  if [ ! -d "$cell_dir" ]; then
    echo "Error: No tiles found for grid cell '$cell_id' at $cell_dir"
    exit 1
  fi

  echo "Uploading grid cell $cell_id..."

  for mbtiles in "$cell_dir"/*.mbtiles; do
    [ -f "$mbtiles" ] || continue
    local filename
    filename=$(basename "$mbtiles")
    upload_file "$mbtiles" "grid/$cell_id/$filename" \
      "application/octet-stream" \
      "public, max-age=2592000"
  done

  if [ -f "$cell_dir/manifest.json" ]; then
    upload_file "$cell_dir/manifest.json" "grid/$cell_id/manifest.json" \
      "application/json" \
      "public, max-age=3600"
  fi

  echo "Done: grid/$cell_id"
}

upload_grid() {
  local specific_cell="${1:-}"

  if [ ! -d "$GRID_DIR" ]; then
    echo "Error: $GRID_DIR does not exist. Run build-grid-tiles first."
    exit 1
  fi

  if [ -n "$specific_cell" ]; then
    # Upload a specific grid cell
    upload_grid_cell "$specific_cell"
  else
    # Upload all grid cells
    for cell_dir in "$GRID_DIR"/E*_S*/; do
      [ -d "$cell_dir" ] || continue
      cell_id=$(basename "$cell_dir")
      upload_grid_cell "$cell_id"
    done

    # Upload grid index
    if [ -f "$GRID_DIR/index.json" ]; then
      echo "Uploading grid index..."
      upload_file "$GRID_DIR/index.json" "grid/index.json" \
        "application/json" \
        "public, max-age=3600"
    fi
  fi
}

# --- Main dispatch ---

if [ $# -ge 1 ] && [ "$1" = "--grid" ]; then
  # Grid mode
  shift
  upload_grid "${1:-}"
elif [ $# -ge 1 ]; then
  # Upload specific trail(s)
  for trail_id in "$@"; do
    upload_trail "$trail_id"
  done
else
  # Upload all trails
  for trail_dir in "$TILES_DIR"/*/; do
    [ -d "$trail_dir" ] || continue
    trail_id=$(basename "$trail_dir")
    # Skip the grid directory (not a trail)
    [ "$trail_id" = "grid" ] && continue
    upload_trail "$trail_id"
  done
  upload_root_manifest
fi

echo ""
echo "Upload complete."
