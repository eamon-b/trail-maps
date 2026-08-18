# P1 Plan — Flagship Field Features (from the Field Usability Review)

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

> **Source:** `docs/field-usability-review.md` §2 and roadmap items 7–12.
> **Theme:** make user-added waypoints and routes a feature people actively want, and give
> the hike screen the navigation context (ETA / bearing / time-to-water) that raw km can't.
> **Relationship to existing plans:** builds directly on Phase 4 item 2 (`custom_waypoints`,
> migration 5) and is a deliberate stepping stone to `plans/part-6b-crowdsourcing-design.md` —
> every capture improvement here increases the quality of what users will later share.
> Photos here are **local-only**; 6b explicitly defers photos in *community submissions* to 6c,
> and nothing in this plan uploads anything.

---

## Goals

- Creating a waypoint takes **one tap from the hike screen** at the moment of observation.
- Custom waypoints are first-class: full type set, editable position, undo-able delete, optional photo.
- User data is never trapped: custom waypoints and trails export as GPX via the OS share sheet.
- Users can compose **routes** (ordered waypoint sequences) without a geometry editor.
- The Contribute tab becomes the management home for "my data".
- Next-waypoint cards answer "how long?" and "which way?", not just "how far?".

## Current state (verified in the review)

- Creation: map long-press only (`TrailMap.tsx:613`, handler `trail/[id].tsx:261-298`), snaps to
  track, requires a loaded track; disclosed only via a tip on the Contribute tab (`contribute.tsx:30-34`).
- Form: `AddWaypointSheet.tsx` — name (required), 4 types (`TYPE_OPTIONS` `:11-16`), notes.
- Edit: name/type/description only (`trail/[id].tsx:313-318`); position immutable.
- Delete: confirm `Alert`, no undo (`trail/[id].tsx:350-373`); `UndoToast` exists and is wired
  for plan stops only.
- Storage: `custom_waypoints` (migration 5, `db/schema.ts:85-103`), CRUD in
  `trail-data-service.ts:377-452`, merged into display/plans via `getMergedTrail` (`:275-296`)
  with `custom-` id prefix (`trail-utils.ts:237-247`).
- Routes: none. GPX import only; `<rte>` folded into the main track (`gpx-processor.ts:318-323`).
- Export: datasheet Text/CSV only (`overview.tsx:163-182`); `plan-export.ts` exists for plans.
  No GPX export anywhere.
- Measure machinery that routes can reuse: `measure-service.ts:23-69`
  (`measureBetweenPoints` → distance/ascent/descent/time/water between two km positions).
- Heading is captured on every location update (`location-service.ts:9,44,91,150`) but unused
  outside the map. ETA exists only day-level (`HikeDashboard.tsx:63-69`).
- Native deps NOT currently installed: `expo-image-picker`, `expo-clipboard`, `expo-sharing`,
  `expo-sensors`. Any of these added ⇒ dev-client rebuild (CLAUDE.md: verify with
  `npx expo prebuild` + `eas build --profile development`).

## Key design decisions

1. **Five PRs, one migration each where needed, in this order:**
   A (capture & editing) → B (export) → C (nav info) → D (routes) → E (My Data).
   A is the foundation (schema migration 6); B–C are independent of each other; D depends on
   nothing in B/C but reuses A's sheet polish; E lists what A–D create, so it lands last.
2. **One native-dependency batch.** `expo-image-picker`, `expo-sharing`, and `expo-clipboard`
   are all added in PR A (even though sharing is used in PR B) so there is exactly **one**
   dev-client rebuild for the whole of P1. `expo-sensors` is explicitly **out** — PR C ships
   with GPS course heading first (decision 8).
3. **Waypoint types become data, not two hardcoded lists.** A single
   `WAYPOINT_TYPE_META` registry (label, emoji/icon, color token, "creatable" flag) in
   `src/lib`/mobile shared space feeds `TYPE_OPTIONS`, `WAYPOINT_COLORS` (`TrailMap.tsx:15-35`),
   the datasheet, and the elevation-profile dots. Creatable set for the form:
   `water, water-tank, campsite, shelter, town, lookout, junction, hazard, poi`.
   `hazard` is new end-to-end (color: alert amber family; renders on map + datasheet;
   excluded from water/resupply calculators).
