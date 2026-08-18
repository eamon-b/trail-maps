# Field Usability & UI Review — Trail Companion Mobile App

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

**Date:** 2026-07-10
**Scope:** The full mobile app (`mobile/`), reviewed against one central aim: *the app must be easily usable in the field* — one-handed, gloved, in bright sun or darkness, tired, with a weak GPS fix and a battery that has to last a week. User-added waypoints and routes are treated as the flagship feature and reviewed in depth.

Every finding cites `file:line` so it can be actioned directly. A prioritized roadmap is at the end.

---

## Executive summary

The foundations are genuinely good: a coherent token system with four themes including Night Red and high contrast, reduce-motion support throughout, honest GPS-accuracy handling in the off-trail alert logic, a well-structured offline tile pipeline, and a hike dashboard with a deliberate above/below-the-fold hierarchy. This is better field-awareness than most hiking apps ship with.

The gap is between *designed intent* and *execution at the edges* — and in the field, the edges are the product:

1. **Dead ends under failure.** Denied location permission shows an eternal "Searching for GPS signal…" with no way out. Off-trail snooze can't be cancelled. These are exactly the states a stressed hiker hits.
2. **Taps that don't go where the hiker is looking.** Tapping "NEXT WATER" or any upcoming waypoint opens the generic map, not that waypoint. The single most common field interaction is a dead-end tap.
3. **The flagship feature (custom waypoints) is functional but thin.** One hidden entry point (map long-press), 4 waypoint types, no position editing, no photos, no undo on delete, no export/share. Custom *routes* barely exist — GPX import only, no drawing, no alternates.
4. **Field-critical information is missing.** No coordinates display, no bearing/compass to next waypoint, no per-waypoint ETA, no battery-aware tracking mode, no offline-readiness indicator on the hike screen.
5. **The design system exists but isn't enforced.** Sub-44pt touch targets, hardcoded colors that break Night Red and dark mode, high-contrast honored by only 7 components, haptics wired only in hike mode, duplicated headers/cards, and two 700–1200-line god screens.

---

## Part 1 — Hike mode: the field-critical surface

### 1.1 What works

- Above/below-fold hierarchy is explicit and correct: next campsite → next water → town/shelter grid, then TODAY, then UPCOMING (`HikeDashboard.tsx:71-78, 99-259`).
- Alert states never rely on color alone — icon + label always present (`LocationStatusBar.tsx:16-22, 44-61`).
- Off-trail alerting is unusually honest about GPS error: accuracy-radius crediting (`off-trail-alert-service.ts:51-54`), suppression above 200 m accuracy (`useOffTrailAlert.ts:22, 98-102`), and 3-reading debounce with instant improvement transitions (`useOffTrailAlert.ts:19, 106-115`).
- Foreground tracking stops on tab blur to save battery (`hike.tsx:90-98`); background tracking is opt-in with a persistent notification (`location-service.ts:174-181`).

### 1.2 Critical fixes (P0)

**Permission-denied dead end.** `useLocation` sets an `error` on permission denial (`useLocation.ts:176-203`) but `hike.tsx:82-83` never destructures it. A user who denied location sees "Searching for GPS signal…" forever, with no explanation and no "Open Settings" button. Retry only fires on an app-foreground transition (`hike.tsx:102-108`). **Fix:** consume `error`; render a distinct state card with the reason and a `Linking.openSettings()` CTA.

**Waypoint taps are dead ends.** `handleWaypointSelect` and `onSeeAllWaypoints` both push the bare `/trail/${activeTrailId}` route, ignoring which waypoint was tapped (`hike.tsx:274-278, 329-331`). Tapping "NEXT WATER" should open the map focused on that waypoint with its detail sheet up. **Fix:** pass a `focusWaypointId` param; the map viewer's reducer already supports selecting a waypoint (`trail/[id].tsx:84-109`) — wire the param into it.

