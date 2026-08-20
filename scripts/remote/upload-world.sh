#!/usr/bin/env bash
#
# Upload the world contour PMTiles archive to Cloudflare R2 (issue #34).
#
#   local:  public/data/tiles/world.pmtiles   (150-350 GB, estimated)
#   remote: aus-map-data / contours/world.pmtiles
#
# wrangler `r2 object put` caps out around 300 MiB, so this goes through
# rclone's S3 multipart uploader — same approach as the --contours branch of
# scripts/upload-tiles.sh, tuned for a much bigger file.
#
# Usage:
#   ./scripts/remote/upload-world.sh                 # validate + upload + verify
#   ./scripts/remote/upload-world.sh --verify-only   # just check what is in R2
#   ./scripts/remote/upload-world.sh --dry-run       # rclone --dry-run
#   RCLONE_REMOTE=r2prod ./scripts/remote/upload-world.sh
#
# Environment overrides:
#   RCLONE_REMOTE  rclone remote name        (default r2)
#   R2_BUCKET      bucket                     (default aus-map-data)
#   PMTILES_FILE   local archive path         (default public/data/tiles/world.pmtiles)
#   OBJECT_KEY     remote key                 (default contours/world.pmtiles)
#   CONTOUR_WORKER_URL  worker base URL for the /health check
#
# ---------------------------------------------------------------------------
# rclone remote setup (do this once, on the build box)
# ---------------------------------------------------------------------------
# 1. In the Cloudflare dashboard: R2 > Manage R2 API Tokens > Create API token
#    with **Object Read & Write** limited to the aus-map-data bucket. Copy the
#    Access Key ID and Secret Access Key it shows once.
# 2. `rclone config` > n(ew remote) > name it (e.g. r2) > storage: s3 >
#    provider: Cloudflare > enter the two keys > region: auto >
#    endpoint: https://<account-id>.r2.cloudflarestorage.com >
#    advanced: no_check_bucket = true
#    (the token has no bucket-management permission, so rclone must not try to
#    create/head the bucket).
#
#    Equivalent ~/.config/rclone/rclone.conf stanza — TEMPLATE ONLY, fill it in
#    on the box, never commit real keys:
#
#      [r2]
#      type = s3
#      provider = Cloudflare
#      access_key_id = <R2 access key id>
#      secret_access_key = <R2 secret access key>
#      region = auto
#      endpoint = https://<cloudflare-account-id>.r2.cloudflarestorage.com
#      no_check_bucket = true
#
# 3. chmod 600 ~/.config/rclone/rclone.conf
# 4. Destroy the token in the dashboard when the build box is decommissioned.
#
# No credential lives in this repo, and this script never reads or prints one.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RCLONE_REMOTE="${RCLONE_REMOTE:-r2}"
R2_BUCKET="${R2_BUCKET:-aus-map-data}"
PMTILES_FILE="${PMTILES_FILE:-$PROJECT_ROOT/public/data/tiles/world.pmtiles}"
OBJECT_KEY="${OBJECT_KEY:-contours/world.pmtiles}"
CONTOUR_WORKER_URL="${CONTOUR_WORKER_URL:-https://contour-tiles.aus-map-data.workers.dev}"
WORLD_SOURCE="${WORLD_SOURCE:-world}"

DRY_RUN=false
VERIFY_ONLY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --verify-only) VERIFY_ONLY=true; shift ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "$command_name" > /dev/null 2>&1; then
    echo "Error: $command_name not found. $install_hint" >&2
    exit 1
  fi
}

require_command rclone "Install it (apt-get install rclone) — see the setup notes at the top of this script."

# --- Preflight: the remote must already be configured ---

if ! rclone listremotes | grep -qx "${RCLONE_REMOTE}:"; then
  echo "Error: no rclone remote named \"${RCLONE_REMOTE}\"." >&2
  echo "" >&2
  echo "Configure one first (see the commented setup block at the top of this" >&2
  echo "script): create an R2 API token in the Cloudflare dashboard with Object" >&2
  echo "Read & Write on ${R2_BUCKET}, then run 'rclone config'." >&2
  echo "" >&2
  echo "Remotes currently configured:" >&2
  rclone listremotes | sed 's/^/  /' >&2
  exit 1
fi

# Object-level access check that does NOT need bucket-management permissions.
if ! rclone lsf --s3-no-check-bucket --max-depth 1 "${RCLONE_REMOTE}:${R2_BUCKET}" > /dev/null; then
  echo "Error: rclone cannot list ${RCLONE_REMOTE}:${R2_BUCKET}." >&2
  echo "Check the endpoint (account id) and that the token grants Object Read &" >&2
  echo "Write on this bucket, in the same account as ${CONTOUR_WORKER_URL}." >&2
  exit 1
fi

# --- Verify helpers ---

