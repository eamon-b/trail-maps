# Australian Contour Tiles — public docs & demo page

Static one-page site documenting the public `australia.pmtiles` contour tileset
(R2 bucket `aus-map-data`, key `contours/australia.pmtiles`): live MapLibre demo,
usage snippets, schema, extract instructions, and CC-BY attribution.

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

- The archive URL is defined once, in the `ARCHIVE_URL` constant at the top of
  the inline script in `index.html`; the docs snippets are populated from it at
  runtime. Change that one constant to move the tileset.
- Browser access to the archive requires the CORS rules on the `aus-map-data`
  bucket (GET/HEAD, wildcard origin, `etag`/`content-range` exposed). They were
  set 2026-08-19 via `wrangler r2 bucket cors set`.
- The demo basemap and fonts are hotlinked from OpenFreeMap (free to use, no
  key). Contour layers are added on top of their `positron` style.
