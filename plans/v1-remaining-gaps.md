# v1.0 Remaining Gaps & Polish

Gaps identified from end-to-end review of the full v1.0 implementation (Parts 0-4 + 5a) against the original plans.

---

## Pre-Release (P0)

### 1. ~~React Error Boundary Around TrailMap~~ MOSTLY DONE

MapLibre can crash on invalid GeoJSON or out-of-memory with large tile sets. Currently a map crash takes down the entire app.

**Status:** `MapErrorBoundary.tsx` already exists with full retry UI. `trail/[id].tsx` is already wrapped. Only `plan/map.tsx` and `plan/section-map.tsx` still need wrapping. `measure.tsx` does NOT render TrailMap (uses ElevationProfile only), so no change needed there.

**Remaining work:**
- `mobile/app/plan/map.tsx` — wrap `TrailMap` in `MapErrorBoundary`
- `mobile/app/plan/section-map.tsx` — wrap `TrailMap` in `MapErrorBoundary`

### 2. ~~Alert Threshold Configuration UI~~ DONE

**Status:** Fully implemented. `mobile/app/settings.tsx` has an "OFF-TRAIL ALERT SENSITIVITY" section with Tight/Normal/Loose options, persisted to AsyncStorage key `trail-companion:alertThreshold`. The hike tab loads the saved preference on focus. No remaining work.

### 3. Background Location Tracking — PARTIALLY DONE

`location-service.ts` has background tracking code (`startBackgroundTracking()`) but the hike tab only uses foreground tracking. GPS stops when the user locks their phone while walking — a critical gap for a hiking app.

**Status:** All infrastructure is in place:
- `expo-task-manager` already installed (v14.0.9)
- `app.json` already declares iOS `UIBackgroundModes: ["location"]` and Android `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_LOCATION` permissions
- `location-service.ts` has `startBackgroundTracking()` / `stopBackgroundTracking()` with persistent notification
- `useLocation.ts` accepts a `background` option and handles the full lifecycle

**Remaining work (small):**
- `mobile/app/(tabs)/hike.tsx` — pass `background: true` to `useLocation()` when tracking is active
- Consider adding a user toggle (settings or hike tab) to opt in/out of background tracking
- **Testing concern:** Background location requires a real device or emulator with location simulation. Add a Maestro flow or manual test checklist for: lock phone → walk → unlock → verify position updated.

---

## Post-Release (P1)

### 4. Trail Data Versioning — MOSTLY DONE

**Status:** Core versioning logic is implemented:
- `mobile/assets/trails/index.json` already has `dataVersion` per trail (e.g. `"2026-02-23"`)
- `trail-loader.ts` compares bundled vs stored `dataVersion` and skips re-import when versions match

**Remaining work (UI only):**
- `mobile/app/trail/overview.tsx` — show "Last updated" timestamp (data is available, just not displayed)
- Optional: show "Trail data updated" toast after a version-triggered re-import (nice-to-have)

### 5. ~~Measure Tool Mini Elevation Profile~~ DONE

**Status:** Fully implemented. `measure.tsx` renders a compact `ElevationProfile` in the result panel with `segmentTrackPoints` and `segmentWaterKms`. `ElevationProfile` already has a `compact` prop (100pt height). No remaining work.

### 6. Water Source Overlay on Elevation Profile — MOSTLY DONE

**Status:** Core rendering is implemented:
- `ElevationProfile` accepts `waterSourceKms` prop and renders blue dots at water positions
- `measure.tsx` passes `segmentWaterKms` correctly

**Remaining work:**
- Verify `mobile/app/plan/[planId].tsx` passes `waterSourceKms` to `ElevationProfile` in `DayPlanCard` — may need wiring
- Verify `mobile/app/trail/[id].tsx` passes water waypoints to profile

---

## Polish (P2)

### 7. Forward-Biased Trail Snapping

`useLocation.ts` uses a coarse-then-fine nearest-point algorithm but doesn't track movement history or apply directional bias. On trails with switchbacks or parallel sections, this could snap to the wrong segment.

**What to build:**
- Track recent movement direction (last 3-5 GPS readings)
- When multiple trail points are equidistant, prefer the one in the forward direction
- Use recent km positions to determine "forward" vs "backward"

**Files to change:**
- `mobile/src/hooks/useLocation.ts` — add movement history and directional bias to snapping

### 8. Smart Zoom Based on Walking Speed

Map zoom is fixed at level 14. Could adapt based on context — zoom out when moving fast (road walk), zoom in when stationary or in complex terrain.

**What to build:**
- Calculate speed from recent GPS readings
- Adjust zoom: 13 when speed >5km/h, 14 default, 15 when stationary
- Smooth transitions between zoom levels

