# Implementation Plan: Hours-Based (Naismith) Day Planning

## Summary

Replace the Plan screen's flat-ground **km/day target** with a **hours/day target** walked in
terrain-aware Naismith time. Today the splitter packs `pace × dailyHours` kilometres into each day
and only *afterwards* reports the honest Naismith estimate — so on steep trails the two diverge
badly (AAWT at "8 h / Average" produces 13–14 h days). After this change, the greedy splitter
accumulates Naismith time along the track and cuts the day when it reaches the hours target, so
day cards genuinely land near the hours the hiker asked for, on any terrain.

Decisions locked in with Eamon (2026-07-31):
1. **Hours replace the km target entirely** — no mode toggle. Inputs stay exactly as they are
   (daily hours stepper + pace control); only the splitting semantics change.
2. **Pace presets scale the Naismith base speed** — Slow 3 / Average 4 / Fast 5 km/h — applied in
   the **planner and the Hike-view ETAs** (next water / camp / town readouts).
3. **Resupply "≈ N days" and food weights derive from the actual computed plan** (effective
   km/day of the day splits), not from a flat-ground target.

## Current State (all post Phase-8 review fixes, 2026-07-31)

- `src/lib/day-calculator.ts:40` — `estimateHikingTime(distanceKm, ascentM, descentM)` hardcodes
  the 4 km/h base: `dist/4 + ascent/600 + max(0, (descent−300)/600)`, rounded to 0.1 h.
  `computeDays` (line ~100) calls it per day via `calculateElevationBetween`.
- `mobile/src/features/plan/plan-adapters.ts` — `generateDayStops(trail, section, targetKm)` is a
  km-space greedy splitter with three tuned knobs: `window = clamp(0.35·target, 3, 10)` km for
  camp snapping, `floor = max(3, 0.25·target)` km anti-sliver/final-day tolerance, and a
  balanced-midpoint case when `remaining ≤ 2·target`. `PACE_KMH = {slow: 3, average: 4, fast: 5}`
  currently means "flat-ground speed used to derive the km target" (`targetDailyKm = pace × hours`).
- `computePlan` passes `targetDailyKm` to `analyzeResupplyForSection` as `dailyKm`
  (→ `estimatedDays = ceil(gapKm / dailyKm)` → `foodCarryForGap`).
- `mobile/src/services/distance-calculator.ts:84` — Hike ETAs call `estimateHikingTime(...)` (fixed
  4 km/h); doc comment at line 38 states the formula.
- `mobile/src/features/plan/plan-inputs-store.ts` — per-trail `{dailyHours, pace}` persisted
  (zustand + AsyncStorage, `version: 1`). Defaults `8 h / average`.
- Track points: `{lat, lon, ele, dist}`; ~4 600 per trail after mobile optimization. Waypoints
  carry `totalDistance` in the direction-applied km space; everything downstream is already
  direction-safe.

## Key Design Decisions

1. **Time is computed from per-day cumulative segments, not per-point increments.** Naismith's
   descent term (`max(0, (descent − 300)/600)`) has a 300 m *per-day* allowance — it is not
   additive across sub-segments. The splitter therefore evaluates candidate boundaries by
   computing `hoursRaw(dayStartKm → candidateKm)` over the whole day segment each time. This is
   exactly the number `computeDays` will later report for that day, so splitter and day cards
   cannot disagree by construction.
2. **Prefix-sum time index for O(log n) segment queries.** Build once per `computePlan`:
   cumulative `ascent[]` / `descent[]` aligned to `track.points` (plus the existing `dist` field).
   `hoursRaw(a→b, baseKmh)` = interpolated lookups + the closed-form formula. Kills any
   performance concern (Heysen: ~120 boundaries × a handful of camp candidates, each O(log 4600)).
3. **Unrounded internal time.** `estimateHikingTime` keeps its public 0.1 h rounding (display
   contract, existing tests); the new internals use a raw variant so boundary search doesn't
   staircase. Both take an optional `baseKmh = 4` — default keeps every existing caller
   (web planner, old tests) byte-identical.