**Snooze is a one-way door.** `clearSnooze` exists (`useOffTrailAlert.ts:85-88`) but is never called from the screen (`hike.tsx:113`). During a 15/30/60-min snooze there is no "snoozed until HH:MM" indicator; alerts silently cap at `drifting` (`useOffTrailAlert.ts:118-123`). **Fix:** show a snooze chip in the status bar with a tap-to-cancel.

**Warning state (200–500 m off trail) is nearly invisible.** Only `offTrail` raises the banner (`hike.tsx:352-360`); `warning` gets a status-bar tint plus a single haptic. A fatigued hiker who misses one buzz gets no further prompt until fully off trail — and with 30 s intervals plus 3-reading debounce, the first *banner* can be ~90 s + another escalation late. **Fix:** show a dismissible banner (or at minimum a persistent amber chip with distance-from-trail) at `warning`, and repeat the haptic on continued worsening.

**Sub-44pt targets on the hike screen.** The Datasheet link has only 8 pt vertical padding and no min-height (`hike.tsx:424-427`); snooze options 12 pt (`hike.tsx:448-452`); the detail-sheet close button is 32×32 (`WaypointDetailSheet.tsx:99, 223-229`). Gloved, moving hands need ≥44 pt (the token exists: `spacing.ts:23-25`) — arguably 48–56 pt for primary hike-screen actions.

### 1.3 Missing field features (high value)

- **Coordinates readout.** Current lat/long is never displayed anywhere. For emergencies (relaying position to rescue) this is table stakes. Add a coordinates row to the hike screen (tap to copy / long-press to switch format: decimal, DMS, UTM/MGA for Australian rescue).
- **Bearing to next waypoint.** `heading` is captured in every location update (`location-service.ts:9,44,91,150`) but consumed only by the map. The off-trail alert already computes a bearing string ("head 247° WSW", `useOffTrailAlert.ts:125-147`) — but it's static text, not device-relative. Add a simple rotating arrow (device heading vs. target bearing) on the next-waypoint card and in the off-trail banner. No new native deps needed for coarse heading; `expo-sensors` magnetometer would refine it.
- **Per-waypoint ETA.** ETA exists only for the whole day (`HikeDashboard.tsx:63-69, 207-217`). The Naismith machinery (`day-calculator`) can produce "~50 min" per upcoming waypoint — far more useful mid-hike than raw km. Also: the day ETA is computed from `Date.now()` at render and never accounts for breaks, so it silently goes stale; recompute on an interval and label it "at current pace" or similar.
- **Battery-aware tracking.** Everything runs at `Accuracy.High` / 30 s / 10 m always (`location-service.ts:79-84, 171-181`); there is no battery-saver tier and no battery reading anywhere in `src`. Add a power-saving mode (Balanced accuracy, 60–120 s interval) — user-selectable, and/or auto-engaged below ~30% via `expo-battery`.
- **Offline readiness on the hike screen.** Tile services exist, but the hike dashboard never says "offline maps ready" or warns "no cached tiles for the section ahead." A hiker discovers missing tiles when the map is blank in a dead zone. One status line (with a tap-through to download) closes this.
- **Water context, not just distance.** WaterCountdown shows km only (`WaterCountdown.tsx`). With Naismith you can show time-to-water; waypoint `description` (tank condition/reliability) is one tap too deep. Consider surfacing the description snippet on the NEXT WATER card, and a "carry recommendation" reusing `water-carry-calculator` (currently plan-only).

### 1.4 Smaller hike-screen issues

