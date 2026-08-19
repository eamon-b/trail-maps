# Topographic Tile Pipeline Plan

## Decision

**Vector tile provider: Custom pipeline from open data + MapTiler Cloud for development.**

No free, ready-to-use, offline-capable topographic vector tile solution exists. Every serious hiking app (Gaia GPS, OsmAnd, Outdooractive) either uses paid tile providers or invests in a custom data pipeline. We will build our own.

### Why not the alternatives?

| Option | Reason for rejection |
|--------|---------------------|
| OpenFreeMap / Protomaps basemap | No contour lines or hillshading — flat basemaps only |
| OpenTopoMap | Raster-only (PNG tiles), no vector tile API, not maintained |
| MapTiler On-Prem ($2,500/yr) | Too expensive for a non-commercial project |
| Thunderforest ($255+/mo for offline) | Too expensive for offline bulk download tier |
| Mapbox Outdoors | Proprietary, requires switching away from MapLibre |

### What we're building

A build-time pipeline that generates two MBTiles files per trail from open data:

1. **Base map** (vector) — OSM roads, water, land use, POIs from Protomaps
2. **Contour lines** (vector) — elevation isolines from Geoscience Australia SRTM DEM

These are composited via a custom MapLibre style into a topographic map comparable to OpenTopoMap.

> **Note**: Hillshade raster tiles were prototyped but removed — they added minimal visual value on mobile screens while nearly doubling tile package size and introducing rendering bugs. The contour lines alone provide sufficient terrain perception.

---

## Architecture

### Pipeline Overview

```
For each trail in data/trails/:

  trail.json (GPX track coordinates)
        |
  ogr2ogr (buffer 20km corridor)
        |
  corridor.geojson
   /              \
  v                v
pmtiles          gdalwarp
extract          (clip DEM)
  |                |
  v                v
base           gdal_contour
tiles              |
  |                v
  |           ogr2ogr (classify)
  |                |
  |                v
  |           tippecanoe
  |                |
  v                v
base.          contours.
mbtiles        mbtiles
  \              /
   \            /
    MapLibre style.json
    (composites 2 sources)
         |
    Mobile app loads via
    mbtiles:// protocol
```

### Output Structure

```
mobile/assets/tiles/
  style.json                    # MapLibre style referencing all sources
  {trail-id}/
    base.mbtiles                # OSM vector tiles for corridor
    contours.mbtiles            # Contour line vector tiles
```

Tiles are **not** bundled in the app binary. They are downloaded on-demand when the user taps "Download trail for offline use". The app binary includes only the style.json and a manifest of available tile packages with sizes.

---

## Phase 1: Development (MapTiler Cloud)

Use MapTiler Cloud free tier to unblock Part 2 development immediately while the custom pipeline is built.

### Setup
1. Create free MapTiler account (5,000 sessions/month, 100,000 requests/month)
2. Use their Outdoor style URL with MapLibre React Native
3. Use `OfflineManager.createPack()` for basic offline testing

### MapLibre configuration (Phase 1)
```typescript
<MapView
  styleURL={`https://api.maptiler.com/maps/outdoor-v2/style.json?key=${EXPO_PUBLIC_MAPTILER_KEY}`}
/>
```

### Limitations
- Requires network for initial tile load
- Free tier has session limits (sufficient for development, not production)
- No custom contour intervals or styling control

### Exit criteria
- Phase 1 is replaced by Phase 2 when the custom pipeline produces tiles for at least one trail (bibbulmun)

---

## Phase 2: Custom Pipeline (Production)

### Prerequisites (system dependencies)

```bash
# GDAL (contour generation, DEM processing)
# macOS:
brew install gdal

# Ubuntu/Debian:
sudo apt install gdal-bin libgdal-dev

# Verify:
gdalinfo --version   # Need 3.6+

# tippecanoe (vector tile generation)
# macOS:
brew install tippecanoe

# From source (Linux):
git clone https://github.com/felt/tippecanoe.git
cd tippecanoe && make -j && sudo make install

# Verify:
tippecanoe --version

# pmtiles CLI (base map extraction)
# Install from GitHub releases:
# https://github.com/protomaps/go-pmtiles/releases
# Or with Go:
go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest

# tile-join (comes with tippecanoe, for PMTiles→MBTiles conversion)
tile-join --version
```

### Data Sources

#### 1. Elevation Data: Geoscience Australia 1-second SRTM DEM

- **Resolution**: 1 arc-second (~30m at equator, ~26-28m at Australian latitudes)
- **Product**: DEM-S (smoothed — produces cleaner contour lines)
- **Format**: GeoTIFF, tiled as 1x1 degree tiles
- **Licence**: Creative Commons Attribution 4.0 (free, including commercial use)
- **Coverage**: All of mainland Australia + Tasmania

**Download methods** (in order of preference for automation):

1. **ELVIS Portal** (interactive, for initial setup): https://elevation.fsdf.org.au/
   - Draw area of interest, select "1 Second SRTM DEM-S", submit download request
   - Returns zipped GeoTIFFs via email link

2. **WCS Service** (programmatic, for build script):
   ```bash
   gdal_translate -of GTiff \
     "WCS:https://services.ga.gov.au/gis/services/DEM_SRTM_1Second/MapServer/WCSServer?version=1.1.1&coverage=1" \
     -projwin <west> <north> <east> <south> \
     output_dem.tif
   ```

3. **OpenTopography API** (programmatic fallback):
   ```bash
   curl -o dem.tif "https://portal.opentopography.org/API/globaldem?\
   demtype=SRTMGL1&south=-37.0&north=-36.0&west=148.0&east=149.0&\
   outputFormat=GTiff&API_Key=YOUR_KEY"
   ```

#### 2. Base Map: Protomaps Global Basemap

- **Source**: https://maps.protomaps.com/builds/ (updated daily)
- **Format**: PMTiles (OpenMapTiles schema)
- **Licence**: ODbL (OpenStreetMap attribution required)
- **Global file size**: ~120 GB (we extract only trail corridors)

### Step-by-Step Pipeline

#### Step 1: Generate Trail Corridor Polygon

For each trail, create a buffered polygon from the GPX track:

```bash
# Buffer the GPX track by 20km to create a corridor polygon
# The EPSG code must match the trail's MGA zone (see table below)
# 20km captures surrounding towns, access roads, and alternate routes

# Example for AAWT (MGA Zone 55 = EPSG:28355):
ogr2ogr -f GeoJSON corridor.geojson trail.gpx \
  -dialect sqlite \
  -sql "SELECT ST_Transform(
    ST_Buffer(ST_Transform(geometry, 28355), 20000),
    4326
  ) AS geometry FROM tracks"

