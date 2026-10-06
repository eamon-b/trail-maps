# Trail data updates (over the air)

Tracknotes ships every trail's JSON inside the app, and also fetches newer
copies from Cloudflare R2. A waypoint fix (a Shikoku lodging that closed, a
corrected water note) therefore reaches phones without a new APK: rebuild the
mobile trail files, publish them, and the app picks them up.

## How it works

### The bundled seed

`npm run build:mobile-trails` (`scripts/build-mobile-trails.ts`) writes
`mobile/assets/trails/<id>.json` and `mobile/assets/trails/index.json`. These
are committed and bundled into every build. They are what a fresh install
shows, and what the app falls back to when it is offline or the remote copy
cannot be used.

Each `index.json` entry describes its file exactly:

```json
{ "id": "shikoku", "name": "Shikoku Henro: Temples 1-23", "shortName": "Shikoku T1-23", "lengthKm": 154.1,
  "dataVersion": "2026-10-06", "updatedAt": "2026-10-06T00:00:00.000Z",
  "md5": "8e29ab6989e05a470a3d75bc34abc7bf", "bytes": 566944 }
```

- `md5` and `bytes` are of the exact bytes of `<id>.json`.
- `updatedAt` is when this trail's content last changed. The build reads the
  previous `index.json`: a trail whose md5 is unchanged keeps its previous
  `updatedAt` and `dataVersion`, and a trail whose md5 changed is stamped with
  the build time. Re-running the build without changing anything therefore
  changes nothing, and no phone downloads anything.
- `dataVersion` is the date part of `updatedAt`. It is for display only.

The hashing and merge rules live in `scripts/lib/trail-data-catalog.ts`.

### The R2 catalog

`npm run publish:trail-data` (`scripts/publish-trail-data.ts`) uploads to the
`aus-map-data` bucket, served at `https://data.contour-map-tiles.net`. The
offline tile packs use the same bucket and domain.

| Object | Content | Cache-Control |
| --- | --- | --- |
| `trails/v1/<id>.<md5[0..12]>.json` | the trail file, byte for byte as in `mobile/assets/trails/` | `public, max-age=31536000, immutable` |
| `trails/v1/catalog.json` | `{ format: 1, generatedAt, trails: [...] }`, with each index entry plus its `key` | `public, max-age=60` |

```json
{ "format": 1, "generatedAt": "2026-10-06T05:00:00.000Z",
  "trails": [ { "id": "shikoku", "name": "Shikoku Henro: Temples 1-23", "shortName": "Shikoku T1-23", "lengthKm": 154.1,
                "dataVersion": "2026-10-06", "updatedAt": "2026-10-06T00:00:00.000Z",
                "md5": "8e29ab6989e05a470a3d75bc34abc7bf", "bytes": 566944,
                "key": "shikoku.8e29ab6989e0.json" } ] }
```

The catalog lists the trails in `index.json` order.

**The CDN caches 404s for hours.** R2 sends a 404 with no Cache-Control, and
the `data.contour-map-tiles.net` zone kept one for `trails/v1/catalog.json`
for hours after the first publish. So the app asks for
`catalog.json?m=<minute>`: the query string is part of the cache key, so a
stale 404 (or a stale catalog) is never read, and phones asking in the same
minute still share one cached copy. The `--check` mode busts the cache the
same way. To check by hand, add a query string: `curl
'https://data.contour-map-tiles.net/trails/v1/catalog.json?x=1'`.


**Content-addressed keys.** Each trail file is stored under a key named after
its content. A new version is written to a new key and never overwrites the
bytes an already-published catalog points at. A phone that read the old
catalog a moment before a publish still downloads intact old files. Old
objects are left in the bucket. Cleaning them up is manual: keep every key the
live catalog lists, and delete the rest.

**The catalog goes last.** The publish uploads the new trail files first and
the catalog after them, the same way `upload-tiles.sh` uploads its manifests
last. Uploading the catalog is the commit point. If the publish fails
part-way, the live catalog still lists the previous files, all of which are
still in the bucket.

**Ordering.** The app takes a remote copy of a trail only when the catalog's
`updatedAt` for it is strictly later than the `updatedAt` of the copy it
already has, whether that is the bundled copy or an earlier download. The
catalog's `md5` and `bytes` describe the file at `key`, so a download can be
checked before it is used.

Two consequences follow:

- A new APK with newer bundled data wins over an older download.
- Rolling a trail back means publishing the old content with a new
  `updatedAt`. Rebuild it from the old source: the md5 differs from the current
  index entry, so the build stamps it now.

