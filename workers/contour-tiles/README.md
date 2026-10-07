# contour-tiles worker

Serves contour vector tiles out of PMTiles archives on R2.

- Public hostname: `https://tiles.contour-map-tiles.net` (also still on
  `contour-tiles.aus-map-data.workers.dev` for already-shipped mobile builds)
- URL pattern: `/{source}/{z}/{x}/{y}.pbf`
- Archives: R2 bucket `aus-map-data` (see Sources below)
- Health: `/health` — reports archive size/etag and the archive's zoom + bbox
- Consumed by the mobile app via `EXPO_PUBLIC_CONTOUR_TILE_URL`

This Worker is one of three public hostnames for the tileset; the docs page
and the archive itself are served without it:

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | docs + live demo (Cloudflare Pages, `site/contour-tiles/`) |
| `data.contour-map-tiles.net` | the R2 bucket directly — the PMTiles archive and offline tile packs |
| `tiles.contour-map-tiles.net` | this Worker: z/x/y tile endpoint |

Clients that speak PMTiles should read the archive straight off
`data.…` — it has no Worker request limits in front of it. This Worker exists
for clients that can only consume z/x/y URLs.

```bash
npm run dev      # wrangler dev
npm run deploy   # wrangler deploy (requires `wrangler login`)
npx tsc --noEmit # typecheck
```

## Sources

The `{source}` path segment selects one PMTiles archive. The mapping is the
`SOURCES` record in `src/index.ts`:

| Source | R2 key |
| --- | --- |
| `contours` | `contours/australia.pmtiles` |
| `world` | `contours/world.pmtiles` |

**Adding a tileset is one entry in `SOURCES` plus uploading the archive to R2** —
routing, the per-source PMTiles instance cache, edge caching (already keyed by
the full pathname, which includes the source segment) and `/health` all pick it
up automatically. An unknown source is a `404`.

A source listed in `SOURCES` whose archive is not uploaded yet is not an error
condition: it serves `500`s for tiles and reports `ok: false` under
`sources` in `/health`, while the rest of the Worker is unaffected.

### `/health` shape

Top-level fields describe the `contours` source exactly as they always have
(`ok`, plus `archive`/`tiles` when healthy or `error` when not), and the overall
HTTP status still follows `contours` alone — so existing consumers keep working
while `world` is still being built. A `sources` object adds the per-source
breakdown:

```json
{
  "ok": true,
  "archive": { "key": "contours/australia.pmtiles", "size": 0, "etag": "…" },
  "tiles": { "minZoom": 9, "maxZoom": 14, "minLon": 0, "minLat": 0, "maxLon": 0, "maxLat": 0 },
  "sources": {
    "contours": { "ok": true, "archive": { … }, "tiles": { … } },
    "world": { "ok": false, "error": "Contour archive not found" }
  }
}
```

## Contour smoothing

Below each archive's maxzoom, tippecanoe simplified every contour to a few
straight segments, which draws as a sawtooth at z9-z14. Rather than rebuild
the archives, the Worker smooths line geometry as it serves a tile
(`src/contour-smoothing.ts`): Chaikin corner cutting, then Douglas-Peucker at
a sub-pixel tolerance to drop the points the passes add on straight runs. Only
LineString geometry changes. Everything else in the tile is copied through byte
for byte, line endpoints stay exactly where they were (so contours still meet
across tile edges), and closed rings stay closed.

| Source | Zooms smoothed | Passes / tolerance | Compressed size | CPU per tile miss |
| --- | --- | --- | --- | --- |
| `contours` | 9-14 | 3 / 2 | 1.3-2x | ~5-110 ms (densest z9) |
| `world` | 9-11 | 2 / 1 | ~1.15x | up to ~140 ms (densest z10) |

`world` was built with finer simplification and already draws smooth from z12,
so it is left alone there. The `SMOOTHING` comment in `src/index.ts` records
how these settings were chosen. Clients that read the archives directly from
`data.contour-map-tiles.net` get the stored geometry, and so do the offline
tile packs.

Smoothed tiles carry `X-Contour-Smoothing: <version>`. Set the `CONTOUR_SMOOTHING`
var to `off` (Cloudflare dashboard → Worker → Settings → Variables) to serve the
stored geometry again without a code change. The edge cache key names which
geometry it holds (`?geometry=<version>` or `?geometry=raw`), so switching
never serves one kind for the other. Browsers and the app can still hold the
other kind for up to `max-age` (24 h).

