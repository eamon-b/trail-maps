# World Contour Tiles (issue #34)

Expand the contour tileset from Australia to the whole world: best-quality
settings chosen by experiment, built and merged on a rented remote machine,
served from R2 alongside (initially) the existing Australia archive.

Status: tooling implemented on `feat/world-contour-tiles` (this plan is the
spec). The actual world build runs on a remote machine per
`docs/world-contours-remote-build.md`.

## What exists today (baseline)

- `scripts/build-contours-australia.ts`: 2°×2° cells over Australia, SRTM 1"
  DEM (`data/dem/*.hgt`), per-cell gdalwarp (cubicspline, 2× oversample,
  `-tap`) → gdal_contour (10 m) → 4 zoom-tier FlatGeobufs → one tippecanoe
  merge → `australia-contours.pmtiles` (11.9 GB, z9–15).
- Cell IDs `E{lon}_S{latNorthEdge}` (positive degrees south) — Australia-only
  convention, kept as-is; the world build uses a new unambiguous scheme.
- Worker `workers/contour-tiles` serves `/{source}/{z}/{x}/{y}.pbf` from
  `contours/australia.pmtiles`; the schema (layer `contour`, attrs
  `elevation` int-ish + `is_index` 0/1 as *string*, z9–15, 204 for empty) is a
  public API on contour-map-tiles.net — the world tileset must keep it.

## Decisions

### DEM source: Copernicus GLO-30

SRTM only covers 60°N–56°S and needs EarthData auth. Copernicus GLO-30 is
global (−90..90), 1 arc-second, float32 metres, free and anonymous on AWS Open
Data:

- Tile: `https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_{N|S}{lat:02}_00_{E|W}{lon:03}_00_DEM/Copernicus_DSM_COG_10_..._DEM.tif`
  (1°×1°, named by SW corner, COG).
- Land mask: `https://copernicus-dem-30m.s3.amazonaws.com/tileList.txt` lists
  every existing tile (~26,450). Ocean tiles are simply absent — no 404
  probing needed. Cache the list at `data/dem-glo30/.tileList.txt`.
