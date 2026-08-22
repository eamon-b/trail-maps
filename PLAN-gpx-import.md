# Implementation Plan: User GPX Import (Web + Mobile)

## Summary

Let users upload their own GPX file — in the web interface and in the Tracknotes mobile app — and have it become a first-class trail/guide with the full feature set of built-in trails: interactive map, elevation profile, classified waypoints, plan calculator (day splits / resupply / water carries), direction reversal, favorites, custom routes, GPS follow, and (where feasible) offline maps.

The enabling insight from codebase exploration: almost every consumer (both web viewers, the mobile guide panes, all `@lib` calculators, `snapToTrail`, `trail-reverse`) operates on a plain in-memory trail object and is already source-agnostic. What's missing is (a) a **runtime ingestion pipeline** — today the GPX → trail-JSON transformation lives only in the node-only batch script `scripts/build-trails.ts` — and (b) a **runtime trail source** on mobile, where trail JSON is a compile-time Metro `require()` map.

## Goals

- Import a GPX file (tracks, routes, waypoints) on web and mobile; get a full trail experience.
- One shared ingestion implementation (`src/lib`) so a file parses identically on web, mobile, and in the build script — no behavioral forks.
- Graceful degradation: a bare single-track GPX with no waypoints and no elevation still produces a working (if less rich) guide.
- Imported trails never pollute server-side systems (comments API, waypoint-id registry) or collide with bundled trail ids.
- Success criteria:
  - Web: upload → trail page (map, profile, waypoints, reverse, GPX/CSV export) + plan page work; trail persists across reloads (IndexedDB).
  - Mobile: import via document picker → appears in My Guides → Map/Elevation/List panes, Plan calculator, favorites, custom routes, GPS follow all work; survives app restart; deletable.
  - Existing build output is byte-identical (or intentionally-diff'd) after the refactor — verified against the checked-in `public/data/generated/*.json`.

## Current State

### What exists and is reusable as-is
- `src/lib/gpx-parser.ts:14` `parseGpx` — DOMParser-based, browser-safe, **usable client-side on web today** (currently dead code in the shipping build).
- `src/lib/gpx-optimizer.ts` — `douglasPeucker` (:103, iterative — safe on 50k points), `removeElevationSpikes` (:152), `smoothElevation` (:237), `calculateElevationStats` (:295) — all pure and platform-neutral, but **never called by the build pipeline** (relevant: it doesn't clean noisy elevation either).
- `src/lib/track-classification.ts` (`classifyTracks` :72, `combineTracksGeographically` :209), `src/lib/waypoint-classifier.ts` (`classifyWaypoint` :159), `src/lib/track-geometry.ts`, `trail-reverse.ts`, all plan calculators — pure, platform-neutral. Single-track GPX with empty config "just works" via `fallbackToLongest`.
- `scripts/build-mobile-trails.ts:66-183` — dependency-free `perpendicularDistance`/`douglasPeucker`/`simplifyToTarget`/`truncatePoint` (target-point-count simplification), ready to lift into `src/lib`.
- `src/lib/parse-coordinate.ts` — strict coordinate parsing (throws on NaN), currently only used by `build-tiles.ts`.
- Mobile: `trail-bounds.ts`, `position-on-trail.ts`, `useLocation.ts`, `favorites-repo.ts`, `routes` feature, `plan-adapters.ts`, `settings/plan-inputs` stores — all keyed by arbitrary `trailId` strings, **no changes needed**.
- Mobile `guides` SQLite table (`src/db/schema.ts:10-18`) — created in v1, **written by nothing** (`src/db/database.ts:8-11`) — free real estate for the imported-trail registry.
- Web viewers: `initTrailViewer(trailId)` (`src/web/trails/trail-viewer.ts:1524`) and `initPlanViewer(trailId)` (`plan-viewer.ts:897`) each do a single `fetch('/data/generated/${trailId}.json')` then operate purely on the in-memory object — trivially injectable.

### The gaps
1. **Two divergent GPX parsers.** The real pipeline uses `parseGpxNode` (`scripts/build-trails.ts:251`, jsdom); `src/lib/gpx-parser.ts` differs on `<ele>` handling, name defaults, and classification. Neither reads `<wpt><type>` despite `types.ts:20-26` documenting a round-trip contract. Neither is RN-safe (no DOMParser in Hermes).
2. **Ingestion is script-locked.** Cumulative distance (:986), displayPoints simplification (:1011), waypoint enrichment (`enrichWaypoints` :581, `findWaypointVisits` :489, `calculateSegmentStats` :556), variant junctions (:421), off-trail split — all local to `build-trails.ts`, entangled with fs/Papa/HTML generation.
3. **No shared Trail type.** `ProcessedTrail` is local to `build-trails.ts` (:107-218) and hand-duplicated as `TrailJson` in `mobile/src/services/trail-assets.ts:9-43` and as two local `interface Trail`s in the web viewers.
4. **Mobile trails are bundle-time constants.** `trail-loader.ts` resolves from a Metro `require()` map, synchronously; `GuideContext.tsx:41,49` assumes sync resolution. No file picker, no XML parser, no receive-intent in `mobile/package.json`/`app.json`.
5. **Offline tile packs are pre-built server-side per trailId** (`tile-service.ts:395`), not per-bbox. An arbitrary import has no pack.
6. **Elevation quality cliff.** `p.ele || 0` with zero filtering/smoothing: missing `<ele>` → flat profile + distance-only (optimistic) day estimates; noisy barometric `<ele>` → 2-3× inflated ascent.
7. **Unsafe parsing of untrusted input**: `parseFloat(attr || '0')` silently maps malformed lat/lon to 0,0.

## Implementation Steps

Phased so each phase merges independently. Phase 1 is a pure refactor (no user-visible change); Phase 2 ships web upload; Phase 3 ships mobile import; Phase 4 is enhancements.

---

### Phase 1 — Shared ingestion library (`src/lib`)

#### Step 1.1: Platform-neutral GPX parsing
- Files: `src/lib/gpx-parser.ts`, new `src/lib/xml-adapter.ts` (or similar), `scripts/build-trails.ts`, `mobile/package.json`
- Changes:
  - Define a minimal XML-node interface covering the only four operations the parsers use: `querySelectorAll(tag)`, `querySelector(tag)`, `getAttribute(name)`, `textContent`. All selectors are tag-level (`'trkseg trkpt'` at deepest) — trivially adaptable.
  - Refactor `parseGpx(xml, parser?)` to accept an injected document adapter; adapters: DOMParser (web default), jsdom (scripts), `fast-xml-parser` (mobile — dependency-free, Hermes-safe; add to `mobile/package.json` via `npx expo install`/npm, JS-only so no prebuild).
  - **Unify semantics on the pipeline parser's behavior** (`parseGpxNode`): `<rte>` fallback when no `<trk>`, first-descendant `name`, waypoint `desc`. Add on top: read `<wpt><ele>` and `<wpt><type>` (finally implementing the round-trip contract in `types.ts:20-26`), and emit `<type>` from `generateGpx` and the web viewer's `exportGpx`.
  - Replace `parseFloat(attr || '0')` with `src/lib/parse-coordinate.ts` strict parsing; reject files with unparseable coordinates instead of plotting 0°N 0°E.
  - Add input guards at parse level (file size / point count caps — reuse `GPX_OPTIMIZER_DEFAULTS` limits).
  - Delete `parseGpxNode` from `build-trails.ts`; call the unified parser with the jsdom adapter.
- Note for CLAUDE.md: gpx-parser/gpx-optimizer stop being "NOT safe for mobile" — update the docs lines.

#### Step 1.2: Extract `buildTrail()` — the pure ingestion pipeline
- Files: new `src/lib/trail-ingest.ts` (+ tests), `scripts/build-trails.ts`, new `src/lib/trail-types.ts`
- Changes:
  - `trail-types.ts`: single shared `ProcessedTrail` / `TrackData` / `EnrichedWaypoint` / `RouteVariant` / `OffTrailWaypoint` type, replacing the three duplicates (build-trails locals, mobile `TrailJson`, web viewers' local `Trail`s). Mobile/web keep structural compatibility so this is import-swaps, not behavior change.
  - `trail-ingest.ts`: `buildTrail(gpx: GpxData, config: IngestConfig): ProcessedTrail` — lifted verbatim from `processTrail` steps: main-route selection (`selectMainRoute` wrapper over classify+combine), optional reverse, cumulative dist/ascent/descent, adaptive-tolerance displayPoints (`calculateAdaptiveTolerance` moves here), waypoint enrichment (`enrichWaypoints`, `findWaypointVisits`, `calculateSegmentStats`), variant junctions + variant waypoints, off-trail split. Excluded (stay in the script): fs, trail.json write-back, CalTopo GeoJSON, CSV fallback, climate, curated descriptions, the global waypoint-id registry, HTML generation.
  - New in `buildTrail` (opt-in flags, ON for user imports, OFF for the build script to preserve output): `removeElevationSpikes` + `smoothElevation` before ascent accumulation; ascent threshold via `calculateElevationStats`.
  - Waypoint ids: `buildTrail` takes an id-minting callback; the build script passes the registry-backed minter, imports pass a local deterministic minter (`w_` → `uw_<hash>` style, namespaced so they can never collide with registry ids or hit the comments D1 table).
  - Lift `simplifyToTarget`/`truncatePoint` from `build-mobile-trails.ts` into `src/lib/track-simplify.ts`; script imports them back.
  - Refactor `processTrail` to: read files → call `buildTrail` → apply script-only enrichments (GeoJSON, climate, descriptions, registry ids) → write. 
- **Verification gate:** `npm run build:trails` output diff vs. checked-in `public/data/generated/*.json` must be empty (or each diff explained); same for `build:mobile-trails`.

#### Step 1.3: Import-time orchestrator + elevation handling
- Files: new `src/lib/gpx-import.ts` (+ tests)
- Changes:
  - `importGpx(xmlText, {name?, targetPoints?}): { trail: ProcessedTrail, report: ImportReport }` — parse (strict) → guard sizes → clean elevation → `buildTrail` → classify waypoint types via `classifyWaypoint` (respecting explicit `<type>` when present) → `simplifyToTarget` for the mobile point budget when requested.
  - `ImportReport` captures data-quality facts the UIs surface: `hasElevation` (detect all-zero/missing `<ele>`), `elevationLooksNoisy`, point/waypoint counts, tracks found/combined, gap warnings from `combineTracksGeographically`.
  - Synthetic trail id: `u_` + short content hash (stable across re-imports of the same file) — same alphabet as `generateRouteId` (`mobile/src/db/routes-repo.ts:83`).

---

### Phase 2 — Web upload

#### Step 2.1: Viewer injection points
- Files: `src/web/trails/trail-viewer.ts`, `src/web/trails/plan-viewer.ts`
- Changes: add optional preloaded-trail parameter — `initTrailViewer(trailId, preloadedTrail?)` / `initPlanViewer(trailId, preloadedTrail?)` — skipping the fetch when provided (each is a ~3-line change; both operate purely on module state after load). Direction prefs (`trailDirectionPrefs`) and plan state already key off the passed id. **Watch:** `plan-viewer` saves under `trail.config.id` (:773) but loads under the init arg (:910) — ensure the synthetic id is used for both (set `config.id` = import id).

#### Step 2.2: IndexedDB store for imported trails
- Files: new `src/web/imported-trails-db.ts`
- Changes: tiny IndexedDB wrapper (no dep): object store `trails` keyed by id, records `{id, name, lengthKm, createdAt, trail: ProcessedTrail}`. localStorage is out — a full-res track exceeds the ~5MB quota. API: `putTrail`, `getTrail`, `listTrailSummaries`, `deleteTrail`.

#### Step 2.3: Upload page + my-trail pages
- Files: new `src/web/upload.html` (+ `upload.ts`), new `src/web/my-trail.html`, `src/web/my-plan.html` (+ boot scripts), `vite.config.ts`, `src/web/index.html`
- Changes:
  - `vite.config.ts`: add the three pages to `rollupOptions.input` (top-level `src/web/`, NOT under `trails/*/` which is gitignored/regenerated).
  - `upload.html`: file input (+ drag-drop) → `importGpx` → show `ImportReport` (name editable, elevation warning, "fetch elevation" offer — see Phase 4) → save to IndexedDB → link to `my-trail.html?id=…`.
  - `my-trail.html` / `my-plan.html`: copies of the trail/plan template markup with the boot script reading `?id=`, loading from IndexedDB, and calling the init functions with the preloaded trail. No `{{…}}` template pass needed. Include a Delete action. (Plan page keeps its existing 900px min-width gate.)
  - `index.html`: after fetching `index.json`, also list IndexedDB imports under a "My trails" section + link to upload page. Escape user-supplied names (`escapeHtml` — the card template currently doesn't escape).

---

### Phase 3 — Mobile import

#### Step 3.1: Storage — files on disk + registry in the dead `guides` table
- Files: `mobile/src/db/schema.ts`, new `mobile/src/db/imported-trails-repo.ts`, new `mobile/src/services/imported-trail-store.ts`
- Changes:
  - Trail JSON lives as a file: `${Paths.document}/trails/{id}.json` (mirrors the tiles pattern: disk is truth, DB is the view). No 500KB blobs in SQLite rows.
  - Schema v4 migration: repurpose/extend `guides` as the imported-trail registry — add columns `name`, `short_name`, `length_km`, `source` (`'imported'`), `has_elevation` (or add a fresh `imported_trails` table if touching `guides` is messier — decide at implementation; migration pattern per `schema.ts:145-173`, must end with `UPDATE schema_version SET version = 4`; remember production has NO `PRAGMA foreign_keys`, manual cascade on delete like `routes-repo.ts:151`).
  - Repo follows the existing convention (takes `db: SqlDatabase` as first arg). `imported-trail-store.ts`: write/read/delete the JSON file + registry row transactionally-ish (file first, row second; delete row first, file second).
  - Delete must cascade manually across: JSON file, registry row, `favorites`, `routes`/`route_points`, `sync_state`, plan-inputs AsyncStorage entry (or accept orphans for the AsyncStorage one — it's keyed and harmless).

#### Step 3.2: Async trail loading
- Files: `mobile/src/services/trail-loader.ts`, `mobile/src/features/guide/GuideContext.tsx`, `mobile/app/guide/[trailId]/_layout.tsx`, `mobile/app/guide/[trailId]/downloads.tsx`
- Changes:
  - `trail-loader.ts`: keep sync bundled functions; add `loadTrail(id): Promise<TrailJson|null>` (bundled map hit → return; else read imported file) and `listAllTrails(): Promise<TrailIndexEntry[]>` (bundled ∪ registry rows, entries flagged `source: 'bundled'|'imported'`). Add `isServerKnown(id)` = bundled check. Update the header comment ("Custom trails are not supported") and `schema.ts:88-91` comment.
  - `GuideContext.tsx`: make loading async with a spinner rendered *instead of children* while resolving — preserves the non-null `trail` contract so **zero consumers change** (`useGuidePosition`, panes, plan all keep assuming `trail` exists). Unknown id keeps `GuideNotFound`.
  - `_layout.tsx` / `downloads.tsx` header titles: fall back to the registry name for imported ids.

#### Step 3.3: Import UI on My Guides
- Files: `mobile/app/index.tsx`, `mobile/app/_layout.tsx`, new `mobile/src/features/import/` (picker flow + `import-store.ts` or plain async handler), `mobile/package.json`
- Changes:
  - `npx expo install expo-document-picker` (config-plugin-free for basic picking; JS-only → no new native build needed beyond the dependency itself — verify with `npx expo prebuild` + a dev build per CLAUDE.md since it does ship native code on iOS; budget one `eas build`).
  - Home screen: replace `useMemo(listTrails, [])` with state hydrated via `listAllTrails()` on focus (`useFocusEffect`); add "Import GPX" header/FAB action; imported cards get a badge + long-press/swipe Delete.
  - Import flow: pick → read file text (`expo-file-system`) → `importGpx` from `@lib` (fast-xml-parser adapter) → `simplifyToTarget(5000)` full track + display points budget (same budgets as `build-mobile-trails.ts`) → show report (name edit, elevation warning) → persist via `imported-trail-store` → navigate into the guide.
  - Run the parse/ingest inside `InteractionManager`/chunked so a 60k-point file doesn't freeze JS thread visibly; show progress.

#### Step 3.4: Server-boundary gating + waypoint ids
- Files: `mobile/src/features/guide/GuideView.tsx`, comments Composer entry points, `mobile/app/guide/[trailId]/waypoint/[waypointId].tsx`
- Changes:
  - Gate `useCommentSync(trailId)` and description sync on `isServerKnown(trailId)` — avoids a pointless 404 round-trip per guide open and, more importantly, **prevents posting comments against non-server trail ids** (outbox would 4xx or create orphan rows).
  - Waypoint detail for imported trails: hide the comments section (or show "comments unavailable for imported trails"); favorites keep working (purely local).
  - Imported waypoints carry stable minted ids from `importGpx` (never the positional `name-i` fallback), so favorites survive direction flips and re-renders.

#### Step 3.5: Offline maps v1 for imports — bundled-pack reuse
- Files: `mobile/src/services/tile-service.ts` or a small resolver in front of it, `mobile/app/guide/[trailId]/downloads.tsx`, `mobile/src/features/map/map-style.ts` (if pack aliasing needs a path hook)
- Changes:
  - Cheap 80% win: compute the import's bbox (`calculateTrailBounds`) and check containment/overlap against the six bundled trails' bboxes (ship a tiny static bbox table generated at build time, or compute from bundled JSON at runtime). If an imported track falls inside a bundled trail's coverage, the downloads screen offers *that trail's* pack ("Uses Bibbulmun offline pack") and the offline style resolves via the bundled trail's `trailTilesDir`. Keep directory names = bundled trailId (no aliasing on disk — `getDownloadedTrails()` enumerates dir names).
  - Otherwise: downloads screen shows "Offline maps not available for imported trails" and disables the button (today it would 404 into an error state). Online map fallback already works (`map-style.ts:41-47`).
  - GPS follow needs no tiles — works regardless.

---

### Phase 4 — Enhancements (each optional, independent)

- **Elevation backfill**: "Fetch elevation" action when `ImportReport.hasElevation` is false — batch Open Elevation API (pattern from `scripts/fetch-elevation.ts:58-60`: batches of 100, throttled), then re-run ascent/enrichment. Works client-side on web and on mobile (plain fetch). Clearly label day-split estimates "distance-only" until backfilled.
- **Receive/share intent** (mobile): Android `intentFilters` for `.gpx` (`ACTION_VIEW`/`ACTION_SEND`) + iOS document types in `app.json` — config-plugin territory, requires `npx expo prebuild --clean` + new dev build; route the incoming file into the same import flow.
- **On-demand bbox tile packs**: server endpoint (worker) that assembles a pack for an arbitrary bbox keyed by bbox hash — the real fix for offline-anywhere; significant new worker + pipeline work, explicitly out of v1 scope.
- **Web → mobile handoff**: export the ingested trail JSON from web / import on mobile (both ends already speak `ProcessedTrail`).
- **CLAUDE.md / memory updates**: parser safety notes, new lib modules, import architecture.

## Testing Strategy

1. **Phase 1 golden gate (the critical one):** run `npm run build:trails` + `npm run build:mobile-trails` before/after the refactor and diff `public/data/generated/*.json` + `mobile/assets/trails/*.json` — must be identical. Existing 406 web Vitest tests must pass.
2. **Lib unit tests (Vitest, colocated):** unified parser semantics against `tests/fixtures/` GPX (incl. `<rte>`-only, no-`<ele>`, malformed-coord rejection, `<wpt><type>` round trip via `generateGpx`); `buildTrail` on a fixture vs. a golden snapshot; `importGpx` report flags (missing elevation, noisy elevation, multi-track combining); `simplifyToTarget` point budgets.
3. **Mobile Jest:** fast-xml-parser adapter parity test (same fixture through DOMParser-in-jsdom and fast-xml-parser adapters → deep-equal `GpxData`); schema v4 migration test (pattern from `src/db/__tests__/schema.test.ts` — note the test adapter enables FKs while production doesn't, so also assert manual cascade); imported-trails repo CRUD; `loadTrail` dispatch; GuideProvider loading state.
4. **Manual / emulator (ADB workflow per CLAUDE.md):** push a sample GPX to the emulator (`adb push` + pick via Files), import, walk Map/Elevation/List/Plan/favorites/routes, kill + relaunch (persistence), delete (verify cascades). Screenshot-verify each pane.
5. **Web manual:** `npm run dev`, upload fixtures (with/without elevation, multi-track, waypoint-rich Heysen GPX), verify trail + plan pages, reload persistence, delete; verify built site (`npm run build && npm run preview`) since viewers fetch root-absolute paths but the upload pages don't fetch at all.
6. **Maestro (optional):** an `import-gpx.yaml` flow once the UI stabilizes (local-only, per repo convention).

## Risks and Considerations

- **Refactor regression in build output** — mitigated by the golden diff gate in Phase 1; land Phase 1 as its own PR.
- **Elevation garbage-in**: noisy barometric tracks inflate ascent 2-3×; missing elevation silently makes day estimates optimistic. Mitigation: spike-removal + smoothing ON for imports, explicit `ImportReport` warnings, Phase 4 backfill.
- **Huge files**: 100k+ point GPX on a phone — parse guards (size/point caps from `GPX_OPTIMIZER_DEFAULTS`), `simplifyToTarget` immediately after parse, chunked processing to keep the JS thread responsive. `snapToTrail`'s windowed scan assumes ~evenly spaced points — the 5000-point budget preserves that.
- **Id discipline**: `u_`-prefixed trail ids and `uw_`-prefixed waypoint ids must never reach the comments API or `data/waypoint-ids.json`; enforced by the `isServerKnown` gate and the separate minter, but worth a test asserting no network call fires for an imported trailId.
- **Plan-state key mismatch (web)**: save uses `trail.config.id`, load uses the init arg — set both to the import id and add a test/assertion.
- **IndexedDB quota/eviction (web)**: imported trails are best-effort persistent; surface a re-upload path if a record is missing (page handles null trail gracefully).
- **`guides` table repurposing**: it's dead code today but exists in shipped DBs at v1 schema — the v4 migration must `ALTER TABLE ADD COLUMN` (SQLite-safe) rather than recreate, or use a fresh table.
- **Multi-track user GPX**: `combineTracksGeographically` warns on >100m gaps; surface those warnings in the import report rather than silently chaining disconnected segments.
- **XSS**: user-controlled trail/waypoint names/descriptions render on web (index cards, waypoint tables) — `escapeHtml` exists in trail-viewer; audit every interpolation point on the new pages and the index card template (currently unescaped).
- **Scope guard**: alternates/side-trips classification for user GPX works via default patterns but junction detection on arbitrary data may misfire — acceptable; both viewers tolerate empty/missing variants.
