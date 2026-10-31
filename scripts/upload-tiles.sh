#!/usr/bin/env bash
#
# Upload built tile files to Cloudflare R2.
#
# Prerequisites:
#   1. wrangler is a root devDependency: run `npm install`, then start this
#      through `npm run upload:tiles`, which puts node_modules/.bin on PATH
#   2. Authenticate: wrangler login (or CLOUDFLARE_API_TOKEN in the environment)
#
# Usage:
#   ./scripts/upload-tiles.sh                  # Upload all per-trail files
#   ./scripts/upload-tiles.sh bibbulmun        # Upload one trail
#   ./scripts/upload-tiles.sh --no-purge <...>   # Leave the edge cache alone (see purge_public_url)
#
# The script reads from public/data/tiles/ (the build output directory)
# and uploads to the tracknotes-data R2 bucket.
#
# Per-trail uploads are manifest-driven: each trail directory must
# contain a manifest.json (written by the tile build), whose files[] entries
# name the local files to upload and the content-addressed remote keys to put
# them at. The manifest is uploaded last — see upload_manifest_dir.

set -euo pipefail

BUCKET="${R2_BUCKET:-tracknotes-data}"
TILES_DIR="${TILES_DIR:-public/data/tiles}"
# Public URL of the same bucket, for checking what is already published.
TILE_PUBLIC_URL="${TILE_PUBLIC_URL:-https://data.tracknotes.info}"
# Zone of TILE_PUBLIC_URL, for purging republished manifests (not a secret).
CLOUDFLARE_ZONE_ID="${CLOUDFLARE_ZONE_ID:-6d82923521a33b69874327ded7b2b325}"

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

  require_command "wrangler" "Run npm install, then start this with: npm run upload:tiles"
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

# Print one "<local name>\t<remote key>\t<size>" line per manifest entry.
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
      process.stdout.write(`${name}\t${key}\t${Number(file.size) || 0}\n`);
    }
  ' "$manifest_file"
}

# wrangler `r2 object put` rejects uploads over ~300MiB. Te Araroa's and the
# CDT's contours (~1 GB+) are past it, so anything that large goes through an
# S3-compatible multipart client. RCLONE_REMOTE
# selects the Cloudflare S3 remote (defaults to "r2").
RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
WRANGLER_MAX_BYTES="${WRANGLER_MAX_BYTES:-$((300 * 1024 * 1024))}"

has_rclone_remote() {
  command -v rclone &> /dev/null && rclone listremotes | grep -q "^${RCLONE_REMOTE}:"
}

print_rclone_setup() {
  cat <<EOF
No rclone remote named "${RCLONE_REMOTE}" found. To upload files this large:
  1. Create an R2 API token (S3 credentials) in the Cloudflare dashboard:
     R2 > Manage R2 API Tokens > Create (Object Read & Write on $BUCKET)
  2. Run "rclone config" and create a uniquely named S3 remote using:
       provider: Cloudflare
       endpoint: https://<owning-account-id>.r2.cloudflarestorage.com
       advanced option no_check_bucket: true
  3. Re-run with that remote name:
       RCLONE_REMOTE=<remote-name> ./scripts/upload-tiles.sh <same arguments>
EOF
}

# A manifest payload file: wrangler when it fits, rclone multipart when it
# doesn't, with the same Cache-Control either way.
upload_payload_file() {
  local src="$1"
  local dest="$2"
  local cache_control="public, max-age=2592000"

  if [ "$(wc -c < "$src")" -le "$WRANGLER_MAX_BYTES" ]; then
    upload_file "$src" "$dest" "application/octet-stream" "$cache_control"
    return
  fi
  if ! has_rclone_remote; then
    print_rclone_setup
    exit 1
  fi
  echo "  Uploading $dest via rclone (multipart, $(( $(wc -c < "$src") / 1024 / 1024 ))MB)"
  rclone copyto --progress --s3-no-check-bucket \
    --s3-upload-cutoff 64M --s3-chunk-size 64M \
    --header-upload "Cache-Control: $cache_control" \
    --header-upload "Content-Type: application/octet-stream" \
    "$src" "${RCLONE_REMOTE}:$BUCKET/$dest"
}

# True when the bucket serves <key> publicly at exactly <size> bytes. Keys are
# content-addressed, so the right size at the right key is the same file.
is_published() {
  local key="$1"
  local size="$2"
  [ "${size:-0}" -gt 0 ] || return 1
  local length
  length=$(curl --silent --fail --head "$TILE_PUBLIC_URL/$key" \
    | tr -d '\r' | awk 'tolower($1) == "content-length:" { print $2 }' | tail -n 1)
  [ "$length" = "$size" ]
}