# The build script selects the correct EPSG code per trail from the mapping below.
```

**Buffer distance justification**: 20km captures:
- Towns used for resupply (typically within 10km of trail)
- Access roads and alternate routes
- Surrounding terrain context for navigation
- Adequate context when zoomed out

**MGA Zones for our trails**:

| Trail | State | MGA Zone (EPSG) |
|-------|-------|-----------------|
| bibbulmun | WA | 28350 (Zone 50) |
| Cape to Cape | WA | 28350 (Zone 50) |
| Heysen | SA | 28354 (Zone 54) |
| Larapinta | NT | 28353 (Zone 53) |
| AAWT | VIC/NSW/ACT | 28355 (Zone 55) |
| Hume and Hovell | NSW | 28355 (Zone 55) |

#### Step 2: Download and Clip DEM

```bash
# Option A: If DEM tiles already downloaded to data/dem/
gdalbuildvrt -vrtnodata -9999 dem_mosaic.vrt data/dem/*.tif

# Clip to trail corridor
gdalwarp \
  -cutline corridor.geojson \
  -crop_to_cutline \
  -dstnodata -9999 \
  -co COMPRESS=LZW \
  -co TILED=YES \
  dem_mosaic.vrt \
  dem_corridor.tif

# Option B: Download via WCS for just the corridor bounding box
# (then clip to exact corridor polygon)
```

**DEM caching**: Downloaded DEM tiles should be cached in `data/dem/` and shared across trails (the AAWT, Hume and Hovell, and Heysen trails overlap in elevation data coverage).

#### Step 3: Generate Contour Lines

```bash
# Generate 10m contours from the corridor DEM
# Use FlatGeobuf instead of GeoJSON for large corridors — GeoJSON can produce
# multi-GB files for trails like Heysen (44,000 km2), while FlatGeobuf is
# compact and tippecanoe reads it natively.
gdal_contour \
  -a elevation \
  -i 10 \
  -snodata -9999 \
  -f FlatGeobuf \
  dem_corridor.tif \
  contours_raw.fgb
```

#### Step 4: Classify and Convert Contours to MBTiles

Add index contour classification (every 50m = bold line), then convert to vector tiles with zoom-dependent filtering:

```bash
# Add is_index field (1 for every 50m contour, 0 otherwise)
ogr2ogr -f FlatGeobuf contours.fgb contours_raw.fgb \
  -sql "SELECT geometry, elevation,
    CASE WHEN (CAST(elevation AS INTEGER) % 50) = 0 THEN 1 ELSE 0 END AS is_index
    FROM contours_raw"

# Generate MBTiles with zoom-dependent contour density:
#   z9-z10:  100m contours only (overview)
#   z11:     50m contours (valleys/ridges visible)
#   z12:     20m contours (moderate detail)
#   z13-z14: 10m contours (full hiking detail)
tippecanoe \
  -o contours.mbtiles \
  -Z9 -z14 \
  -P \
  -y elevation \
  -y is_index \
  -l contour \
  --no-feature-limit \
  --no-tile-size-limit \
  --simplification=10 \
  -j '{
    "*": [
      ["any",
        ["all", [">=", "$zoom", 13]],
        ["all", [">=", "$zoom", 12], ["==", ["%", ["get", "elevation"], 20], 0]],
        ["all", [">=", "$zoom", 11], ["==", ["%", ["get", "elevation"], 50], 0]],
        ["all", ["<", "$zoom", 11], ["==", ["%", ["get", "elevation"], 100], 0]]
      ]
    ]
  }' \
  contours.fgb
```

**Zoom level rationale**:
- z14 is the maximum useful zoom for 30m SRTM data (beyond this, contours just get bigger with no new detail)
- z9 provides regional overview context
- The filtering ensures low zoom levels aren't overwhelmed with contour lines

#### Step 5: Extract Base Map Tiles

```bash
# Download Protomaps global basemap (or use a cached copy)
# ~120GB for planet — download once, cache in data/protomaps/
wget -c https://build.protomaps.com/20260101.pmtiles \
  -O data/protomaps/planet.pmtiles

# Extract trail corridor region
pmtiles extract \
  data/protomaps/planet.pmtiles \
  base_corridor.pmtiles \
  --region=corridor.geojson \
  --maxzoom=14 \
  --download-threads=8

# Convert PMTiles to MBTiles (for React Native compatibility)
tile-join -o base.mbtiles base_corridor.pmtiles
```

**Alternative**: Instead of downloading the full planet file, use the Protomaps HTTP range request feature to extract directly from their hosted file:

```bash
pmtiles extract \
  https://build.protomaps.com/20260101.pmtiles \
  base_corridor.pmtiles \
  --region=corridor.geojson \
  --maxzoom=14
```

This downloads only the tiles within the corridor polygon — much faster and no 120GB download needed.

#### Step 6: Create MapLibre Style

The style.json composites both sources into a topographic map. See [Appendix A](#appendix-a-maplibre-style) for the complete style definition.

Key design decisions:
- **Contour lines in warm brown** (`rgb(179, 134, 89)`) — standard topo map convention
- **Index contours (50m) bold** with elevation labels along the line
- **`is_index` is a string in the tiles** (`"0"`/`"1"`), so every filter on it must go through
  `["to-number", ["get", "is_index"]]`. Comparing directly against `1` is type-strict in MapLibre,
  matches nothing, and fails silently — you get every contour at intermediate weight and no
  elevation labels at all.
- **Regular contours (10m) thin** and semi-transparent
- **Layer order**: background → earth → land cover → water → contours → roads → buildings → labels → trail overlay

---

## Mobile Integration

### Tile Package Format

Each trail's tiles are packaged as a downloadable bundle:

```
Trail tile manifest (served from CDN / bundled in app):
{
  "trailId": "bibbulmun",
  "version": "2026-02-08",
  "files": [
    { "name": "base.mbtiles", "size": 29208576, "sha256": "66eb70eb..." },
    { "name": "contours.mbtiles", "size": 49364992, "sha256": "30a81621..." }
  ],
  "totalSize": 78573568,
  "bounds": [115.83, -35.11, 117.88, -31.95],
  "zoomRange": [8, 15]
}
```

### Loading MBTiles in MapLibre React Native

```typescript
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as FileSystem from 'expo-file-system';

// Tiles are downloaded to app's document directory
const tilesDir = `${FileSystem.documentDirectory}tiles/${trailId}`;

// Build style with local MBTiles paths
const styleJSON = {
  version: 8,
  sources: {
    basemap: {
      type: 'vector',
      url: `mbtiles://${tilesDir}/base.mbtiles`,
    },
    contour: {
      type: 'vector',
      url: `mbtiles://${tilesDir}/contours.mbtiles`,
    },
  },
  layers: [/* ... style layers ... */],
};

