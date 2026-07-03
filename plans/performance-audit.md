# Mobile App Performance Audit

_2026-03-05 — reviewed 2026-03-05_

## Overview

The app has good foundations — Reanimated for animations, Skia for chart rendering, proper memoization in many places. The issues below are ordered by effort-to-impact ratio. Findings that were incorrect or not worth fixing have been removed.

---

## 1. Waypoint Distances Calculated Twice Per GPS Tick

**Priority:** HIGH — easiest win, biggest per-tick savings
**Effort:** ~5 minutes
**File:** `mobile/app/(tabs)/hike.tsx:190-191`

```typescript
const next = getNextWaypointsByType(km, waypoints, trail.track.points);
const allDistances = calculateDistancesToWaypoints(km, waypoints, trail.track.points);
```

`getNextWaypointsByType()` internally calls `calculateDistancesToWaypoints()` (see `distance-calculator.ts:75`), then the same function is called again on the very next line. Each invocation iterates all upcoming waypoints and runs `calculateElevationBetween()` per waypoint — which itself does a linear scan through track points via `findNearestByDistance()`.

For 50 upcoming waypoints this doubles the per-tick work for no reason.

**Fix:** Call `calculateDistancesToWaypoints()` once, pass the result into a new `getNextWaypointsByType` overload that accepts pre-computed distances. Or restructure so `getNextWaypointsByType` returns both the typed-next map and the full distance array.

---

## 2. Elevation Profile Gesture Runs on JS Thread

**Priority:** HIGH — real gesture smoothness improvement
**Effort:** ~1 hour
**File:** `mobile/src/components/ElevationProfile.tsx:192-210`

Pan gesture calls `findNearestByDistance()` + `setCrosshair()` (setState) on every gesture frame. `findNearestByDistance` is a binary search over 500 sampled points (fast), but `setCrosshair` triggers a full React re-render of the Skia Canvas on every frame. At 60fps gesture input, this causes the JS thread to re-render the chart ~60 times/second.

```typescript
const panGesture = useMemo(() => {
  return Gesture.Pan()
    .onUpdate((e) => {
      // Runs on JS thread:
      const idx = findNearestByDistance(sampledPoints, km);
      setCrosshair({ x, km: ..., ele: ... }); // setState = full re-render
    });
}, [chartMetrics, sampledPoints]);
```

**Fix:** Use `useSharedValue` for crosshair x/km/ele. The binary search still needs `runOnJS`, but the crosshair line rendering should use Reanimated-aware Skia props so the visual update stays on the UI thread. The tooltip (React Native Text) can update via `runOnJS` at a throttled rate since it's less latency-sensitive than the crosshair line.

---

## 3. Map Bounds Debounce

**Priority:** MEDIUM — trivial fix
**Effort:** ~2 minutes
**File:** `mobile/src/components/TrailMap.tsx:365-393`

`handleRegionDidChange` fires on every completed pan/zoom and iterates sampled track points to find the visible km range. The computation itself is cheap (simple coordinate comparisons, not haversine), but it triggers `onVisibleBoundsChange` which propagates state changes to the ElevationProfile visible range highlight. No debounce means rapid successive pans queue up unnecessary state updates.

```typescript
const handleRegionDidChange = useCallback(async () => {
  const bounds = await mapRef.current.getVisibleBounds();
  const step = Math.max(1, Math.floor(trackPoints.length / 200));
  for (let i = 0; i < trackPoints.length; i += step) {
    // ... check if point in bounds
  }
  onVisibleBoundsChange(minKm, maxKm);
}, [onVisibleBoundsChange, trackPoints]);
```

**Fix:** Debounce by 150ms. Two lines — wrap the callback body or use a ref-based debounce.

---

## 4. Location Snapping Haversine Calls

**Priority:** MEDIUM — moderate improvement, more effort
**Effort:** ~30 minutes
**File:** `mobile/src/hooks/useLocation.ts:70-104`

