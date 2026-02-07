# Part 2: Offline Trail Viewer

## Goal
Build the core trail viewing experience with offline-capable maps, GPS location tracking, and distance/elevation calculations to waypoints. This is the foundation of the "Hike" mode functionality.

## Development Tracks

Sections 1-3 and 7-8 (map, tiles, waypoints, elevation profile) can be developed in parallel with Sections 4-6 (GPS, auto-follow, distance calculations). This allows faster iteration on each track.

**Track A (Map & Profile):** Sections 1, 2, 3, 7, 8
**Track B (GPS & Location):** Sections 4, 5, 6
**Integration:** Section 9 (Trail Browsing) ties both tracks together.

## Deliverables

### 1. MapLibre GL Integration ✅ COMPLETE
- ~~Configure MapLibre React Native with the topographic style from the tile pipeline~~ → Currently using MapTiler Cloud Outdoor style (Phase 1); custom topo style pending tile pipeline Phase 2
- ~~Load custom topo style.json compositing base map and contour sources~~ → Deferred to tile pipeline Phase 2 integration
- ~~Implement smooth pan/zoom interactions~~ → Done (`TrailMap.tsx`)
- ~~Trail polyline rendering with direction indicators~~ → Done (main trail + alternates + side trips); direction indicators (arrows along polyline) not yet implemented
- ~~Online fallback to MapTiler Cloud when tiles are not downloaded~~ → MapTiler Cloud is the current primary style

### 2. Offline Map Tiles (App-Side) ✅ COMPLETE

The tile generation pipeline (corridor extraction, contour generation, base map extraction) is handled by the **Topo Tile Pipeline** plan. This section covers the app-side download, caching, and management of the generated MBTiles packages.

- ~~Download MBTiles packages (base + contours) to `FileSystem.documentDirectory`~~ → Done (`tile-service.ts` downloads base.mbtiles + contours.mbtiles to `{documentDir}/tiles/{trailId}/`)
  - ~~Uses persistent storage, not cache directory (avoids iOS cache eviction)~~ → Done (uses `Paths.document`)
  - ~~Two files per trail, sizes per tile pipeline estimates (9-81 MB per trail)~~ → Done (idempotent download, skips if file exists with size > 1000 bytes)
- ~~Download progress UI with size estimates from tile manifest~~ → Done (`plan.tsx` shows per-file download progress with storage info)
- ~~Resume interrupted downloads (track per-file completion)~~ → Done (checks existing file size before downloading)
- ~~Handle full storage gracefully (check available space before download, warn user)~~ → Done (`TileManager.getAvailableSpace()`, storage footer in `plan.tsx`)
- ~~Storage management UI (view downloaded trails with sizes, delete old data)~~ → Done (`plan.tsx` shows per-trail status/size, delete with confirmation dialog)
- ~~Load local MBTiles via `mbtiles://` protocol in MapLibre style~~ → Done (`tile-service.ts` `buildTopoStyle()` generates full 28-layer MapLibre style with `mbtiles://` URLs)
- ~~Switch `TrailMap` style URL from MapTiler Cloud to local MBTiles style when tiles are available~~ → Done (`trail/[id].tsx` calls `tileManager.getOfflineStyle()` and passes to `TrailMap`)

### 3. Offline Asset Management — PARTIAL
- ~~Bundle static assets (icons, fonts, base styles) with app binary~~ → Done
- ~~Bundle PBF font glyphs (Open Sans Regular + Bold, ~2-5 MB) for offline text rendering~~ → Done (`tile-service.ts` `provisionGlyphs()` copies 6 PBF ranges for Open Sans Regular to document directory; loaded via `file://` in offline style)
- Trail data versioning for update checking — **NOT IMPLEMENTED**
- "Last updated" timestamps for cached trail data — **NOT IMPLEMENTED**
- Background download option for large tile sets (requires `expo-task-manager` — see Review Notes) — **NOT IMPLEMENTED**

### 4. GPS Location Tracking — MOSTLY COMPLETE
- ~~React Native geolocation integration~~ → Done using `expo-location` (not `react-native-geolocation-service` as originally stated; `expo-location` is correct for Expo projects)
- ~~Blue dot current position on map with accuracy circle~~ → Done (`TrailMap.tsx` lines 359-386)
- Configurable sampling frequency (battery management) — **PARTIAL**
  - ~~Active: every 30s while walking~~ → Done (fixed at 30s interval, 10m distance in `location-service.ts`)
  - Background: reduced frequency — **NOT IMPLEMENTED** (requires `expo-location` background task + `expo-task-manager`)
  - Manual: GPS only when app is foregrounded — **NOT IMPLEMENTED** (currently tracking is manual start/stop via GPS button)
