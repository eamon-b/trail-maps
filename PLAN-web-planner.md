# Implementation Plan: Web Planning Tool

## Summary

Add a day-by-day trip planning tool to the web app as a new page (`/trails/{id}-plan`) with a three-panel layout: a dual-mode left panel (Days / Stops tabs), a central area (Leaflet map above, elevation profile below), and a thin right datasheet showing the selected day's waypoints. Plans are persisted to localStorage (keyed by trail ID) with a name and optional start date. All planning calculations (day computing, resupply, water carry) are ported from the mobile app to shared `src/lib/` modules.

## Goals

- Users can build a day-by-day hiking plan on a large screen with the map always visible
- Adding/removing stops (overnight camps) is fast: click the waypoint in the Stops tab or on the map
- Selecting a day highlights its segment on the map, elevation profile, and shows its waypoints in the right panel
- Resupply gaps and water-carry dry stretches are visible alongside the day list
- Plan survives page refresh (localStorage); designed so future sharing/sync (e.g. send to phone) is straightforward
- Named plans with optional start date (shows day dates on cards)

## Current State

### Existing web infrastructure
- `src/web/trails/trail-template.html` — HTML template; build script inlines `TRAIL_DATA_PLACEHOLDER`
- `src/web/trails/trail-viewer.ts` — ~1 800 line TypeScript module (Leaflet map, elevation canvas, waypoint table)
- `scripts/build-trails.ts` — generates one static HTML per trail into `dist/` or `public/`
- `src/lib/types.ts` — shared `GpxPoint`, `ClassifiedTrack` etc.; web `Trail`/`Waypoint`/`TrackPoint` types live in trail-viewer.ts

### Mobile planning logic (to be ported)
- `mobile/src/services/day-calculator.ts` — `computeDays()` pure function
- `mobile/src/services/resupply-calculator.ts` — `computeResupply()`
- `mobile/src/services/water-carry-calculator.ts` — `computeWaterCarry()`
- `mobile/src/services/plan-calculator-types.ts` — `StopData`, `ComputedDay`
- All are pure TypeScript with no mobile / browser API dependencies → safe to move to `src/lib/`

### What does NOT yet exist
- Plan page template or viewer
- Shared planning types and calculators in `src/lib/`
- Plan localStorage adapter
- Three-panel CSS layout

---

## Implementation Steps

### Step 1: Port planning types and calculators to `src/lib/`

**Files to create:**
- `src/lib/plan-types.ts`
- `src/lib/day-calculator.ts`
- `src/lib/resupply-calculator.ts`
- `src/lib/water-carry-calculator.ts`

**Changes:**

`plan-types.ts` — Define shared interfaces that work with the web's existing `Trail` shape:
```typescript
export interface StopData {
  km: number;              // totalDistance position on trail
  waypointName: string;    // display name
}

export interface ComputedDay {
  dayNumber: number;
  date: string | null;     // ISO date if startDate set
  startName: string;
  endName: string;
  startKm: number;
  endKm: number;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours: number;
  waterSources: number;
}

export interface PlanState {
  name: string;
  startDate: string | null;   // ISO date
  stops: StopData[];           // sorted by km, excludes trail start/end (those are implicit)
}

export interface ResupplyGap {
  fromName: string;
  toName: string;
  distanceKm: number;
  estimatedDays: number;
  isLong: boolean;         // gap > 5 days at pace
}

export interface WaterGap {
  fromName: string;
  toName: string;
  distanceKm: number;
  isDryStretch: boolean;   // >= 15 km gap
}
```

`day-calculator.ts` — Port `computeDays()` from mobile. Accepts the web's `Trail` type (with `track.points: TrackPoint[]` and `waypoints: Waypoint[]`). Uses `haversineDistance` from `distance.ts`.

`resupply-calculator.ts` — Port `computeResupply()`. Filters waypoints by type `'town'` or `'food'`.

