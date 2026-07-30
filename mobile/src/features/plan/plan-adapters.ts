/**
 * Plan adapters — turn a direction-applied guide trail + the hiker's inputs
 * into the shapes the shared @lib calculators consume, then collect their
 * outputs into one read-only "plan" result.
 *
 * The whole point of Phase 8: reuse the shared calculators, don't reimplement
 * them. The guide's `TrailJson` is already structurally compatible with the
 * calculators' `PlanTrail` / `PlanWaypoint` / `PlanTrackPoint` params
 * (config.name, track.points{lat,lon,ele,dist}, track.totalDistance,
 * waypoints{name,type,totalDistance,description}), so conversion is near-zero
 * — this module is mostly the day-boundary generation the calculators do NOT
 * do (computeDays splits at explicit stops; it has no auto-splitter) plus the
 * camp-snapping the guide adds on top.
 *
 * Pure + React-free so every derivation is unit-testable.
 */

import {
  computeDays,
  buildTimeIndex,
  hoursBetweenIndexed,
  kmAtHours,
  type PlanTrail,
  type PlanStopInput,
  type TimeIndex,
} from '@lib/day-calculator';
import {
  analyzeResupplyForSection,
  foodCarryForGap,
  type ResupplyAnalysis,
  type FoodCarryEstimate,
} from '@lib/resupply-calculator';
import {
  analyzeWaterCarryForSection,
  DEFAULT_DRY_STRETCH_KM,
  type WaterCarryAnalysis,
} from '@lib/water-carry-calculator';
import type { SectionConfig, ComputedDay, ResupplyGap, WaterGap } from '@lib/plan-types';
import type { TrailJson } from '../../services/trail-assets';
import { categoryToken } from '../elevation/waypoint-category';

/** Pace preset. Maps to a flat-ground walking speed (km/h). */
export type Pace = 'slow' | 'average' | 'fast';

/**
 * Flat-ground base walking speed (km/h) per pace preset. This is the Naismith
 * base speed threaded into `estimateHikingTime` / the time index: Slow walks the
 * same terrain-aware formula at 3 km/h flat-speed, Fast at 5. The daily target is
 * expressed in *hours* (used raw), so pace shortens/lengthens the km a day covers
 * without inflating its hours. 'average' == 4 preserves the identity "flat day
 * hours ≈ your daily hours" (8 h flat ≈ 32 km).
 */
export const PACE_KMH: Record<Pace, number> = {
  slow: 3,
  average: 4,
  fast: 5,
};

/** The hiker's live inputs for the plan screen. */
export interface PlanInputs {
  /** Section start position (km, direction-applied space). */
  startKm: number;
  /** Section end position (km, direction-applied space). */
  endKm: number;
  /** Target daily hiking hours. */
  dailyHours: number;
  /** Pace preset. */
  pace: Pace;
  /**
   * Optional display name for the section start. When set, it is preferred over
   * `nameAtKm(startKm)` — this lets the caller resolve duplicate-km waypoints by
   * its own choice (the screen picks a specific WaypointOption, which nameAtKm
   * cannot reproduce because it resolves by array order). Falls back to nameAtKm.
   */
  startName?: string;
  /** Optional display name for the section end (see `startName`). */
  endName?: string;
}

/**
 * How a day's end boundary was resolved:
 *  - `camp`   — snapped to a real campsite/shelter waypoint (interior day).
 *  - `wild`   — no camp in range; a wild camp at the naive target km.
 *  - `finish` — the section end itself (the last day). Neither camp nor wild:
 *    it lands on whatever the section ends at (town, hut, trailhead, …).
 */
export type DayEndKind = 'camp' | 'wild' | 'finish';

/** A day card: the calculator's ComputedDay plus how its end boundary resolved. */
export interface PlanDay extends ComputedDay {
  /**
   * True when the day boundary landed on a real campsite/shelter waypoint.
   * Retained for compatibility; prefer `endKind` for display (it distinguishes
   * the section finish from a wild camp).
   */
  snappedToCamp: boolean;
  /** Three-state end resolution — the UI should key off this, not the boolean. */
  endKind: DayEndKind;
}