// Pass inline style to MapView
<MapLibreGL.MapView styleJSON={JSON.stringify(styleJSON)} />
```

### Download Flow

1. User selects trail → sees tile package size (e.g., "75 MB")
2. Downloads two MBTiles files to `FileSystem.documentDirectory`
3. Files persist across app restarts (not subject to iOS cache eviction)
4. User can delete downloaded tiles via storage management UI

This avoids the iOS cache eviction problem identified in the research docs — `documentDirectory` is persistent, unlike cache directories.

### Fallback: Online Tiles

When tiles are not downloaded, fall back to MapTiler Cloud (Phase 1 config) for online viewing. This gives users a preview of any trail before committing to the download.

---

## Build Script Design

### New script: `scripts/build-tiles.ts`

Follows the same pattern as `build-trails.ts` — a TypeScript script that orchestrates CLI tools:

```typescript
// scripts/build-tiles.ts
//
// Generates topographic MBTiles for each trail:
//   1. Creates corridor polygon from GPX track
//   2. Downloads/clips SRTM DEM to corridor
//   3. Generates contour line vector tiles
//   4. Extracts base map vector tiles from Protomaps
//   5. Writes tile manifest JSON
//
// Prerequisites: gdal, tippecanoe, pmtiles CLI
//
// Usage: npx tsx scripts/build-tiles.ts [--trail bibbulmun] [--skip-base]
```

### npm scripts

```json
{
  "build:tiles": "tsx scripts/build-tiles.ts",
  "build:tiles:bibbulmun": "tsx scripts/build-tiles.ts --trail bibbulmun"
}
```

**Note**: `build:tiles` is intentionally kept separate from the main `build` script. Adding it to `build` would break builds for anyone without GDAL/tippecanoe/pmtiles installed. Tile generation is a standalone step run manually or in a dedicated CI job. The main `build` remains:
```json
{
  "build": "npm run fetch:climate && npm run build:trails && tsc && vite build"
}
```

### Directory structure for intermediate data

```
data/
  dem/                          # Cached SRTM DEM tiles (1x1 degree GeoTIFFs)
    S32E116.hgt                 # Shared across trails
    S33E116.hgt
    ...
  protomaps/
    planet.pmtiles              # Global basemap (or downloaded per-corridor)
  tiles/                        # Build output (intermediate)
    bibbulmun/
      corridor.geojson
      dem_corridor.tif
      contours_raw.fgb
      contours.fgb
      contours.mbtiles
      base.pmtiles
      base.mbtiles
    heysen/
      ...
```

### Final output location

```
public/data/tiles/              # Served by CDN / hosted for download
  bibbulmun/
    base.mbtiles
    contours.mbtiles
    manifest.json
  heysen/
    ...
  style.json                    # Shared style (paths replaced at runtime)
```

---

## Size Estimates

Based on bibbulmun actual output (28 MB base + 47 MB contours = 75 MB) and corridor area ratios:

| Trail | Length | Corridor Area (20km buffer) | Base | Contours | Total |
|-------|--------|----------------------------|------|----------|-------|
| Cape to Cape | 123 km | ~5,000 km2 | 4 MB | 5 MB | **~9 MB** |
| Larapinta | 223 km | ~9,000 km2 | 6 MB | 8 MB | **~14 MB** |
| Hume and Hovell | 440 km | ~18,000 km2 | 13 MB | 20 MB | **~33 MB** |
| bibbulmun | 982 km | ~40,000 km2 | 28 MB | 47 MB | **~75 MB** (actual) |
| AAWT | 655 km | ~26,000 km2 | 18 MB | 30 MB | **~48 MB** |
| Heysen | 1099 km | ~44,000 km2 | 31 MB | 50 MB | **~81 MB** |

Estimates for non-bibbulmun trails are extrapolated from actual bibbulmun output scaled by corridor area. Actual sizes will vary with terrain complexity and urban density. The Heysen estimate may be lower because much of South Australia is flat.

**Target**: <150 MB per trail.

---

## Implementation Steps

### Phase 1: MapTiler Cloud for Development
1. Create MapTiler account, add API key as `EXPO_PUBLIC_MAPTILER_KEY`
2. Configure MapLibre with MapTiler Outdoor style URL
3. Implement basic offline region caching via `OfflineManager` for testing
4. Continue Part 2 development with working topo maps

### Phase 2: Custom Pipeline (Build Script) — COMPLETE

5. ~~Install system dependencies (GDAL, tippecanoe, pmtiles CLI)~~ ✅
6. ~~Validate `mbtiles://` protocol on Android emulator~~ ✅
7. ~~Download SRTM DEM tiles for first trail (bibbulmun) via ELVIS portal~~ ✅ (20 tiles in `data/dem/`)
8. ~~Implement corridor polygon generation from GPX (with dynamic MGA zone selection per trail)~~ ✅
9. ~~Implement contour generation pipeline (gdal_contour → ogr2ogr classify → tippecanoe)~~ ✅
10. ~~Implement base map extraction (pmtiles extract → tile-join)~~ ✅
11. ~~Create MapLibre topo style.json (Protomaps Basemap schema)~~ ✅
12. ~~Generate and bundle PBF font glyphs from Open Sans for offline text rendering~~ ✅
13. ~~Validate output: load MBTiles in MapLibre on device~~ ✅
14. ~~Wrap pipeline in `scripts/build-tiles.ts`~~ ✅
15. ~~Add `.gitignore` entries for `data/dem/`, `data/protomaps/`, `data/tiles/`, `public/data/tiles/`~~ ✅