`water-carry-calculator.ts` — Port `computeWaterCarry()`. Filters waypoints by type `'water'` or `'water-tank'`.

**Adjustments needed during port:**
- Replace mobile `TrailWaypoint` references with the web `Waypoint` type (from trail-viewer.ts or types.ts)
- Replace mobile `TrackPoint` references with web `TrackPoint` (`{ lat, lon, ele, dist }`)
- Elevation calculation: use the same approach (`calculateElevationBetween()` iterating `track.points`)

**Tests:** Add unit tests in `src/lib/day-calculator.test.ts` etc., using the existing Vitest setup.

---

### Step 2: Extend the build script to generate plan pages

**File to modify:** `scripts/build-trails.ts`

**Changes:**
- After generating `{id}.html`, also generate `{id}-plan.html` from `plan-template.html`
- Inline the same `TRAIL_DATA_PLACEHOLDER` JSON blob (plan page loads identical trail data)
- The plan page will be bundled separately by Vite (new entry point in `vite.config.ts`)

**File to modify:** `vite.config.ts`
- Add `src/web/trails/plan-viewer.ts` as an additional Vite entry point

---

### Step 3: Create `src/web/trails/plan-template.html`

Three-panel CSS Grid layout:

```
+──────────────+────────────────────────────────+──────────────+
│ PLAN HEADER (trail name, plan name, start date, save status) │
+──────────────+────────────────────────────────+──────────────+
│              │                                │              │
│  Left panel  │         Leaflet map            │  Datasheet   │
│  300px fixed │         (flex 1)               │  220px fixed │
│              │                                │              │
│  [Days][Stop]│                                │              │
│  ─────────── │                                │              │
│  Day 1: …    │                                │ Day 2 detail │
│  Day 2: …  ← │                                │ ─────────── │
│  Day 3: …    │                                │ 📍 Waypoint  │
│              │                                │ 💧 Water     │
│              │                                │ 🏠 Hut       │
│              +────────────────────────────────+              │
│  ─────────── │    Elevation profile (canvas)  │              │
│  Resupply    │    Full trail grey + highlight  │              │
│  Water carry │                                │              │
+──────────────+────────────────────────────────+──────────────+
```

Key CSS:
- Outer container: `display: grid; grid-template-columns: 300px 1fr 220px; grid-template-rows: auto 1fr`
- Center column: `display: flex; flex-direction: column`
- Map: `flex: 1` (fills available vertical space)
- Elevation canvas: fixed height ~160px
- Left + right panels: `overflow-y: auto` with scroll

---

### Step 4: Create `src/web/trails/plan-viewer.ts`

Main module — wires everything together. Structure:

```typescript
// --- State ---
let trail: Trail;
let planState: PlanState;
let selectedDayIndex: number | null = null;

// --- Init ---
function init(trailData: Trail): void
function initMap(): void          // reuse trail-viewer patterns
function initElevation(): void
function loadOrCreatePlan(): void

// --- Rendering ---
function renderAll(): void
function renderDayList(): void
function renderStopList(): void
function renderResupplySection(): void
function renderWaterCarrySection(): void
function renderDayDatasheet(day: ComputedDay | null): void
function redrawMapLayers(): void
function redrawElevationProfile(): void

// --- Interaction ---
function selectDay(index: number | null): void
function toggleStop(km: number, name: string): void
function setStartDate(date: string): void
function setPlanName(name: string): void

// --- Persistence ---
function savePlan(): void
function loadPlan(): PlanState | null
```

**Map layer strategy (Leaflet):**
- `baseLayer`: Full trail polyline in muted grey (`#aaa`, weight 3, opacity 0.6)
- `dayLayer`: Per-day coloured polyline; when a day is selected, redraw only that day in blue (`#3b82f6`, weight 5); all other days stay grey
- `stopMarkers`: LayerGroup of overnight stop markers (custom flag icon or tent emoji)
- Waypoint markers: reuse existing marker logic, but clicking a waypoint in planning mode toggles it as a stop (instead of showing a popup)

