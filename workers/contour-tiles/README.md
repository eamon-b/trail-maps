# contour-tiles worker

Serves contour vector tiles out of PMTiles archives on R2.

- URL pattern: `/{source}/{z}/{x}/{y}.pbf`
- Archives: R2 bucket `aus-map-data` (see Sources below)
- Health: `/health` — reports archive size/etag and the archive's zoom + bbox
- Consumed by the mobile app via `EXPO_PUBLIC_CONTOUR_TILE_URL`

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

## Edge caching and the workers.dev limitation

Tile responses are stored in `caches.default`, keyed by URL (query string
stripped, always a GET key so HEAD shares the same entry).

**This does nothing today.** The Cache API is a no-op on `*.workers.dev`,
because the cache is zone-level and workers.dev is a zone shared by every
account. The code is written so switching it on is config-only:

1. Add the domain as a zone in this Cloudflare account.
2. Uncomment a `[[routes]]` block in `wrangler.toml` (custom domain or route —
   both examples are there) and set `workers_dev = false` once the cutover is
   done.
3. `npm run deploy`.
4. Repoint `EXPO_PUBLIC_CONTOUR_TILE_URL` in `mobile/eas.json` and
   `mobile/.env.local` at the new hostname. Metro inlines `EXPO_PUBLIC_*` at
   bundle time — restart Metro after editing `.env.local`.

To confirm caching went live, request the same tile twice and watch the
`X-Edge-Cache` response header flip from `MISS` to `HIT`.

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

## Related: r2.dev rate limits

Separate from this Worker, offline tile downloads (`EXPO_PUBLIC_TILE_BASE_URL`)
are served straight from an `r2.dev` public bucket URL. `r2.dev` is rate-limited
and explicitly not meant for production traffic — it has no custom-domain cache
in front of it, so bulk offline downloads can get throttled. The fix is the same
shape as the one above: put the bucket behind a custom domain (or a Worker) on a
zone in this account and repoint `EXPO_PUBLIC_TILE_BASE_URL`.
