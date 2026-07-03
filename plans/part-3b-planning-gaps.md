# Part 3b: Planning Tools — Remaining Gaps

Gaps identified from reviewing the Part 3 implementation against the original plan. Excludes drag-to-reorder (intentionally dropped — reordering campsites doesn't make sense since they're ordered by trail position).

## Code Quality Fixes (Do First)

### 1. Extract Duplicated Utilities

`generateId()` is copy-pasted 4 times and `migrateStopsJson()` is copy-pasted twice. Extract both to a shared module.

**Files to change:**
- Create `mobile/src/services/plan-utils.ts` with `generateId()` and `migrateStopsJson()`
- Update imports in: `mobile/src/services/plan-service.ts`, `mobile/app/plan/create.tsx`, `mobile/app/plan/[planId].tsx`, `mobile/app/plan/map.tsx`

### 2. Make use of Unused Components

`ClimateCard` and `WaterCountdown` are exported but never rendered. Integrate them.

- **`ClimateCard`**: The day card already renders climate data inline (DayPlanCard lines 183-187). `ClimateCard` appears to be a richer standalone version. Decide: use it inside `DayPlanCard` instead of raw text.
- **`WaterCountdown`**: A compact "Next water: X.X km" indicator. Integrate it into the day cards or the hike tab. Likely belongs in Part 5 (On-Trail Features) rather than here, if that is the case, make a note of this in that plan.

### 3. DayPlanCard Button Guards

`DayPlanCard` renders merge-up and split buttons unconditionally (lines 213-229). When `onMergeUp` or `onSplit` are undefined the buttons are visible but do nothing. Add this functionality on the carts that make sense (eg you cannot 'merge up' the first day).

**File:** `mobile/src/components/DayPlanCard.tsx` lines 213-229

---

## Feature Gaps

### 4. Remove Warning Thresholds

`PlanThresholds` defaults exist in `plan-calculator-types.ts` (30km distance, 10h time, 1 water source minimum) but there's no UI to change them.

The app should not be telling users that a day is too long, it is up to them to consider what is too long. Please remove this, it can be added at a later date if necessary.

### 5. Section Hiking — Map-Based Selection

The plan specifies "tap two points on map" to define a section. Currently only waypoint list and km entry are supported.

**What to build:**
- "Select on map" button in `SectionSelector` that navigates to a dedicated map screen
- Map screen with two-tap workflow: first tap sets start, second tap sets end
- Return selected km values to `SectionSelector`

**Files to change:**
- `mobile/src/components/SectionSelector.tsx` — add "Select on map" button
- Create `mobile/app/plan/section-map.tsx` — map screen for two-point selection
- Wire up navigation + param passing

### 6. Elevation Profile Integration

The elevation profile does not respond to section selection or show water source positions.

**What to build:**
- **Section scoping**: When a section is defined, the elevation profile should crop to that range
- **Water source overlay**: Show water source positions on the elevation profile as markers or vertical lines
- **Day segment highlighting**: When viewing a day on the map, highlight the corresponding segment on the elevation profile

**Files to change:**
- `mobile/src/components/ElevationProfile.tsx` — add `highlightRange`, `waterSources`, and `highlightedSegment` props
- `mobile/app/plan/[planId].tsx` or `mobile/app/trail/[id].tsx` — pass new props

### 7. Measure Tool — Map-Based Point Selection

The measure tool only supports selecting points from a waypoint list. The plan specifies map-based selection.

**What to build:**
- "Select on map" button next to each waypoint picker in the measure screen
- Navigate to a map screen, tap to select a point, return its km/name to the measure screen
- Could reuse the same pattern as section map selection (item 5)

**Files to change:**
- `mobile/app/plan/measure.tsx` — add "Select on map" buttons
- Reuse or extend `mobile/app/plan/section-map.tsx` for single-point selection mode

### 8. Measure Tool — Mini Elevation Profile

The measure result panel shows stats but not a mini elevation profile of the measured segment.

**What to build:**
- Small `ElevationProfile` rendered in the result panel showing just the measured segment
- Extract the elevation points between start/end km from trail data
- Render as a compact, non-interactive profile

**Files to change:**
- `mobile/app/plan/measure.tsx` — add `ElevationProfile` to result panel
- May need a `compact` or `mini` prop on `ElevationProfile` to reduce height/padding

---

## Lower Priority / Can Defer

### 9. Auto-Suggest Splitting Long Days

This feature is not desired. Mark it as such in the original plan.

### 10. Common Section Presets

For trails with well-known sections, offer preset section definitions.

**What to build:**
- Add optional `sections` array to trail.json metadata
- Show preset buttons in `SectionSelector` when available
- Tapping a preset fills in start/end km values

**Files to change:**
- Trail data: add `sections` to `data/trails/*/trail.json` where applicable
- `mobile/src/components/SectionSelector.tsx` — render preset buttons
- `mobile/src/lib/trail-utils.ts` — parse section presets from trail data

### 11. Plan Export — PDF Format

Currently only text and CSV export via the OS share sheet. No PDF generation.

**What to build:**
- Generate a PDF with plan summary, day-by-day breakdown, and climate data
- Use a library like `expo-print` or `react-native-html-to-pdf`
- Include a simple formatted layout (no need for fancy design)

**Files to change:**
- `mobile/src/services/plan-export.ts` — add `exportPlanAsPdf` function
- `mobile/app/plan/[planId].tsx` — add PDF option to export alert

---

## Implementation Order

1. **Items 1-3** (code quality) — quick wins, no user-facing risk
2. **Item 4** (thresholds UI) — small feature, completes existing functionality
3. **Items 5 + 7** (map-based selection) — can share a map selection component
4. **Item 6** (elevation profile) — visual polish, independent of other items
5. **Item 8** (mini elevation) — depends on item 6 pattern
6. **Items 9-11** (lower priority) — defer to after core gaps are filled
