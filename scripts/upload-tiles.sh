#!/usr/bin/env bash
#
# Upload built tile files to Cloudflare R2.
#
# Prerequisites:
#   1. Install wrangler: npm install -g wrangler
#   2. Authenticate: wrangler login
#
# Usage:
#   ./scripts/upload-tiles.sh                  # Upload all per-trail files (not national contours)
#   ./scripts/upload-tiles.sh bibbulmun        # Upload one trail
#   ./scripts/upload-tiles.sh --grid           # Upload all grid tiles
#   ./scripts/upload-tiles.sh --grid E114_S34  # Upload one grid cell
#   ./scripts/upload-tiles.sh --contours       # Upload australia-contours.pmtiles
#   ./scripts/upload-tiles.sh --verify-contours # Check the Worker can read the archive
#
# The script reads from public/data/tiles/ (the build output directory)
# and uploads to the aus-map-data R2 bucket.
#
# Per-trail and per-grid-cell uploads are manifest-driven: each directory must
# contain a manifest.json (written by the tile build), whose files[] entries
# name the local files to upload and the content-addressed remote keys to put
# them at. The manifest is uploaded last — see upload_manifest_dir.

set -euo pipefail

BUCKET="${R2_BUCKET:-aus-map-data}"
TILES_DIR="${TILES_DIR:-public/data/tiles}"
GRID_DIR="$TILES_DIR/grid"
CONTOUR_LOCAL_FILENAME="australia-contours.pmtiles"
CONTOUR_OBJECT_KEY="contours/australia.pmtiles"
CONTOUR_WORKER_URL="${CONTOUR_WORKER_URL:-https://contour-tiles.aus-map-data.workers.dev}"

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" &> /dev/null; then
    echo "Error: $command_name not found. $install_hint"
    exit 1
  fi
}

require_tiles_dir() {
  if [ ! -d "$TILES_DIR" ]; then
    echo "Error: $TILES_DIR does not exist. Run build:tiles first."
    exit 1
  fi
}

upload_file() {
  local src="$1"
  local dest="$2"
  local content_type="$3"
  local cache_control="$4"

  require_command "wrangler" "Install it with: npm install -g wrangler"
  echo "  Uploading $dest ($content_type)"
  wrangler r2 object put "$BUCKET/$dest" \
    --remote \
    --file "$src" \
    --content-type "$content_type" \
    --cache-control "$cache_control"
}

# Refuse to upload an mbtiles that would be unusable (or crash the app) on a
# device: must pass sqlite integrity_check and contain at least one tile.
# An empty stub (AAWT, 2026-04) and a corrupt database (bibbulmun, 2026-04)
# have both been uploaded silently in the past; MapLibre native aborts the
# whole app on files like these.
validate_mbtiles() {
  local mbtiles="$1"

  require_command "sqlite3" "Install it with your package manager (e.g. dnf install sqlite)"

  local integrity
  if ! integrity=$(sqlite3 "$mbtiles" "PRAGMA integrity_check;" 2>&1); then
    echo "Error: $mbtiles is not a readable SQLite database: $integrity"
    exit 1
  fi
  if [ "$integrity" != "ok" ]; then
    echo "Error: $mbtiles failed integrity check: $integrity"
    exit 1
  fi

  local tile_count
  tile_count=$(sqlite3 "$mbtiles" "SELECT count(*) FROM tiles;" 2>/dev/null || echo 0)
  if [ "${tile_count:-0}" -lt 1 ]; then
    echo "Error: $mbtiles contains no tiles — refusing to upload an empty tile database"
    exit 1
  fi

  echo "  Validated $(basename "$mbtiles"): $tile_count tiles, integrity ok"
}

