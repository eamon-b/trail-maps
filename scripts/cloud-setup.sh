#!/usr/bin/env bash
# Setup script for Claude Code cloud environments (claude.ai/code).
#
# Paste this file's contents into the environment's settings (cloud environment
# menu → Edit → Setup script). It runs as root before Claude Code starts, so a
# session opens with every package installed and `npm run check` ready to run.
#
# Every step warns rather than aborts: a mirror or registry hiccup should cost
# one missing piece, not the whole session.

set -u

warn() { echo "cloud-setup: WARNING: $*" >&2; }

# System tools the tests need: scripts/tile-pipeline.test.ts shells out to the
# sqlite3 CLI to inspect .mbtiles files.
if ! command -v sqlite3 >/dev/null 2>&1; then
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3; } \
    || warn "could not install sqlite3 (scripts/tile-pipeline.test.ts will fail)"
fi

# Find the checkout: the project dir if the harness names it, else the usual
# clone location, else wherever this script is run from.
repo=""
for dir in "${CLAUDE_PROJECT_DIR:-}" /home/user/trail-maps "$(git rev-parse --show-toplevel 2>/dev/null)"; do
  if [ -n "$dir" ] && [ -f "$dir/package.json" ] && [ -d "$dir/mobile" ]; then
    repo="$dir"
    break
  fi
done
if [ -z "$repo" ]; then
  warn "trail-maps checkout not found; skipping npm installs"
  exit 0
fi
cd "$repo" || exit 0

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 20 ] || warn "Node $(node -v 2>/dev/null) found; CI uses Node 22"

export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false

# Root (web app, build scripts; pulls gpx-tools and te-araroa-data from GitHub),
# the Expo app, and the two Cloudflare workers each have their own lockfile.
for pkg in . mobile workers/comments-api workers/contour-tiles; do
  [ -f "$pkg/package-lock.json" ] || continue
  echo "cloud-setup: npm ci in $pkg"
  npm ci --prefix "$pkg" || warn "npm ci failed in $pkg"
done

# Copy the Te Araroa GPX out of node_modules (gitignored), so build:trails works
# without the full `npm run build`.
npm run sync:te-araroa >/dev/null || warn "sync:te-araroa failed"

echo "cloud-setup: done"
exit 0