4. **Pace = Naismith base speed, nothing else.** `PACE_KMH` is renamed in meaning (constant can
   stay): Slow walks the same formula at 3 km/h flat-speed, Fast at 5. The hours target is used
   raw (`targetH = dailyHours`). "Average at 8 h on flat ground ≈ 32 km" still holds — the flat
   identity is preserved, steep terrain now shortens km instead of inflating hours.
5. **The Phase-8 splitter shape survives, translated into hours-space.** The three knobs become
   `windowH = clamp(0.35·targetH, 0.75, 2.5)` and `floorH = max(0.75, 0.25·targetH)` (the km
   values 3/10/3 at 4 km/h ≈ 0.75/2.5/0.75 h — same tuning, unit-converted), and the loop logic is
   identical with `remaining`/`target`/`window`/`floor` measured in hours:
   - stop when `remainingH ≤ targetH + floorH` (final day, `endKind: 'finish'`);
   - balanced midpoint when `remainingH ≤ 2·targetH` (boundary at `kmAtHours(lastKm, remainingH/2)`);
   - else full day at `kmAtHours(lastKm, targetH)`;
   - camp snap: candidates where `|hoursRaw(lastKm→camp) − boundaryTargetH| ≤ windowH`, rejecting
     camps with `hoursRaw(camp→endKm) < floorH`; nearest-in-time wins; else "Wild camp" at the
     naive km (rounded 0.1 km). `snappedKms`/`endKind` semantics unchanged.
6. **Resupply days from the realized plan.** `computePlan` computes
   `effectiveDailyKm = sectionKm / days.length` after `computeDays` and passes *that* to
   `analyzeResupplyForSection`. Fallback when `days.length === 0` (degenerate section):
   `baseKmh × dailyHours`. The shared calculator's API is untouched.
7. **Hike ETAs read the per-trail pace preference.** `distance-calculator` gains an optional
   `baseKmh` param threaded from its call sites, which read `selectPrefs(trailId).pace` →
   `PACE_KMH`. Users who never opened the planner keep the default Average = 4 km/h — zero
   behavior change until they express a pace. (`formatEtaMinutes`'s 5-minute snapping already
   absorbs small shifts.)
8. **Summary tile change**: "Target/day 32.0 km" becomes "Target/day **8 h**", and a derived
   "Avg/day **X km**" (sectionKm / days) replaces the flat-ground promise with the realized one.
   Day cards need no change — their Est. time will now sit near the target naturally. Keep a
   subtle "+2.1 h" style over-target hint on a day card only if snapping pushed it past
   `targetH + windowH` (should be rare by construction; cheap to render from existing fields).

## Implementation Steps

### Step 1 — Shared lib: parameterized Naismith + time index (`src/lib/day-calculator.ts`)
- `estimateHikingTime(distanceKm, ascentM, descentM, baseKmh = 4)` (rounded, public) and
  `estimateHikingHoursRaw(...)` (unrounded, exported for the splitter).
- New `buildTimeIndex(points: ElevationPoint[])` → prefix ascent/descent arrays;
  `hoursBetweenIndexed(index, fromKm, toKm, baseKmh)`; `kmAtHours(index, fromKm, targetHours,
  baseKmh)` (monotonic bisection on `hoursBetweenIndexed(fromKm, ·)`, linear-interpolated km,
  clamped to the section). Reuse `ElevationPoint` from `track-geometry`; keep the module
  browser-API-free (stays mobile-safe).
- `computeDays(trail, stops, startDate, section?, baseKmh = 4)` — thread the base into the per-day
  estimate. Optional trailing param keeps web/mobile callers source-compatible.
- Tests (`day-calculator.test.ts`): base-speed identities (8 h at 4 km/h flat = 32.0 km via
  `kmAtHours`; 3 vs 5 km/h scale), prefix index vs `calculateElevationBetween` agreement on random
  ranges, descent-allowance day-scoping (two half-segments ≠ naive sum), rounding-free monotonicity.

### Step 2 — Splitter rewrite in hours-space (`mobile/src/features/plan/plan-adapters.ts`)
- `PlanInputs` unchanged (startKm/endKm/dailyHours/pace/startName?/endName?).
- `generateDayStops(trail, section, targetHours, baseKmh)` per Decision 5, using the Step-1 index
  (build once in `computePlan`, pass it in).
