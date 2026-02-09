#!/usr/bin/env bash
#
# Download SRTM 1-arc-second DEM tiles from NASA EarthData.
#
# Prerequisites:
#   1. Free NASA EarthData account: https://urs.earthdata.nasa.gov/
#   2. ~/.netrc file with credentials:
#        machine urs.earthdata.nasa.gov login YOUR_USERNAME password YOUR_PASSWORD
#
# Usage:
#   ./scripts/download-dem.sh            # Download missing tiles only
#   ./scripts/download-dem.sh --all      # Re-download all tiles (overwrite)
#   ./scripts/download-dem.sh --dry-run  # Show what would be downloaded
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEM_DIR="$PROJECT_ROOT/data/dem"
# NASA migrated SRTM data from e4ftl01.cr.usgs.gov to the LP DAAC cloud in 2025.
# URL pattern: .../SRTMGL1.003/{TILE}.SRTMGL1.hgt/{TILE}.SRTMGL1.hgt.zip
BASE_URL="https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/SRTMGL1.003"
COOKIE_FILE="$DEM_DIR/.cookies"

# All SRTM tiles needed for the 6 trails.
# Tile name = SW corner: S34E114 covers 34°S–33°S, 114°E–115°E.
TILES=(
  # Bibbulmun (WA) — 20 tiles, likely already present
  S32E115 S32E116 S32E117 S32E118
  S33E115 S33E116 S33E117 S33E118
  S34E115 S34E116 S34E117 S34E118
  S35E115 S35E116 S35E117 S35E118
  S36E115 S36E116 S36E117 S36E118

  # Cape to Cape (WA) — 2 tiles
  S34E114 S35E114

  # Larapinta (NT) — 2 tiles
  S24E132 S24E133

  # Heysen (SA) — 15 tiles
  S32E137 S32E138 S32E139
  S33E137 S33E138 S33E139
  S34E137 S34E138 S34E139
  S35E137 S35E138 S35E139
  S36E137 S36E138 S36E139

  # AAWT + Hume & Hovell (NSW/VIC) — 15 tiles
  S35E146 S35E147 S35E148
  S36E146 S36E147 S36E148 S36E149
  S37E146 S37E147 S37E148 S37E149
  S38E146 S38E147 S38E148 S38E149
)

# --- Parse arguments ---

FORCE=false
DRY_RUN=false

for arg in "$@"; do
  case "$arg" in
    --all)    FORCE=true ;;
    --dry-run) DRY_RUN=true ;;
    --help|-h)
      echo "Usage: $0 [--all] [--dry-run]"
      echo "  --all      Re-download all tiles (overwrite existing)"
      echo "  --dry-run  Show what would be downloaded without downloading"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

# --- Preflight checks ---

if [ "$DRY_RUN" = false ]; then
  if ! command -v curl &>/dev/null; then
    echo "Error: curl is required but not found."
    exit 1
  fi

  if ! command -v unzip &>/dev/null; then
    echo "Error: unzip is required but not found."
    exit 1
  fi

  if [ ! -f "$HOME/.netrc" ]; then
    echo "Error: ~/.netrc not found."
    echo ""
    echo "Create a free NASA EarthData account at:"
    echo "  https://urs.earthdata.nasa.gov/"
    echo ""
    echo "Then create ~/.netrc with:"
    echo "  machine urs.earthdata.nasa.gov login YOUR_USERNAME password YOUR_PASSWORD"
    echo ""
    echo "And set permissions:"
    echo "  chmod 600 ~/.netrc"
    exit 1
  fi

  if ! grep -q "urs.earthdata.nasa.gov" "$HOME/.netrc"; then
    echo "Error: ~/.netrc does not contain urs.earthdata.nasa.gov credentials."
    echo ""
    echo "Add this line to ~/.netrc:"
    echo "  machine urs.earthdata.nasa.gov login YOUR_USERNAME password YOUR_PASSWORD"
    exit 1
  fi
fi

mkdir -p "$DEM_DIR"

# --- Determine which tiles to download ---

to_download=()
already_have=()

for tile in "${TILES[@]}"; do
  if [ "$FORCE" = true ] || [ ! -f "$DEM_DIR/${tile}.hgt" ]; then
    to_download+=("$tile")
  else
    already_have+=("$tile")
  fi
done

echo "SRTM DEM Tile Downloader"
echo "========================"
echo ""
echo "Total tiles needed:  ${#TILES[@]}"
echo "Already downloaded:  ${#already_have[@]}"
echo "To download:         ${#to_download[@]}"
echo ""

if [ ${#to_download[@]} -eq 0 ]; then
  echo "All tiles are already present in $DEM_DIR"
  echo "Use --all to re-download everything."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo "Tiles to download:"
  for tile in "${to_download[@]}"; do
    echo "  $tile  ->  $DEM_DIR/${tile}.hgt"
  done
  exit 0
fi

# --- Download tiles ---

succeeded=0
failed=0
failed_tiles=()

for tile in "${to_download[@]}"; do
  zip_file="$DEM_DIR/${tile}.SRTMGL1.hgt.zip"
  hgt_file="$DEM_DIR/${tile}.hgt"
  url="$BASE_URL/${tile}.SRTMGL1.hgt/${tile}.SRTMGL1.hgt.zip"

  echo -n "Downloading ${tile}... "

  # NASA EarthData uses cookie-based redirect auth
  http_code=$(curl -s -o "$zip_file" -w "%{http_code}" \
    -n -L \
    -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "$url")

  if [ "$http_code" != "200" ]; then
    echo "FAILED (HTTP $http_code)"
    rm -f "$zip_file"
    failed=$((failed + 1))
    failed_tiles+=("$tile")
    continue
  fi

  # Verify it's actually a zip file (not an HTML error page)
  if ! file "$zip_file" | grep -qi "zip"; then
    echo "FAILED (not a valid zip file — check credentials)"
    rm -f "$zip_file"
    failed=$((failed + 1))
    failed_tiles+=("$tile")
    continue
  fi

  # Extract .hgt file
  if unzip -o -q "$zip_file" -d "$DEM_DIR" 2>/dev/null; then
    rm -f "$zip_file"
    size=$(du -h "$hgt_file" | cut -f1)
    echo "OK ($size)"
    succeeded=$((succeeded + 1))
  else
    echo "FAILED (unzip error)"
    rm -f "$zip_file"
    failed=$((failed + 1))
    failed_tiles+=("$tile")
  fi
done

# Clean up cookies
rm -f "$COOKIE_FILE"

# --- Summary ---

echo ""
echo "========================"
echo "Downloaded: $succeeded"
echo "Failed:     $failed"
echo "Total:      $(find "$DEM_DIR" -name '*.hgt' | wc -l) .hgt files in $DEM_DIR"

if [ $failed -gt 0 ]; then
  echo ""
  echo "Failed tiles:"
  for tile in "${failed_tiles[@]}"; do
    echo "  $tile"
  done
  echo ""
  echo "Common issues:"
  echo "  - Invalid credentials in ~/.netrc"
  echo "  - Need to accept the LP DAAC data use agreement at:"
  echo "    https://urs.earthdata.nasa.gov/profile"
  echo "    (go to Applications > Authorized Apps and approve LP DAAC)"
  exit 1
fi
