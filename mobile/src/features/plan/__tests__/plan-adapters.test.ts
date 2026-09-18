/**
 * Plan adapter tests. Covers the guide-added logic (hours-space day-boundary
 * generation + camp snapping, section scoping, direction-flip recompute) and
 * confirms the shared @lib calculators are driven with the right inputs over a
 * real bundled trail (cape_to_cape — the smallest, 126.9 km; aawt — the steep
 * regression anchor).
 */

import {
  PACE_KMH,
  computePlan,
  fullTrailSection,
  generateDayStops,
  overnightWaypoints,
  planWindowHours,
  sectionFromWaypoints,
  waypointOptions,
  type PlanInputs,
} from '../plan-adapters';
import { buildTimeIndex, hoursBetweenIndexed, type TimeIndex } from '@lib/day-calculator';
import { resolveGuideTrail } from '../../guide/guide-trail';
import type { TrailJson } from '../../../services/trail-assets';

// Real bundled fixtures: work in Jest via the require() map.
const cape = require('../../../../assets/trails/cape_to_cape.json') as TrailJson;
const aawt = require('../../../../assets/trails/aawt.json') as TrailJson;
const cdt = require('../../../../assets/trails/cdt.json') as TrailJson;

/** Build the Naismith time index the splitter consumes. */
function indexOf(trail: TrailJson): TimeIndex {
  return buildTimeIndex(trail.track.points);
}

