# contour-tiles worker

Serves contour vector tiles out of PMTiles archives on R2.

- Public hostname: `https://tiles.contour-map-tiles.net` (the only one: the
  `workers.dev` URL is off, `workers_dev = false`, issue #159)
- URL pattern: `/{source}/{z}/{x}/{y}.pbf`
- Archives: R2 bucket `aus-map-data` (see Sources below)
- Health: `/health` — reports archive size/etag and the archive's zoom + bbox
- Consumed by the mobile app via `EXPO_PUBLIC_CONTOUR_TILE_URL`

This Worker is one of three public hostnames for the tileset; the docs page
and the archive itself are served without it:

| Hostname | Serves |
| --- | --- |
| `contour-map-tiles.net` | docs + live demo (Cloudflare Pages, `contours/site/`) |
| `data.contour-map-tiles.net` | the R2 bucket directly — the PMTiles archives |
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
`SOURCES` record in `src/sources.ts`:

| Source | R2 key |
| --- | --- |
| `world` | `contours/world.pmtiles` |
| `contours` | `contours/world.pmtiles` (alias) |
| `base` | `basemap/planet.pmtiles` |

`contours` served the Australia archive (`contours/australia.pmtiles`,
Geoscience Australia DEM-S) until that archive was retired in favour of the
world one (#228). It stays as an alias of `world` because shipped Tracknotes
builds (no OTA updates) request `/contours/{z}/{x}/{y}.pbf` for Australian
trails and read `/health`'s top-level `ok` as that source's health, and public
endpoint users may use it. `contours/australia.pmtiles` stays in R2 as a
frozen download (last built 2026-10-23); this Worker no longer serves it.

`base` is not contours: it is the Protomaps planet basemap (z0–15), the same
archive `scripts/build-tiles.ts` extracts the bundled offline packs' `base.mbtiles`
from. Tracknotes downloads it tile by tile along an imported or community
route to build that route's offline pack on the phone (issue #227), so it must
be a whole-planet daily build from build.protomaps.com (~120 GB; not
`data/protomaps/planet.pmtiles`, which despite its name is a 2 GB Australia
extract) whose basemap major version matches `scripts/topo-style.json` (v4).
It is over wrangler's size limit; rclone streams it from the build server
straight into R2, without a local copy:
`rclone copyurl https://build.protomaps.com/<YYYYMMDD>.pmtiles r2:aus-map-data/basemap/planet.pmtiles`
(then check `sources.base` in the Worker's `/health` shows maxZoom 15 and world bounds).
Replacing it is safe while phones download: the etag-mismatch retry below picks
up the new archive, and a pack built across the switch mixes two builds of the
same schema.

**Adding a tileset is one entry in `SOURCES` plus uploading the archive to R2** —
routing, the PMTiles instance cache (keyed by R2 key, so aliases share one
instance), edge caching (already keyed by
the full pathname, which includes the source segment) and `/health` all pick it
up automatically. An unknown source is a `404`.

A source listed in `SOURCES` whose archive is not uploaded yet is not an error
condition: it serves `500`s for tiles and reports `ok: false` under
`sources` in `/health`, while the rest of the Worker is unaffected.

### `/health` shape

Top-level fields describe `DEFAULT_SOURCE` (`world`) in the shape they always
had (`ok`, plus `archive`/`tiles` when healthy or `error` when not), and the
overall HTTP status follows that source alone. Shipped app builds read the
top-level `ok` as the health of `contours`, which still holds because
`contours` is an alias of `world`. A `sources` object adds the per-source
breakdown:

```json
{
  "ok": true,
  "archive": { "key": "contours/world.pmtiles", "size": 0, "etag": "…" },
  "tiles": { "minZoom": 9, "maxZoom": 15, "minLon": 0, "minLat": 0, "maxLon": 0, "maxLat": 0 },
  "sources": {
    "contours": { "ok": true, "archive": { "key": "contours/world.pmtiles", … }, "tiles": { … } },
    "world": { "ok": true, "archive": { … }, "tiles": { … } }
  }
}
```

## Edge caching

Tile responses are stored in `caches.default`, keyed by URL (query string
stripped, always a GET key so HEAD shares the same entry).

This is **live on `tiles.contour-map-tiles.net`** (verified 2026-08-19:
requesting `/contours/12/3734/2493.pbf` twice flips `X-Edge-Cache` from `MISS`
to `HIT`). The Cache API would be a no-op on a `*.workers.dev` hostname, whose
zone is shared by every account; that hostname is now off (`workers_dev =
false`, issue #159), so the custom domain is the only way in.

What is and is not cached:

| Response | Edge-cached | Why |
| --- | --- | --- |
| `200` tile | yes | immutable for the life of an archive build |
| `204` empty tile | no | 204 is not one of Cloudflare's cacheable status codes; it still carries `Cache-Control: public, max-age=86400` for browsers/downstream caches, and on the Worker side it is a directory lookup the in-isolate cache usually answers without touching R2 |
| `/health` | no | `Cache-Control: no-store`; it reports current archive state |
| `404` / `405` / `500` | no | a transient R2 failure must not pin an error to a tile URL for 24h |

## Staleness after re-uploading the archive

Tiles are immutable for the lifetime of an archive build, but
`world.pmtiles` can be re-uploaded. Two separate caches are involved:

- **R2 / in-isolate PMTiles cache** — handled. A re-upload changes the R2 etag;
  the next range read from a stale warm isolate raises `EtagMismatch`, and the
  Worker drops the cached PMTiles instance and retries once.
- **Edge cache** — *not* handled, by choice. For up to `max-age` (86400s / 24h)
  after a re-upload the edge can serve pre-upload tiles.

That staleness window is the accepted tradeoff: contour geometry changes rarely
and never urgently, so no purge machinery is built. If a rebuild ever does need
to land immediately, either purge the zone cache manually in the Cloudflare
dashboard or change the URL path so the new tiles have new cache keys. The edge
cache is keyed by URL, so `/contours/…` and `/world/…` hold separate entries
for the same tiles; repointing `contours` from the Australia archive to the
world one was followed by a purge of `tiles.contour-map-tiles.net/contours/*`;
`npm run check:contours-alias` (root) confirms both took effect: `/health` reports
`sources.contours.archive.key` as `contours/world.pmtiles`, and `/contours/…`
and `/world/…` serve byte-identical tiles. A purge clears only the edge:
browsers and phones may keep tiles they already hold for their `max-age`
(86400 s), so devices can show the old lines for up to a day after it.

The source → archive mapping lives in `src/sources.ts`, free of runtime
dependencies so the root suite tests it (`src/lib/contour-worker-sources.test.ts`).

## CORS

`ALLOWED_ORIGIN` (optional `[vars]` entry in `wrangler.toml`) sets
`Access-Control-Allow-Origin`; it defaults to a wildcard. **Leave it unset in
production:** the endpoint is public, so the demo on `contour-map-tiles.net` and
anyone else's map fetch it from other origins, and a single origin would break
them all (it takes one value, not a list). The phone is unaffected either way:
MapLibre's native requests send no `Origin`. Preflights answer with
`Access-Control-Max-Age: 86400`.

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