- `computePlan`: `baseKmh = PACE_KMH[pace]`; call `computeDays(..., baseKmh)`; resupply per
  Decision 6; delete `targetDailyKm` from `PlanResult` in favor of `targetHours` +
  `effectiveDailyKm` (update `PlanResult` consumers).
- Port the Phase-8 invariant tests to hours-space and add the design-issue regression: with the
  real AAWT fixture at 8 h / average, **every** day's `estimatedHours ≤ targetH + windowH + 0.1`
  (this single assertion is the point of the whole change — it fails against today's code with
  days at 13–14 h). Keep: finish-state, sliver rejection, balanced final pair, camp-snap
  time-window, duplicate-km name preference, flat-trail equivalence with the old km behavior
  (regression anchor: on a flat synthetic trail old and new splits agree within 0.1 km).

### Step 3 — Plan screen summary (`mobile/app/guide/[trailId]/plan.tsx`)
- Summary tiles: Days · Distance · Est. time · **Target/day (hours)**; add/replace with
  "Avg/day X km" per Decision 8. `formatHours` already exists.
- Optional over-target hint on `DaySplitList` cards (only when `estimatedHours > targetH + windowH`).

### Step 4 — Hike ETAs pick up pace (`mobile/src/services/distance-calculator.ts` + call sites)
- Optional `baseKmh = 4` param on the ETA computation; update the line-38 doc comment.
- Call sites (grep `distance-calculator` imports — Hike dashboard / `useDistanceToNext` path):
  read `PACE_KMH[selectPrefs(trailId).pace]` from `plan-inputs-store`. Keep the store the single
  source of pace so planner and hike views can never disagree.
- Tests: existing distance-calculator tests extended for a non-default base.

### Step 5 — E2E verification (emulator)
- AAWT, 8 h / Average, full trail: day cards read ~7–9.5 h (was 13.1–14.7 h); day count rises
  (~22 → ~30); "🏁 Trail end" finish state intact; Heysen SOBO flip recomputes; Larapinta resupply
  legs show plan-derived day counts; pace flip Average→Slow *lengthens* each day's hours toward
  the same 8 h target while shortening km.
- Run `~/.maestro/bin/maestro test mobile/maestro/plan-screen.yaml` (selectors were chosen to
  survive this change — no km-number or footer-text assertions).

## File Map

| File | Action |
|------|--------|
| `src/lib/day-calculator.ts` | Modify: `baseKmh` params, raw variant, `buildTimeIndex` / `hoursBetweenIndexed` / `kmAtHours` |
| `src/lib/day-calculator.test.ts` | Extend |
| `mobile/src/features/plan/plan-adapters.ts` | Rewrite splitter in hours-space; `PlanResult` fields; resupply threading |
| `mobile/src/features/plan/__tests__/plan-adapters.test.ts` | Port invariants; AAWT hours-bound regression |
| `mobile/app/guide/[trailId]/plan.tsx` | Summary tiles; pass-through |
| `mobile/src/features/plan/DaySplitList.tsx` | Optional over-target hint |
| `mobile/src/services/distance-calculator.ts` (+ hike call sites) | Optional `baseKmh`, pace from plan-inputs-store |
| `mobile/src/features/plan/plan-inputs-store.ts` | No schema change (fields keep meaning); export a `paceBaseKmh` helper |

## Risks & Notes

1. **Feel change on flat trails: none by design** (flat identity preserved); on steep trails day
   *distances* shrink — that is the fix, but screenshot-compare AAWT/Cape to Cape before/after for
   the commit message.
2. **Splitter cost**: prefix index makes each candidate evaluation O(log n); a Heysen slow-pace
   plan (~150 days) recomputes in well under a frame budget on the JS thread; verify once with a
   `console.time` during E2E, then remove.
3. **Web planner untouched** (`computeDays` default base = 4, explicit stops, no auto-splitter).
   If the web planner later wants pace, the same `baseKmh` param is already there.
4. **Store**: `dailyHours`/`pace` keep their names and persisted values; no migration (meaning
   shift is behavioral, not schematic). `version` stays 1.
5. **Do not** re-tune `windowH`/`floorH` beyond the unit conversion in this change — one variable
   at a time; the Phase-8 fix tests pin the current shape.