**Decision**: Hillshade raster tiles (originally step 10) were prototyped and removed — they added minimal terrain perception on mobile while nearly doubling package size and causing rendering bugs.

### Phase 3: Polish & Remaining Trails
16. Download SRTM DEM tiles for remaining trails via ELVIS portal
17. Run pipeline for all 6 trails
18. ~~Tune contour styling (intervals, colors, opacity, label density)~~ ✅
19. Measure actual tile sizes, optimize if needed
20. ~~Choose tile hosting strategy (S3 + CloudFront or similar — tiles are too large for static hosting like Vercel)~~ ✅ → **Cloudflare R2** (see Appendix D)
21. ~~Implement tile download UI in the mobile app~~ ✅
22. ~~Implement storage management (view/delete downloaded tiles)~~ ✅
23. Design tile versioning/update mechanism (how app detects newer tiles, incremental vs full re-download)
24. Test offline operation end-to-end on device

**Additional Phase 3 work completed:**
- ~~Create `tile-service.ts` — reusable tile download/management service~~ ✅
- ~~Fix offline font loading — bundled PBF glyphs provisioned to document directory~~ ✅
- ~~Add `.pbf` to Metro asset extensions for bundled font loading~~ ✅
- ~~Update dev screen to use tile service instead of inline logic~~ ✅

---

## Testing Strategy

### Pipeline validation
- Run pipeline on bibbulmun first (medium complexity, well-known trail)
- Compare output visually against OpenTopoMap at same location
- Verify contour elevation values match known peaks/passes
- Check for tile boundary artifacts (gaps, repeated contours)

### Mobile integration testing
- Load MBTiles on both iOS and Android simulators
- Test offline operation (airplane mode after download)
- Measure tile rendering performance (frame rate during pan/zoom)
- Measure storage usage vs estimates

### Visual quality checklist
- [ ] Contour lines are smooth (not jagged from low-res DEM)
- [ ] Index contours (50m) are visibly bolder than regular (10m)
- [ ] Elevation labels are readable and not overlapping
- [ ] Base map roads/water/POIs are visible through contour overlay
- [ ] Zoom transitions between contour densities are smooth (no pop-in)
- [ ] No visual artifacts at tile boundaries

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| GDAL/tippecanoe not available in CI | Pipeline runs locally or in a Docker container; output MBTiles are committed or uploaded to CDN |
| MBTiles not loading in MapLibre React Native | Validated on Android emulator; fallback to OfflineManager with MapTiler Cloud |
| Tile sizes too large | Reduce buffer from 20km to 10km; reduce max zoom from z15 to z13 |
| Contour quality poor from 30m SRTM | SRTM at 30m is sufficient for 10m contour intervals; using DEM-S (smoothed) variant |
| Geoscience Australia WCS service down | Cache downloaded DEM tiles locally; use OpenTopography API as fallback |
| Protomaps planet file too large to download | Use HTTP range request extraction (no full download needed) |
| Tile files too large for static hosting (Vercel 250MB limit) | Host tiles on Cloudflare R2 (zero egress, built-in CDN, S3-compatible API); keep tile builds separate from web deployment |
| Contour GeoJSON too large for memory on big trails | Use FlatGeobuf format for intermediate contour files — compact, streamed, and natively supported by tippecanoe |

---

## Appendix A: MapLibre Style

Complete `style.json` for the two-source topographic map. This is the actual implemented style from `scripts/topo-style.json`, using Protomaps Basemap schema layer names:

```json
{
  "version": 8,
  "name": "Tracknotes Topo",
  "sources": {
    "basemap": {
      "type": "vector",
      "url": "mbtiles://{basePath}/base.mbtiles"
    },
    "contour": {
      "type": "vector",
      "url": "mbtiles://{basePath}/contours.mbtiles"
    }
  },
  "glyphs": "{glyphsPath}/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": { "background-color": "#f8f4f0" }
    },
    {
      "id": "earth",
      "type": "fill",
      "source": "basemap",
      "source-layer": "earth",
      "paint": { "fill-color": "#f8f4f0" }
    },
    {
      "id": "landcover-grassland",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landcover",
      "filter": ["==", "kind", "grassland"],
      "paint": { "fill-color": "#d8e8c8", "fill-opacity": 0.6 }
    },
    {
      "id": "landcover-forest",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landcover",
      "filter": ["==", "kind", "forest"],
      "paint": { "fill-color": "#aed1a0", "fill-opacity": 0.5 }
    },
    {
      "id": "landcover-scrub",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landcover",
      "filter": ["==", "kind", "scrub"],
      "paint": { "fill-color": "#c8d7ab", "fill-opacity": 0.4 }
    },
    {
      "id": "landuse-park",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landuse",
      "filter": ["in", "kind", "park", "national_park", "nature_reserve", "protected_area"],
      "paint": { "fill-color": "#c8dfab", "fill-opacity": 0.3 }
    },
    {
      "id": "water",
      "type": "fill",
      "source": "basemap",
      "source-layer": "water",
      "paint": { "fill-color": "#aad3df" }
    },
    {
      "id": "waterway",
      "type": "line",
      "source": "basemap",
      "source-layer": "water",
      "filter": ["in", "kind_detail", "river", "stream", "canal"],
      "paint": {
        "line-color": "#aad3df",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 15, 2]
      }
    },
    {
      "id": "contour-regular",
      "type": "line",
      "source": "contour",
      "source-layer": "contour",
      "minzoom": 11,
      "filter": ["!=", ["to-number", ["get", "is_index"]], 1],
      "paint": {
        "line-color": "rgb(179, 134, 89)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.3, 14, 0.6],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.15, 14, 0.35]
      }
    },
    {
      "id": "contour-index",
      "type": "line",
      "source": "contour",
      "source-layer": "contour",
      "minzoom": 9,
      "filter": ["==", ["to-number", ["get", "is_index"]], 1],
      "paint": {
        "line-color": "rgb(166, 116, 66)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.4, 11, 0.8, 14, 1.4],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0.1, 11, 0.25, 14, 0.5]
      }
    },
    {
      "id": "road-path",
      "type": "line",
      "source": "basemap",
      "source-layer": "roads",
      "filter": ["==", "kind", "path"],
      "paint": {
        "line-color": "#b0a090",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 15, 1.5],
        "line-dasharray": [3, 2]
      }
    },
    {
      "id": "road-minor",
      "type": "line",
      "source": "basemap",
      "source-layer": "roads",
      "filter": ["==", "kind", "minor_road"],
      "paint": {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 15, 2.5]
      }
    },
    {
      "id": "road-major",
      "type": "line",
      "source": "basemap",
      "source-layer": "roads",
      "filter": ["==", "kind", "major_road"],
      "paint": {
        "line-color": "#fefeb3",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 15, 4]
      }
    },
    {
      "id": "road-highway",
      "type": "line",
      "source": "basemap",
      "source-layer": "roads",
      "filter": ["==", "kind", "highway"],
      "paint": {
        "line-color": "#e9ac77",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 15, 6]
      }
    },
    {
      "id": "building",
      "type": "fill",
      "source": "basemap",
      "source-layer": "buildings",
      "minzoom": 13,
      "paint": { "fill-color": "#d9d0c9", "fill-opacity": 0.7 }
    },
    {
      "id": "contour-label",
      "type": "symbol",
      "source": "contour",
      "source-layer": "contour",
      "minzoom": 11,
      "filter": ["==", ["to-number", ["get", "is_index"]], 1],
      "layout": {
        "symbol-placement": "line",
        "text-field": ["concat", ["to-string", ["get", "elevation"]], "m"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 11],
        "text-max-angle": 25,
        "text-padding": 150,
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "rgb(131, 66, 37)",
        "text-halo-color": "rgba(255, 255, 255, 0.85)",
        "text-halo-width": 1.5
      }
    },
    {
      "id": "place-village",
      "type": "symbol",
      "source": "basemap",
      "source-layer": "places",
      "filter": ["==", "kind_detail", "village"],
      "layout": {
        "text-field": ["get", "name"],
        "text-size": 12,
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "#333",
        "text-halo-color": "#fff",
        "text-halo-width": 1.5
      }
    },
    {
      "id": "place-town",
      "type": "symbol",
      "source": "basemap",
      "source-layer": "places",
      "filter": ["==", "kind_detail", "town"],
      "layout": {
        "text-field": ["get", "name"],
        "text-size": 14,
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "#333",
        "text-halo-color": "#fff",
        "text-halo-width": 2
      }
    },
    {
      "id": "place-city",
      "type": "symbol",
      "source": "basemap",
      "source-layer": "places",
      "filter": ["in", "kind_detail", "city", "metropolis"],
      "layout": {
        "text-field": ["get", "name"],
        "text-size": 16,
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "#222",
        "text-halo-color": "#fff",
        "text-halo-width": 2
      }
    },
    {
      "id": "peak",
      "type": "symbol",
      "source": "basemap",
      "source-layer": "pois",
      "filter": ["==", "kind", "peak"],
      "layout": {
        "text-field": ["concat", ["get", "name"], "\n", ["get", "elevation"]],
        "text-size": 11,
        "text-anchor": "center",
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "#6a4c30",
        "text-halo-color": "#fff",
        "text-halo-width": 1.5
      }
    }
  ]
}
```