/** Small synthetic trail with predictable camps for boundary tests. */
function syntheticTrail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100, // flat: hoursRaw == distance / baseKmh (no ascent/descent)
    dist: i, // 0..100 km
  }));
  return {
    config: {
      id: 'syn',
      name: 'Synthetic',
      shortName: 'SYN',
      region: 'Test',
      lengthKm: 100,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'w0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
      { id: 'c1', name: 'Camp A', lat: 0, lon: 0, type: 'campsite', totalDistance: 20 },
      { id: 't1', name: 'Townsville', lat: 0, lon: 0, type: 'town', totalDistance: 40 },
      // 50 m along and named after the same turn-off: one group, one stop —
      // the Salida / Poncha Springs shape, in miniature.
      {
        id: 't2',
        name: 'Poncha',
        lat: 0,
        lon: 0,
        type: 'town',
        totalDistance: 40.05,
        offTrailKm: 5,
        accessMode: 'hitch',
        accessName: 'Highway 1',
      },
      { id: 'wt', name: 'Tank', lat: 0, lon: 0, type: 'water-tank', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

/** A flat camp-free trail so wild-camp boundaries land at exact km. */
function flatTrail(lengthKm: number): TrailJson {
  const points = Array.from({ length: lengthKm + 1 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100,
    dist: i,
  }));
  return {
    config: {
      id: 'flat',
      name: 'Flat',
      shortName: 'FLT',
      region: 'Test',
      lengthKm,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'w0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: lengthKm },
    ],
    track: { points, displayPoints: points, totalDistance: lengthKm, totalAscent: 0, totalDescent: 0 },
  };
}

describe('waypoint selectors', () => {
  it('overnightWaypoints returns only camp/shelter family, km-ordered', () => {
    const camps = overnightWaypoints(syntheticTrail());
    expect(camps.map((c) => c.name)).toEqual(['Camp A', 'Camp B']);
  });

  it('overnightWaypoints over the real trail finds the campsites in order', () => {
    const camps = overnightWaypoints(cape);
    expect(camps.length).toBe(6); // cape_to_cape has 6 campsites
    const kms = camps.map((c) => c.km);
    expect(kms).toEqual([...kms].sort((a, b) => a - b));
  });

  it('waypointOptions is the full waypoint set in km order', () => {
    const opts = waypointOptions(cape);
    expect(opts.length).toBe(cape.waypoints.length);
    expect(opts[0].km).toBeLessThanOrEqual(opts[opts.length - 1].km);
  });

  it('fullTrailSection spans the whole track', () => {
    const s = fullTrailSection(cape);
    expect(s.startKm).toBe(0);
    expect(s.endKm).toBe(cape.track.totalDistance);
  });
});

describe('planWindowHours', () => {
  it('clamps the snap window to [0.75, 2.5] around 0.35 · targetHours', () => {
    expect(planWindowHours(1)).toBeCloseTo(0.75, 5); // 0.35 below floor -> clamped up
    expect(planWindowHours(5)).toBeCloseTo(1.75, 5); // in range
    expect(planWindowHours(8)).toBeCloseTo(2.5, 5); // 2.8 above ceiling -> clamped down
  });
});

describe('generateDayStops (hours-space)', () => {
  // On the flat synthetic trail hoursRaw == distance / baseKmh, so a targetH of
  // 5 h at 4 km/h reproduces the old 20 km/day target exactly (windowH 1.75 h =
  // 7 km, floorH 1.25 h = 5 km — the same tuning, unit-converted).
  it('snaps boundaries to nearby camps and wild-camps otherwise', () => {
    const trail = syntheticTrail();
    const section = fullTrailSection(trail);
    const { stops } = generateDayStops(trail, section, 5, 4, indexOf(trail));
    const names = stops.map((s) => s.waypointName);
    expect(stops[0]).toMatchObject({ km: 20, waypointName: 'Camp A' });
    expect(names).toContain('Wild camp');
    // Camp B at 60 should be snapped somewhere in the list.
    expect(stops.some((s) => s.waypointName === 'Camp B')).toBe(true);
  });

  it('produces strictly increasing boundaries and leaves a final day to the end', () => {
    const trail = syntheticTrail();
    const section = fullTrailSection(trail);
    // 6.25 h @ 4 km/h == the old 25 km/day target.
    const { stops } = generateDayStops(trail, section, 6.25, 4, indexOf(trail));
    const kms = stops.map((s) => s.km);
    for (let i = 1; i < kms.length; i++) expect(kms[i]).toBeGreaterThan(kms[i - 1]);
    // No boundary within one window of the end (last day runs to 100).
    expect(kms[kms.length - 1]).toBeLessThan(section.endKm);
  });

  it('makes a single day when the section is shorter than a day', () => {
    const trail = syntheticTrail();
    const { stops } = generateDayStops(
      trail,
      { startKm: 0, endKm: 15, startName: 'a', endName: 'b' },
      5,
      4,
      indexOf(trail),
    );
    expect(stops).toEqual([]);
  });

  it('splits a section only slightly longer than the target into two bounded days (Fix 2)', () => {
    // targetH 5 h → windowH 1.75 h (7 km), floorH 1.25 h (5 km); a day may run to
    // targetH+floorH = 6.25 h (25 km). A 26.9 km camp-free stretch is 6.725 h — in
    // the (target+floor, target+window] band that used to collapse into ONE
    // oversized day. It must now split into a balanced pair.
    const trail = syntheticTrail();
    const section = { startKm: 62, endKm: 88.9, startName: 'a', endName: 'b' };
    const idx = indexOf(trail);
    const { stops } = generateDayStops(trail, section, 5, 4, idx);
    expect(stops.length).toBe(1); // one interior boundary → two days
    // Neither resulting day exceeds targetH + floorH (in time), and none is a sliver.
    const boundaries = [section.startKm, ...stops.map((s) => s.km), section.endKm];
    for (let i = 1; i < boundaries.length; i++) {
      const h = hoursBetweenIndexed(idx, boundaries[i - 1], boundaries[i], 4);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThanOrEqual(5 + 1.25 + 0.05);
    }
  });

  it('never places a boundary that leaves a sub-floor sliver final day (Fix 3)', () => {
    // A camp sits 2 km (0.5 h) from the end on a 0..40 section. Snapping to it
    // would leave a final day below floorH — so it must be rejected in time terms.
    const trail: TrailJson = {
      ...syntheticTrail(),
      waypoints: [
        { id: 'w0', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0 },
        { id: 'cx', name: 'Mid Camp', lat: 0, lon: 0, type: 'campsite', totalDistance: 18 },
        { id: 'cend', name: 'Near End Camp', lat: 0, lon: 0, type: 'campsite', totalDistance: 38 },
        { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
      ],
    };
    const section = { startKm: 0, endKm: 40, startName: 'a', endName: 'b' };
    const idx = indexOf(trail);
    const { stops } = generateDayStops(trail, section, 5, 4, idx);
    const floorH = Math.max(0.75, 5 * 0.25); // 1.25 h
    // Every boundary leaves at least floorH (in time) to the section end.
    for (const s of stops) {
      expect(hoursBetweenIndexed(idx, s.km, section.endKm, 4)).toBeGreaterThanOrEqual(floorH);
    }
    expect(stops.some((s) => s.waypointName === 'Near End Camp')).toBe(false);
  });

  it('snaps to the camp nearest in time within the window', () => {
    const trail = syntheticTrail();
    const section = fullTrailSection(trail);
    const idx = indexOf(trail);
    const { stops } = generateDayStops(trail, section, 5, 4, idx);
    // Camp A (20 km / 5 h) is dead on the first day's 5 h target → snapped.
    expect(stops[0]).toMatchObject({ waypointName: 'Camp A' });
    const campH = hoursBetweenIndexed(idx, section.startKm, stops[0].km, 4);
    const windowH = Math.min(2.5, Math.max(0.75, 5 * 0.35));
    expect(Math.abs(campH - 5)).toBeLessThanOrEqual(windowH);
  });

  it('flat-trail splits match the old km-mode boundaries within 0.1 km', () => {
    // Regression anchor: on flat ground the hours splitter must reproduce the old
    // km behavior. 5 h @ 4 km/h == 20 km/day → boundaries at 20/40/60/80.
    const trail = flatTrail(100);
    const section = fullTrailSection(trail);
    const { stops } = generateDayStops(trail, section, 5, 4, indexOf(trail));
    const kms = stops.map((s) => s.km);
    expect(kms.length).toBe(4);
    [20, 40, 60, 80].forEach((expected, i) => {
      expect(Math.abs(kms[i] - expected)).toBeLessThanOrEqual(0.1);
    });
  });
});

describe('computePlan over the real trail', () => {
  const inputs: PlanInputs = { startKm: 0, endKm: cape.track.totalDistance, dailyHours: 8, pace: 'average' };

  it('splits into multiple days that cover the whole distance', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.days.length).toBeGreaterThan(1);
    const summed = plan.days.reduce((s, d) => s + d.distanceKm, 0);
    expect(summed).toBeCloseTo(cape.track.totalDistance, 0);
    // Day 1 starts at the section start; last day ends at the section end.
    expect(plan.days[0].startKm).toBe(0);
    expect(plan.days[plan.days.length - 1].endKm).toBe(cape.track.totalDistance);
  });

  it('reports the hours target and the realized effective km/day', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.targetHours).toBe(8);
    const sectionKm = cape.track.totalDistance;
    expect(plan.effectiveDailyKm).toBeCloseTo(sectionKm / plan.days.length, 6);
  });

  it('surfaces resupply legs (cape_to_cape has 3 towns)', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.resupplyGroups.length).toBe(3);
    expect(plan.resupplyLegs.length).toBeGreaterThan(0);
    // Each leg carries the calculator's own food-weight estimate.
    expect(plan.resupplyLegs[0].food.weightKg).toBeGreaterThan(0);
    expect(plan.resupplySummary.hasData).toBe(true);
  });

  it('reports no water data when the trail has no water-type waypoints', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.water.hasWaterData).toBe(false);
    expect(plan.topWaterCarries).toEqual([]);
  });

  it('flags the last computed day as a non-snapped (section-end) boundary', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.days[plan.days.length - 1].snappedToCamp).toBe(false);
  });

  it('marks the final day as a finish, not a wild camp (Fix 1)', () => {
    // Synthetic trail so we get deterministic camp snaps + a clear finish.
    const trail = syntheticTrail();
    const plan = computePlan(trail, { startKm: 0, endKm: 100, dailyHours: 5, pace: 'average' });
    const last = plan.days[plan.days.length - 1];
    // The last day ends at the section end (a trailhead) — a finish, never wild.
    expect(last.endKind).toBe('finish');
    expect(last.snappedToCamp).toBe(false);
    // Interior days carry the camp/wild distinction; every endKind is one of three.
    for (const d of plan.days) expect(['camp', 'wild', 'finish']).toContain(d.endKind);
    // At least one interior day snapped to a real camp (Camp A / Camp B).
    const interior = plan.days.slice(0, -1);
    expect(interior.some((d) => d.endKind === 'camp')).toBe(true);
    // snappedToCamp stays consistent with endKind === 'camp'.
    for (const d of plan.days) expect(d.snappedToCamp).toBe(d.endKind === 'camp');
  });

  it('prefers caller-supplied start/end names over km lookup (Fix 5)', () => {
    // Two waypoints share the end km; nameAtKm resolves by array order and would
    // pick the first. A caller-supplied endName must win (duplicate-km disambig).
    const base = syntheticTrail();
    const trail: TrailJson = {
      ...base,
      waypoints: [
        ...base.waypoints,
        { id: 'dup', name: 'First At 100', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
      ],
    };
    const preferred = computePlan(trail, {
      startKm: 0,
      endKm: 100,
      dailyHours: 5,
      pace: 'average',
      startName: 'Chosen Start',
      endName: 'Chosen End',
    });
    expect(preferred.days[0].startName).toBe('Chosen Start');
    expect(preferred.days[preferred.days.length - 1].endName).toBe('Chosen End');

    // Fallback: without names, it resolves via nameAtKm (the trail's waypoints).
    const fallback = computePlan(trail, { startKm: 0, endKm: 100, dailyHours: 5, pace: 'average' });
    expect(fallback.days[0].startName).toBe('Start');
    expect(fallback.days[fallback.days.length - 1].endName).toBe('Finish');
  });

  it('surfaces water carries and the dry-stretch flag on a watered trail', () => {
    const trail = syntheticTrail(); // has a water-tank at 55 km
    const plan = computePlan(trail, { startKm: 0, endKm: 100, dailyHours: 8, pace: 'average' });
    expect(plan.water.hasWaterData).toBe(true);
    expect(plan.topWaterCarries.length).toBeGreaterThan(0);
    // Biggest carry first.
    const dists = plan.topWaterCarries.map((g) => g.distanceKm);
    expect(dists).toEqual([...dists].sort((a, b) => b - a));
    // A > 15 km gap must be flagged dry.
    expect(plan.topWaterCarries.some((g) => g.isDryStretch)).toBe(true);
  });
});