**Files to change:**
- `mobile/app/trail/[id].tsx` — dynamic zoom in auto-follow mode

### 9. Direction Indicators on Trail Polyline

The trail polyline renders as a solid line without directional indicators. Arrows along the line would show hiking direction at a glance.

**What to build:**
- Add arrow symbols along the trail polyline at regular intervals
- Use MapLibre `symbol-placement: line` with a small arrow icon
- Respect current direction (NOBO/SOBO)

**Files to change:**
- `mobile/src/components/TrailMap.tsx` — add symbol layer for direction arrows

### 12. Snooze State Persistence

Off-trail alert snooze state (`snoozeUntil`) is in-memory only. If the user closes and reopens the app during a snooze period, the snooze is lost.

**What to build:**
- Persist snooze expiration to AsyncStorage when snooze is activated
- On app launch / hike tab focus, check if a snooze is still active
- Clear expired snoozes on load

**Files to change:**
- `mobile/src/hooks/useOffTrailAlert.ts` — add AsyncStorage read/write for snooze state

### 14. Document displayPoints vs points Distinction

`TrailMap` receives `displayPoints` (Douglas-Peucker simplified) while `ElevationProfile` gets `trackPoints` (full resolution). This is architecturally correct but undocumented.

**What to do:**
- Add a comment block in `trail-utils.ts` or `types.ts` explaining:
  - `displayPoints`: simplified for map rendering performance (~5000 points)
  - `trackPoints`: full resolution for elevation profile accuracy and distance calculations
  - Why they differ and when to use each

**Files to change:**
- `mobile/src/lib/trail-utils.ts` — add documentation comment

---

## Implementation Order (Updated)

1. **P0 remaining** — do before release:
   - Item 1: Wrap `plan/map.tsx` and `plan/section-map.tsx` in `MapErrorBoundary` (~15 min)
   - Item 3: Pass `background: true` to `useLocation()` in hike tab + add user toggle (~1 hr)
2. **P1 remaining** — first post-release update:
   - Item 4: Add "Last updated" display in trail overview (~30 min)
   - Item 6: Verify/wire water sources in plan editor and trail viewer (~30 min)
3. **P2 items 7-9, 12, 14** — polish when time permits (all still TODO)

---

## Review Notes

**Reviewed:** 2026-03-03

### Summary

Of the 11 items in this plan, **3 are fully complete**, **4 are partially done** (infrastructure exists, just needs wiring/UI), and **4 are genuinely not started**. The actual remaining work is significantly less than the plan suggests.

### Items Already Complete (remove from backlog)
| Item | Status |
|------|--------|
| 2. Alert Threshold UI | Fully implemented in `settings.tsx` with persistence |
| 5. Measure Mini Profile | Compact `ElevationProfile` renders in measure results |
| 6. Water Overlay (core) | `ElevationProfile` renders blue dots for water sources |

### Items Partially Done (reduced scope)
| Item | What's Left |
|------|------------|
| 1. Error Boundary | Only `plan/map.tsx` and `plan/section-map.tsx` need wrapping |
| 3. Background Location | Pass `background: true` in hike tab; all infrastructure exists |
| 4. Data Versioning | "Last updated" UI in overview screen; version logic works |
| 6. Water Overlay (integration) | May need wiring in plan editor `DayPlanCard` |

### Items Not Started (accurate as written)
| Item | Notes |
|------|-------|
| 7. Forward-Biased Snapping | Correct — useLocation.ts has no movement history |
| 8. Smart Zoom | Correct — zoom is static |
| 9. Direction Arrows | Correct — no symbol layer exists |
| 12. Snooze Persistence | Correct — in-memory only |
| 14. displayPoints Documentation | Correct — no comments exist |

### Numbering Gap
Items 10, 11, 13 are missing from the plan (likely removed in earlier editing). The numbering jumps from 9 to 12 to 14. Consider renumbering for clarity.

### Risks / Concerns
- **Background location (item 3):** This is the only P0 item with real complexity. Enabling `background: true` is a one-line change, but the UX around it matters — battery drain warning, user consent, toggle placement. Consider whether this should be opt-in (settings toggle) vs always-on.
- **Forward snapping (item 7):** The plan is light on edge cases. What happens when a hiker backtracks intentionally (forgot something at camp)? The directional bias should have a fallback or cooldown period. Consider tracking confidence/speed to decide when to apply bias.
- **Smart zoom (item 8):** Needs hysteresis to avoid zoom flickering when speed oscillates around the threshold. The plan should specify a minimum duration at a speed before changing zoom (e.g. 30 seconds at >5km/h before zooming out).