**Notes**:
- `{basePath}` is replaced at runtime with the actual tile directory path
- `{glyphsPath}` is replaced at runtime with the path to bundled PBF font glyphs
- The style uses **Protomaps Basemap** schema layer names (`earth`, `roads` with `kind`, `places` with `kind_detail`, `pois`, `buildings`) — not OpenMapTiles schema
- Trail overlay layers (polyline, waypoints) are added dynamically by the app on top of this style
- Font glyphs are bundled in `mobile/assets/fonts/Open Sans Regular/` for offline operation
- Contour styling tuned in Phase 3: added minzoom to regular contours (z11), index contours (z9), and labels (z11); increased label padding to 150 for reduced density on mobile; reduced text-max-angle to 25 for smoother label placement

---

## Appendix B: Font Glyphs — DONE

MapLibre needs PBF font glyphs for text rendering. Glyphs are downloaded via `scripts/fetch-font-glyphs.ts` from the OpenMapTiles CDN and bundled in `mobile/assets/fonts/Open Sans Regular/`.

Bundled glyph ranges: 0-255, 256-511, 512-767, 768-1023, 8192-8447, 8448-8703 (covers Latin, extended Latin, and common symbols).

To regenerate: `npm run fetch:fonts`

---

## Appendix C: Docker Build Environment (Optional)

For reproducible builds and CI, wrap the pipeline dependencies in a Docker image:

```dockerfile
FROM ghcr.io/osgeo/gdal:ubuntu-full-3.9.0

RUN apt-get update && apt-get install -y \
  build-essential libsqlite3-dev zlib1g-dev \
  nodejs npm golang-go \
  && rm -rf /var/lib/apt/lists/*

# Install tippecanoe
RUN git clone https://github.com/felt/tippecanoe.git /opt/tippecanoe \
  && cd /opt/tippecanoe && make -j && make install

# Install pmtiles CLI
RUN go install github.com/protomaps/go-pmtiles/cmd/pmtiles@latest

WORKDIR /app
COPY scripts/ scripts/
COPY data/ data/
ENTRYPOINT ["npx", "tsx", "scripts/build-tiles.ts"]
```

This is optional — the pipeline can run on any machine with the prerequisites installed. Docker is useful for CI or for team members who don't want to install GDAL locally.

---

## Appendix D: Tile Hosting — Cloudflare R2

**Decision: 2026-02-08**

### Why R2 over S3 + CloudFront

The plan originally suggested S3 + CloudFront. After evaluating options, **Cloudflare R2** is the better fit:

| Factor | S3 + CloudFront | Cloudflare R2 |
|--------|----------------|---------------|
| Storage cost | $0.023/GB/mo | $0.015/GB/mo (10 GB free) |
| Egress cost | $0.085/GB | **Free** |
| CDN | Separate service (CloudFront) | Built-in (Cloudflare network) |
| API | S3 native | S3-compatible |
| Setup | 2 services (S3 bucket + CF distribution) | 1 service (R2 bucket + public access) |

For a download-heavy workload (~260 MB total, individual files up to 50 MB), zero egress is the decisive factor. Even modest usage (100 users × 260 MB) would cost ~$2/month on CloudFront but $0 on R2.

### R2 Bucket Structure

```
aus-map-data/                        # R2 bucket name
  bibbulmun/
    base.mbtiles                     # 28 MB
    contours.mbtiles                 # 47 MB
    manifest.json
  cape-to-cape/
    base.mbtiles
    contours.mbtiles
    manifest.json
  heysen/
    ...
  manifest.json                      # Root manifest listing all trails + versions
```

### Public Access URL