describe('hours-based regression (the point of the change)', () => {
  it('keeps every AAWT day near the hours target on steep terrain', () => {
    // The whole reason for this change: at 8 h / average over the real steep
    // AAWT, the OLD km-mode splitter produced 13–14 h days. In hours-mode every
    // day must land at or below targetH + windowH (+ a 0.1 h rounding slack).
    const plan = computePlan(aawt, {
      startKm: 0,
      endKm: aawt.track.totalDistance,
      dailyHours: 8,
      pace: 'average',
    });
    const windowH = Math.min(2.5, Math.max(0.75, 8 * 0.35)); // 2.5
    for (const d of plan.days) {
      expect(d.estimatedHours).toBeLessThanOrEqual(8 + windowH + 0.1);
    }
    // Terrain-aware splitting yields more, shorter days than the old km packing
    // (which fit ~22 oversized days into the same trail).
    expect(plan.days.length).toBeGreaterThan(22);
  });

  it('a slower pace yields more days than a faster pace at the same hours', () => {
    const base = { startKm: 0, endKm: aawt.track.totalDistance, dailyHours: 8 };
    const slow = computePlan(aawt, { ...base, pace: 'slow' });
    const fast = computePlan(aawt, { ...base, pace: 'fast' });
    // Slow base speed (3 km/h) covers fewer km per 8 h → more days than fast (5).
    expect(slow.days.length).toBeGreaterThan(fast.days.length);
    // Pace only scales the base speed constant.
    expect(PACE_KMH.slow).toBeLessThan(PACE_KMH.fast);
  });
});

