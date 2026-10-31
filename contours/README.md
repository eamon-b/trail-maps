# Contour Map Tiles

The public world-contours dataset: 10 m contour lines from Copernicus GLO-30 as
one PMTiles archive, a z/x/y tile endpoint, and a page documenting both, at
[contour-map-tiles.net](https://contour-map-tiles.net). Tracknotes uses it like
any other client. It lives in this repo because both share the contour zoom
tiers (below), not because the app owns it.

| Path | What |
| --- | --- |
| `scripts/build-contours-world.ts` | the world build: DEM → contour shards → `world.pmtiles` |
| `scripts/remote/` | running that build on a rented machine, and uploading the result |
| `scripts/contour-experiment.ts` | side-by-side quality experiments on the build settings |
| `docs/world-contours-remote-build.md` | the runbook for a world build |
| `worker/` | the `contour-tiles` Worker: `/{source}/{z}/{x}/{y}.pbf` and `/health` |
| `site/` | the public page and live demo (Cloudflare Pages, direct upload) |

Run everything from the repo root: the scripts use the root `package.json`, its
tests run in `npm test` and its lint and typecheck cover `contours/scripts/`.
The Worker has its own `package.json` (`cd contours/worker && npm ci`).

## Infrastructure

Everything here sits on the `contour-map-tiles.net` zone and the R2 bucket
`aus-map-data`. The app's own content (trail data, offline packs, photos) is in
`tracknotes-data` on `tracknotes.info`, so nothing in this list holds app or
user data.

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | `site/` (Pages project `aus-contour-tiles`) |
| `data.contour-map-tiles.net` | `aus-map-data`: the archives under `contours/` |
| `tiles.contour-map-tiles.net` | `worker/` |

## What the app relies on

These are the dataset's public interface. Changing one changes the app, so
`scripts/e2e-tile-check.mjs` (the `tile-packs` CI job, weekly and on its own
changes) checks each through the URLs in `mobile/eas.json`:

- `GET /health` answers 200 or 503 with `sources.world.ok`, the archive's size
  and `tiles.maxZoom` 15 (the maxzoom the app's style declares).
- `GET /world/{z}/{x}/{y}.pbf` serves gzip MVT with a `contour` layer, through
  z15.
- The zoom tiers: 100 m lines from z9, 50 m from z10, 20 m from z12, 10 m from
  z13.

The tiers are the one piece of code both sides share: `CONTOUR_TIERS` and the
tippecanoe settings in `scripts/tile-pipeline.ts`, which the world build here
and every offline pack the app ships (`scripts/build-tiles.ts`) both use, so a
pack draws the same lines as the online tiles. Change them in one PR that
rebuilds both, or the lines visibly change when a phone goes offline.

The `contours` source (an alias of `world`) and the top-level `ok` in `/health`
are kept for clients outside the app; the app reads neither.

One source here is the app's, not the dataset's: `base`, the Protomaps planet
basemap (`basemap/planet.pmtiles`), which the phone reads alongside `world` to
build offline maps for imported and community routes (`corridor-pack.ts`
needs both `sources.base.ok` and `sources.world.ok`). Until the archive is
uploaded, `/health` reports it as not found and those builds stop before
fetching anything.
