# Contour Map Tiles — public docs & demo page

Static one-page site documenting the public contour tileset in the R2 bucket
`aus-map-data`: the world archive (`contours/world.pmtiles`, Copernicus GLO-30,
~613 GB). Live MapLibre demo on it, usage snippets, schema, extract
instructions, and the attribution its licence requires. The page also lists the
deprecated Australia archive (`contours/australia.pmtiles`, Geoscience
Australia DEM-S, 13.5 GB, CC BY 4.0), frozen at its 2026-10-23 build: still
downloadable from R2, no longer served by the Worker (`/contours/` is now an
alias of `/world/`) and no longer rebuilt.

Deployed on Cloudflare Pages (project `aus-contour-tiles`), served at
`contour-map-tiles.net` with `aus-contour-tiles.pages.dev` as the fallback:

```bash
npx wrangler pages deploy contours/site --project-name aus-contour-tiles
```

The three public hostnames on the `contour-map-tiles.net` zone:

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | this page (Pages) |
| `data.contour-map-tiles.net` | the R2 bucket — the archives (the app's offline packs are at `data.tracknotes.info`, bucket `tracknotes-data`) |
| `tiles.contour-map-tiles.net` | the contour-tiles Worker (z/x/y endpoint) |

Notes:

- The archive URLs are defined once, in the `ARCHIVE_URL` (world) and
  `AUSTRALIA_URL` (deprecated download) constants at the top of the inline script in `index.html`;
  the docs snippets are populated from them at runtime. Change those constants
  to move a tileset.
- The world archive's size and tile count on the page (~613 GB, ~232 million
  tiles) come from the 2026-10-24 re-tier build, and the deprecated Australia
  archive's (13.5 GB, ~9.6 million tiles) from its final 2026-10-23 build;
  refresh the world's after a rebuild from the object's `content-length` and
  the PMTiles header's addressed-tile count.
- Browser access to the archive requires the CORS rules on the `aus-map-data`
  bucket (GET/HEAD, wildcard origin, `etag`/`content-range` exposed). They were
  set 2026-08-19 via `wrangler r2 bucket cors set`.
- The demo basemap and fonts are hotlinked from OpenFreeMap (free to use, no
  key). Contour layers are added on top of their `positron` style.
