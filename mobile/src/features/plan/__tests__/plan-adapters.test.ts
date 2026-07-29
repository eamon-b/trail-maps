/**
 * Plan adapter tests. Covers the guide-added logic (day-boundary generation +
 * camp snapping, section scoping, direction-flip recompute) and confirms the
 * shared @lib calculators are driven with the right inputs over a real bundled
 * trail (cape_to_cape — the smallest, 126.9 km).
 */

import {
  PACE_KMH,
  computePlan,
  fullTrailSection,
  generateDayStops,
  overnightWaypoints,
  sectionFromWaypoints,
  targetDailyKm,
  waypointOptions,
  type PlanInputs,
} from '../plan-adapters';
import { resolveGuideTrail } from '../../guide/guide-trail';
import type { TrailJson } from '../../../services/trail-assets';

// Real bundled fixture: works in Jest via the require() map.
const cape = require('../../../../assets/trails/cape_to_cape.json') as TrailJson;

/** Small synthetic trail with predictable camps for boundary tests. */
function syntheticTrail(): TrailJson {
  const points = Array.from({ length: 101 }, (_, i) => ({
    lat: 0,
    lon: i * 0.001,
    ele: 100, // flat: estimateHikingTime == distance/4
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
      { id: 'wt', name: 'Tank', lat: 0, lon: 0, type: 'water-tank', totalDistance: 55 },
      { id: 'c2', name: 'Camp B', lat: 0, lon: 0, type: 'campsite', totalDistance: 60 },
      { id: 'end', name: 'Finish', lat: 0, lon: 0, type: 'trailhead', totalDistance: 100 },
    ],
    track: { points, displayPoints: points, totalDistance: 100, totalAscent: 0, totalDescent: 0 },
  };
}

describe('targetDailyKm', () => {
  it('is pace km/h × daily hours', () => {
    expect(targetDailyKm({ pace: 'average', dailyHours: 8 })).toBe(PACE_KMH.average * 8);
    expect(targetDailyKm({ pace: 'slow', dailyHours: 10 })).toBe(30);
    expect(targetDailyKm({ pace: 'fast', dailyHours: 6 })).toBe(30);
  });

  it('never drops below 1 km', () => {
    expect(targetDailyKm({ pace: 'slow', dailyHours: 0 })).toBe(1);
  });
});

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

describe('generateDayStops', () => {
  it('snaps boundaries to nearby camps and wild-camps otherwise', () => {
    const trail = syntheticTrail();
    const section = fullTrailSection(trail);
    // target 20 km/day → naive targets 20,40,60,80. Camps at 20 and 60 snap;
    // 40 has only a town (not camp family) → wild camp; 80 → wild camp.
    const { stops } = generateDayStops(trail, section, 20);
    const names = stops.map((s) => s.waypointName);
    expect(stops[0]).toMatchObject({ km: 20, waypointName: 'Camp A' });
    expect(names).toContain('Wild camp');
    // Camp B at 60 should be snapped somewhere in the list.
    expect(stops.some((s) => s.waypointName === 'Camp B')).toBe(true);
  });

  it('produces strictly increasing boundaries and leaves a final day to the end', () => {
    const trail = syntheticTrail();
    const section = fullTrailSection(trail);
    const { stops } = generateDayStops(trail, section, 25);
    const kms = stops.map((s) => s.km);
    for (let i = 1; i < kms.length; i++) expect(kms[i]).toBeGreaterThan(kms[i - 1]);
    // No boundary within one window of the end (last day runs to 100).
    expect(kms[kms.length - 1]).toBeLessThan(section.endKm);
  });

  it('makes a single day when the section is shorter than a day', () => {
    const trail = syntheticTrail();
    const { stops } = generateDayStops(trail, { startKm: 0, endKm: 15, startName: 'a', endName: 'b' }, 20);
    expect(stops).toEqual([]);
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

  it('surfaces resupply legs (cape_to_cape has 3 towns)', () => {
    const plan = computePlan(cape, inputs);
    expect(plan.resupply.hasResupplyData).toBe(true);
    expect(plan.foodCarries.length).toBeGreaterThan(0);
    // Each leg carries the calculator's own food-weight estimate.
    expect(plan.foodCarries[0].food.weightKg).toBeGreaterThan(0);
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
    // Every resupply point lies inside the section.
    for (const p of plan.resupply.points) {
      expect(p.km).toBeGreaterThanOrEqual(prevelly.km);
      expect(p.km).toBeLessThanOrEqual(yallingup.km);
    }
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