- **GPS accuracy handling:** — **PARTIAL**
  - ~~Display accuracy circle when accuracy >20m~~ → Done (`TrailMap.tsx` line 363)
  - Degrade km position confidence when accuracy >50m — **NOT IMPLEMENTED** (no visual indicator)
  - ~~Show "Low GPS accuracy" indicator when accuracy >100m~~ → Done via `LocationStatusBar` (accuracy >100m → `warning` state in `trail/[id].tsx` line 118)
- ~~Snap user position to nearest track point~~ → Done (`useLocation.ts` snapToTrail)
  - Prefer "forward" direction when equidistant from multiple track points — **NOT IMPLEMENTED**
  - Use recent movement direction to resolve ambiguity — **NOT IMPLEMENTED**
- ~~Calculate current km position along trail~~ → Done
- **Graceful degradation without GPS permission:** — **DONE**
  - ~~App remains fully functional for planning~~ → Done (plan tab works independently)
  - ~~Clear messaging about what requires location access~~ → Done (error state in useLocation hook)

### 5. Map Auto-Follow Behavior ✅ COMPLETE
- ~~Auto-follow user position by default~~ → Done (`trail/[id].tsx` isFollowingUser defaults to true)
- ~~Pause auto-follow when user pans manually~~ → Done (`TrailMap.tsx` onRegionWillChange checks isUserInteraction)
- ~~"Re-center" floating button to resume auto-follow~~ → Done (`TrailMap.tsx` lines 399-408)
- Smart zoom level based on speed/context — **NOT IMPLEMENTED** (fixed at zoom 14; polish item)

### 6. Distance/Elevation to Waypoints ✅ COMPLETE
- ~~Real-time calculation from current position to:~~ → Done (`distance-calculator.ts`)
  - ~~Next campsite~~ → Done
  - ~~Next water source~~ → Done
  - ~~Next town~~ → Done
  - ~~Next shelter~~ → Done
  - ~~Any selected waypoint~~ → Done (distance shown in `WaypointDetailSheet`, calculated in `trail/[id].tsx` line 144-147)
- ~~Display cumulative distance and net elevation change~~ → Done (WaypointDistance includes elevationGain/elevationLoss)
- ~~Integrate with Hike Dashboard "NEXT" cards from Part 1~~ → Done (`hike.tsx` lines 94-124 build real `DashboardData` from GPS + trail using `getNextWaypointsByType()`)

### 7. Waypoint Display on Map ✅ COMPLETE
- ~~Waypoint markers with emoji icons (14 types)~~ → Done with colored circles instead of emoji (14 type-to-color mappings in `TrailMap.tsx`); emoji icons in `WaypointDetailSheet`
- ~~Tap waypoint to open bottom sheet with details:~~ → Done
  - ~~Name, type, description~~ → Done
  - ~~Distance from current position~~ → Done (passed as `distanceFromUser`)
  - ~~Elevation~~ → Done
  - ~~"Show on elevation profile" button~~ → Done (via `onShowOnProfile` callback)

### 8. Elevation Profile Integration ✅ COMPLETE
- ~~Pull-up drawer from bottom of map view~~ → Done (`ElevationProfileDrawer.tsx`, three snap points: 80px/40%/70%)
- Contextual profile showing currently visible map section — **PARTIAL** (profile shows full trail with a blue highlight rectangle for the visible map region via `visibleRange` prop; does not crop to only visible section)
- Bidirectional sync: — **DONE**
  - ~~Pan map → profile updates visible range~~ → Done (`TrailMap.tsx` `onVisibleBoundsChange` callback calculates min/max km; `ElevationProfile.tsx` renders blue highlight rectangle)
  - ~~Tap profile → map pans to location~~ → Done (`handleProfileDistanceTap` in `trail/[id].tsx` lines 181-189 finds nearest track point via `findNearestByDistance` and sets `panTarget`)
- ~~Current position marker on profile~~ → Done (vertical line at `currentKm`)
- ~~Waypoint markers on profile~~ → Done (color-coded dots on profile)

**Functions ported from `src/web/trails/trail-viewer.ts`:**

