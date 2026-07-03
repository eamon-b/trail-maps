#!/usr/bin/env bash
#
# Download ALL SRTM 1-arc-second DEM tiles covering Australia.
#
# Australia SRTM coverage: S10-S44, E112-E153.
# Tile names use the SW corner convention: S34E114 covers 34S-33S, 114E-115E.
#
# This downloads ~600-800 land tiles (~3-5 GB). Ocean tiles return 404 and are skipped.
#
# Prerequisites:
#   1. Free NASA EarthData account: https://urs.earthdata.nasa.gov/
#   2. ~/.netrc file with credentials:
#        machine urs.earthdata.nasa.gov login YOUR_USERNAME password YOUR_PASSWORD
#
# Usage:
#   ./scripts/download-dem-australia.sh            # Download missing tiles only
#   ./scripts/download-dem-australia.sh --all       # Re-download all tiles
#   ./scripts/download-dem-australia.sh --dry-run   # Show what would be downloaded
#   ./scripts/download-dem-australia.sh --lat 30 38 # Download latitudes S30-S38 only
#   ./scripts/download-dem-australia.sh --lon 145 155 # Download longitudes E145-E155 only
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEM_DIR="$PROJECT_ROOT/data/dem"
BASE_URL="https://data.lpdaac.earthdatacloud.nasa.gov/lp-prod-protected/SRTMGL1.003"
COOKIE_FILE="$DEM_DIR/.cookies"

# Australia bounds (inclusive). Tile name = SW corner of 1x1 degree cell,
# so row S44 (covering 44S-43S) is needed for southern Tasmania — South East
# Cape sits at ~43.64S.
LAT_MIN=10
LAT_MAX=44
LON_MIN=112
LON_MAX=153

# --- Parse arguments ---

FORCE=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      FORCE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --lat)
      LAT_MIN="$2"
      LAT_MAX="$3"
      shift 3
      ;;
    --lon)
      LON_MIN="$2"
      LON_MAX="$3"
      shift 3
      ;;
    --help|-h)
      echo "Usage: $0 [--all] [--dry-run] [--lat MIN MAX] [--lon MIN MAX]"
      echo "  --all          Re-download all tiles (overwrite existing)"
      echo "  --dry-run      Show what would be downloaded without downloading"
      echo "  --lat MIN MAX  Only download latitudes S{MIN} to S{MAX} (default: 10 44)"
      echo "  --lon MIN MAX  Only download longitudes E{MIN} to E{MAX} (default: 112 153)"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
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
    exit 1
  fi
fi

mkdir -p "$DEM_DIR"

# --- Count tiles to download ---

total=0
to_download=0
already_have=0

for lat in $(seq "$LAT_MIN" "$LAT_MAX"); do
  for lon in $(seq "$LON_MIN" "$LON_MAX"); do
    tile=$(printf "S%02dE%03d" "$lat" "$lon")
    total=$((total + 1))

    if [ "$FORCE" = true ] || [ ! -f "$DEM_DIR/${tile}.hgt" ]; then
      to_download=$((to_download + 1))
    else
      already_have=$((already_have + 1))
    fi
  done
done

echo "SRTM DEM Australia Downloader"
echo "=============================="
echo ""
echo "Range:    S${LAT_MIN}-S${LAT_MAX}, E${LON_MIN}-E${LON_MAX}"
echo "Total possible tiles: $total"
echo "Already downloaded:   $already_have"
echo "To check/download:    $to_download"
echo ""
echo "Note: Many tiles are ocean and will return 404 (expected)."
echo ""

if [ $to_download -eq 0 ]; then
  echo "All tiles are already present in $DEM_DIR"
  echo "Use --all to re-download everything."
  exit 0
fi

if [ "$DRY_RUN" = true ]; then
  echo "Tiles to download (dry run):"
  for lat in $(seq "$LAT_MIN" "$LAT_MAX"); do
    for lon in $(seq "$LON_MIN" "$LON_MAX"); do
      tile=$(printf "S%02dE%03d" "$lat" "$lon")
      if [ "$FORCE" = true ] || [ ! -f "$DEM_DIR/${tile}.hgt" ]; then
        echo "  $tile"
      fi
    done
  done
  exit 0
fi

# --- Download tiles ---

succeeded=0
skipped_ocean=0
failed=0
failed_tiles=()

for lat in $(seq "$LAT_MIN" "$LAT_MAX"); do
  for lon in $(seq "$LON_MIN" "$LON_MAX"); do
    tile=$(printf "S%02dE%03d" "$lat" "$lon")

    # Skip if already downloaded
    if [ "$FORCE" = false ] && [ -f "$DEM_DIR/${tile}.hgt" ]; then
      continue
    fi

    zip_file="$DEM_DIR/${tile}.SRTMGL1.hgt.zip"
    hgt_file="$DEM_DIR/${tile}.hgt"
    url="$BASE_URL/${tile}.SRTMGL1.hgt/${tile}.SRTMGL1.hgt.zip"

    echo -n "[$((succeeded + skipped_ocean + failed + 1))/$to_download] ${tile}... "

    # NASA EarthData uses cookie-based redirect auth
    http_code=$(curl -s -o "$zip_file" -w "%{http_code}" \
      -n -L \
      -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
      "$url")

    if [ "$http_code" = "404" ]; then
      echo "ocean (404)"
      rm -f "$zip_file"
      skipped_ocean=$((skipped_ocean + 1))
      continue
    fi

    if [ "$http_code" != "200" ]; then
      echo "FAILED (HTTP $http_code)"
      rm -f "$zip_file"
      failed=$((failed + 1))
      failed_tiles+=("$tile")
      continue
    fi

    # Verify it's actually a zip file (not an HTML error page)
    if ! file "$zip_file" | grep -qi "zip"; then
      echo "FAILED (not a valid zip file)"
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
done

# Clean up cookies
rm -f "$COOKIE_FILE"

# --- Summary ---

hgt_count=$(find "$DEM_DIR" -name '*.hgt' | wc -l)

echo ""
echo "=============================="
echo "Downloaded:    $succeeded"
echo "Ocean (404):   $skipped_ocean"
echo "Failed:        $failed"
echo "Total .hgt:    $hgt_count files in $DEM_DIR"

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
  exit 1
fi