/** The full read-only plan derived from inputs. */
export interface PlanResult {
  section: SectionConfig;
  /** The hiker's daily hiking-hours target (used raw by the splitter). */
  targetHours: number;
  /**
   * Realized average km/day of the computed split (`sectionKm / days.length`).
   * Drives resupply "≈ N days" and food weights so they reflect the actual plan,
   * not a flat-ground promise. Falls back to `baseKmh × dailyHours` for a
   * degenerate section that produced no days.
   */
  effectiveDailyKm: number;
  days: PlanDay[];
  resupply: ResupplyAnalysis;
  /** Resupply gaps paired with their food-carry weight estimate. */
  foodCarries: { gap: ResupplyGap; food: FoodCarryEstimate }[];
  water: WaterCarryAnalysis;
  /** Longest water carries in the section, biggest first (top N). */
  topWaterCarries: WaterGap[];
}

/** A pickable section boundary (a waypoint). */
export interface WaypointOption {
  id: string;
  name: string;
  km: number;
  type: string;
}

/**
 * Waypoints suitable as an overnight day-end: the camp + shelter families
 * (campsite/hut/etc.), in km order. Used only for snapping day boundaries —
 * the guide's own semantic grouping, wider than the resupply/water calculators'
 * narrow type sets.
 */
export function overnightWaypoints(trail: TrailJson): WaypointOption[] {
  return trail.waypoints
    .filter((wp) => {
      const token = categoryToken(wp.type);
      return token === 'waypointCamp' || token === 'waypointShelter';
    })
    .map(toOption)
    .sort((a, b) => a.km - b.km);
}

/** All waypoints as ordered pick options for the section steppers. */
export function waypointOptions(trail: TrailJson): WaypointOption[] {
  return trail.waypoints.map(toOption).sort((a, b) => a.km - b.km);
}

function toOption(wp: TrailJson['waypoints'][number], i: number): WaypointOption {
  return {
    id: wp.id ?? `wp_${i}_${Math.round((wp.totalDistance ?? 0) * 1000)}`,
    name: wp.name,
    km: wp.totalDistance ?? 0,
    type: wp.type,
  };
}

/** The default full-trail section (first → last, whole track). */
export function fullTrailSection(trail: TrailJson): SectionConfig {
  const opts = waypointOptions(trail);
  const startName = opts[0]?.name ?? `${trail.config.name} Start`;
  const endName = opts[opts.length - 1]?.name ?? `${trail.config.name} End`;
  return { startKm: 0, endKm: trail.track.totalDistance, startName, endName };
}

/** Build a SectionConfig from two chosen waypoint options. */
export function sectionFromWaypoints(start: WaypointOption, end: WaypointOption): SectionConfig {
  return { startKm: start.km, endKm: end.km, startName: start.name, endName: end.name };
}

/**
 * Camp-snap time window (± hours) around a day's naive boundary, as a function
 * of the daily hours target: `clamp(0.35 · targetHours, 0.75, 2.5)`. Exported so
 * the plan screen can render the over-target hint against the exact same bound
 * the splitter snaps within — one formula, one source of truth (Decision 8).
 */
export function planWindowHours(targetHours: number): number {
  return Math.min(2.5, Math.max(0.75, 0.35 * targetHours));
}

/**
 * The splitter's final-day tolerance: the remainder is absorbed into the last
 * day while it stays within `targetHours + planFloorHours(targetHours)`, and no
 * final day is left shorter than this. Exported for the same reason as
 * `planWindowHours` — the over-target hint must judge the final day against the
 * allowance the splitter actually grants it (which exceeds the snap window once
 * targetHours > 10).
 */
export function planFloorHours(targetHours: number): number {
  return Math.max(0.75, 0.25 * targetHours);
}

