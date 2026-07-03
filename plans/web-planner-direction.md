# Plan: Direction Support (NOBO / SOBO) for Web Trip Planner

## Problem

The web trip planner always displays the trail NOBO (start → end, km increasing). Hikers travelling
SOBO (end → start) see day cards in the wrong order, km labels counting the wrong way, and the Stops
tab sorted in the wrong direction.

Neither the trail viewer nor the plan page currently has any direction concept — so this is a
greenfield feature, not a sync problem.

---

## Goals

- Users can toggle NOBO / SOBO from the plan page header.
- Day cards, Stops tab, and the datasheet all flip to match the chosen direction.
- Map highlighting and elevation overlay remain correct (they operate on km positions regardless).
- Direction is persisted per-trail in `PlanState` (already saved to localStorage).
- No changes to the internal km representation in `PlanState.stops` — all stops are always stored
  as absolute km from the trail start (NOBO). The display layer is responsible for flipping.
- The existing calculator functions (`computeDays`, `analyzeResupply`, `analyzeWaterCarry`) are
  unchanged — they operate on NOBO km and produce NOBO-ordered results.

---

## Approach: Display-layer reversal

The simplest and most robust approach is to keep all internal data in NOBO km and only reverse
things in the display layer.

When direction is SOBO:

| Thing | How it changes |
|---|---|
| Day cards | Reversed order (Day 1 = last NOBO day, etc.) + "km from end" label |
| Stops tab | Sorted descending by km; gap labels show `(+X.X km)` counting from trail end |
| Datasheet | Rows sorted descending by km |
| Day numbering | `dayNumber = totalDays - i` |
| km display | `displayKm = totalDistance - absoluteKm` |
| Map | Unchanged (same polyline segments) |
| Elevation profile | Unchanged (still drawn NOBO — reversing would require horizontal flip, out of scope for v1) |

---

## Implementation Steps

### Step 1: Add `direction` to `PlanState`

**File:** `src/lib/plan-types.ts`

```typescript
export interface PlanState {
  name: string;
  startDate: string | null;
  stops: StopData[];
  direction?: 'nobo' | 'sobo';   // optional for backwards-compat; defaults to 'nobo'
}
```

`direction` is optional with no migration needed — existing saved plans without the field are
treated as NOBO.

---

### Step 2: Add direction toggle to plan header

**File:** `src/web/trails/plan-template.html`

Add a `<button>` to `#plan-header` between the date input and save status:

```html
<button id="direction-toggle" class="direction-btn" title="Toggle hiking direction">
  ↑ NOBO
</button>
```

CSS for `direction-btn`:

```css
.direction-btn {
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border-color, #ccc);
  border-radius: 4px;
  background: none;
  cursor: pointer;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary, #555);
  white-space: nowrap;
  transition: background 0.15s;
}
.direction-btn:hover { background: var(--bg-secondary, #f5f5f5); }
.direction-btn.sobo { color: #2563eb; border-color: #93c5fd; background: #eff6ff; }
```

---

### Step 3: Add direction state and helpers to `plan-viewer.ts`

**File:** `src/web/trails/plan-viewer.ts`

Add to state section:

```typescript
// Derived from planState.direction; updated by setDirection()
let isSobo = false;
```

Add helper:

```typescript
function displayKm(absoluteKm: number): number {
  return isSobo
    ? Math.round((trail.track.totalDistance - absoluteKm) * 10) / 10
    : Math.round(absoluteKm * 10) / 10;
}
```

Add interaction handler:

```typescript
function setDirection(dir: 'nobo' | 'sobo'): void {
  planState.direction = dir;
  isSobo = dir === 'sobo';
  const btn = document.getElementById('direction-toggle');
  if (btn) {
    btn.textContent = isSobo ? '↓ SOBO' : '↑ NOBO';
    btn.classList.toggle('sobo', isSobo);
  }
  // Deselect current day — index may no longer be valid after reversal
  selectedDayIndex = null;
  scheduleSave();
  renderAll();
}
```

Wire up in `initHeader()`:

```typescript
const dirBtn = document.getElementById('direction-toggle');
if (dirBtn) {
  isSobo = (planState.direction ?? 'nobo') === 'sobo';
  dirBtn.textContent = isSobo ? '↓ SOBO' : '↑ NOBO';
  dirBtn.classList.toggle('sobo', isSobo);
  dirBtn.addEventListener('click', () =>
    setDirection(isSobo ? 'nobo' : 'sobo')
  );
}
```

---

### Step 4: Update `renderDayList()` for SOBO

`computeDays()` always returns days in NOBO order (Day 1 first). When SOBO, reverse the array for
display and re-number:

```typescript
function renderDayList(): void {
  // ...existing code...
  const rawDays = currentDays;           // NOBO order from computeDays()
  const days = isSobo ? [...rawDays].reverse() : rawDays;
  const totalDays = days.length;

  container.innerHTML = days.map((day, i) => {
    const displayNumber = isSobo ? totalDays - i : day.dayNumber;
    // km labels:
    const startDisplay = `${displayKm(isSobo ? day.endKm : day.startKm).toFixed(1)} km`;
    const endDisplay   = `${displayKm(isSobo ? day.startKm : day.endKm).toFixed(1)} km`;
    // start/end names also flip:
    const startName = isSobo ? day.endName : day.startName;
    const endName   = isSobo ? day.startName : day.endName;
    // data-day-index uses the ORIGINAL currentDays index for selectDay()
    const originalIndex = isSobo ? totalDays - 1 - i : i;
    // ...rest of card template unchanged, using displayNumber/startName/endName...
  });
}
```

The `data-day-index` attribute must store the **original** `currentDays` index (not the reversed
display index), because `selectDay()` uses it to index into `currentDays` for map/elevation work.

---

### Step 5: Update `renderStopList()` for SOBO

Reverse the filtered waypoints list and update the gap calculation:

```typescript
function renderStopList(): void {
  let waypoints = (trail.waypoints ?? []).filter(/* existing filter */);
  if (isSobo) waypoints = [...waypoints].reverse();

  container.innerHTML = waypoints.map((wp, i) => {
    const km = wp.totalDistance ?? 0;
    // ...
    const prevWp = i > 0 ? waypoints[i - 1] : null;
    const prevKm = prevWp?.totalDistance ?? (isSobo ? trail.track.totalDistance : 0);
    const gap = i > 0 ? `+${Math.abs(km - prevKm).toFixed(1)}` : '';
    const displayKmLabel = displayKm(km).toFixed(1);
    // ...display displayKmLabel instead of km.toFixed(1)...
  });
}
```

---

### Step 6: Update `renderDayDatasheet()` for SOBO

Reverse the `inDay` waypoints array before rendering rows, and swap start/end:

```typescript
function renderDayDatasheet(day: ComputedDay | null): void {
  // ...
  if (day) {
    const startName = isSobo ? day.endName : day.startName;
    const endName   = isSobo ? day.startName : day.endName;
    const startKm   = isSobo ? day.endKm : day.startKm;
    const endKm     = isSobo ? day.startKm : day.endKm;

    let inDay = waypoints.filter(/* existing km range filter */);
    if (isSobo) inDay = [...inDay].reverse();
    // ...rest unchanged, using startName/endName/startKm/endKm...
  }
}
```

---

### Step 7: Update km display in `renderAll()` / `renderDayList()` empty state

The empty state message is direction-agnostic, so no change needed there. The "All waypoints" view
in the datasheet (when no day is selected) should also respect SOBO ordering — apply the same
`isSobo ? reverse() : identity` to the waypoints list.

---

## Testing Plan

**Unit tests** (no new tests needed for pure display logic, but add if `displayKm` becomes shared):

- `displayKm(0)` with SOBO and totalDistance=100 → 100
- `displayKm(100)` with SOBO and totalDistance=100 → 0
- `displayKm(40)` with SOBO and totalDistance=100 → 60

**Manual smoke test:**

1. Open a trail plan page, add 2 stops → see 3 NOBO day cards.
2. Click direction toggle → button shows "↓ SOBO", day cards reverse (Day 1 = last segment).
3. Day card km labels now count from trail end.
4. Click a day card → map highlights the correct segment (same polyline, different label).
5. Switch to Stops tab → waypoints listed from trail end to start.
6. Reload page → direction persists.
7. Toggle back to NOBO → layout restores to original.

---

## Out of Scope (v1)

- Elevation profile horizontal flip (canvas would need to draw km right-to-left; deferred).
- Syncing direction with the trail viewer (it doesn't have this feature yet either).
- Date calculation for SOBO starts (startDate would refer to Day 1 in SOBO order — the last NOBO
  day). This needs careful handling: when flipping, the date sequence reversal is implicit since the
  displayed Day 1 already has the last NOBO date. Currently `computeDays()` assigns dates in NOBO
  order, so the reversed display naturally shows SOBO dates correctly without any change.

---

## File Map

| File | Change |
|---|---|
| `src/lib/plan-types.ts` | Add optional `direction` field to `PlanState` |
| `src/web/trails/plan-template.html` | Add `#direction-toggle` button + CSS |
| `src/web/trails/plan-viewer.ts` | Add `isSobo`, `displayKm()`, `setDirection()`, update render functions |