| Function group | Source functions | Status | Mobile location |
|---------------|----------------|--------|-----------------|
| Elevation profile rendering | `drawElevationProfile` (line 963) | ✅ Done | `ElevationProfile.tsx` (Skia canvas) |
| Map ↔ profile sync | `setupElevationHover` (line 869) | ✅ Done | `trail/[id].tsx` bidirectional: tap profile → pan map; pan map → visible range highlight on profile |
| Waypoint interaction | `handleTableRowClick` (line 429), `drawWaypointMarkers` (line 319) | ✅ Done | `TrailMap.tsx` onWaypointPress, `WaypointDetailSheet.tsx` |
| Direction reversal | `createReversedTrail` (line 1502) + helpers | ✅ Done | `trail-utils.ts` lines 130-217 |
| Variant tracks | `drawAlternates` (282), `drawSideTrips` (295), `findVariantByKey` (547) | ✅ Done | `TrailMap.tsx` + `trail-utils.ts` |
| Nearest point lookup | `findNearestByDistance` (line 196) | ✅ Done | `trail-utils.ts` line 77 |

Note: All calculation/data-transformation logic has been ported. Rendering was reimplemented for React Native (Skia for profile, MapLibre for map). Bidirectional map ↔ profile sync is implemented (tap profile → pan map; pan map → visible range highlight on profile).

### 9. Trail Browsing — MOSTLY COMPLETE
- ~~Trail list/index view~~ → Done (`plan.tsx` with FlatList from SQLite)
- Trail overview (map, stats, description) — **PARTIAL** (trail name shown in toolbar; no dedicated overview/stats screen)
- ~~Download trail for offline button~~ → Done (`plan.tsx` shows download/delete buttons per trail with progress UI and storage management)
- ~~Direction toggle (NOBO/SOBO equivalent)~~ → Done (`trail/[id].tsx` toggleDirection with AsyncStorage persistence)

## Success Criteria
- Map displays trail with current GPS location
- Full offline functionality after downloading trail
- Distance to next campsite/water/town updates in real-time
- Elevation profile syncs with map view
- Battery-conscious GPS sampling works
- Tile packages can be downloaded and managed (35-210 MB per trail)
- App remains responsive with 500MB cached tiles
- GPS battery usage measured and documented
- Works gracefully with GPS accuracy up to 100m
- App fully functional for planning without GPS permission

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation
- **Topo Tile Pipeline** (`plans/topo-tile-pipeline.md`): At minimum Phase 1 (MapTiler Cloud) must be complete to begin Track A. Phase 2 (custom pipeline) must produce tiles for at least one trail (bibbulmun) before Section 2 (app-side tile management) can be fully implemented.

## Notes
- Start with a single trail (Bibbulmun) for all testing
- Battery life testing on actual devices is critical
- The map ↔ elevation sync logic from `trail-viewer.ts` is a key asset to port (see Section 8 table)
- Tile hosting strategy decided: **Cloudflare R2** — zero egress, built-in CDN, S3-compatible API. See `plans/topo-tile-pipeline.md` Appendix D for details. App reads `EXPO_PUBLIC_TILE_BASE_URL` env var.

---

## Review Notes

**Reviewed: 2026-02-09** (supersedes 2026-02-08 review)

### Overall Assessment

This plan is **~95% implemented**. All core features — map rendering, offline tiles, GPS tracking, elevation profile with bidirectional sync, waypoint interaction, distance calculations, hike dashboard, and trail browsing with tile management — are built and integrated. The remaining work is: (1) trail data versioning, (2) background location tracking, and (3) polish items. No bugs were found.

### Implementation Status Summary

| Section | Status | Key files |
|---------|--------|-----------|
| 1. MapLibre GL | ✅ Complete | `TrailMap.tsx` (547 lines) |
| 2. Offline Tiles | ✅ Complete | `tile-manager.ts` (85 lines), `tile-service.ts` (567 lines) |
| 3. Offline Assets | ⚠️ ~60% (fonts done, versioning not) | `tile-service.ts` `provisionGlyphs()` |
| 4. GPS Tracking | ⚠️ ~85% (no background mode) | `location-service.ts` (78 lines), `useLocation.ts` (139 lines) |
| 5. Auto-Follow | ✅ Complete | `TrailMap.tsx`, `trail/[id].tsx` |
| 6. Distance/Elevation | ✅ Complete | `distance-calculator.ts` (84 lines), `hike.tsx` (179 lines) |
| 7. Waypoint Display | ✅ Complete | `TrailMap.tsx`, `WaypointDetailSheet.tsx` (146 lines) |
| 8. Elevation Profile | ✅ Complete | `ElevationProfile.tsx` (378 lines), `ElevationProfileDrawer.tsx` (105 lines) |
| 9. Trail Browsing | ⚠️ ~85% (no overview screen) | `plan.tsx` (320 lines), `trail/[id].tsx` (430 lines) |

