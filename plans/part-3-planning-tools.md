# Part 3: Planning Tools

## Goal
Build the comprehensive planning suite that makes this app invaluable for trip preparation. Includes the multi-day campsite planner (the "killer feature"), resupply planning, water carry calculations, and point-to-point measurement.

## Deliverables

### 1. Multi-Day Campsite Planner (Core Feature)
**Entry Point: "Add Campsites"**
- Bottom sheet listing all campsite/hut/accommodation waypoints in trail order
- Checkboxes to select overnight stops
- Search/filter by name
- Visual indicators for campsite features (water, shelter, etc.)

**Day Plan View**
- Day cards showing:
  - Day number and date
  - Start → End location
  - Distance, elevation gain/loss
  - Water source count
  - Estimated hiking time
  - Warnings (exceeds distance target, long dry stretch, etc.)
- Day card actions:
  - `[↑]` Merge with previous day (remove intermediate campsite)
  - `[↓]` Split day (insert intermediate campsite from popup list)
  - `[≡]` Drag to reorder
  - Swipe left to remove stop
- All stats update instantly on changes

**Integration**
- "Show on map" zooms to day's segment
- Highlights segment on both map and elevation profile
- Store multiple plans per trail (plans often change on-trail)

**Edge Case Handling**
- Long day warning: configurable threshold, default 30km
- "No campsite available" scenarios: allow custom stops
- Custom stops: long-press on map to create ad-hoc overnight location
- First/last day handling: clear UI for start point selection
- Impossibly long days: suggest splitting with available waypoints

### 2. Section Hiking Support
- Define start/end points for section hikes (not just thru-hikes)
- **Entry methods for defining section:**
  - Select start/end from waypoint list
  - Tap two points on map
  - Enter km markers directly
- Default to full trail; "Section" button reveals options
- Map and datasheet show only selected section
- All calculations (distance, elevation, waypoints) scoped to section
- Quick presets for common sections (if trail data includes them)

### 3. Resupply Distance Calculator
- Identify resupply waypoints (towns, stores) from waypoint classification
- Calculate distances between resupply points
- Account for off-trail detours to actual stores
- Food carry calculator:
  - Input: days of food, grams per day
  - Output: food weight, next resupply point
- Integrate with day planner: "I need to resupply by day X, which town?"

### 4. Water Carry Distances
- List water sources along trail with distances between them
- Highlight long dry stretches with warnings
- Seasonal availability notes where data exists
- Visual water distance overlay on elevation profile
- "Water source countdown" in planning view

### 5. Measure Between Two Points
**Entry methods:**
1. From waypoint list: tap waypoint → "Measure from here" → tap second
2. From map: long-press to drop pin → "Measure from here" → tap second point

**Result panel:**
- Along-trail distance
- Elevation gain and loss (separate)
- Net elevation change
- Mini elevation profile for segment
- Waypoints between the two points
- "Swap direction" button to flip ascent/descent

### 6. Climate/Weather Overview for Dates
- Use existing historical climate data for planning dates
- Monthly temperature ranges (min/avg/max)
- Precipitation averages
- Display alongside day plan

### 7. Plan Mode Dashboard
- Overview tab showing:
  - Trail summary stats
  - Current plan summary (total days, total distance)
  - Resupply points in plan
  - Long water carries flagged
- Quick access to edit plan, view full datasheet

### 8. Plan Data Model
Define and implement the schema for trip plans:

```typescript
interface TripPlan {
  id: string;
  trailId: string;
  name: string;
  direction: 'nobo' | 'sobo';
  startDate?: Date;
  section?: { startKm: number; endKm: number };
  stops: PlanStop[];
  createdAt: Date;
  updatedAt: Date;
}

interface PlanStop {
  waypointId: string | null;  // null for custom stops
  customLocation?: { lat: number; lon: number; name: string };
  nightNumber: number;  // 0 = start, 1 = first night, etc.
  notes?: string;
}
```

- Plan storage in local SQLite (uses Part 0 schema)
- Plan versioning for undo/redo support
- Plan export: shareable link, PDF, or printable format

## Success Criteria
- Can create a complete multi-day plan for any trail
- Day stats update instantly when modifying plan
- Multiple plans can be saved per trail
- Resupply points correctly identified with distances
- Water carry warnings appear for dry stretches
- Measure tool works from both map and waypoint list
- Section hiking shows correct scoped data

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation
- Part 2: Offline Trail Viewer (for map integration)

## Notes
- The campsite planner UX is critical - this is what differentiates from competitors
- Plan data must work offline (stored locally)
- Consider plan export (share with hiking partner, print, etc.)
- "Auto-Plan" with distance targets is explicitly noted as extension/v2 feature

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] All affected files identified
- [x] Steps in the right order
- [ ] Edge cases considered
- [x] Simpler alternatives considered (Auto-Plan deferred)
- [ ] Testing strategy

### This Is the Right Focus

The campsite planner as the "killer feature" is the correct call. FarOut and similar apps do this poorly. Getting this right is worth significant effort.

### Issues Found

1. **Section 7 ("I'm Here" Manual Location Ping) is misplaced**
   This is a communication/sharing feature, not a planning tool. It belongs in Part 7 (Trip Sharing) or Part 5 (On-Trail Features).

   **Move to Part 7** where it fits naturally with emergency contacts and progress sharing.

2. **Missing: Plan data schema**
   The plan describes features but not the data model. Define early:
   ```typescript
   interface TripPlan {
     id: string;
     trailId: string;
     name: string;
     direction: 'nobo' | 'sobo';
     startDate?: Date;
     section?: { startKm: number; endKm: number };
     stops: PlanStop[];
     createdAt: Date;
     updatedAt: Date;
   }

   interface PlanStop {
     waypointId: string;
     nightNumber: number; // 0 = start, 1 = first night, etc.
     notes?: string;
   }
   ```

3. **Campsite planner - edge cases not addressed**
   - What if selected campsites create a day that's impossibly long (>50km)?
   - What if there are no campsites between two points?
   - What if user wants to camp at a non-campsite location?
   - How to handle split/merge at plan boundaries (first/last day)?

4. **Section hiking - needs more detail**
   - How does the user define section start/end?
   - Tap on map? Select from waypoint list? Enter km markers?
   - Should default to full trail

5. **Water carry distances - data dependency**
   - Plan assumes water source data exists
   - Current trail data may not have complete water source info
   - Need fallback behavior when water data is incomplete

### Suggested Additions

**Add to Section 1 (Campsite Planner):**
```
**Edge case handling:**
- Long day warning threshold: configurable, default 30km
- "No campsite available" scenarios: allow custom stops
- Custom stops: drop pin on map to create ad-hoc overnight location
```

**Add new section:**
```
### 9. Plan Data Model
- Define schema for trip plans (see Review Notes)
- Plan storage in local SQLite
- Plan versioning/history for undo support
```

### Risks

1. **UX complexity**: The day card merge/split/drag interactions could be confusing. Needs user testing.

2. **Performance**: Recalculating all day stats on every edit could be slow for long trails with many stops. Consider debouncing or incremental updates.

### Dependencies Validation
Correctly identifies dependency on Part 2 for map integration. The plan data model should be part of Part 0's data architecture to avoid rework.
