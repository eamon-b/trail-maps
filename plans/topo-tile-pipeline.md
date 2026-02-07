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

A build-time pipeline that generates three MBTiles files per trail from open data:

1. **Base map** (vector) — OSM roads, water, land use, POIs from Protomaps
2. **Contour lines** (vector) — elevation isolines from Geoscience Australia SRTM DEM
3. **Hillshade** (raster) — terrain shading from the same SRTM DEM

These are composited via a custom MapLibre style into a topographic map comparable to OpenTopoMap.

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
   /         |          \
  v          v           v
pmtiles    gdalwarp     gdalwarp
extract    (clip DEM)   (clip DEM)
  |          |              |
  v          v              v
base     gdal_contour   gdaldem hillshade
tiles       |              |
  |         v              v
  |    tippecanoe     gdal_translate
  |         |              |
  v         v              v
base.    contours.     hillshade.
mbtiles  mbtiles       mbtiles
  \         |          /
   \        |         /
    MapLibre style.json
    (composites 3 sources)
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
    hillshade.mbtiles           # Pre-rendered hillshade raster tiles
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
# GDAL (contour generation, hillshade, raster processing)
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

#### Step 5: Generate Hillshade

```bash
# Generate multidirectional hillshade (blends light from multiple angles)
gdaldem hillshade \
  -multidirectional \
  -s 111120 \
  -compute_edges \
  -of GTiff \
  -co COMPRESS=LZW \
  dem_corridor.tif \
  hillshade.tif

# Convert hillshade to MBTiles raster tiles (z14 native, z8 minimum via overviews)
gdal_translate \
  -of MBTILES \
  -co TILE_FORMAT=PNG \
  -co ZOOM_LEVEL_STRATEGY=UPPER \
  hillshade.tif \
  hillshade_raw.mbtiles

# Add overview zoom levels down to z8
gdaladdo -r average --config ZOOM_LEVEL_AUTO YES hillshade_raw.mbtiles 2 4 8 16 32 64
```

**Parameter notes**:
- `-multidirectional`: Blends light from 225/270/315/360 degrees — avoids the "one side lit, other side dark" problem of single-direction hillshade
- `-s 111120`: Scale factor required when DEM is in degrees (lat/lon) but elevation is in metres. 111120 = approximate metres per degree.
- `-compute_edges`: Prevents black border artifacts at tile boundaries
- Zoom levels: z8-z14 (SRTM resolution doesn't justify higher)

#### Step 6: Extract Base Map Tiles

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

#### Step 7: Create MapLibre Style

The style.json composites all three sources into a topographic map. See [Appendix A](#appendix-a-maplibre-style) for the complete style definition.

Key design decisions:
- **Hillshade at 30% opacity** under the base map — subtle terrain shading
- **Contour lines in warm brown** (`rgb(179, 134, 89)`) — standard topo map convention
- **Index contours (50m) bold** with elevation labels along the line
- **Regular contours (10m) thin** and semi-transparent
- **Layer order**: background → hillshade → land cover → contours → water → roads → labels → trail overlay

---

## Mobile Integration

### Tile Package Format

Each trail's tiles are packaged as a downloadable bundle:

```
Trail tile manifest (served from CDN / bundled in app):
{
  "trailId": "bibbulmun",
  "version": "2026-02-01",
  "files": [
    { "name": "base.mbtiles", "size": 89000000, "sha256": "abc..." },
    { "name": "contours.mbtiles", "size": 45000000, "sha256": "def..." },
    { "name": "hillshade.mbtiles", "size": 72000000, "sha256": "ghi..." }
  ],
  "totalSize": 206000000,
  "bounds": [115.5, -35.2, 118.0, -31.8],
  "zoomRange": [0, 14]
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
    hillshade: {
      type: 'raster',
      url: `mbtiles://${tilesDir}/hillshade.mbtiles`,
      tileSize: 256,
    },
  },
  layers: [/* ... style layers ... */],
};

// Pass inline style to MapView
<MapLibreGL.MapView styleJSON={JSON.stringify(styleJSON)} />
```

### Download Flow

1. User selects trail → sees tile package size (e.g., "206 MB")
2. Downloads three MBTiles files to `FileSystem.documentDirectory`
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
//   4. Generates hillshade raster tiles
//   5. Extracts base map vector tiles from Protomaps
//   6. Writes tile manifest JSON
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
    dem_s32_e116.tif            # Shared across trails
    dem_s33_e116.tif
    ...
  protomaps/
    planet.pmtiles              # Global basemap (or downloaded per-corridor)
  tiles/                        # Build output (intermediate)
    bibbulmun/
      corridor.geojson
      dem_corridor.tif
      contours.fgb
      contours.mbtiles
      hillshade.tif
      hillshade.mbtiles
      base.pmtiles
      base.mbtiles
      manifest.json
    heysen/
      ...
```

