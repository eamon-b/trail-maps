# Implementation Plan — Phase 4 of Issue #6: Product Completion

## Summary

Phase 4 is the final phase of the [issue #6](https://github.com/eamon-b/trail-maps/issues/6) roadmap: **(1)** web planner NOBO/SOBO toggle, **(2)** local custom waypoints on mobile (stepping stone to crowd-sourcing), **(3)** custom-trail parity (climate + elevation + offline tiles for imported GPX), **(4)** a crowd-sourcing design doc — doc only, no build. Four PRs, one per item; merge order 1 → 2 → 3, with 4 in parallel.

## Goals

- SOBO hikers can plan on the web with correct day splits, ascent/descent, datasheets, and elevation profile.
- Users can add/edit/delete their own waypoints (esp. water sources) on any trail; they flow into water-carry, datasheet, elevation, and measure automatically.
- Imported GPX trails get climate data, elevation backfill, and offline tiles — feature parity with bundled trails.
- A concrete, decision-complete crowd-sourcing design doc exists for v2.

## Current State (exploration verified)

- **Direction:** `plans/web-planner-direction.md` prescribes display-layer km flips, but predates Phase 3. Mobile already does data-layer reversal: `createReversedTrail` (`mobile/src/lib/trail-utils.ts:198`, with `reverseTrackPoints`:148, `reverseWaypoints`:156), applied at `mobile/app/plan/[planId].tsx:135-137`; variant math is already shared (`src/lib/variant-reverse.ts`). Web `plan-viewer.ts` already imports `@lib/day-calculator` etc.
- **Waypoints:** mobile UI renders exclusively from the `TrailJson` blob → `trailJsonToTrail()` → `Trail.waypoints`; the SQLite `waypoints` table is a write-only mirror. `TrailMap` already has `onLongPress` (returns `{latitude, longitude, nearestKm}`) and `customPins`; `plan/section-map.tsx:116-150` is a working long-press-to-pick-point template. Schema is at `SCHEMA_VERSION = 4` with a clean transactional migration pattern.
- **Parity:** custom-trail offline tile download is fully coded (`plan.tsx` custom branch → `grid-tile-service.ts` → merge into standard `tiles/{trailId}/` layout) — blocked only on the Phase 2 R2 grid upload (251 cells / 21 GB, built but not hosted). Climate has no runtime path at all (bundled-only, registered at `trail-loader.ts:106-109`). Elevation backfill is build-time only; GPX without `<ele>` imports flat.
- **Crowd-sourcing:** no backend exists (only the read-only contour Worker). `plans/part-6-community-features.md` is the skeleton and self-flags backend choice, moderation, offline sync, and legal as unresolved.

## Key Design Decisions

1. **Direction toggle = data-layer reversal via a shared `createReversedTrail`** — supersedes the display-layer approach in `plans/web-planner-direction.md`. Rationale: (a) the display-layer plan shows **wrong ascent/descent/estimatedHours** on every SOBO day card (`computeDays` output is direction-dependent; the doc never addresses this); (b) scattering `isSobo ?` conditionals across four renderers recreates the Phase-1 km-offset bug class, while data-layer reversal has exactly two km-space conversion points; (c) it completes the Phase 3 consolidation and gives web mobile's battle-tested single code path. Elevation profile flip comes free and is **in scope**.
2. **km-space contract:** `PlanState.stops[].km` in localStorage stays **NOBO-absolute forever** (no migration, no rewrite on toggle). Runtime lives entirely in active-direction km. Conversions only at (i) `renderAll()` stops→active and (ii) `toggleStop`/`isStop` active→NOBO, with epsilon 0.05 km comparisons.
3. **Direction values `'NOBO' | 'SOBO'`** (uppercase — matches mobile's `plans.direction` column). Toggle button text uses trail `config.direction` labels (e.g. Westbound/Eastbound) with NOBO/SOBO fallback.
4. **Custom waypoints in a new `custom_waypoints` table** (migration 5), not an `is_custom` column: the `waypoints` table is bulk-rewritten on `dataVersion` bumps — separate table makes wiping user data structurally impossible. Rows use uuid PKs and timestamps (sync-ready for crowd-sourcing).
5. **Store raw pressed lat/lon + snapped `km_position` + `off_track_m`** — marker renders where the water actually is; distance math uses the snapped km; UI shows "≈150 m off trail". Same semantics as bundled waypoints, so reversal/calculators work untouched.
6. **Climate parity via user-triggered runtime fetch** (Open-Meteo archive, 2014–2023, ≤5 auto-picked sample points) cached in a new `trails.climate_json` column and registered through the existing `registerClimateData` — climate-service and UI unchanged. Never fetches silently (offline-first).
7. **Elevation backfill in scope, opt-in at import** (Open-Meteo elevation API, ≤500 samples, linear interpolation) when GPX lacks `<ele>`.
8. **Four PRs, one per item.** Merge order 1 → 2 → 3; item 4 (doc) any time. Item 2 owns migration 5 (including `climate_json` so item 3 needs no migration). All Phase 4 branches cut after `phase-3-shared-code` merges.

## Implementation Steps

### Item 1 — Web planner NOBO/SOBO toggle (PR 1)

**Step 1.1 — Shared reversal module `src/lib/trail-reverse.ts` (new).** Port `reverseTrackPoints` / `reverseWaypoints` / `createReversedTrail` from `mobile/src/lib/trail-utils.ts:148-220`, generalized to structural generics in the style of `variant-reverse.ts` (`<P extends {dist:number}>`, all-optional waypoint fields with `?? 0` guards so web's `PlanWaypoint` is accepted). Reuses `reverseAlternates`/`transformSideTrips` from `src/lib/variant-reverse.ts`. Then shrink `mobile/src/lib/trail-utils.ts` to re-export from `@lib/trail-reverse` (same pattern as its existing `@lib/track-geometry` re-export at line 229). Mobile call sites unchanged.
- Tests: `src/lib/trail-reverse.test.ts` (Vitest) — port mobile fixtures **before** refactoring: double-reversal ≈ identity, endpoint mapping 0↔total, ascent/descent swap, `trackIndex` mirroring.

**Step 1.2 — Shared direction helpers `src/lib/plan-direction.ts` (new).** `type PlanDirection = 'NOBO'|'SOBO'`; `toActiveKm` / `toNoboKm` (= `total − km` when SOBO); `stopsToActive(stops, dir, total)` (map + re-sort); `KM_EPSILON = 0.05`. Test round-trip stability under 2-dp rounding.

**Step 1.3 — `PlanState.direction`.** Add `direction?: PlanDirection` to `PlanState` (`src/lib/plan-types.ts:39`); extend the `isValidPlanState` guard in `src/web/trails/plan-state.ts` to reject bad values. Absent field = NOBO; no migration.

**Step 1.4 — Wire `src/web/trails/plan-viewer.ts`.**
- Add `reversedTrail` memo + `activeTrail()` helper (`SOBO ? (reversedTrail ??= createReversedTrail(trail)) : trail`).
- `renderAll()` (line 764): `computeDays(activeTrail(), stopsToActive(planState.stops, dir, total), planState.startDate)`. Switch all renderer reads (`renderDayList`:441, `renderStopList`:540, `renderDayDatasheet`:585, resupply/water sections, elevation, day map highlight) from `trail.` to `activeTrail().` — **no per-renderer conditionals**.
- Markers: `drawWaypointMarkers` (line 203) builds from `activeTrail().waypoints`; `toggleStop` (674) writes `toNoboKm(...)` to `planState.stops`; `isStop` (142) compares with `KM_EPSILON`. Rebuild markers on toggle.
- `setDirection()`: set state, reset `selectedDayIndex`, `scheduleSave()`, redraw markers, `renderAll()`. Toggle button in `plan-template.html` `#plan-header` (~line 393) + CSS, wired in `initHeader()` (784); label from `config.direction` labels.

### Item 2 — Local custom waypoints, mobile (PR 2)

**Step 2.1 — Migration 5 (`mobile/src/db/schema.ts`).** `SCHEMA_VERSION = 5`:
```sql
CREATE TABLE custom_waypoints (
  id TEXT PRIMARY KEY, trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'water',
  lat REAL NOT NULL, lon REAL NOT NULL, ele REAL,
  km_position REAL NOT NULL, off_track_m REAL, description TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX idx_custom_waypoints_trail_id ON custom_waypoints(trail_id);
ALTER TABLE trails ADD COLUMN climate_json TEXT;  -- item 3's cache, avoids a second migration
```
Update `mobile/src/db/__tests__/schema.test.ts` (fresh install → v5; v4→v5 preserves rows; cascade delete).

**Step 2.2 — CRUD on `TrailDataService`** (`mobile/src/services/trail-data-service.ts`): `addCustomWaypoint` / `getCustomWaypoints` (ORDER BY km_position) / `updateCustomWaypoint` / `deleteCustomWaypoint`, with a `CustomWaypoint` interface. Type picker limited to `water`, `water-tank`, `campsite`, `poi` (from the `waypoint-classifier.ts` taxonomy; water types flow into calculators via `WATER_TYPES`). Jest CRUD tests.

**Step 2.3 — Merge at the load boundary.** New pure `mergeCustomWaypoints(trail, custom): Trail` in `mobile/src/lib/trail-utils.ts`: map rows to `TrailWaypoint` with stable ids `custom-${row.id}`, `totalDistance = kmPosition`, `trackIndex` via `findNearestByDistance`; insert sorted; recompute segment `distance` deltas for all waypoints; ascent/descent 0. Must survive `createReversedTrail` (add merge→reverse round-trip test). Wire in `TrailDataContext.loadTrail` (`mobile/src/contexts/TrailDataContext.tsx:50`) after `trailJsonToTrail` — **every consumer (map, datasheet, water-carry, elevation, measure) picks custom waypoints up with zero further changes**; `reloadTrail()` already exists for refresh-after-edit.

**Step 2.4 — UI.**
- Add: `onLongPress` on `TrailMap` in `mobile/app/trail/[id].tsx` (handler template: `plan/section-map.tsx:116-150`) → new `AddWaypointSheet` component (name, 4-type picker, notes, read-only "km X.X · ≈Y m off trail" via `@lib/distance` haversine) → `addCustomWaypoint` → `reloadTrail()`.
- Edit/delete: existing waypoint detail sheet gains Edit/Delete when `id.startsWith('custom-')`; delete confirms via `Alert.alert`.
- Distinct marker color in `TrailMap` for custom waypoints; update `contribute.tsx` copy to point at long-press-to-add.

### Item 3 — Custom-trail parity: climate + elevation + tiles (PR 3)

**Step 3.1 — Shared `src/lib/climate-aggregate.ts` (new).** Extract the daily→monthly aggregation from `scripts/fetch-climate.ts` (~lines 172-230): `aggregateDailyToMonthly(daily): MonthlyClimate[]`. Refactor the script to import it (behavioral no-op — diff one regenerated climate.json to prove it). Vitest fixture test.

**Step 3.2 — `mobile/src/services/custom-climate-service.ts` (new).**
- `pickClimateSamplePoints(points, total, max=5)`: endpoints + interior every ~100 km, names "km 0", "km 104"…
- `fetchCustomTrailClimate(trail)`: per location, Open-Meteo archive API 2014–2023 daily temp/precip → `aggregateDailyToMonthly` → existing `ClimateData` shape (with honest `dataYears`); retry/backoff + inter-request delay.
- `ensureCustomTrailClimate(...)`: cache-first via new `getClimateJson`/`storeClimateJson` on `TrailDataService` (`climate_json` column), then `registerClimateData` (`climate-service.ts:43`) — downstream unchanged.
- UI: climate tab in `plan/[planId].tsx` shows a "Fetch climate data (requires internet)" card for custom trails with no cache; loading/error/retry states. Also register cached climate in `TrailDataContext.loadTrail` for custom trails.

**Step 3.3 — `mobile/src/services/elevation-service.ts` (new).** `fetchElevations(coords)` (Open-Meteo elevation API, batches of 100) + `backfillTrackElevation(points, sampleDists, sampleEles)` (linear interpolation, ≤500 samples). Wire into `mobile/app/import/index.tsx`: when warnings include `no_elevation`, offer opt-in fetch; on success re-run gpx-processor stats; on failure import flat as today. Jest for batching + interpolation.

**Step 3.4 — Offline tiles: UX fix + verification.** Code path is complete. Fix `mobile/app/(tabs)/plan.tsx:217` to sum real `cell.totalSize` from the grid index instead of `estimateGridDownloadSize(cells.length)`. Then run the verification checklist **once the Phase 2 R2 grid upload lands** (gate: import GPX → download → airplane mode → base+contours render; uncovered region → "No Tiles Available").

### Item 4 — Crowd-sourcing design doc (PR 4, doc only)

Write `plans/part-6b-crowdsourcing-design.md`, superseding the open questions in `part-6-community-features.md`. Required sections and the decision each must land:
1. **Scope**: water-source status first (item 2 primitive), then waypoint corrections, condition reports; photos/ratings stay 6c.
2. **Data model**: `custom_waypoints` + sync columns (`sync_status`, `server_id`, `deleted_at`, `device_id`); water status as append-only observations.
3. **Sync model**: recommend push-only submissions + curated pull (moderated contributions folded into published trail JSON via the existing `dataVersion` refresh path) — conflict resolution reduces to moderation; offline outbox, no background sync.
4. **Backend**: Supabase (AU Sydney residency, auth + RLS + moderation dashboard speed) vs Cloudflare Workers+D1 — decision table; recommend Supabase for 6b, tiles stay on Cloudflare.
5. **Identity**: anonymous device-id submit + optional email magic link; no accounts needed to read.
6. **Moderation**: pre-publication queue, owner-moderated initially, dedupe-by-proximity auto-signals, rejection feedback.
7. **Distribution**: build-time fold into trail JSON for 6b; live API deferred to 6c.
8. **Legal**: contribution licensing (CC0/CC-BY-SA grant), safety-critical water-data liability disclaimer, AU Privacy Act (APPs), takedown process.
9. **Rollout & metrics** + open-questions appendix.

## Testing Strategy

- **Web (Vitest):** new `trail-reverse`, `plan-direction`, `climate-aggregate` suites; existing calculator suites must stay green (`npm test`).
- **Mobile (Jest):** schema v5 migration tests; custom-waypoint CRUD; `mergeCustomWaypoints` (ordering, stable ids, reversal round-trip); water-carry integration (merged `type:'water'` waypoint shrinks a dry-stretch gap); climate cache-first/failure paths; elevation interpolation (`cd mobile && npx jest`).
- **Maestro:** new `custom-waypoint.yaml` (long-press → add → visible in datasheet → delete); `custom-trail-climate.yaml` (online-tagged); re-run `plan-creation.yaml`/`plan-editing.yaml` after the trail-utils re-export refactor; `custom-trail-offline.yaml` after the R2 grid upload.
- **Manual smoke, item 1:** toggle SOBO → Day 1 = former last segment **with swapped ascent/descent** (check an asymmetric day); elevation profile flipped; add stop in SOBO → toggle NOBO → stop at `total − km`, not duplicated; reload persists direction.
- Typechecks: `npx tsc --noEmit` (web + mobile), `npx expo lint`.

## Risks and Considerations

- **Shared `reverseWaypoints` drift breaking mobile** — port mobile test fixtures verbatim before refactoring; keep mobile jest suites as integration insurance.
- **km-space leaks in plan-viewer** — enforce the "storage NOBO / runtime active / two conversion points / epsilon compares" contract in review.
- **Migration collision** — item 2 owns migration 5 including `climate_json`; item 3 ships no migration. If item 2 is descoped, item 3 takes over migration 5.
- **Maestro long-press flakiness on the MapLibre canvas** — if unstable, seed a waypoint via a dev-only path and assert the rest of the flow.
- **Open-Meteo on-device limits/latency** — ≤5 locations, inter-request delay, single retry, per-location progress; strictly user-triggered.
- **Item 3 tile verification blocked on Phase 2 R2 upload** — only Step 3.4's checklist waits; all item-3 code ships independently.
- **Sequencing:** all branches cut after `phase-3-shared-code` merges (it's currently uncommitted); item 3 branches from item 2 if not yet merged.