/**
 * Generate the interior overnight-stop boundaries for a section, greedily
 * walking `targetHours` of terrain-aware Naismith time at a time and snapping
 * each boundary to the nearest camp/shelter waypoint within a time window.
 *
 * The shared `computeDays` does NOT auto-split — it only splits at the explicit
 * stops it is handed. This function IS that auto-splitter, plus the snapping
 * the calculator has no concept of. It is the Phase-8 km-space splitter with the
 * exact same shape, translated 1:1 into hours-space (Decision 5): the three
 * knobs are unit-converted (the km values 3/10/3 at 4 km/h ≈ 0.75/2.5/0.75 h)
 * and every `remaining`/`target`/`window`/`floor` comparison is now in hours.
 *
 *  - `windowH` = clamp(targetH * 0.35, 0.75, 2.5): how far in time either side of
 *                the naive target a boundary may snap to a camp/shelter.
 *  - `floorH`  = max(0.75, 0.25 * targetH): a day may run up to `targetH + floorH`
 *                and no final day is left shorter than `floorH`.
 *
 *  Time is always measured over whole segments (`hoursBetweenIndexed`), never
 *  summed across increments, because Naismith's descent allowance is per-day
 *  scoped — so this matches exactly what `computeDays` will later report.
 *
 *  Each iteration looks at the hours still remaining to the section end:
 *   1. If `remainingH <= targetH + floorH`, the rest is one acceptable final day
 *      — stop. 2. Else if `remainingH <= 2 * targetH`, place ONE balanced
 *      boundary at the time-midpoint. 3. Else take a full `targetH`-length day.
 *
 *  The boundary km comes from `kmAtHours(lastKm, boundaryTargetH)`. It then snaps
 *  to the camp/shelter nearest in time (|hoursRaw(lastKm→camp) − boundaryTargetH|
 *  ≤ windowH), rejecting any camp whose hoursRaw(camp→end) < floorH (would leave a
 *  sliver / sits at the end). When no camp qualifies the boundary is a "Wild camp"
 *  at the naive km rounded to 0.1 km. `snappedKms`/`endKind` semantics unchanged:
 *  exact camp kms go into the set, wild kms do not.
 */
export function generateDayStops(
  trail: TrailJson,
  section: SectionConfig,
  targetHours: number,
  baseKmh: number,
  index: TimeIndex,
): { stops: PlanStopInput[]; snappedKms: Set<number> } {
  const stops: PlanStopInput[] = [];
  const snappedKms = new Set<number>();
  const targetH = Math.max(0.1, targetHours);
  const windowH = planWindowHours(targetH);
  const floorH = planFloorHours(targetH);
  const camps = overnightWaypoints(trail).filter(
    (c) => c.km > section.startKm && c.km < section.endKm,
  );

  let lastKm = section.startKm;
  // Guard against pathological inputs: at most one boundary per ~min day.
  const maxStops = 500;

  for (let i = 0; i < maxStops; i++) {
    const remainingH = hoursBetweenIndexed(index, lastKm, section.endKm, baseKmh);
    // The rest is a reasonable final day — stop (no boundary): case 1.
    if (remainingH <= targetH + floorH) break;

    // Case 2: balance the final two days (time-midpoint). Case 3: a full day.
    const boundaryTargetH = remainingH <= 2 * targetH ? remainingH / 2 : targetH;
    const naiveKm = kmAtHours(index, lastKm, boundaryTargetH, baseKmh);

    // Nearest-in-time qualifying camp: strictly ahead, inside the time window,
    // and not so close to the end (in time) that the final day drops below floor.
    let best: WaypointOption | null = null;
    let bestDelta = Infinity;
    for (const c of camps) {
      if (c.km <= lastKm) continue;
      // Would leave a sub-floor sliver / sits effectively at the end.
      if (hoursBetweenIndexed(index, c.km, section.endKm, baseKmh) < floorH) continue;
      const campH = hoursBetweenIndexed(index, lastKm, c.km, baseKmh);
      const delta = Math.abs(campH - boundaryTargetH);
      if (delta <= windowH && delta < bestDelta) {
        best = c;
        bestDelta = delta;
      }
    }

    if (best) {
      stops.push({ km: best.km, waypointName: best.name });
      snappedKms.add(best.km);
      lastKm = best.km;
    } else {
      const km = Math.round(naiveKm * 10) / 10;
      stops.push({ km, waypointName: 'Wild camp' });
      lastKm = km;
    }
  }

  return { stops, snappedKms };
}