# Drop a republished file from Cloudflare's edge cache. The edge keeps
# manifest.json far past its max-age (on 2026-10-12 larapinta's was 5.5 days
# old), and the app fetches the plain URL, so without a purge phones go on
# seeing the previous manifest — and no update — for days. Needs an API token
# with Cache Purge on the zone (wrangler's CLOUDFLARE_API_TOKEN can have it).
#
# A purge that cannot be done fails the script (after the upload, which is
# complete and consistent by then) rather than printing a warning that
# scrolls past: "Upload complete" must not be printed over a manifest no
# phone will see. `--no-purge` opts out when the purge is being done another
# way (the dashboard: Caching > Configuration > Purge Cache > Custom Purge).
PURGE=1
purge_public_url() {
  local url="$1"
  if [ "$PURGE" = 0 ]; then
    echo "  Not purged from the edge cache (--no-purge): $url"
    return 0
  fi
  # require_purge_token has normally refused to start without one; this is
  # the backstop for a caller that skipped it.
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "Error: $url was uploaded but not purged from the edge cache:"
    echo "  CLOUDFLARE_API_TOKEN is not set. Phones keep seeing the previous copy until"
    echo "  the edge drops it. Set a token with Cache Purge on the zone and re-run, purge"
    echo "  it in the dashboard, or pass --no-purge to accept that."
    exit 1
  fi
  local response
  response=$(curl --silent --show-error -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CLOUDFLARE_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "{\"files\":[\"$url\"]}" || true)
  if [[ "$response" =~ \"success\"[[:space:]]*:[[:space:]]*true ]]; then
    echo "  Purged $url from the edge cache"
  else
    echo "Error: $url was uploaded but the edge cache purge failed: $response"
    echo "  Phones keep seeing the previous copy until it is purged. Re-run, purge it in"
    echo "  the dashboard, or pass --no-purge to accept that."
    exit 1
  fi
}

# Refuse to start a manifest upload that could not purge. Checked once, before
# anything is uploaded: purge_public_url runs after each manifest, so without
# this an all-trails upload with no token published the first trail unpurged
# and exited, leaving the rest not uploaded at all.
require_purge_token() {
  [ "$PURGE" = 1 ] || return 0
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "Error: CLOUDFLARE_API_TOKEN is not set, so the manifests this uploads could not"
    echo "  be purged from the edge cache, and phones would keep seeing the previous ones"
    echo "  for days. Set a token with Cache Purge on the zone, or pass --no-purge to purge"
    echo "  by hand (dashboard: Caching > Configuration > Purge Cache > Custom Purge)."
    echo "  Nothing was uploaded."
    exit 1
  fi
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
# manifests still reference them (a phone mid-download, an edge-cached copy).
# `npm run cleanup:tiles` lists what no live manifest references and, with
# --delete, removes it (scripts/cleanup-superseded-tiles.ts).
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

  # Fail before uploading anything when a file is too big for wrangler and
  # there is no rclone remote to take it.
  while IFS=$'\t' read -r name key size; do
    [ -n "$name" ] && [ -f "$src_dir/$name" ] || continue
    if [ "$(wc -c < "$src_dir/$name")" -gt "$WRANGLER_MAX_BYTES" ] && ! has_rclone_remote; then
      echo "Error: $name is over wrangler's $((WRANGLER_MAX_BYTES / 1024 / 1024))MiB limit."
      print_rclone_setup
      exit 1
    fi
  done <<< "$entries"

  # Here-string keeps the loop in the current shell so a failure exits the script.
  while IFS=$'\t' read -r name key size; do
    [ -n "$name" ] || continue
    local src="$src_dir/$name"
    if [ ! -f "$src" ]; then
      # A file the bucket already holds at this content-addressed key needs no
      # local copy: a manifest that changes only one of a pack's files can be
      # republished without downloading the others.
      if is_published "$remote_prefix/$key" "$size"; then
        echo "  $name already published at $remote_prefix/$key ($size bytes), skipping"
        continue
      fi
      echo "Error: manifest lists '$name' but $src does not exist. Rebuild before uploading."
      exit 1
    fi
    case "$name" in
      *.mbtiles) validate_mbtiles "$src" ;;
    esac
    upload_payload_file "$src" "$remote_prefix/$key"
  done <<< "$entries"

  # Last: publishing the manifest is what makes the new objects live.
  upload_file "$manifest_file" "$remote_prefix/manifest.json" \
    "application/json" \
    "public, max-age=3600"
  purge_public_url "$TILE_PUBLIC_URL/$remote_prefix/manifest.json"
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

# --- Main dispatch ---

# --no-purge may sit anywhere in the arguments.
args=()
for arg in "$@"; do
  if [ "$arg" = "--no-purge" ]; then PURGE=0; else args+=("$arg"); fi
done
set -- "${args[@]+"${args[@]}"}"

# Every mode publishes manifests, and so purges.
require_purge_token

if [ $# -ge 1 ]; then
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
    # Not a trail: output of the deleted grid pipeline, if an old build left it
    [ "$trail_id" = "grid" ] && continue
    upload_trail "$trail_id"
  done
  upload_root_manifest
fi

echo ""
echo "Upload complete."