describe('section scoping', () => {
  it('restricts days and resupply to the chosen waypoint boundaries', () => {
    const opts = waypointOptions(cape);
    const prevelly = opts.find((o) => o.name === 'Prevelly')!;
    const yallingup = opts.find((o) => o.name === 'Yallingup')!;
    const section = sectionFromWaypoints(prevelly, yallingup);
    const plan = computePlan(cape, {
      startKm: section.startKm,
      endKm: section.endKm,
      dailyHours: 8,
      pace: 'average',
    });
    expect(plan.days[0].startKm).toBe(prevelly.km);
    expect(plan.days[plan.days.length - 1].endKm).toBe(yallingup.km);
    // Every leg lies inside the section, though the option list is trail-wide.
    for (const leg of plan.resupplyLegs) {
      expect(leg.fromKm).toBeGreaterThanOrEqual(prevelly.km);
      expect(leg.toKm).toBeLessThanOrEqual(yallingup.km);
    }
    expect(plan.resupplyGroups.length).toBe(3);
  });
});

describe('direction-flip recompute', () => {
  it('recomputes the plan from the direction-applied trail', () => {
    const forward = computePlan(cape, {
      startKm: 0,
      endKm: cape.track.totalDistance,
      dailyHours: 8,
      pace: 'average',
    });
    const reversed = resolveGuideTrail(cape, 'reversed');
    const back = computePlan(reversed, {
      startKm: 0,
      endKm: reversed.track.totalDistance,
      dailyHours: 8,
      pace: 'average',
    });

    // Same total distance either way.
    const fwdDist = forward.days.reduce((s, d) => s + d.distanceKm, 0);
    const revDist = back.days.reduce((s, d) => s + d.distanceKm, 0);
    expect(revDist).toBeCloseTo(fwdDist, 0);

    // Endpoints swap: reversed day 1 starts where the forward plan ended.
    expect(back.days[0].startName).toBe(forward.days[forward.days.length - 1].endName);
  });
});