Coarse-then-refine search over track points. For AAWT with ~5,000 points: coarse pass samples every 10th point (~500 haversine calls), refinement pass checks ~20 neighbors. Total ~520 haversine calls per GPS tick — each is pure math with no allocations, taking roughly 0.5ms on a mid-range device.

This is functional but wasteful. The hiker moves slowly; consecutive snaps will be near each other.

**Fix options (pick one):**
- **Spatial grid index** — bucket points by lat/lon cell at trail load time. Snapping becomes O(1) cell lookup + ~10 distance checks. Most correct fix.
- **Start-from-last** — cache the last snapped index and search a small window around it (±50 points). Falls back to full scan if the window misses. Simpler, handles 99% of cases.

Also: add a distance threshold — skip re-snapping if the GPS position hasn't moved more than ~10m from the last reading.

---

## 5. Inline Style Objects in MapLibre Layers

**Priority:** MEDIUM — trivial fix, many instances
**Effort:** ~10 minutes
**File:** `mobile/src/components/TrailMap.tsx:427+`

MapLibre layer styles are inline objects recreated every render. MapLibre diffs them internally, but creating and diffing ~10 style objects per render is unnecessary overhead. There are 8+ layer style objects in TrailMap alone.

```typescript
<MapLibreGL.LineLayer
  id="trail-line-layer"
  style={{
    lineColor: '#e53935',
    lineWidth: 3,
    lineOpacity: 0.9,
    lineCap: 'round',
    lineJoin: 'round',
  }}
/>
```

**Fix:** Extract to module-level `const` objects. For styles that depend on theme colors or `focusedWaypointId`, use `useMemo`.

---

## 6. FlatList Missing Optimization Props

**Priority:** MEDIUM — matters on full waypoint list screen
**Effort:** ~15 minutes
**File:** `mobile/src/components/WaypointList.tsx:112-119`

```typescript
<FlatList
  ref={listRef}
  data={displayWaypoints}
  keyExtractor={(item) => String(item.id)}
  renderItem={renderItem}
  scrollEnabled={!maxItems}
  onScrollToIndexFailed={() => {}}
/>
```

Missing: `getItemLayout`, `removeClippedSubviews`, `maxToRenderPerBatch`, `initialNumToRender`, `windowSize`.

**Context:** On the hike dashboard, `maxItems` caps the list at 8 items — these props don't matter there. But on the trail viewer's full waypoint list (100+ items for trails like Bibbulmun), the lack of `getItemLayout` means `scrollToIndex` can fail (hence the no-op `onScrollToIndexFailed`) and initial render materializes all rows.

**Fix:** Add `getItemLayout` (rows have fixed height via `minHeight: touchTarget.min`), `removeClippedSubviews={true}`, and `initialNumToRender={15}`. The `onScrollToIndexFailed` no-op should be replaced with a `scrollToOffset` fallback.

---

## 7. TrailDataContext Value Not Memoized

**Priority:** MEDIUM
**Effort:** ~5 minutes
**File:** `mobile/src/contexts/TrailDataContext.tsx:75`

The context provider passes an inline object as `value`, meaning every state change (including `loading` toggling) triggers re-renders in all consumers — even those that only read `trail`.

```typescript
<TrailDataContext.Provider value={{ trail, dbTrail, loading, error, loadTrail, reloadTrail }}>
```

Note: `FocusedWaypointContext` is already properly memoized with `useMemo` (line 23-26), so it does not have this issue.

**Fix:** Wrap the value in `useMemo` with the correct deps. If `loading` re-renders are still noisy, split into a data context and a loading-status context.

---

## 8. App Startup Sequential DB Inserts (First Launch Only)

**Priority:** LOW-MEDIUM — only affects first launch or data version bumps
**Effort:** ~20 minutes
**Files:** `mobile/src/services/trail-data-service.ts:122-131`, `mobile/src/services/trail-loader.ts:57-112`

`storeWaypoints()` inserts waypoints one at a time in a loop:

```typescript
for (const wp of waypoints) {
  await this.db.runAsync(
    `INSERT INTO waypoints (...) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [...]
  );
}
```

The audit originally rated this CRITICAL, but `trail-loader.ts:67-68` already checks `if (existing && existing.dataVersion === bundledVersion) continue` — so trails are skipped entirely after the first successful import. The 600+ sequential inserts only happen on first launch or when `dataVersion` changes in a data update.

**Fix:** Wrap the loop in `await this.db.execAsync('BEGIN')` / `COMMIT` — transactions turn 100 individual disk syncs into one. For further improvement, batch into multi-row INSERTs (SQLite supports up to 500 values per statement).

---

## 9. Plan Tab Loads Plans Sequentially

**Priority:** LOW — only 6 trails currently
**Effort:** ~10 minutes
**File:** `mobile/app/(tabs)/plan.tsx:77-82`

```typescript
for (const trail of list) {
  const trailPlans = await planService.listPlansForTrail(trail.id);
  // ...
}
```

Sequential `await` in a loop. With 6 bundled trails this is 6 sequential DB round-trips. The audit claimed 20 trails, but that's only possible with many custom imports.

**Fix:** Single SQL query: `SELECT * FROM plans ORDER BY trail_id` and group in JS. This eliminates all per-trail round-trips regardless of trail count.

---

## 10. 350ms setTimeout for Bottom Sheet Conflicts

**Priority:** LOW — UX polish
**Effort:** ~30 minutes
**File:** `mobile/app/trail/[id].tsx:155-171`

Two `@gorhom/bottom-sheet` instances on the trail viewer screen suppress each other's animations. Current workaround:

```typescript
setTimeout(() => {
  elevationDrawerRef.current?.expand();
}, 350); // "ensure the WaypointDetailSheet's BottomSheet has fully unmounted"
```

**Fix:** Use a single bottom sheet with swappable content, or a state machine that serializes transitions (dismiss sheet A → wait for `onClose` callback → expand sheet B).

---

## Lower Priority

| Issue | Location | Notes |
|-------|----------|-------|
| Zoom snaps to 14 when following user | `TrailMap.tsx:289-296` | Ignores current zoom level; should preserve it |
| `onScrollToIndexFailed` is a no-op | `WaypointList.tsx:118` | Waypoint focus silently fails — use `scrollToOffset` fallback |
| No debounce on `onMapPan` callback | `TrailMap.tsx:406` | Accidental touch disables follow mode |
| Missing `React.memo` on list items | `DayPlanCard`, `ResupplyList` | Parent re-renders cause all items to re-render |
| No skeleton for trail viewer | `trail/[id].tsx:174-181` | Just a spinner, no layout skeleton |
| Glyph provisioning checks 256 files | `tile-service.ts:57-103` | Runs on every trail view |

---

## Removed Findings

These were in the original audit but are incorrect or not worth fixing:

- **"Three state updates per GPS tick, no batching"** — React 18 automatically batches all `setState` calls inside callbacks, including `useCallback`. The three calls in `handleLocationUpdate` (`useLocation.ts:106-110`) already produce a single re-render. No fix needed.
- **"Plan recalculation is all-or-nothing"** — The `computeDays` / `analyzeWaterCarry` / `analyzeResupply` calls are already wrapped in `useMemo` with correct deps (`[trail, stops, plan?.startDate, section]`). They only recompute when stops actually change, not on every keystroke. Already optimized.
- **"FocusedWaypointContext causes unnecessary re-renders"** — The context value is already wrapped in `useMemo` (line 23-26) and only changes when `focusedWaypointId` changes. All consumers *should* re-render when focus changes — that's the intended cross-view sync behavior.
- **"No global trail cache"** — `TrailDataContext` caches via `loadedIdRef` and skips re-loading if the ID matches. The hike screen loads independently but only on tab focus. The actual redundancy depends on navigation patterns and isn't a clear win without measuring.