# Print one "<local name>\t<remote key>" line per manifest entry.
#
# Parsed with node (guaranteed present — the whole build pipeline is Node) so
# this script does not pick up a jq dependency. Entries without a `key` fall
# back to `name`, which is how manifests built before content addressing are
# uploaded unchanged.
read_manifest_entries() {
  local manifest_file="$1"

  require_command "node" "Install Node.js, then retry."

  node -e '
    const fs = require("fs");
    const manifestPath = process.argv[1];
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (e) {
      console.error(`${manifestPath}: could not parse manifest — ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      console.error(`${manifestPath}: manifest lists no files`);
      process.exit(1);
    }
    for (const file of manifest.files) {
      const name = file && file.name;
      if (typeof name !== "string" || name === "" || name.includes("/")) {
        console.error(`${manifestPath}: invalid file name ${JSON.stringify(name)}`);
        process.exit(1);
      }
      const key = typeof file.key === "string" && file.key !== "" ? file.key : name;
      if (key.includes("/") || key.includes("..")) {
        console.error(`${manifestPath}: invalid object key ${JSON.stringify(key)}`);
        process.exit(1);
      }
      process.stdout.write(`${name}\t${key}\n`);
    }
  ' "$manifest_file"
}

# Upload every file a manifest lists, then the manifest itself.
#
# The manifest is uploaded LAST and is the atomic commit point of the whole
# operation. Payload files go to their content-addressed `key`, so a new build
# never overwrites the bytes an already-published manifest points at: a client
# that fetched the old manifest a moment before this runs keeps downloading the
# old, still-intact objects, and a mid-loop failure leaves the live manifest
# (and therefore every client) on the previous consistent set.
#
# Local filenames stay plain (`base.mbtiles`) — `key` is a remote-only alias,
# and the app writes downloads to `name` on device.
#
# Superseded objects at old keys are deliberately left in the bucket: older
# manifests still reference them. Cleanup is manual for now (list the bucket,
# keep whatever any live manifest references, delete the rest).
upload_manifest_dir() {
  local src_dir="$1"
  local remote_prefix="$2"
  local manifest_file="$src_dir/manifest.json"

  if [ ! -f "$manifest_file" ]; then
    echo "Error: $manifest_file not found."
    echo "Uploads are manifest-driven — run the tile build first to generate it"
    echo "(e.g. npx tsx scripts/build-tiles.ts --trail <id>)."
    exit 1
  fi

  local entries
  if ! entries=$(read_manifest_entries "$manifest_file"); then
    exit 1
  fi

  # Here-string keeps the loop in the current shell so a failure exits the script.
  while IFS=$'\t' read -r name key; do
    [ -n "$name" ] || continue
    local src="$src_dir/$name"
    if [ ! -f "$src" ]; then
      echo "Error: manifest lists '$name' but $src does not exist. Rebuild before uploading."
      exit 1
    fi
    case "$name" in
      *.mbtiles) validate_mbtiles "$src" ;;
    esac
    upload_file "$src" "$remote_prefix/$key" \
      "application/octet-stream" \
      "public, max-age=2592000"
  done <<< "$entries"

  # Last: publishing the manifest is what makes the new objects live.
  upload_file "$manifest_file" "$remote_prefix/manifest.json" \
    "application/json" \
    "public, max-age=3600"
}

upload_trail() {
  local trail_id="$1"
  local trail_dir="$TILES_DIR/$trail_id"

  require_tiles_dir

  if [ ! -d "$trail_dir" ]; then
    echo "Error: No tiles found for trail '$trail_id' at $trail_dir"
    exit 1
  fi

  echo "Uploading tiles for $trail_id..."

  upload_manifest_dir "$trail_dir" "$trail_id"

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

  # Grid manifests come from the same writeManifest() as trail manifests, so
  # they carry the same content-addressed keys — keep both paths identical.
  upload_manifest_dir "$cell_dir" "grid/$cell_id"

  echo "Done: grid/$cell_id"
}

upload_grid() {
  local specific_cell="${1:-}"

  require_tiles_dir

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

# --- Contour PMTiles upload ---

# wrangler `r2 object put` rejects uploads over ~300MiB; the Australia contour
# PMTiles is several GB, so it must go through an S3-compatible multipart
# client. RCLONE_REMOTE selects the Cloudflare S3 remote (defaults to "r2").
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
WRANGLER_MAX_BYTES="${WRANGLER_MAX_BYTES:-$((300 * 1024 * 1024))}"

validate_contour_archive() {
  local pmtiles_file="$1"
  local magic

  # PMTiles v3 begins with the ASCII bytes "PMTiles" followed by version 3.
  magic=$(od -An -tx1 -N8 "$pmtiles_file" | tr -d ' \n')
  if [ "$magic" != "504d54696c657303" ]; then
    echo "Error: $pmtiles_file is not a valid PMTiles v3 archive."
    exit 1
  fi
}

verify_contours() {
  require_command "curl" "Install curl, then retry."

  local health_url="${CONTOUR_WORKER_URL%/}/health"
  local body
  if ! body=$(curl --silent --show-error --fail-with-body "$health_url"); then
    echo "Error: the contour Worker did not confirm the R2 archive at $CONTOUR_OBJECT_KEY."
    if [ -n "$body" ]; then
      echo "Worker response: $body"
    fi
    echo "Check that RCLONE_REMOTE points to the same Cloudflare account as $CONTOUR_WORKER_URL."
    return 1
  fi

  if [[ ! "$body" =~ \"ok\"[[:space:]]*:[[:space:]]*true ]]; then
    echo "Error: unexpected contour Worker health response: $body"
    return 1
  fi

  echo "Verified: $CONTOUR_WORKER_URL can read $BUCKET/$CONTOUR_OBJECT_KEY"
}

upload_contours() {
  require_tiles_dir

  local pmtiles_file="$TILES_DIR/$CONTOUR_LOCAL_FILENAME"

  if [ ! -f "$pmtiles_file" ]; then
    echo "Error: $pmtiles_file not found. Run build-contours-australia first."
    exit 1
  fi

  validate_contour_archive "$pmtiles_file"

  local size
  size=$(wc -c < "$pmtiles_file")

  if [ "$size" -le "$WRANGLER_MAX_BYTES" ]; then
    echo "Uploading contour PMTiles via wrangler..."
    upload_file "$pmtiles_file" "$CONTOUR_OBJECT_KEY" \
      "application/octet-stream" \
      "public, max-age=2592000"
  else
    echo "Contour PMTiles is $((size / 1024 / 1024))MB — over wrangler's 300MiB limit."
    echo "R2 destination: ${RCLONE_REMOTE}:$BUCKET/$CONTOUR_OBJECT_KEY"
    echo "The rclone remote must belong to the same account as $CONTOUR_WORKER_URL."
    if command -v rclone &> /dev/null && rclone listremotes | grep -q "^${RCLONE_REMOTE}:"; then
      echo "Checking object access without requesting bucket-management permissions..."
      if ! rclone lsf --s3-no-check-bucket --max-depth 1 "${RCLONE_REMOTE}:$BUCKET" > /dev/null; then
        echo "Error: rclone cannot access the existing $BUCKET bucket."
        echo "Check the remote endpoint and that the token has Object Read & Write access to this bucket."
        exit 1
      fi
      echo "Uploading via rclone (multipart)..."
      rclone copyto --progress --s3-no-check-bucket \
        --s3-upload-cutoff 64M --s3-chunk-size 64M \
        "$pmtiles_file" "${RCLONE_REMOTE}:$BUCKET/$CONTOUR_OBJECT_KEY"
    else
      cat <<EOF
No rclone remote named "${RCLONE_REMOTE}" found. To upload files this large:
  1. Create an R2 API token (S3 credentials) in the Cloudflare dashboard:
     R2 > Manage R2 API Tokens > Create (Object Read & Write on $BUCKET)
  2. Run "rclone config" and create a uniquely named S3 remote using:
       provider: Cloudflare
       endpoint: https://<owning-account-id>.r2.cloudflarestorage.com
       advanced option no_check_bucket: true
  3. Re-run with that remote name:
       RCLONE_REMOTE=<remote-name> npm run upload:tiles -- --contours
EOF
      exit 1
    fi
  fi
  verify_contours
  echo "Done: $CONTOUR_OBJECT_KEY"
}

# --- Main dispatch ---

if [ $# -ge 1 ] && [ "$1" = "--grid" ]; then
  # Grid mode
  shift
  upload_grid "${1:-}"
elif [ $# -ge 1 ] && [ "$1" = "--contours" ]; then
  # Contour PMTiles mode
  upload_contours
elif [ $# -ge 1 ] && [ "$1" = "--verify-contours" ]; then
  verify_contours
elif [ $# -ge 1 ]; then
  # Upload specific trail(s)
  for trail_id in "$@"; do
    upload_trail "$trail_id"
  done
else
  require_tiles_dir
  # Upload all trails
  for trail_dir in "$TILES_DIR"/*/; do
    [ -d "$trail_dir" ] || continue
    trail_id=$(basename "$trail_dir")
    # Skip the grid directory (not a trail)
    [ "$trail_id" = "grid" ] && continue
    upload_trail "$trail_id"
  done
  upload_root_manifest
  echo ""
  echo "Note: the Australia-wide online contour archive is a separate upload."
  echo "Run: npm run upload:tiles -- --contours"
fi

echo ""
echo "Upload complete."