describe('resupply selection', () => {
  const full: PlanInputs = { startKm: 0, endKm: 100, dailyHours: 8, pace: 'average' };

  /**
   * The synthetic trail on a steady 2 m/km climb plus a second, separate town,
   * so a leg's ascent and a merge are both exact hand sums: 0→40 climbs 80 m,
   * 40→70 climbs 60 m, 70→100 climbs 60 m.
   */
  function twoTownTrail(): TrailJson {
    const points = Array.from({ length: 101 }, (_, i) => ({
      lat: 0,
      lon: i * 0.001,
      ele: 100 + i * 2,
      dist: i,
    }));
    const base = syntheticTrail();
    return {
      ...base,
      waypoints: [
        ...base.waypoints,
        { id: 't3', name: 'Creede', lat: 0, lon: 0, type: 'town', totalDistance: 70 },
      ],
      track: { points, displayPoints: points, totalDistance: 100, totalAscent: 200, totalDescent: 0 },
    };
  }

  it('ticks every option by default: one stop per group, one leg per boundary', () => {
    const plan = computePlan(syntheticTrail(), full);
    // The twin towns 50 m apart are one turn-off, so one group and one stop.
    expect(plan.resupplyGroups.length).toBe(1);
    expect(plan.resupplyGroups[0].label).toBe('Highway 1');
    expect(plan.resupplyStops).toEqual([
      { km: 40, name: 'Townsville / Poncha', optionIds: ['t1', 't2'] },
    ]);
    expect(plan.resupplyLegs.map((l) => [l.fromName, l.toName])).toEqual([
      ['Trail Start', 'Townsville / Poncha'],
      ['Townsville / Poncha', 'Trail End'],
    ]);
  });

  it('joins two ticks in one group into a single stop', () => {
    const plan = computePlan(syntheticTrail(), { ...full, resupplyStops: ['t1', 't2'] });
    expect(plan.resupplyStops.length).toBe(1);
    expect(plan.resupplyStops[0].name).toBe('Townsville / Poncha');
    // One tick in the same group is the same stop, under its own name.
    const one = computePlan(syntheticTrail(), { ...full, resupplyStops: ['t2'] });
    expect(one.resupplyStops.map((s) => s.name)).toEqual(['Poncha']);
  });

  it('merges the legs of an unticked stop, summing distance and ascent', () => {
    const trail = twoTownTrail();
    const every = computePlan(trail, full);
    expect(every.resupplyLegs.map((l) => l.distanceKm)).toEqual([40, 30, 30]);
    expect(every.resupplyLegs.map((l) => l.ascentM)).toEqual([80, 60, 60]);

    // Untick the first group: its two legs become one.
    const merged = computePlan(trail, { ...full, resupplyStops: ['t3'] });
    expect(merged.resupplyLegs.map((l) => [l.fromName, l.toName])).toEqual([
      ['Trail Start', 'Creede'],
      ['Creede', 'Trail End'],
    ]);
    expect(merged.resupplyLegs[0].distanceKm).toBe(40 + 30);
    expect(merged.resupplyLegs[0].ascentM).toBe(80 + 60);
  });

  it('an explicit empty selection is a plan with no stops, not the default', () => {
    const plan = computePlan(twoTownTrail(), { ...full, resupplyStops: [] });
    expect(plan.resupplyStops).toEqual([]);
    expect(plan.resupplyLegs).toEqual([]);
    expect(plan.resupplySummary.hasData).toBe(false);
    // The options themselves are still offered — the list is trail-wide.
    expect(plan.resupplyGroups.length).toBe(2);
  });

  it('takes days per leg from the hiker’s hours and pace, not the day split', () => {
    // The first leg is 40 flat km: 10 h at 4 km/h, 13.3 h at 3 km/h.
    const trail = syntheticTrail();
    const at8 = computePlan(trail, full);
    expect(at8.resupplyLegs[0].estimatedHours).toBeCloseTo(10, 5);
    expect(at8.resupplyLegs[0].estimatedDays).toBe(2);
    expect(computePlan(trail, { ...full, pace: 'slow' }).resupplyLegs[0].estimatedDays).toBe(2);
    expect(computePlan(trail, { ...full, dailyHours: 16 }).resupplyLegs[0].estimatedDays).toBe(1);
  });

  it('drops a ticked stop outside the section, keeping the list trail-wide', () => {
    const plan = computePlan(twoTownTrail(), { ...full, endKm: 50 });
    // Creede (70 km) is ticked but out of range: no leg reaches it.
    expect(plan.resupplyLegs.map((l) => l.toName)).toEqual(['Townsville / Poncha', 'Trail End']);
    for (const leg of plan.resupplyLegs) expect(leg.toKm).toBeLessThanOrEqual(50);
    expect(plan.resupplyStops.length).toBe(2);
    expect(plan.resupplyGroups.length).toBe(2);
  });

  it('groups the real CDT asset and resolves Monarch Pass to one stop', () => {
    const plan = computePlan(cdt, {
      startKm: 0,
      endKm: cdt.track.totalDistance,
      dailyHours: 8,
      pace: 'average',
    });
    const options = plan.resupplyGroups.reduce((n, g) => n + g.options.length, 0);
    expect(options).toBeGreaterThanOrEqual(60);
    // Several towns share a turn-off, so there are strictly fewer groups.
    expect(plan.resupplyGroups.length).toBeLessThan(options);

    const monarch = plan.resupplyGroups.find((g) => g.label?.startsWith('Monarch Pass'))!;
    expect(monarch.options.length).toBeGreaterThan(1);
    expect(plan.resupplyStops.filter((s) => s.km === monarch.km).length).toBe(1);
  });
});