### Final output location

```
public/data/tiles/              # Served by CDN / hosted for download
  bibbulmun/
    base.mbtiles
    contours.mbtiles
    hillshade.mbtiles
    manifest.json
  heysen/
    ...
  style.json                    # Shared style (paths replaced at runtime)
```

---

## Size Estimates

Based on research and corridor area calculations:

| Trail | Length | Corridor Area (20km buffer) | Base | Contours | Hillshade | Total |
|-------|--------|----------------------------|------|----------|-----------|-------|
| Cape to Cape | 123 km | ~5,000 km2 | 15 MB | 8 MB | 12 MB | **~35 MB** |
| Larapinta | 223 km | ~9,000 km2 | 20 MB | 12 MB | 18 MB | **~50 MB** |
| Hume and Hovell | 440 km | ~18,000 km2 | 40 MB | 25 MB | 35 MB | **~100 MB** |
| bibbulmun | 982 km | ~40,000 km2 | 80 MB | 45 MB | 65 MB | **~190 MB** |
| AAWT | 655 km | ~26,000 km2 | 55 MB | 35 MB | 45 MB | **~135 MB** |
| Heysen | 1099 km | ~44,000 km2 | 90 MB | 50 MB | 70 MB | **~210 MB** |

These are estimates — actual sizes depend on terrain complexity (more mountainous = more contour lines) and urban area density (more features = larger base tiles). The Heysen estimate may be lower because much of South Australia is flat.

**Target**: <300 MB per trail, <500 MB for the largest (Heysen).

---

## Implementation Steps

### Phase 1: MapTiler Cloud for Development
1. Create MapTiler account, add API key as `EXPO_PUBLIC_MAPTILER_KEY`
2. Configure MapLibre with MapTiler Outdoor style URL
3. Implement basic offline region caching via `OfflineManager` for testing
4. Continue Part 2 development with working topo maps

### Phase 2: Custom Pipeline (Build Script)
5. Install system dependencies (GDAL, tippecanoe, pmtiles CLI)
6. Validate `mbtiles://` protocol: create a small test MBTiles, load it in MapLibre on both iOS and Android to confirm local tile loading works before investing in the full pipeline
7. Download SRTM DEM tiles for first trail (bibbulmun) via ELVIS portal
8. Implement corridor polygon generation from GPX (with dynamic MGA zone selection per trail)
9. Implement contour generation pipeline (gdal_contour → ogr2ogr classify → tippecanoe)
10. Implement hillshade generation pipeline (gdaldem → gdal_translate)
11. Implement base map extraction (pmtiles extract → tile-join)
12. Create MapLibre topo style.json
13. Generate and bundle PBF font glyphs from Open Sans for offline text rendering (see Appendix B)
14. Validate output: load all three MBTiles in MapLibre on device
15. Wrap pipeline in `scripts/build-tiles.ts`
16. Add `.gitignore` entries for `data/dem/`, `data/protomaps/`, `data/tiles/`, `public/data/tiles/`

### Phase 3: Polish & Remaining Trails
17. Run pipeline for all 6 trails
18. Tune contour styling (intervals, colors, opacity, label density)
19. Tune hillshade opacity and blending
20. Measure actual tile sizes, optimize if needed
21. Choose tile hosting strategy (S3 + CloudFront or similar — tiles are too large for static hosting like Vercel)
22. Implement tile download UI in the mobile app
23. Implement storage management (view/delete downloaded tiles)
24. Design tile versioning/update mechanism (how app detects newer tiles, incremental vs full re-download)
25. Test offline operation end-to-end on device

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
- [ ] Hillshade provides clear terrain perception
- [ ] Hillshade doesn't obscure other map features
- [ ] Base map roads/water/POIs are visible through contours/hillshade
- [ ] Zoom transitions between contour densities are smooth (no pop-in)
- [ ] No visual artifacts at tile boundaries

---

## Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| GDAL/tippecanoe not available in CI | Pipeline runs locally or in a Docker container; output MBTiles are committed or uploaded to CDN |
| MBTiles not loading in MapLibre React Native | Tested in Part 0 spike; fallback to OfflineManager with MapTiler Cloud |
| Tile sizes too large | Reduce buffer from 20km to 10km; reduce max zoom from z14 to z13; use WebP for hillshade |
| Contour quality poor from 30m SRTM | SRTM at 30m is sufficient for 10m contour intervals; if needed, use DEM-S (smoothed) variant |
| Geoscience Australia WCS service down | Cache downloaded DEM tiles locally; use OpenTopography API as fallback |
| Protomaps planet file too large to download | Use HTTP range request extraction (no full download needed) |
| Tile files too large for static hosting (Vercel 250MB limit) | Host tiles on S3 + CloudFront or similar object storage; keep tile builds separate from web deployment |
| Contour GeoJSON too large for memory on big trails | Use FlatGeobuf format for intermediate contour files — compact, streamed, and natively supported by tippecanoe |

---

## Appendix A: MapLibre Style

Complete `style.json` for the three-source topographic map:

```json
{
  "version": 8,
  "name": "Trail Companion Topo",
  "sources": {
    "basemap": {
      "type": "vector",
      "url": "mbtiles://{basePath}/base.mbtiles"
    },
    "contour": {
      "type": "vector",
      "url": "mbtiles://{basePath}/contours.mbtiles"
    },
    "hillshade": {
      "type": "raster",
      "url": "mbtiles://{basePath}/hillshade.mbtiles",
      "tileSize": 256
    }
  },
  "glyphs": "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  "layers": [
    {
      "id": "background",
      "type": "background",
      "paint": {
        "background-color": "#f8f4f0"
      }
    },
    {
      "id": "hillshade-overlay",
      "type": "raster",
      "source": "hillshade",
      "paint": {
        "raster-opacity": 0.3,
        "raster-resampling": "linear"
      }
    },
    {
      "id": "landcover-grass",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landcover",
      "filter": ["==", "class", "grass"],
      "paint": {
        "fill-color": "#d8e8c8",
        "fill-opacity": 0.6
      }
    },
    {
      "id": "landcover-wood",
      "type": "fill",
      "source": "basemap",
      "source-layer": "landcover",
      "filter": ["==", "class", "wood"],
      "paint": {
        "fill-color": "#aed1a0",
        "fill-opacity": 0.5
      }
    },
    {
      "id": "water",
      "type": "fill",
      "source": "basemap",
      "source-layer": "water",
      "paint": {
        "fill-color": "#aad3df"
      }
    },
    {
      "id": "waterway",
      "type": "line",
      "source": "basemap",
      "source-layer": "waterway",
      "paint": {
        "line-color": "#aad3df",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2]
      }
    },
    {
      "id": "contour-regular",
      "type": "line",
      "source": "contour",
      "source-layer": "contour",
      "filter": ["!=", ["get", "is_index"], 1],
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
      "filter": ["==", ["get", "is_index"], 1],
      "paint": {
        "line-color": "rgb(166, 116, 66)",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.7, 14, 1.2],
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.2, 14, 0.4]
      }
    },
    {
      "id": "road-minor",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "filter": ["all", ["==", "class", "minor"]],
      "paint": {
        "line-color": "#ffffff",
        "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 14, 2]
      }
    },
    {
      "id": "road-secondary",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "filter": ["all", ["in", "class", "secondary", "tertiary"]],
      "paint": {
        "line-color": "#fefeb3",
        "line-width": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 3]
      }
    },
    {
      "id": "road-primary",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "filter": ["==", "class", "primary"],
      "paint": {
        "line-color": "#fcd6a4",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 4]
      }
    },
    {
      "id": "road-trunk-motorway",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "filter": ["in", "class", "trunk", "motorway"],
      "paint": {
        "line-color": "#e9ac77",
        "line-width": ["interpolate", ["linear"], ["zoom"], 6, 0.5, 14, 5]
      }
    },
    {
      "id": "path-track",
      "type": "line",
      "source": "basemap",
      "source-layer": "transportation",
      "filter": ["in", "class", "path", "track"],
      "paint": {
        "line-color": "#b0a090",
        "line-width": ["interpolate", ["linear"], ["zoom"], 12, 0.5, 14, 1.5],
        "line-dasharray": [3, 2]
      }
    },
    {
      "id": "building",
      "type": "fill",
      "source": "basemap",
      "source-layer": "building",
      "minzoom": 13,
      "paint": {
        "fill-color": "#d9d0c9",
        "fill-opacity": 0.7
      }
    },
    {
      "id": "contour-label",
      "type": "symbol",
      "source": "contour",
      "source-layer": "contour",
      "filter": ["==", ["get", "is_index"], 1],
      "layout": {
        "symbol-placement": "line",
        "text-field": ["concat", ["to-string", ["get", "elevation"]], "m"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11, 9, 14, 12],
        "text-max-angle": 30,
        "text-padding": 100,
        "text-font": ["Open Sans Regular"]
      },
      "paint": {
        "text-color": "rgb(131, 66, 37)",
        "text-halo-color": "rgba(255, 255, 255, 0.8)",
        "text-halo-width": 1.5
      }
    },
    {
      "id": "place-village",
      "type": "symbol",
      "source": "basemap",
      "source-layer": "place",
      "filter": ["==", "class", "village"],
      "layout": {
        "text-field": "{name}",
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
      "source-layer": "place",
      "filter": ["==", "class", "town"],
      "layout": {
        "text-field": "{name}",
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
      "source-layer": "place",
      "filter": ["in", "class", "city", "metropolis"],
      "layout": {
        "text-field": "{name}",
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
      "source-layer": "mountain_peak",
      "layout": {
        "text-field": ["concat", ["get", "name"], "\n", ["to-string", ["get", "ele"]], "m"],
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
- The style references OpenMapTiles schema layer names. Protomaps uses its own "Basemap" schema which is similar but not identical — verify exact layer and property names against the [Protomaps Basemap docs](https://docs.protomaps.com/basemaps) before finalizing. In particular, `mountain_peak` may be named differently.
- Trail overlay layers (polyline, waypoints) are added dynamically by the app on top of this style
- Font glyphs need to be either bundled or downloaded; the demotiles URL is a placeholder for development — replace with bundled local glyphs for offline operation (see Appendix B)
- This is a starting point — visual tuning will happen in Phase 3

---

## Appendix B: Font Glyphs

MapLibre needs PBF font glyphs for text rendering. Options:

1. **Bundle fonts with the app**: Generate PBF glyphs from Open Sans using [font-maker](https://github.com/maplibre/font-maker), bundle in `mobile/assets/fonts/`
2. **Use a CDN**: Point `glyphs` URL to a hosted glyph set (requires network for first load)
3. **Use MapTiler fonts** (Phase 1 only): `https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=KEY`

For offline operation, fonts must be bundled. This is a small asset (~2-5 MB for Open Sans Regular + Bold).

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

## Review Notes

**Reviewed: 2026-02-08**

### Overall Assessment

This is a thorough, well-researched plan. The architecture is sound, the tool choices are correct, the pipeline steps are detailed and technically accurate, and the phased approach (MapTiler for dev → custom pipeline for production) is pragmatic. The plan is ready for implementation with the corrections and additions noted below.

### Issues Fixed

1. **Spelling inconsistency**: The plan inconsistently used "Bibbulmum" in some places. Fixed all instances to `bibbulmun` to match the codebase trail ID and directory name.

### Gaps Identified and Addressed

All gaps below have been fixed in the plan above:

2. **`.gitignore` updates** — added as implementation step 16
3. **Font glyph bundling** — added as implementation step 13
4. **`mbtiles://` protocol validation** — added as implementation step 6 (early gate before full pipeline)
5. **Hillshade zoom range** — added `ZOOM_LEVEL_STRATEGY` to gdal_translate command in Step 5
6. **CDN/hosting strategy** — added as implementation step 21 and risk table entry
7. **Tile versioning** — added as implementation step 24 (Phase 3 design question)
8. **Dynamic MGA zone** — updated Step 1 to note dynamic EPSG selection per trail
9. **Contour memory** — switched Steps 3-4 from GeoJSON to FlatGeobuf format
10. **Protomaps schema** — added verification note in Appendix A
11. **Peak icon without sprite** — removed `icon-image` reference, switched to text-only symbol
12. **Build script isolation** — removed `build:tiles` from main `build` command, added explanatory note

### Checklist Results

- [x] All affected files identified
- [x] Steps are in the right order
- [x] Dependencies and prerequisites are documented well
- [x] Edge cases considered (tile size limits, offline, fallback, large files, hosting)
- [x] Testing strategy sufficient (includes mbtiles:// protocol validation step)
- [x] No simpler alternatives exist for the core problem
- [x] No risk of breaking existing build (build:tiles kept separate)