When you change `SMOOTHING` or the algorithm, bump `SMOOTHING_VERSION`, so tiles
cached under the old settings are not served.

## Edge caching

Tile responses are stored in `caches.default`, keyed by URL path plus the
geometry tag above (the request's own query string is stripped; always a GET
key so HEAD shares the same entry).

This is **live on `tiles.contour-map-tiles.net`** (verified 2026-08-19:
requesting `/contours/12/3734/2493.pbf` twice flips `X-Edge-Cache` from `MISS`
to `HIT`). It remains a no-op on the `*.workers.dev` hostname, where the Cache
API does nothing because that zone is shared by every account — so measure
caching on the custom domain only.

`workers_dev = true` is deliberately still set, so builds that already shipped
with the workers.dev URL inlined keep working. Flip it to `false` only once no
released build points there.

What is and is not cached:

| Response | Edge-cached | Why |
| --- | --- | --- |
| `200` tile | yes | immutable for the life of an archive build |
| `204` empty tile | no | 204 is not one of Cloudflare's cacheable status codes; it still carries `Cache-Control: public, max-age=86400` for browsers/downstream caches, and on the Worker side it is a directory lookup the in-isolate cache usually answers without touching R2 |
| `/health` | no | `Cache-Control: no-store`; it reports current archive state |
| `404` / `405` / `500` | no | a transient R2 failure must not pin an error to a tile URL for 24h |

## Staleness after re-uploading the archive

Tiles are immutable for the lifetime of an archive build, but
`australia.pmtiles` can be re-uploaded. Two separate caches are involved:

- **R2 / in-isolate PMTiles cache** — handled. A re-upload changes the R2 etag;
  the next range read from a stale warm isolate raises `EtagMismatch`, and the
  Worker drops the cached PMTiles instance and retries once.
- **Edge cache** — *not* handled, by choice. For up to `max-age` (86400s / 24h)
  after a re-upload the edge can serve pre-upload tiles.

That staleness window is the accepted tradeoff: contour geometry changes rarely
and never urgently, so no purge machinery is built. If a rebuild ever does need
to land immediately, either purge the zone cache manually in the Cloudflare
dashboard or change the URL path so the new tiles have new cache keys.

## CORS

`ALLOWED_ORIGIN` (optional `[vars]` entry in `wrangler.toml`) sets
`Access-Control-Allow-Origin`; it defaults to a wildcard for dev. Preflights
answer with `Access-Control-Max-Age: 86400`.

CORS headers are attached **after** cache retrieval and are never stored in the
cache entry. `caches.default` is keyed by URL only, so a stored ACAO would be
replayed verbatim to every later requester of that URL. Keeping the stored bytes
origin-agnostic means no origin can be served another origin's ACAO, and
changing `ALLOWED_ORIGIN` takes effect immediately instead of after entries
expire. When `ALLOWED_ORIGIN` is set, responses also carry `Vary: Origin` so
downstream shared caches know the response is origin-dependent.

## CORS on the bucket itself (separate from this Worker)

Browsers reading the archive directly (`pmtiles://…`) need CORS on the R2
bucket, not on this Worker. Rules were set 2026-08-19 — GET/HEAD, wildcard
origin, `range`/`if-match` allowed, `etag`/`content-range`/`accept-ranges`
exposed:

```bash
wrangler r2 bucket cors list aus-map-data
```

The exposed `etag` and `content-range` are load-bearing: without them the
pmtiles JS client cannot validate ranges and the demo map renders nothing.

## Related: off r2.dev

Offline tile downloads (`EXPO_PUBLIC_TILE_BASE_URL`) used to point at the
`pub-….r2.dev` public bucket URL, which is rate-limited and explicitly not
meant for production traffic. Since 2026-08-19 they go through
`data.contour-map-tiles.net` — same bucket, same object keys, but with a real
CDN cache in front. The `r2.dev` URL still works and is unchanged; nothing has
to be migrated off it in a hurry.

`mobile/.env.local` is untracked, so it keeps whatever it had: update it by hand
to match `eas.json`. Metro inlines `EXPO_PUBLIC_*` at bundle time, so restart
Metro afterwards — and remember `eas.json` only affects EAS cloud builds.