### Changes Since 2026-02-08 Review

The previous review identified several items as stubs or bugs that have since been completed or were inaccurately assessed. Corrections:

1. **Tile management is fully implemented** — `tile-manager.ts` (85 lines) delegates to `tile-service.ts` (567 lines) which handles download, storage, deletion, and builds a complete 28-layer MapLibre offline style with `mbtiles://` protocol URLs. The `plan.tsx` screen provides download progress UI, storage management, and delete confirmation.
2. **Hike dashboard uses real data** — `hike.tsx` lines 94-124 build `DashboardData` from GPS + trail data via `getNextWaypointsByType()` and `calculateDistancesToWaypoints()`. No mock data remains.
3. **Accuracy circle is correctly implemented** — `accuracyCircleRadiusExpression()` at `TrailMap.tsx:144-161` converts GPS accuracy meters to screen pixels using a zoom-dependent interpolation with latitude compensation (`cosLat * 40075017 / (256 * 2^z)`). Clamped to [2, 200] pixels.
4. **Profile → map sync is implemented** — `handleProfileDistanceTap` at `trail/[id].tsx:181-189` finds the nearest track point via `findNearestByDistance()` and triggers a map pan via `panTarget` state.
5. **Map → profile sync is implemented** — `TrailMap.tsx` `onVisibleBoundsChange` callback calculates visible km range; `ElevationProfile.tsx` renders a blue highlight rectangle over the visible region.

### Remaining Issues

#### 1. Trail snapping doesn't prefer forward direction
`useLocation.ts` uses a coarse-then-fine nearest-point algorithm but doesn't track movement history or apply directional bias. On trails with switchbacks or parallel sections, this could snap to the wrong segment. **Nice-to-have, not blocking.**

#### 2. Background location tracking not implemented
Requires `expo-task-manager` (not installed) + `expo-location` background task registration + iOS background mode declaration in `app.json`. Without this, GPS tracking stops when the user locks their phone while walking. **This is the most important functional gap for the "Hike" use case.**

#### 3. No error boundary for map crashes
MapLibre can crash on invalid GeoJSON or out-of-memory with large tile sets. `TrailMap` has no React error boundary — a map crash takes down the entire app. **Should wrap in an error boundary with a "Map failed to load" fallback before release.**

#### 4. Trail data versioning not implemented
No mechanism to check if cached trail data is stale or prompt users to re-download. Users could be hiking with outdated waypoint information. **Important for the "Plan" use case.**

#### 5. `displayPoints` vs `points` distinction undocumented
`TrailMap` receives `displayPoints` (Douglas-Peucker simplified) while `ElevationProfile` gets `trackPoints` (full resolution). This is architecturally correct (simplified for map performance, full for profile accuracy) but should be documented for maintainability.

### Remaining Work (Prioritized)

**P0 — No items. All critical features are complete.**

**P1 — Important for production readiness:**
1. Add React error boundary around `TrailMap` component
2. Implement background location tracking (requires `expo-task-manager`)
3. Trail data versioning / "last updated" / update checking
4. Trail overview/stats screen (dedicated screen before entering map viewer)

**P2 — Polish:**
5. Forward-bias in trail snapping for switchbacks
6. Smart zoom based on walking speed
7. GPS confidence degradation UI at >50m accuracy
8. Direction indicators (arrows) on trail polyline
9. Configurable GPS sampling frequency UI

### Checklist Results

- [x] All affected files identified — yes, all key files exist and are cross-referenced
- [x] Steps are in the right order — yes, tracks A/B parallelism is sound
- [x] Dependencies and prerequisites correct — `expo-location` used correctly throughout
- [x] Edge cases considered — GPS accuracy, offline, permission denial all addressed
- [x] Testing strategy sufficient — success criteria are measurable
- [x] No bugs introduced — accuracy circle, profile sync, dashboard all verified correct
- [x] No simpler alternatives — architecture choices (Skia, MapLibre, expo-location) are all appropriate
- [x] Won't break existing functionality — all new code, no regressions
