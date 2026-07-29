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

import { computeDays, type PlanTrail, type PlanStopInput } from '@lib/day-calculator';
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
 * Flat-ground km/h per preset. Note the shared `estimateHikingTime` hardcodes a
 * 4 km/h base + Naismith climb penalty and is NOT parameterised by speed, so
 * pace here drives the *daily distance target* (how far to pack into a day),
 * while each day's shown hours stay the calculator's terrain-aware estimate.
 * 'average' == 4 gives the clean identity "flat day hours ≈ your daily hours".
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
}

/** A day card: the calculator's ComputedDay plus whether its end snapped to a real camp. */
export interface PlanDay extends ComputedDay {
  /** True when the day boundary landed on a real campsite/shelter waypoint. */
  snappedToCamp: boolean;
}

/** The full read-only plan derived from inputs. */
export interface PlanResult {
  section: SectionConfig;
  targetDailyKm: number;
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

/** Convert km/h + hours into the greedy daily-distance target (min 1 km). */
export function targetDailyKm(inputs: Pick<PlanInputs, 'pace' | 'dailyHours'>): number {
  const km = PACE_KMH[inputs.pace] * inputs.dailyHours;
  return Math.max(1, Math.round(km * 10) / 10);
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
 * Generate the interior overnight-stop boundaries for a section, greedily
 * walking `targetKm` at a time and snapping each boundary to the nearest
 * camp/shelter waypoint within a window.
 *
 * The shared `computeDays` does NOT auto-split — it only splits at the explicit
 * stops it is handed. This function IS that auto-splitter, plus the snapping
 * the calculator has no concept of:
 *
 *  - Window = clamp(target * 0.35, 3km, 10km) either side of the naive target.
 *  - If a camp/shelter waypoint falls in [lastKm, sectionEnd) and inside the
 *    window, the boundary snaps to it (named). Otherwise the boundary is a
 *    "Wild camp" at the naive target km.
 *  - The final day always runs to the section end (no sliver last day): once
 *    the next target would land within one window of the end, we stop.
 */
export function generateDayStops(
  trail: TrailJson,
  section: SectionConfig,
  targetKm: number,
): { stops: PlanStopInput[]; snappedKms: Set<number> } {
  const stops: PlanStopInput[] = [];
  const snappedKms = new Set<number>();
  const target = Math.max(1, targetKm);
  const window = Math.min(10, Math.max(3, target * 0.35));
  const camps = overnightWaypoints(trail).filter(
    (c) => c.km > section.startKm && c.km < section.endKm,
  );

  let lastKm = section.startKm;
  // Guard against pathological inputs: at most one boundary per ~min day.
  const maxStops = 500;

  for (let i = 0; i < maxStops; i++) {
    const naive = lastKm + target;
    // Stop once the next full day would reach (within a window of) the end:
    // the remaining distance becomes the final day.
    if (naive + window >= section.endKm) break;

    // Nearest camp to the naive target, inside the window and strictly ahead.
    let best: WaypointOption | null = null;
    let bestDelta = Infinity;
    for (const c of camps) {
      if (c.km <= lastKm) continue;
      const delta = Math.abs(c.km - naive);
      if (delta <= window && delta < bestDelta) {
        best = c;
        bestDelta = delta;
      }
    }

    if (best) {
      stops.push({ km: best.km, waypointName: best.name });
      snappedKms.add(best.km);
      lastKm = best.km;
    } else {
      const km = Math.round(naive * 10) / 10;
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
    startName: nameAtKm(trail, inputs.startKm) ?? `${trail.config.name} Start`,
    endName: nameAtKm(trail, inputs.endKm) ?? `${trail.config.name} End`,
  };

  const target = targetDailyKm(inputs);
  const { stops, snappedKms } = generateDayStops(trail, section, target);

  // TrailJson is structurally a PlanTrail — pass it straight through.
  const planTrail = trail as unknown as PlanTrail;
  const computed = computeDays(planTrail, stops, null, section);
  const days: PlanDay[] = computed.map((d, i) => ({
    ...d,
    // Last computed day ends at the section end (never a snapped camp); interior
    // days snapped when their end km matched a real camp waypoint.
    snappedToCamp: i < computed.length - 1 && snappedKms.has(d.endKm),
  }));

  const resupply = analyzeResupplyForSection(trail.waypoints, section.startKm, section.endKm, target);
  const foodCarries = resupply.gaps.map((gap) => ({ gap, food: foodCarryForGap(gap) }));

  const water = analyzeWaterCarryForSection(
    trail.waypoints,
    section.startKm,
    section.endKm,
    DEFAULT_DRY_STRETCH_KM,
  );
  const topWaterCarries = [...water.gaps].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 5);

  return { section, targetDailyKm: target, days, resupply, foodCarries, water, topWaterCarries };
}

/** Resolve a display name for an exact km (a waypoint at that km, else null). */
function nameAtKm(trail: TrailJson, km: number): string | null {
  const wp = trail.waypoints.find((w) => (w.totalDistance ?? 0) === km);
  return wp?.name ?? null;
}