With R2 public access enabled (the bucket's r2.dev public URL):

```
https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev/bibbulmun/base.mbtiles
https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev/bibbulmun/contours.mbtiles
https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev/bibbulmun/manifest.json
https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev/manifest.json
```

A custom domain can be added later to front the same bucket.

### Upload Workflow

Upload tiles after running `build:tiles` for a trail:

```bash
# Using wrangler (Cloudflare CLI)
npx wrangler r2 object put aus-map-data/bibbulmun/base.mbtiles \
  --file public/data/tiles/bibbulmun/base.mbtiles \
  --content-type application/octet-stream

npx wrangler r2 object put aus-map-data/bibbulmun/contours.mbtiles \
  --file public/data/tiles/bibbulmun/contours.mbtiles \
  --content-type application/octet-stream

npx wrangler r2 object put aus-map-data/bibbulmun/manifest.json \
  --file public/data/tiles/bibbulmun/manifest.json \
  --content-type application/json

# Or using AWS CLI with R2 endpoint
aws s3 sync public/data/tiles/ s3://aus-map-data/ \
  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

### Setup Steps

1. **Create Cloudflare account** (free tier is sufficient)
2. **Create R2 bucket** named `aus-map-data`
3. **Enable public access** on the bucket (Settings → Public access → Enable)
4. **Optional: Add custom domain** in front of the bucket via Cloudflare DNS
5. **Install wrangler**: `npm install -g wrangler` and `wrangler login`
6. **Upload tiles** using the commands above
7. **Set `EXPO_PUBLIC_TILE_BASE_URL`** in the mobile app to the public URL

### CORS Configuration

R2 public buckets allow cross-origin requests by default. If needed, configure via:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 86400
  }
]
```

### Cache Headers

Set `Cache-Control` on upload for efficient client-side caching:

```bash
# MBTiles change rarely — cache for 30 days
--cache-control "public, max-age=2592000"

# Manifests should be checked more frequently
--cache-control "public, max-age=3600"
```

### Cost Estimate

| Component | Amount | Cost |
|-----------|--------|------|
| Storage | ~260 MB | **Free** (10 GB free tier) |
| Class A ops (writes) | ~12 uploads | **Free** (1M free/month) |
| Class B ops (reads) | ~1,000 downloads/month | **Free** (10M free/month) |
| Egress | ~260 GB/month (1,000 full downloads) | **Free** |
| **Total** | | **$0/month** |

Even at 10× the estimated traffic, the cost remains $0 within R2's free tier.

---

## Review Notes

**Reviewed: 2026-02-08**

### Overall Assessment

This is a thorough, well-researched plan. The architecture is sound, the tool choices are correct, the pipeline steps are detailed and technically accurate, and the phased approach (MapTiler for dev → custom pipeline for production) is pragmatic. The plan is ready for implementation with the corrections and additions noted below.

### Issues Fixed

1. **Spelling inconsistency**: The plan inconsistently used "Bibbulmum" in some places. Fixed all instances to `bibbulmun` to match the codebase trail ID and directory name.

### Gaps Identified and Addressed

All gaps below have been fixed in the plan above:

2. **`.gitignore` updates** — added as implementation step 15
3. **Font glyph bundling** — added as implementation step 12
4. **`mbtiles://` protocol validation** — added as implementation step 6 (early gate before full pipeline)
5. **CDN/hosting strategy** — added as implementation step 20 and risk table entry
6. **Tile versioning** — added as implementation step 23 (Phase 3 design question)
7. **Dynamic MGA zone** — updated Step 1 to note dynamic EPSG selection per trail
8. **Contour memory** — switched Steps 3-4 from GeoJSON to FlatGeobuf format
9. **Protomaps schema** — Appendix A updated to use actual Protomaps Basemap schema layer names
10. **Peak icon without sprite** — removed `icon-image` reference, switched to text-only symbol
11. **Build script isolation** — removed `build:tiles` from main `build` command, added explanatory note

### Checklist Results

- [x] All affected files identified
- [x] Steps are in the right order
- [x] Dependencies and prerequisites are documented well
- [x] Edge cases considered (tile size limits, offline, fallback, large files, hosting)
- [x] Testing strategy sufficient (includes mbtiles:// protocol validation step)
- [x] No simpler alternatives exist for the core problem
- [x] No risk of breaking existing build (build:tiles kept separate)

---

## Phase 2 Completion Notes

**Completed: 2026-02-08**

### What was built

- `scripts/build-tiles.ts` — Complete pipeline orchestrator (728 lines)
- `scripts/fetch-font-glyphs.ts` — PBF font glyph downloader (115 lines)
- `scripts/topo-style.json` — MapLibre style with Protomaps Basemap schema (266 lines)
- `mobile/app/(dev)/map-tiles.tsx` — Dev test screen for tile loading verification
- `mobile/assets/fonts/Open Sans Regular/*.pbf` — Bundled font glyphs for offline text
- npm scripts: `build:tiles`, `build:tiles:bibbulmun`, `fetch:fonts`
- `.gitignore` entries for `data/dem/`, `data/protomaps/`, `data/tiles/`, `public/data/tiles/`

### Bibbulmun output (first trail)

- `base.mbtiles`: 28 MB (vector, Protomaps Basemap schema)
- `contours.mbtiles`: 47 MB (vector, 10m intervals with 50m index)
- Total: **75 MB** (significantly under the 150 MB target)

### Decision: Hillshade removed

Hillshade raster tiles were prototyped and tested on device. They were removed because:
- Minimal visual benefit on mobile screens — contour lines alone provide sufficient terrain perception
- Nearly doubled tile package size (added ~60 MB for bibbulmun)
- Caused rendering bugs on Android (raster layer compositing issues)

The build script, style.json, and mobile code have all been updated to remove hillshade. The plan has been updated to reflect this decision.