**Elevation profile canvas strategy:**
- Draw full trail in light grey (same as current but desaturated)
- After full trail draw, overlay the selected day's segment in blue with slight transparency
- Reuse existing axis calculation / label logic from trail-viewer.ts

---

### Step 5: Left panel — Days tab

`renderDayList()`:
- For each `ComputedDay`:
  ```
  ┌─────────────────────────────────┐
  │ DAY 1  ·  Mon 3 Mar 2025        │
  │ Woolpack Inn → Mt Speculation   │
  │ 24.3 km  +1 240 m  -450 m  ~7h │
  │ 💧 3 water sources              │
  └─────────────────────────────────┘
  ```
- Click card → `selectDay(i)`
- Selected card gets highlight border/background
- "No stops added yet" empty state when stops list is empty

`renderResupplySection()` (below day cards):
- Collapsible section: "Resupply" header
- List: `Town A → Town B: 124 km (~6 days) ⚠️ LONG`

`renderWaterCarrySection()`:
- Collapsible section: "Water carry"
- List: `Last Creek → First Bore: 32 km 🔴 DRY STRETCH`

---

### Step 6: Left panel — Stops tab

`renderStopList()`:
- Search input (`<input type="text" placeholder="Filter waypoints…">`)
- Filtered list of all trail waypoints (sorted by km)
- Each row:
  ```
  ✓ 🏠  Mt Speculation Hut    124.3 km  (+23.4 km)
    💧  Speculation Creek     118.1 km  (+17.2 km)
    📍  Merrijig Creek        112.0 km  (+11.1 km)
  ```
  - Checkmark + accent bg = currently a stop
  - `(+X.X km)` gap from previous waypoint in the filtered list
- Click row → `toggleStop(km, name)`

---

### Step 7: Right panel — Day datasheet

`renderDayDatasheet(day)`:
- Header: "Day N — StartName → EndName"
- Sub-header: "X.X km · +Ym · ~Zh"
- Table of waypoints in that day's km range:
  ```
  Type  Name              km     Δkm
  📍    Woolpack Inn       101.0  start
  💧    Merrijig Creek     112.0  +11.0
  💧    Speculation Creek  118.1  +6.1
  🏠    Mt Speculation Hut 124.3  +6.2
  ```
- When no day selected: show all waypoints (same as existing datasheet)

---

### Step 8: Plan metadata header

A thin header bar above the three panels:
```
← Back to trail   [Plan name input field]   Start: [date input]   ✓ Saved
```

- "← Back to trail" links to `{id}.html`
- Plan name: `<input type="text">` — auto-saves on blur (debounced)
- Start date: `<input type="date">` — triggers day date recalculation
- Save status indicator: "Saved" / "Unsaved changes"

---

### Step 9: localStorage persistence

`src/web/trails/plan-state.ts`:

```typescript
const STORAGE_KEY = (trailId: string) => `trail-plan-${trailId}`;

export function loadPlanState(trailId: string): PlanState | null
export function savePlanState(trailId: string, state: PlanState): void
export function clearPlanState(trailId: string): void
```

State shape (JSON-serialisable):
```json
{
  "name": "My AAWT 2025 plan",
  "startDate": "2025-03-15",
  "stops": [
    { "km": 24.3, "waypointName": "Woolpack Inn" },
    { "km": 47.1, "waypointName": "Davies Plain Hut" }
  ]
}
```

Design note: The state shape is kept minimal and JSON-safe so that a future "share to phone" feature can encode it in a URL parameter or QR code with no changes to the structure.

---

### Step 10: Add link from trail viewer to plan page

**File to modify:** `src/web/trails/trail-template.html`

Add a "Plan this trail" button near the existing Export buttons, linking to `{id}-plan.html`.