4. **"Mark my location" writes first, edits after.** The hike-screen button immediately
   persists a waypoint at the current GPS position (name defaulted to "Marked HH:MM",
   type `poi`), then opens `AddWaypointSheet` in edit mode. Rationale: in the field the fix
   is the valuable part; a form that can be backgrounded/abandoned must not lose it.
   An `UndoToast` ("Waypoint marked — Undo") covers accidental taps.
5. **Free-floating pins allowed, snap annotated.** Creation no longer *requires* a snap:
   if the nearest track point is > 2 km away, store `km_position` of the nearest point anyway
   plus the real `off_track_m`, and render the pin at the true lat/lon with an "≈N m off trail"
   badge (the schema already stores both — no migration needed for this part). The existing
   raw-vs-snapped marker mismatch is fixed by drawing a thin connector line from pin to
   snapped track point when `off_track_m > 25`.
6. **Position edit = re-drop, not drag.** Map drag-to-move fights the pan gesture and follow
   camera. Edit mode gets a "Move pin" action that enters a crosshair mode (map centered on
   the pin, fixed center crosshair, pan the map under it, Confirm/Cancel) — the same
   interaction as `section-map.tsx` point picking, so it reuses that pattern rather than a
   new gesture. Saves lat/lon/ele/km_position/off_track_m together.
7. **Photos: one per waypoint in v1, file-system storage.** New nullable `photo_uri` column
   (migration 6) pointing into `FileSystem.documentDirectory + 'waypoint-photos/'`.
   Capture via `expo-image-picker` (camera or library), downscaled to ≤1600 px / ~80 % JPEG
   before save (images are for identification, not art; keeps exports and future 6c uploads
   sane). Deleting a waypoint deletes its file. Not shown on the map — thumbnail in
   `WaypointDetailSheet` and `AddWaypointSheet`, full-screen on tap.
8. **Bearing v1 uses GPS course, honestly labelled.** `heading` from `expo-location` is
   course-over-ground: valid while moving, garbage standing still. The bearing arrow renders
   only when speed > 0.5 m/s and the last fix is < 60 s old; otherwise it degrades to the
   cardinal text ("NE") that needs no device orientation. Magnetometer support
   (`expo-sensors`) is a follow-up, not in P1 — this avoids a native dep and calibration UX
   for a feature that works acceptably while walking (the dominant field case).
9. **Routes are ordered waypoint sequences over existing geometry — no drawn geometry.**
   A route = name + ordered list of `(waypoint_id | km_position)` legs; leg metrics come from
   `measureBetweenPoints`. Off-track waypoints contribute a straight-line leg (haversine,
   flagged "off-track ≈straight-line" in the UI). Drawing/sketching stays in P2 (item 18).
10. **Export format: GPX 1.1** — `<wpt>` for waypoints (with `<type>`, `<desc>`, `<ele>`),
    `<trk>` for custom-trail tracks, `<rte>` for routes. Photos are NOT embedded (GPX has no
    sane standard for it); the share sheet offers the `.gpx` file via `expo-sharing`.
    A `gpx-writer.ts` lands in `mobile/src/lib` (mobile-safe: string building only, no DOM —
    the existing `gpx-parser.ts` in `src/lib` is browser-only, which is why this is a new file).

---

## PR A — Waypoint capture & editing upgrades (roadmap 7 + 8)

**Migration 6:** `ALTER TABLE custom_waypoints ADD COLUMN photo_uri TEXT;` (nullable; no
backfill). Follow the transactional migration pattern in `db/schema.ts:113+`.

1. **Type registry.** Create `mobile/src/lib/waypoint-type-meta.ts`; refactor
   `AddWaypointSheet.TYPE_OPTIONS`, `TrailMap.WAYPOINT_COLORS`, datasheet type labels, and
   `ElevationProfile` dot colors to consume it. Add `hazard` (new) and the expanded creatable
   set (decision 3). Verify calculators: `distance-calculator.ts:56-63` (water types) and
   resupply logic must not pick up `hazard`/`lookout`/`junction`.
