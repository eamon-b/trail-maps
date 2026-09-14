# Contour Map Tiles — public docs & demo page

Static one-page site documenting the public contour tilesets in the R2 bucket
`aus-map-data`: the world archive (`contours/world.pmtiles`, Copernicus GLO-30,
~750 GB) and the Australia archive (`contours/australia.pmtiles`, Geoscience
Australia DEM-S, 11.9 GB). Live MapLibre demo on the world archive, usage
snippets, schema, extract instructions, and the attribution each licence requires.

Deployed on Cloudflare Pages (project `aus-contour-tiles`), served at
`contour-map-tiles.net` with `aus-contour-tiles.pages.dev` as the fallback:

```bash
npx wrangler pages deploy site/contour-tiles --project-name aus-contour-tiles
```

The three public hostnames on the `contour-map-tiles.net` zone:

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | this page (Pages) |
| `data.contour-map-tiles.net` | the R2 bucket — archive + offline tile packs |
| `tiles.contour-map-tiles.net` | the contour-tiles Worker (z/x/y endpoint) |

Notes:

- The archive URLs are defined once, in the `ARCHIVE_URL` (world) and
  `AUSTRALIA_URL` constants at the top of the inline script in `index.html`;
  the docs snippets are populated from them at runtime. Change those constants
  to move a tileset.
- The world archive's size and tile count on the page (~750 GB, ~232 million
  tiles) come from the 2026-09-14 build; refresh them from `pmtiles show` after
  a rebuild.
- Browser access to the archive requires the CORS rules on the `aus-map-data`
  bucket (GET/HEAD, wildcard origin, `etag`/`content-range` exposed). They were
  set 2026-08-19 via `wrangler r2 bucket cors set`.
- The demo basemap and fonts are hotlinked from OpenFreeMap (free to use, no
  key). Contour layers are added on top of their `positron` style.