/**
 * The full read-only plan for a section + inputs. Ties every derived number to
 * the shared calculators; the only guide-added logic is day-boundary generation
 * (above) and camp-snap tagging.
 */
export function computePlan(trail: TrailJson, inputs: PlanInputs): PlanResult {
  const section: SectionConfig = {
    startKm: inputs.startKm,
    endKm: inputs.endKm,
    // Prefer caller-supplied names (they resolve duplicate-km waypoints by the
    // exact option the user picked); fall back to a km lookup, then a generic.
    startName: inputs.startName ?? nameAtKm(trail, inputs.startKm) ?? `${trail.config.name} Start`,
    endName: inputs.endName ?? nameAtKm(trail, inputs.endKm) ?? `${trail.config.name} End`,
  };

  const baseKmh = PACE_KMH[inputs.pace];
  const targetH = inputs.dailyHours;

  // TrailJson is structurally a PlanTrail — pass it straight through. Build the
  // Naismith time index once (O(n)); the splitter reuses it for O(log n) queries.
  const planTrail = trail as unknown as PlanTrail;
  const index = buildTimeIndex(planTrail.track.points);
  const { stops, snappedKms } = generateDayStops(trail, section, targetH, baseKmh, index);

  const computed = computeDays(planTrail, stops, null, section, baseKmh);
  const days: PlanDay[] = computed.map((d, i) => {
    const isLast = i === computed.length - 1;
    // Last computed day ends at the section end (a "finish" — could be a town,
    // hut or trailhead, never a snapped wild camp). Interior days are a real
    // camp when their end km matched a snapped waypoint, else a wild camp.
    const endKind: DayEndKind = isLast ? 'finish' : snappedKms.has(d.endKm) ? 'camp' : 'wild';
    return { ...d, endKind, snappedToCamp: endKind === 'camp' };
  });

  // Resupply "≈ N days" / food weights derive from the realized plan (Decision 6):
  // the effective km/day of the actual split, not a flat-ground target. computeDays
  // always yields ≥1 day, so the fallback is an unreachable safeguard; a 0-length
  // section gives effectiveDailyKm = 0, which computeResupplyGaps clamps to 1 km
  // (and such a section has no gaps anyway).
  const sectionKm = section.endKm - section.startKm;
  const effectiveDailyKm = days.length > 0 ? sectionKm / days.length : baseKmh * inputs.dailyHours;

  const resupply = analyzeResupplyForSection(
    trail.waypoints,
    section.startKm,
    section.endKm,
    effectiveDailyKm,
  );
  const foodCarries = resupply.gaps.map((gap) => ({ gap, food: foodCarryForGap(gap) }));

  const water = analyzeWaterCarryForSection(
    trail.waypoints,
    section.startKm,
    section.endKm,
    DEFAULT_DRY_STRETCH_KM,
  );
  const topWaterCarries = [...water.gaps].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 5);

  return {
    section,
    targetHours: targetH,
    effectiveDailyKm,
    days,
    resupply,
    foodCarries,
    water,
    topWaterCarries,
  };
}

/** Resolve a display name for an exact km (a waypoint at that km, else null). */
function nameAtKm(trail: TrailJson, km: number): string | null {
  const wp = trail.waypoints.find((w) => (w.totalDistance ?? 0) === km);
  return wp?.name ?? null;
}