2. **"Mark my location"** on the hike screen: prominent button (≥56 pt) near the top of the
   dashboard, enabled when a GPS fix exists. Implements decision 4: insert immediately
   (`addCustomWaypoint` with current lat/lon, ele from fix, `km_position` from the snapped
   position `useLocation` already computes, `off_track_m` from distance-from-trail), fire
   `UndoToast`, open `AddWaypointSheet` prefilled. Works with degraded GPS (stores accuracy
   in the description preamble when accuracy > 50 m: "±120 m fix").
3. **Visible add on the map:** toolbar "+" button in `trail/[id].tsx` → crosshair mode
   (decision 6's component, reused for create) → `AddWaypointSheet`. Long-press remains.
4. **Free-floating pins + connector line** (decision 5) in `TrailMap` custom-waypoint layer.
5. **Position edit:** "Move pin" in `AddWaypointSheet` edit mode → crosshair mode → update
   via extended `updateCustomWaypoint` (add lat/lon/ele/km_position/off_track_m to its
   dynamic SET — `trail-data-service.ts:414-447`).
6. **Delete with undo:** replace the confirm `Alert` (`trail/[id].tsx:350-373`) with
   immediate delete + `UndoToast` (5 s). Undo = re-insert the captured row (keep the full row
   in memory; re-use the same id so merged references stay stable). Photo file deletion is
   deferred until the toast expires.
7. **Photos** (decision 7): capture/pick/downscale/store; thumbnail in detail sheet; delete
   lifecycle. New `mobile/src/services/waypoint-photo-service.ts`.
8. **Native deps batch** (decision 2): `npx expo install expo-image-picker expo-sharing
   expo-clipboard`; `app.json` plugin entries as required (image-picker needs camera/photos
   permission strings); `npx expo prebuild --clean`; document the rebuild in the PR.

**Tests:** type-registry consumers (snapshot of map colors per type), mark-my-location
insert-then-undo, position-edit persistence, photo service (file created/deleted, downscale
bounds), calculator exclusion of new types. Maestro: extend the custom-waypoint flow with
mark-my-location and delete-undo.

## PR B — GPX export & share (roadmap 9)

1. `mobile/src/lib/gpx-writer.ts`: `waypointsToGpx()`, `trailToGpx()` (main track +
   preserved alternates), `routeToGpx()` (used by PR D later). Escape XML, emit
   `<time>` from `created_at`, `<type>` from the registry.
2. Share entry points:
   - Trail overview (`overview.tsx`) → "Export my waypoints (GPX)" (custom waypoints on that
     trail) and, for custom trails, "Export trail (GPX)".
   - Waypoint detail sheet → "Share waypoint" (single-`<wpt>` GPX + a plain-text fallback
     line "Name — -35.12345, 148.98765 (km 42.3)" for messaging apps).
   Write to `cacheDirectory`, hand to `expo-sharing`.
3. Round-trip guarantee: exporting then importing through the existing GPX import must
   reproduce name/type/position (add an integration test through `gpx-processor`).

**Tests:** writer output vs golden files; XML escaping; round-trip via the existing parser.

## PR C — Next-waypoint ETA, bearing, time-to-water (roadmap 12)

1. **Per-waypoint ETA:** extend `distance-calculator.ts` to return, per upcoming waypoint,
   Naismith minutes from current position (`estimateHikingTime` over the km span, elevation
   from `track-geometry`'s gain/loss — the same call `measure-service.ts:32-38` makes).
   Render "~50 min" on `WaypointCard` (both full and compact variants) and `WaypointList`
   rows. Label the day-level ETA "at plan pace" and recompute it on a 60 s interval
   (fixes the frozen-`Date.now()` issue at `HikeDashboard.tsx:63-69`).
2. **Bearing arrow** (decision 8): `bearingBetween(current, target)` already exists in
   `off-trail-alert-service.ts:84-123` — extract it to a shared util. New `BearingIndicator`
   component: arrow rotated by `(targetBearing − courseHeading)` when moving, cardinal text
   otherwise. Shown on the NEXT CAMPSITE / NEXT WATER cards and in the off-trail banner
   (upgrading its static "head 247° WSW" string).
3. **Time-to-water:** `WaterCountdown` gains "· ~40 min" using the same per-waypoint ETA;
   surface the water waypoint's `description` first line on the NEXT WATER card
   (one `numberOfLines={1}` row — tank condition is exactly what hikers need pre-tap).

**Tests:** ETA math against `measure-service` fixtures; bearing rotation math incl. wrap-around
(350°→10°); moving/stationary gating logic.

## PR D — Waypoint-sequence routes (roadmap 10)

**Migration 7:**
`routes (id TEXT PK, trail_id TEXT REFERENCES trails ON DELETE CASCADE, name TEXT, created_at, updated_at)`;
`route_legs (route_id REFERENCES routes ON DELETE CASCADE, seq INTEGER, waypoint_ref TEXT, km_position REAL, PRIMARY KEY (route_id, seq))`.
`waypoint_ref` holds a merged waypoint id (bundled positional or `custom-` id); `km_position`
is denormalized so legs survive waypoint deletion (render as "(deleted waypoint)" but keep
geometry).

1. **Builder UI:** from the trail map toolbar ("Route" button) — tap waypoints in order,
   ordered chip list at the bottom with remove/reorder, live total distance/time via
   `measureBetweenPoints` per leg (decision 9). Save → named route.
2. **Rendering:** selected route highlights its track spans (existing `highlightedSegment`
   mechanism in `TrailMap`) plus straight dashed lines for off-track legs; leg list view with
   per-leg distance/ascent/time/water count (reuse the Measure result layout,
   `measure.tsx:396-404`).
3. **Service:** `mobile/src/services/route-service.ts` (CRUD + metrics assembly).
4. **Export:** `routeToGpx` wired into the share sheet (PR B's writer).
5. Explicit non-goals: no turn-by-turn, no drawn geometry (P2 item 18), no route-in-plan
   integration yet (a route can be *measured*; making it a plan section is a follow-up).

**Tests:** leg metric assembly (on-track, off-track, mixed); deletion survival; export golden file.

## PR E — Contribute tab → "My data" (roadmap 11)

Replace the static Contribute tab (`contribute.tsx`) with:
1. **My waypoints:** all custom waypoints across trails (new `getAllCustomWaypoints()`
   grouped by trail), rows → deep-link to the map focused on that waypoint (the P0 deep-link
   param), swipe-to-delete with undo, "Export all (GPX)".
2. **My trails:** imported trails with size/date, rename/delete (move the logic that exists
   in `overview.tsx:117-161`), Import GPX button (kept from today).
3. **My routes:** list from PR D.
4. Keep the 6a/6b framing: a "Sharing with the community — coming in v2" footer pointing at
   water-status reporting per `part-6b-crowdsourcing-design.md`, so the tab is honest about
   what's local vs future-shared.

**Tests:** cross-trail query; delete cascade behavior surfaced correctly; Maestro flow for the
new tab.

---

## Sequencing & verification

- Order: **A → B → C → D → E** (B/C swappable; D after B only for the export hook, which can
  be stubbed). One rebuild after A (decision 2), none after.
- Every PR: `npx tsc --noEmit`, `npx jest`, `npx expo lint`; A additionally
  `npx expo prebuild --clean` + a development EAS build per CLAUDE.md.
- Maestro flows updated in the PR that changes the surface (A: waypoint flow; E: tab flow).

## Risks

- **Native-deps batch (A)** is the riskiest step (permissions strings, prebuild). Mitigation:
  it's isolated in one PR, verified with a dev build before B–E stack on it.
- **GPS course heading UX** (C): standing-still degradation must be obvious or users will
  distrust the arrow — the moving/stale gating in decision 8 is a hard requirement, not polish.
- **Route leg semantics** (D): off-track straight-line legs must be visually distinct (dashed +
  label) or estimated times will be read as trail-accurate.
- **id stability:** routes reference merged waypoint ids; bundled positional ids (`wp-${i}`)
  shift on data-version bumps — hence the denormalized `km_position` fallback (and this is the
  same instability 6b §2.0 flags; if 6b's stable-id work lands first, `waypoint_ref` upgrades
  for free).