- The whole TODAY card body is one collapse Pressable (`HikeDashboard.tsx:183-229`) — easy accidental collapse; move the toggle to a header chevron.
- The snooze menu is an absolute overlay at fixed `top: 80` (`hike.tsx:432-441`) — not anchored to the banner or safe area; replace with `AppBottomSheet` (already the app's standard).
- Water/shelter cards omit the elevation-gain figure that campsite/town cards show, though it's computed for all (`distance-calculator.ts:33`).
- Direction/plan changes made in another tab only apply when Hike regains focus (`hike.tsx:131-198`) — acceptable, but worth a "plan updated" refresh cue.
- WaterCountdown's green is hardcoded `#4CAF50` (`WaterCountdown.tsx:26-28`) — it will glow green in Night Red mode, defeating dark adaptation. Route all three threshold colors through the theme.

---

## Part 2 — User-added waypoints & routes (the flagship feature)

### 2.1 Current state

Custom waypoints work end-to-end: map long-press → snap to trail → `AddWaypointSheet` (name/type/notes) → separate `custom_waypoints` table that survives data refreshes (`db/schema.ts:85-103`, comment at `:77-84`) → merged into datasheet, plans, and water calculations via `getMergedTrail` (`trail-data-service.ts:275-296`). The persistence design is exactly right.

Custom routes exist only as whole imported GPX trails (`custom-trail-service.ts:205-286`). The import flow itself is strong — staged UI, live map preview, typed errors with suggestions, opt-in elevation backfill with save blocked while fetching (`import/index.tsx`).

### 2.2 Where it falls short of "a feature people want"

**Discoverability: one hidden entry point.** Long-press-on-map is the *only* way to create a waypoint, and it's disclosed only in a tip on the Contribute tab (`contribute.tsx:30-34`). Fixes:
- Add a visible "+" / "Add waypoint" button on the map toolbar (drops a pin at map center or current GPS position).
- Add **"Mark my location"** on the hike screen — the killer field action ("water source here", "campsite full", "track washed out") should be one tap from the dashboard, pre-filled with current GPS position, no map interaction needed.

**Only 4 types** (`AddWaypointSheet.tsx:11-16`: water, water-tank, campsite, poi) while the map renders ~18 (`TrailMap.tsx:15-35`). Hikers will want shelter/hut, lookout, junction, hazard/warning, and town at minimum. A **hazard** type is the most field-valuable addition and currently impossible.

**Position is immutable.** Edit covers name/type/description only (`trail/[id].tsx:313-318`); a misplaced pin must be deleted and recreated. Add "move pin" (drag or re-long-press) to edit mode.

**No undo on delete** — a confirm `Alert` then gone (`trail/[id].tsx:350-373`), despite `UndoToast` existing and being wired for plan-stop removal. Swap the confirm for delete + undo toast; it's both safer and faster in the field.

**Pin renders at raw press point while km/off-trail math uses the snapped point** (`trail/[id].tsx:277-287` vs `pendingWaypoint` marker) — for a sloppy gloved press these visibly disagree. Show both (pin + snapped-point tick + connecting line) or snap the pin when `offTrackM` is small.

**No free-floating pins.** Long-press requires a loaded track and snaps to it (`TrailMap.tsx:497-505`). An off-trail campsite or car park can't be marked honestly. `off_track_m` is already stored — allow pins beyond the snap radius with a "N m off trail" annotation.

**No photos.** No image field in schema or form. A photo of a water tank or trail junction is often *the* piece of information worth recording. Add an optional photo (camera or library) stored via `expo-file-system`, path column on `custom_waypoints`.

**No export/share.** Custom waypoints and trails can't leave the phone — no GPX export, no share (Contribute says "coming in v2", `contribute.tsx:38-41`). Before any community backend, ship **GPX/JSON export via the OS share sheet** — it makes user data durable and shareable with zero server work, and builds trust that data isn't trapped.

### 2.3 Routes: the missing half

There is no way to create or modify a route in-app. Recommended progression:

1. **Waypoint-sequence routes (cheap, high value):** let users pick existing waypoints in order and save as a named route; along-track distance/elevation between them already exists (`track-geometry.ts`, `measure-service.ts:23-69` does exactly this for two points). This covers "my side trip to the lookout and back" without a geometry editor.
2. **Tap-to-sketch off-track legs:** straight-line segments between tapped points with live distance — enough for detours and water runs.
3. **Alternates on custom trails:** GPX `<rte>` elements are currently flattened into the main track (`gpx-processor.ts:318-323`); preserve them as alternate tracks, which the renderer already supports (orange dashed, `TrailMap.tsx:220-227`).

### 2.4 Contribute tab

Currently a stub: an import button, a tip, and a v2 notice (`contribute.tsx`). Two options: (a) fold Import into Plan and replace the tab with something field-useful, or (b) make Contribute the home of **"My data"** — list/manage all custom waypoints and trails across trails, export, stats ("you've added 14 waypoints"). Option (b) matches the stated product aim and gives custom data a management surface it currently lacks (today you can only find your waypoints by browsing the map).

---

## Part 3 — Plan mode

Plan is feature-rich (auto day-splitting, resupply, water carry, climate, sections, versions, export) but the interaction cost is high:

- **Editing verbs are scattered:** FAB for add, per-card `↑`/`↓` icon buttons for merge/split (glyphs read as *reorder*, `DayPlanCard.tsx:213-222`), swipe-left to remove, 500 ms long-press to relocate a stop via a separate map screen (`DayPlanCard.tsx:85-91`, `map.tsx:156-214`). Three of four verbs are invisible. **Fix:** a per-day "⋯" menu (or tap → action sheet) listing Split / Merge / Move / Remove with labels; keep gestures as shortcuts.
- **Water & resupply are hidden on the Overview tab** while the default tab is Days (`[planId].tsx:92, 686-687`). Surface a compact per-day water/resupply strip on the Days tab — it's the information the plan exists to produce.
- **Start date is a raw `YYYY-MM-DD` TextInput** with regex validation (`create.tsx:161-180, 31-37`). Use a native date picker.
- **Two near-identical map screens** (`map.tsx` vs `section-map.tsx`) with different pin-color conventions (theme colors vs literals `#4CAF50`/`#FF5722`, `section-map.tsx:164-174` vs `map.tsx:134`) and a fragile dynamic-param return contract (`section-map.tsx:208-218`). Merge into one parameterized screen.
- **God screens:** `[planId].tsx` is 1,176 lines owning load, persistence, undo, split, sections, climate, versions, export, and five sheets; `plan.tsx` is 718 lines mixing browsing, tile downloads, plan lists, and storage. Split before layering more UI on top.
- **No haptics anywhere in Plan** despite heavy gesture use — `haptics.ts` is consumed only by `hike.tsx`. Promote haptics to a design-system primitive (selection tick on stop toggle, success on save, warning on destructive swipe).
- Sub-44pt rows: `touchTarget.min / 2` used at `plan.tsx:638, 691, 710` and `ClimateOverview.tsx:140`.
- Offline tile download lives only on Plan-tab trail cards (`plan.tsx:289-377`); Overview shows read-only status (`overview.tsx:516-522`) and the map viewer offers nothing. Add download/status affordances to both — the map is where its absence hurts.

---

## Part 4 — UI overhaul: design-system priorities

The token system (`src/tokens/`) and theme layer (`src/theme/`) are solid. The overhaul work is mostly *enforcement and consolidation*, not reinvention:

1. **Kill hardcoded colors.** Violations that actively break theming: `_layout.tsx:65,108-124` (loading/error screens), `#c00` destructive red (`settings.tsx:251`, `[planId].tsx:887`, `create.tsx:177`), `ClimateCard.tsx:23` temp colors, `WaterCountdown.tsx:26-28`, `section-map.tsx:164-174` pins, and `rgba(0,0,0,0.08)`/`#0001` borders (`plan.tsx:625,637,680`, `ResupplyList.tsx:206,239`, `WaterCarryList.tsx:122`, `ClimateOverview.tsx:149,155`) which vanish on dark/OLED. Add semantic tokens (`danger`, `waterOk/Low/Critical`, `tempCold/Mild/Hot`) and an ESLint rule banning color literals in styles.
2. **Enforce touch targets.** One shared `TouchableRow`/`Button` primitive with `minHeight: touchTarget.min`; fix the `/2` sites and the hike-screen gaps (§1.2). Consider a `touchTarget.field = 56` tier for hike-mode primary actions.
3. **Complete high-contrast coverage.** Only 7 components honor the toggle; `plan.tsx` cards, StopSelector, SectionSelector, AlertBanner, UndoToast, AppBottomSheet, ProgressBar, and both map screens ignore it. Centralize via the `Card` primitive rather than per-component checks.
4. **Consolidate duplicated chrome.** A shared `ScreenHeader` (the Back/title/spacer pattern is copy-pasted across 5+ screens) and universal use of `Card` (Plan screens re-implement its shadow/radius/border recipe inline).
5. **Font scaling.** No `maxFontSizeMultiplier` anywhere and fixed-height rows with `numberOfLines` will clip at large OS text sizes. Also reconsider the 12 pt `caption` used for field data (WaterCountdown, SunriseCountdown, TODAY stats — `WaterCountdown.tsx:50-53`, `HikeDashboard.tsx:293-311`): in sunlight with tired eyes, key numbers should be ≥14–16 pt. Long-term: a "field mode" (or auto-on in Hike) that bumps the whole type scale and target sizes.
6. **Real tab icons.** Letter circles "P/H/C" with literal `#fff` (`(tabs)/_layout.tsx:88-102`) read as placeholders; swap for glyphs (map/boot/plus).
7. **Waypoint clustering** for dense areas — imported trails with many waypoints render every circle/label individually (`TrailMap.tsx`).
8. **Zoom buttons on the map** — pinch-only zoom is hostile to one-handed/gloved use. MapLibre camera already supports programmatic zoom; add +/− to the toolbar.

---

## Prioritized roadmap

### P0 — Field safety & dead ends (small diffs, high impact)
1. Surface location `error` with an Open Settings CTA (`hike.tsx`).
2. Deep-link waypoint taps from the dashboard to the focused waypoint on the map.
3. Snooze indicator + cancel; banner (or persistent chip) at `warning` state.
4. Coordinates readout on the hike screen (tap to copy).
5. Fix sub-44pt targets (hike screen + `touchTarget.min / 2` sites).
6. Theme the WaterCountdown/ClimateCard/AlertBanner literals so Night Red actually stays red.

### P1 — Make the flagship feature earn its place
7. "Mark my location" one-tap waypoint from the hike screen; visible add-waypoint button on the map.
8. Expand waypoint types (incl. hazard); allow position edit; delete-with-undo; photo attachment.
9. GPX export/share of custom waypoints and trails.
10. Waypoint-sequence custom routes (reusing measure/track-geometry machinery).
11. Contribute tab → "My data" management surface.
12. Per-waypoint ETA + bearing arrow on next-waypoint cards; time-to-water.

### P2 — UI overhaul & structural health
13. Semantic color tokens + lint ban on literals; complete high-contrast coverage.
14. Shared `ScreenHeader`; adopt `Card` everywhere; haptics as a system-wide primitive.
15. Plan editing verbs into a labeled per-day menu; water/resupply strip on Days tab; native date picker.
16. Merge `map.tsx`/`section-map.tsx`; split the two god screens.
17. Battery-saver tracking tier; offline-readiness indicator on hike screen; map zoom buttons; font-scaling audit; real tab icons; waypoint clustering.
18. Alternates preserved from GPX `<rte>`; tap-to-sketch route legs.

---

*Method note: findings were gathered by three parallel code surveys (hike mode & location stack; map/waypoints/import/measure; plan flow & design system) and key claims were verified against source before writing. All line references are against branch `claude/field-usability-ui-review-b8jftd` at the time of review.*