**Format version.** `v1` in `trails/v1/` is the trail JSON format version
(`TRAIL_DATA_FORMAT` in `trail-data-catalog.ts`). Old app builds only read
`trails/v1/catalog.json`, so a change to the trail JSON shape that they cannot
read must not be published there. Such a change bumps the format, publishes
under `trails/v2/`, and teaches the new app build to read v2. Then v1 is left
frozen: old builds keep the last v1 data and never see a file they would
misread. A change old builds can read, such as an added optional field, stays
in v1.

### On the phone

The app checks the catalog on launch and when it returns to the foreground, at
most once every 6 hours (5 minutes after a failed check, e.g. offline).
Pull-to-refresh on My Guides forces a check. Newer copies of trails the phone
already has (bundled, or downloaded earlier) are downloaded in the background,
one at a time. A guide that is already open keeps the data it opened with, and
picks up the new data the next time it is opened.

Trails in the catalog that this build does not bundle are listed on My Guides
with a "New · downloads when opened" pill, and are fetched the first time the
guide is opened (or a shared plan for them is). After that they update like any
other trail.

On the device the copies live in `{documentDir}/trail-data/` beside a small
`state.json` (the last catalog and what is installed); see
`mobile/src/services/trail-data-updates.ts` and the pure rules in
`mobile/src/services/trail-catalog.ts`. A build with no
`EXPO_PUBLIC_TILE_BASE_URL` runs on its bundled data alone.

## Publishing a waypoint fix

1. Make the fix in the source data, for example `data/trails/shikoku/` or
   `CURATED_WAYPOINTS` in `scripts/process-shikoku-caltopo.ts` followed by
   `--reapply`.
2. Rebuild:
   ```bash
   npm run build:trails && npm run build:mobile-trails
   ```
   The last line of the build log says how many trails changed content. Only
   those get a new `updatedAt`.
3. Commit the regenerated `mobile/assets/trails/` files and `index.json`, and
   get them onto `main`. The committed index must match what was published:
   the next APK bundles that index, and the `updatedAt` stamps are what stop
   phones re-downloading content they already have. Publishing from a
   committed tree also means a later publish from another checkout cannot
   quietly undo this one.
4. Dry run, and check that only the trails you expected appear:
   ```bash
   npm run publish:trail-data -- --dry-run
   ```
5. Publish. This needs `wrangler` on `PATH` and `wrangler login`:
   ```bash
   npm run publish:trail-data
   ```

Checking and options:

- `npm run publish:trail-data -- --check` exits 1 and lists the differing
  trails when the live catalog does not match the local index. Use it to
  answer "did I forget to publish?", for example in CI.
- `--all` re-uploads every trail file and the catalog, even if nothing changed.
- `--force` publishes even when it would roll a trail back, drop a trail, or
  comes from a checkout the live catalog does not descend from (see below).
- `--remove <id>` (repeatable) allows this publish to drop that trail from the
  live catalog.
- `R2_BUCKET` overrides the bucket. `TRAIL_DATA_BASE_URL` overrides where the
  live catalog is read from.

Before uploading anything, the script refuses to publish when any of these is
wrong:

- `index.json` does not match the files byte for byte. The fix is to run
  `npm run build:mobile-trails`.
- A file is not a trail the app could load. It must parse as JSON, its
  `config.id` must match its id, and it must have a `waypoints` array and a
  non-empty `track.points` array (the app refuses an empty track).
- An id is not `[A-Za-z0-9_-]{1,64}`, or it starts with `u_`. That prefix is
  reserved for trails imported on the device.
- The live catalog has a newer `updatedAt` for a trail than the local index,
  with different content: publishing would roll it back, as a publish from a
  stale checkout would. Pull and rebuild, or pass `--force` if the rollback is
  intended.
- The live catalog's `sourceCommit` (the HEAD it was published from) is not an
  ancestor of this checkout's HEAD, or is unknown to this clone: the same stale
  checkout, caught even when the bytes happen to differ. Pull and rebuild, or
  pass `--force`. Without git the check warns and continues.
- A trail in the live catalog is missing from the local `index.json`. That is
  usually a build that failed for it, not a decision, so name each trail to
  drop with `--remove <id>` (or pass `--force`).

## Adding a brand-new trail

A trail published to the catalog that an app build has not bundled still
appears in that app as a downloadable guide. Any build that reads the catalog
gets it without an app update. It still needs:

- **Comments.** Add its id to `ALLOWED_TRAILS` in
  `workers/comments-api/src/validation.ts` and redeploy the comments worker.
  Until then the server rejects comment sync for it. The publish script warns
  about any id missing from the list, and `scripts/server-trail-allowlist.test.ts`
  fails until the list matches `index.json`.
- **The next APK.** Add it to the bundled asset map in
  `mobile/src/services/trail-assets.ts` so the next build ships it as a seed.
- **Offline maps.** Build and upload its tile pack
  (`npm run build:tiles -- --trail <id>`, then `npm run upload:tiles <id>`).
  The `tile-packs` check fails until the pack exists.