**File to modify:** `scripts/build-trails.ts`

Ensure the relative link `{id}-plan.html` is correct in the output directory.

---

## File Map

| File | Action | Notes |
|------|--------|-------|
| `src/lib/plan-types.ts` | Create | Shared StopData, ComputedDay, PlanState |
| `src/lib/day-calculator.ts` | Create | Port from mobile |
| `src/lib/resupply-calculator.ts` | Create | Port from mobile |
| `src/lib/water-carry-calculator.ts` | Create | Port from mobile |
| `src/lib/day-calculator.test.ts` | Create | Unit tests |
| `src/lib/resupply-calculator.test.ts` | Create | Unit tests |
| `src/lib/water-carry-calculator.test.ts` | Create | Unit tests |
| `src/web/trails/plan-template.html` | Create | 3-panel layout HTML |
| `src/web/trails/plan-viewer.ts` | Create | Main planner module |
| `src/web/trails/plan-state.ts` | Create | localStorage adapter |
| `scripts/build-trails.ts` | Modify | Also generate `-plan.html` pages |
| `vite.config.ts` | Modify | Add plan-viewer.ts entry point |
| `src/web/trails/trail-template.html` | Modify | Add "Plan this trail" link |

---

## Testing Strategy

**Unit tests (Vitest):**
- `day-calculator.test.ts`: Test `computeDays()` with known stops and track points; verify distance, ascent, descent, water count, date calculation
- `resupply-calculator.test.ts`: Test gap calculation with town waypoints
- `water-carry-calculator.test.ts`: Test dry stretch detection at 15 km threshold

**Manual / visual testing:**
1. `npm run build:trails` — verify `{id}-plan.html` files are generated
2. `npm run dev` — open `/trails/aawt-plan` and verify 3-panel layout renders
3. Switch to Stops tab, search for a waypoint, click to add stop — verify day list updates
4. Select a day — verify map highlights segment, elevation highlights, datasheet updates
5. Set a start date — verify dates appear on day cards
6. Reload page — verify plan persists from localStorage
7. Resize browser window — verify layout doesn't break below ~1200px (add horizontal scroll or breakpoint message)

**Regression:**
- `npm test` must still pass (web unit tests unaffected by new files)

---

## Risks and Considerations

1. **TrackPoint type alignment**: The web's `TrackPoint` type is defined inside `trail-viewer.ts`, not exported from `src/lib/types.ts`. Before porting calculators, extract `TrackPoint` and `Waypoint` into `src/lib/types.ts` so they're importable by the new calculators.

2. **Large trail point arrays**: `track.points` for a long trail can be 100k+ points. The elevation-between calculation iterates all points in a day's range — for very long days this could be slow. The mobile solves this with `trackIndex` on waypoints (direct array slice). The web trail data also has `trackIndex` on waypoints, so use that to slice rather than searching by km.

3. **Elevation canvas resize**: The existing `drawElevationProfile()` in trail-viewer.ts listens to window resize. The plan page has a fixed-height canvas region — need to ensure it responds to layout changes (left/right panel visibility changes).

4. **Waypoint type string normalisation**: The mobile's waypoint type strings (`'water'`, `'town'`, `'hut'`, etc.) must match what the web's build script outputs in the JSON. Verify with an actual generated trail JSON file before writing the filter conditions.

5. **No backend / multi-device sync**: Plans are localStorage only. Do not over-engineer a sync mechanism in v1, but document the state shape clearly so it can be used as a payload for future sharing features (URL params, QR code, or backend API).

6. **Minimum screen width**: The 3-panel layout needs ~900px+ to be usable. Add a message or collapsed panels for smaller screens rather than a fully responsive design (out of scope for v1).

7. **Direction (NOBO/SOBO)**: The existing trail viewer already handles direction reversal with localStorage. The plan page should respect the same direction state, or include its own direction toggle, so stops are added in the correct direction order.