remote_size() {
  rclone size --s3-no-check-bucket --json "${RCLONE_REMOTE}:${R2_BUCKET}/${OBJECT_KEY}" 2>/dev/null \
    | tr -d '{}" ' | tr ',' '\n' | awk -F: '/^bytes:/ {print $2}'
}

verify_remote() {
  echo ""
  echo "Remote object:"
  local listing
  if ! listing="$(rclone lsl --s3-no-check-bucket "${RCLONE_REMOTE}:${R2_BUCKET}/${OBJECT_KEY}" 2>&1)" \
     || [ -z "$listing" ]; then
    echo "  (not found at ${R2_BUCKET}/${OBJECT_KEY})"
    # shellcheck disable=SC2001  # indenting every line of multi-line output
    if [ -n "$listing" ]; then echo "$listing" | sed 's/^/  /'; fi
    return 1
  fi
  # shellcheck disable=SC2001  # indenting every line of multi-line output
  echo "$listing" | sed 's/^/  /'

  local remote_bytes
  remote_bytes="$(remote_size || true)"
  if [ -n "${remote_bytes:-}" ] && [ -f "$PMTILES_FILE" ]; then
    local local_bytes
    local_bytes="$(wc -c < "$PMTILES_FILE")"
    if [ "$remote_bytes" = "$local_bytes" ]; then
      echo "  ✓ size matches local file ($remote_bytes bytes)"
    else
      echo "  ⚠ size mismatch: remote $remote_bytes vs local $local_bytes bytes"
      echo "    (expected while an upload is in flight; re-run to resume/overwrite)"
      return 1
    fi
  fi

  echo ""
  echo "Worker checks (edge cache holds old bytes for up to 24 h after a re-upload):"
  echo "  Health: ${CONTOUR_WORKER_URL%/}/health"
  echo "  Tile:   ${CONTOUR_WORKER_URL%/}/${WORLD_SOURCE}/15/28450/18593.pbf   (Mt Sonder, NT)"
  if command -v curl > /dev/null 2>&1; then
    local body
    if body="$(curl --silent --show-error --fail-with-body "${CONTOUR_WORKER_URL%/}/health")"; then
      echo "  /health -> $body"
    else
      echo "  ⚠ /health request failed: $body"
      echo "    (expected until the worker is deployed with the '${WORLD_SOURCE}' source)"
    fi
  fi
}

if [ "$VERIFY_ONLY" = true ]; then
  verify_remote
  exit 0
fi

# --- Validate the local archive before spending hours uploading it ---

if [ ! -f "$PMTILES_FILE" ]; then
  echo "Error: $PMTILES_FILE not found." >&2
  echo "Run the join step first: npx tsx scripts/build-contours-world.ts --join" >&2
  exit 1
fi

# PMTiles v3 starts with "PMTiles" + version byte 3. The header is written LAST
# by `pmtiles convert`, so a killed convert leaves a big file with no header —
# exactly the file you must not upload.
magic="$(od -An -tx1 -N8 "$PMTILES_FILE" | tr -d ' \n')"
if [ "$magic" != "504d54696c657303" ]; then
  echo "Error: $PMTILES_FILE is not a valid PMTiles v3 archive (bad magic: $magic)." >&2
  echo "A killed/OOM-ed convert leaves a headerless file — re-run the --join step." >&2
  exit 1
fi

if command -v pmtiles > /dev/null 2>&1; then
  echo "Archive header:"
  pmtiles show "$PMTILES_FILE" | sed 's/^/  /'
fi

local_bytes="$(wc -c < "$PMTILES_FILE")"
echo ""
echo "Uploading:"
echo "  from: $PMTILES_FILE ($(du -h "$PMTILES_FILE" | cut -f1), $local_bytes bytes)"
echo "  to:   ${RCLONE_REMOTE}:${R2_BUCKET}/${OBJECT_KEY}"
echo ""

rclone_args=(
  copyto
  --progress
  --s3-no-check-bucket
  --s3-chunk-size 128M
  --s3-upload-cutoff 128M
  --s3-upload-concurrency 8
  --header-upload "Content-Type: application/octet-stream"
  --header-upload "Cache-Control: public, max-age=2592000"
  --retries 5
  --low-level-retries 20
)
if [ "$DRY_RUN" = true ]; then rclone_args+=(--dry-run); fi

rclone "${rclone_args[@]}" "$PMTILES_FILE" "${RCLONE_REMOTE}:${R2_BUCKET}/${OBJECT_KEY}"

if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete — nothing uploaded."
  exit 0
fi

verify_remote

cat <<EOF

Done: ${R2_BUCKET}/${OBJECT_KEY}

Next: deploy the worker with the '${WORLD_SOURCE}' source
  (cd workers/contour-tiles && npx wrangler deploy)
then re-check /health and the Mt Sonder tile above.
EOF