- Longitude pixel spacing widens in latitude bands (1" below 50°, then
  1.5"/2"/3"/5"/10" at 50/60/70/80/85°). gdalwarp resamples to our target
  grid regardless; no special handling, just more interpolation at high
  latitudes.
- Local naming: store as `data/dem-glo30/{N46E006}.tif` (SW-corner short
  names). Separate directory from the SRTM cache so the two sources never mix
  in one mosaic.

The world build uses GLO-30 everywhere, including Australia, so the archive is
internally consistent. The existing SRTM-based Australia archive stays in
production until the world archive is verified over Australian trails.

### Global grid and cell naming

Same 2°×2° cell strategy, extended to signed global coordinates:

- Lattice: SW corners at even degrees, lon −180..178, lat −90..88. This
  lattice *contains* the Australia lattice exactly (E112_S34's real SW corner
  is (112, −36), both even), so per-cell outputs are geometrically compatible.
- Cell ID: lat-first, SW corner, zero-padded: `N46E006`, `S26E132`,
  `S02W080`. Regex `^[NS]\d{2}[EW]\d{3}$` — distinct from both the legacy
  Australia scheme (`E132_S24`) and Copernicus full names. NOTE the legacy
  scheme's `S` value is the cell's *north* edge; the world scheme is SW corner.
  `E132_S24` ≡ world `S26E132`. Never mix work dirs.
- Module: `scripts/lib/world-grid.ts` —
  `interface WorldCell { id: string; west: number; south: number; east: number; north: number }`
  (all signed degrees),
  `worldCellId(west, south)`, `parseWorldCellId(id)`, `isAlignedWorldCellId(id)`,
  `enumerateWorldCells(bbox?)`,
  `dem1DegTiles(cell)` → 1° SW corners, `demTileName({lat, lon})` → `N46E006`,
  `copernicusKey({lat, lon})` → full AWS object key.

### Shards (partition of the world)

One tippecanoe run over the whole world would repeat the Australia merge
pain (24 h, RAM-bound) at ~20× scale. Instead:

1. Cells are partitioned into named **shards** (continent-scale). Defined in
   `world-grid.ts` as an ordered list of bboxes; `shardForCell(cell)` = first
   bbox containing the cell centre, with a mandatory catch-all last entry —
   priority order makes the partition total and disjoint even though bboxes
   overlap. Shards: europe, asia-west, asia-east, africa, north-america,
   central-america, south-america, oceania (incl. Australia/NZ), islands +
   catch-all `rest`; `antarctica` and `greenland` are separate opt-out shards
   (ice-sheet contours are huge and near-useless — build last or skip).
2. Each shard builds independently (resumable per-cell, exactly like the
   Australia script) and merges with tippecanoe to `world_{shard}.mbtiles`.
3. `tile-join` unions the shard mbtiles into `world.mbtiles` (cells are
   clipped disjoint, so tile-join only stitches at shard-border tiles), then
   `pmtiles convert` → `world.pmtiles`. tile-join must run with
   `--no-tile-size-limit` so re-encoded border tiles aren't dropped.

### Build script: `scripts/build-contours-world.ts`

Same per-cell pipeline as Australia (buffered warp @ `CONTOUR_WARP_TR_DEG`
cubicspline + `-tap`, gdal_contour −i 10, identical 4-tier split and
`is_index`), differences:

- Grid/DEM from `world-grid.ts` + `data/dem-glo30/`.
- `--shard <name>` selects the cell set; `--bbox` and `--cell` for testing.
- `--fetch-dem`: download missing GLO-30 tiles for the pending cells before
  building (calls the fetcher); `--purge-dem`: delete a cell's DEM tiles once
  the cell is done and no *pending* cell still needs them (keeps peak disk
  ~shard-sized instead of ~1.1 TB world DEM).
- Merge outputs `world_{shard}.mbtiles` (tippecanoe `-o *.mbtiles`, same
  quality flags as Australia incl. `--simplify-only-low-zooms`).
- `--join`: tile-join all `world_*.mbtiles` present → `world.mbtiles` →
  `pmtiles convert` → `world.pmtiles`; validates zoom range (z9–15) with the
  existing `validateMbtilesArtifact` before convert.
- No MGA/EPSG anywhere (contours are built in EPSG:4326; the epsg field in the
  Australia CellDef was never used by the contour path).
- Work dir `data/tiles/contours-world/`, tier files `{cellId}_{tier}.fgb` +
  `.done` markers, same `--merge-only`/`--force`/`--parallel` semantics and
  the same E2BIG-safe execFileSync argv merge.

### Worker: additive multi-source

`SOURCES: Record<string, string>` = `{ contours: 'contours/australia.pmtiles',
world: 'contours/world.pmtiles' }`; per-source PMTiles instance cache keyed by
source; unknown source → 404 (unchanged message shape). `/health` keeps its
current response for `contours` and gains a per-source breakdown; a missing
world archive must NOT fail health while only Australia is deployed — report
per-source ok flags, overall ok if at least the default source is healthy.
Keep the diff minimal: PR #25 touches this worker.

### Quality experiments: `scripts/contour-experiment.ts`

The issue explicitly wants settings experimentation before burning a week of
remote compute. Harness: build the *same small bbox* (default: Mt Sonder,
132.5..132.65, −23.65..−23.5; test tile z15 28450/18593) under a matrix of
variants, each variant a named settings bundle:

- `warpScale`: 1 | 2 | 3 (× 1 arc-second density)
- `resampling`: cubicspline | cubic | lanczos
- `simplification`: tippecanoe `--simplification` value
- `minimumDetail`, `simplifyOnlyLowZooms`
- `demDir`: compare SRTM (`data/dem`) vs GLO-30 (`data/dem-glo30`) over
  Australia

Outputs per variant: `data/experiments/{run}/{variant}.pmtiles` + timing +
sizes + `ogrinfo` vertex counts in `results.json`, plus a generated
`index.html` — side-by-side synchronized MapLibre panes reading the local
pmtiles via the pmtiles JS protocol (CDN deps fine, local-only harness;
serve with `npx serve data/experiments/{run}`).

Decision gate: Eamon eyeballs the compare page, picks the bundle, and the
chosen values become the defaults in `build-contours-world.ts` before the
remote build starts.

### Remote build

`docs/world-contours-remote-build.md` + `scripts/remote/bootstrap.sh` (apt
GDAL ≥3.6, tippecanoe from source, Node 22, pmtiles CLI, rclone) +
`scripts/remote/run-shard.sh` (setsid nohup + logging + bounded retry — the
laptop lessons: OOM killer kills silent background jobs, tippecanoe temp spill
must not land on tmpfs, a killed merge leaves an invalid pmtiles because the
header is written last).

Sizing (estimates, to validate with the first shard):
- Cells: ~7,000–7,500 2° land cells incl. polar (≈26,450 GLO-30 tiles ÷ ~4,
  edge effects); ~5,500 excluding Antarctica/Greenland interior.
- Cell processing: ~100 s/cell (laptop measured 1 m 40 s) → on a 32-thread box
  at `--parallel 16`, ≈ 10–13 h for all shards' cells.
- DEM: ~1.1 TB world total; per-shard peak ~100–200 GB with `--purge-dem`.
- tippecanoe per shard: Australia (248 cells) took ~4 h tiling + ~20 h
  RAM-starved clustering on 15 GB; with 128 GB RAM expect ~2–5 h/shard, and
  shards can run 2–3 concurrent → ~1–2 days.
- Output: Australia is 11.9 GB / 7.7 M km² of mostly-flat land; world land is
  ~19× the area with far more high-relief terrain → **rough estimate
  150–350 GB** for world.pmtiles. R2 storage ≈ $2.5–5.5/month; egress free.
- Machine: Hetzner dedicated (e.g. AX102: 32 threads, 128 GB RAM, 2×1.92 TB
  NVMe, ~€110/mo, unmetered 1 Gbps) or an hourly cloud box with ≥64 GB RAM +
  ≥3 TB NVMe. One month's rental covers the whole build with retries.
- Upload: rclone (S3 API, multipart) — `wrangler r2 object put` is impractical
  at 100+ GB. Content-addressed key not needed; key `contours/world.pmtiles`,
  same 24 h edge-cache staleness tradeoff as Australia re-uploads.

### Rollout

1. Land this branch (tooling only, no data change).
2. Run experiments locally, pick settings (Eamon decision gate).
3. Rent machine, bootstrap, build `oceania` shard first (contains Australia →
   direct quality comparison against the production archive on known trails).
4. Build remaining shards, `--join`, upload `contours/world.pmtiles`.
5. Deploy worker with the `world` source; verify `/health` + spot tiles.
6. Point the public demo/docs (PR #25 site) at `world`; later decide whether
   `contours` becomes an alias of world and the SRTM Australia archive is
   retired.

## Non-goals (this branch)

- No change to the per-trail offline tile pipeline (`build-tiles.ts`) or the
  mobile app.
- No change to the served schema (layer/attrs/zooms/204s).
- Not building bathymetry, hillshade, or non-contour layers.
