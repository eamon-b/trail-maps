import { describe, it, expect } from 'vitest';
import {
  estimateHikingTime,
  estimateHikingHoursRaw,
  buildTimeIndex,
  hoursBetweenIndexed,
  kmAtHours,
  countWaterSources,
  computeDays,
} from './day-calculator';
import type { PlanTrail } from './day-calculator';
import { calculateElevationBetween } from './track-geometry';
import type { ElevationPoint } from './track-geometry';
import type { StopData, PlanWaypoint } from './plan-types';

// --- estimateHikingTime ---

describe('estimateHikingTime', () => {
  it('flat 20km day with no descent returns 5h', () => {
    expect(estimateHikingTime(20, 0, 0)).toBe(5);
  });

  it('20km with 600m ascent and 0m descent returns 6h', () => {
    expect(estimateHikingTime(20, 600, 0)).toBe(6);
  });

  it('descent up to 300m is free (no penalty)', () => {
    // 20km flat + 0 ascent + 300m descent (300 <= threshold, penalty = 0)
    expect(estimateHikingTime(20, 0, 300)).toBe(5);
  });

  it('descent > 300m incurs penalty', () => {
    // 20km + 0 ascent + 900m descent → 5 + 0 + (900-300)/600 = 5 + 1 = 6
    expect(estimateHikingTime(20, 0, 900)).toBe(6);
  });

  it('rounds to 1 decimal', () => {
    // 15km + 500m ascent → 15/4 + 500/600 = 3.75 + 0.833… = 4.583… → 4.6
    expect(estimateHikingTime(15, 500, 0)).toBe(4.6);
  });

  it('baseKmh defaults to 4 (unchanged behavior)', () => {
    expect(estimateHikingTime(20, 0, 0)).toBe(estimateHikingTime(20, 0, 0, 4));
  });

  it('non-default baseKmh scales the distance term', () => {
    // 24km flat at 3 km/h → 8h; at 6 km/h → 4h
    expect(estimateHikingTime(24, 0, 0, 3)).toBe(8);
    expect(estimateHikingTime(24, 0, 0, 6)).toBe(4);
  });
});

// --- estimateHikingHoursRaw ---

describe('estimateHikingHoursRaw', () => {
  it('matches the Naismith formula without rounding', () => {
    // 15km + 500m ascent at 4 km/h → 3.75 + 0.8333… (unrounded)
    expect(estimateHikingHoursRaw(15, 500, 0)).toBeCloseTo(3.75 + 500 / 600, 10);
  });

  it('estimateHikingTime is the 0.1 h rounding of the raw variant', () => {
    const raw = estimateHikingHoursRaw(15, 500, 0);
    expect(estimateHikingTime(15, 500, 0)).toBe(Math.round(raw * 10) / 10);
  });

  it('descent up to 300m is free; beyond incurs a linear penalty', () => {
    expect(estimateHikingHoursRaw(20, 0, 300)).toBeCloseTo(5, 10);
    expect(estimateHikingHoursRaw(20, 0, 900)).toBeCloseTo(6, 10);
  });
});

// --- synthetic tracks for the time index ---

/** Flat track: constant elevation, 10 points/km. */
function flatPoints(totalKm: number, ele = 500): ElevationPoint[] {
  const pointsPerKm = 10;
  return Array.from({ length: totalKm * pointsPerKm + 1 }, (_, i) => ({
    dist: i / pointsPerKm,
    ele,
  }));
}

/** Steadily-descending track: drops `dropPerPointM` at every 0.1 km step. */
function descendingPoints(totalKm: number, dropPerPointM: number): ElevationPoint[] {
  const pointsPerKm = 10;
  return Array.from({ length: totalKm * pointsPerKm + 1 }, (_, i) => ({
    dist: i / pointsPerKm,
    ele: 2000 - dropPerPointM * i,
  }));
}

/** Deterministic bumpy track via a seeded LCG so "random" ranges are reproducible. */
function bumpyPoints(totalKm: number): ElevationPoint[] {
  const pointsPerKm = 10;
  const n = totalKm * pointsPerKm + 1;
  let seed = 123456789;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let ele = 800;
  return Array.from({ length: n }, (_, i) => {
    ele += (rand() - 0.5) * 40; // wander ±20 m per step
    return { dist: i / pointsPerKm, ele };
  });
}

// --- buildTimeIndex / hoursBetweenIndexed / kmAtHours ---

describe('time index', () => {
  it('hoursBetweenIndexed agrees with estimateHikingHoursRaw over calculateElevationBetween', () => {
    const points = bumpyPoints(120);
    const index = buildTimeIndex(points);
    let seed = 987654321;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let t = 0; t < 200; t++) {
      const a = rand() * 120;
      const b = rand() * 120;
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      for (const base of [3, 4, 5]) {
        const { gain, loss } = calculateElevationBetween(from, to, points);
        const expected = estimateHikingHoursRaw(to - from, gain, loss, base);
        const actual = hoursBetweenIndexed(index, from, to, base);
        expect(actual).toBeCloseTo(expected, 10);
      }
    }
  });

  it('flat identity: 8 h at 4 km/h ≈ 32.0 km', () => {
    const index = buildTimeIndex(flatPoints(100));
    expect(kmAtHours(index, 0, 8, 4)).toBeCloseTo(32, 6);
  });

  it('base scaling: same 8 h target yields shorter km slower, longer km faster', () => {
    const index = buildTimeIndex(flatPoints(100));
    expect(kmAtHours(index, 0, 8, 3)).toBeCloseTo(24, 6);
    expect(kmAtHours(index, 0, 8, 5)).toBeCloseTo(40, 6);
  });

  it('kmAtHours round-trips through hoursBetweenIndexed on bumpy terrain', () => {
    const index = buildTimeIndex(bumpyPoints(120));
    for (const targetH of [2, 4, 6, 8]) {
      const km = kmAtHours(index, 5, targetH, 4);
      // Nearest-point snapping makes hoursBetweenIndexed a step function with tiny
      // (~one-step, <0.05 h) discontinuities, so a target landing in a gap round-trips
      // to within one step's contribution rather than exactly.
      expect(hoursBetweenIndexed(index, 5, km, 4)).toBeCloseTo(targetH, 1);
    }
  });

  it('kmAtHours clamps to the track end when the target exceeds the whole track', () => {
    const index = buildTimeIndex(flatPoints(100));
    expect(kmAtHours(index, 0, 1000, 4)).toBe(100);
    expect(kmAtHours(index, 80, 1000, 4)).toBe(100);
  });

  it('descent allowance is day-scoped: whole segment > sum of two half segments', () => {
    // 8 m drop per 0.1 km step = 80 m/km. Over 5 km each half loses 400 m (> 300).
    const points = descendingPoints(40, 8);
    const index = buildTimeIndex(points);
    const a = 0;
    const b = 5;
    const c = 10;
    const whole = hoursBetweenIndexed(index, a, c, 4);
    const part1 = hoursBetweenIndexed(index, a, b, 4);
    const part2 = hoursBetweenIndexed(index, b, c, 4);
    // Splitting grants the 300 m free allowance twice, under-counting time. The
    // whole-day measurement is the honest one, so it must be strictly larger.
    expect(whole).toBeGreaterThan(part1 + part2);
    // Gap is exactly one extra 300 m allowance (300/600 = 0.5 h) when both halves
    // exceed the 300 m threshold.
    expect(whole - (part1 + part2)).toBeCloseTo(0.5, 6);
  });

  it('handles empty points without crashing', () => {
    const index = buildTimeIndex([]);
    expect(hoursBetweenIndexed(index, 0, 10, 4)).toBe(0);
    expect(kmAtHours(index, 0, 8, 4)).toBe(0);
  });
});

// --- countWaterSources ---

describe('countWaterSources', () => {
  const waypoints: PlanWaypoint[] = [
    { name: 'Spring', type: 'water', totalDistance: 10 },
    { name: 'Tank', type: 'water-tank', totalDistance: 20 },
    { name: 'Town', type: 'town', totalDistance: 15 },
    { name: 'Creek', type: 'water', totalDistance: 30 },
  ];

  it('counts water sources within range (exclusive start, inclusive end)', () => {
    expect(countWaterSources(0, 25, waypoints)).toBe(2); // spring at 10, tank at 20
  });

  it('excludes sources at or before startKm', () => {
    expect(countWaterSources(10, 25, waypoints)).toBe(1); // only tank at 20
  });

  it('includes source at exactly endKm', () => {
    expect(countWaterSources(0, 20, waypoints)).toBe(2); // spring + tank
  });

  it('ignores non-water waypoints', () => {
    expect(countWaterSources(0, 16, waypoints)).toBe(1); // only spring, town excluded
  });

  it('returns 0 when no sources in range', () => {
    expect(countWaterSources(40, 50, waypoints)).toBe(0);
  });
});

// --- computeDays ---

function makeFlatTrail(totalKm: number, waypoints: PlanWaypoint[] = []): PlanTrail {
  // Flat trail: 10 points per km
  const pointsPerKm = 10;
  const points = Array.from({ length: totalKm * pointsPerKm + 1 }, (_, i) => ({
    lat: -35 + i * 0.001,
    lon: 148 + i * 0.001,
    ele: 500,
    dist: i / pointsPerKm,
  }));
  return {
    config: { name: 'Test Trail' },
    track: { points, totalDistance: totalKm },
    waypoints,
  };
}

describe('computeDays', () => {
  it('no stops → single day covering full trail', () => {
    const trail = makeFlatTrail(100);
    const days = computeDays(trail, []);
    expect(days).toHaveLength(1);
    expect(days[0].dayNumber).toBe(1);
    expect(days[0].startKm).toBe(0);
    expect(days[0].endKm).toBe(100);
    expect(days[0].distanceKm).toBe(100);
  });

  it('one stop → two days', () => {
    const trail = makeFlatTrail(100);
    const stops: StopData[] = [{ km: 60, waypointName: 'Camp Alpha' }];
    const days = computeDays(trail, stops);
    expect(days).toHaveLength(2);
    expect(days[0].distanceKm).toBe(60);
    expect(days[1].distanceKm).toBe(40);
    expect(days[0].endName).toBe('Camp Alpha');
    expect(days[1].startName).toBe('Camp Alpha');
  });

  it('two stops → three days with correct km splits', () => {
    const trail = makeFlatTrail(90);
    const stops: StopData[] = [
      { km: 30, waypointName: 'Stop A' },
      { km: 60, waypointName: 'Stop B' },
    ];
    const days = computeDays(trail, stops);
    expect(days).toHaveLength(3);
    expect(days[0].distanceKm).toBe(30);
    expect(days[1].distanceKm).toBe(30);
    expect(days[2].distanceKm).toBe(30);
  });

  it('assigns dates when startDate provided', () => {
    const trail = makeFlatTrail(60);
    const stops: StopData[] = [{ km: 30, waypointName: 'Mid' }];
    const days = computeDays(trail, stops, '2025-03-15');
    expect(days[0].date).toBe('2025-03-15');
    expect(days[1].date).toBe('2025-03-16');
  });

  it('date is undefined when no startDate', () => {
    const trail = makeFlatTrail(50);
    const days = computeDays(trail, []);
    expect(days[0].date).toBeUndefined();
  });

  it('counts water sources correctly', () => {
    const waypoints: PlanWaypoint[] = [
      { name: 'Spring', type: 'water', totalDistance: 25 },
      { name: 'Creek', type: 'water', totalDistance: 55 },
    ];
    const trail = makeFlatTrail(80, waypoints);
    const stops: StopData[] = [{ km: 40, waypointName: 'Camp' }];
    const days = computeDays(trail, stops);
    expect(days[0].waterSources).toBe(1); // spring at 25
    expect(days[1].waterSources).toBe(1); // creek at 55
  });

  it('uses first/last waypoint names for trail start/end', () => {
    const waypoints: PlanWaypoint[] = [
      { name: 'Trailhead', type: 'endpoint', totalDistance: 0 },
      { name: 'Summit', type: 'mountain', totalDistance: 50 },
    ];
    const trail = makeFlatTrail(50, waypoints);
    const days = computeDays(trail, []);
    expect(days[0].startName).toBe('Trailhead');
    expect(days[0].endName).toBe('Summit');
  });

  it('handles unsorted stops by producing correct day distances', () => {
    // Stops passed out of order — computeDays should sort them or reject them.
    // Currently it trusts the caller, so unsorted stops produce negative distances.
    const trail = makeFlatTrail(100);
    const unsortedStops: StopData[] = [
      { km: 70, waypointName: 'Camp B' },
      { km: 30, waypointName: 'Camp A' },
    ];
    const days = computeDays(trail, unsortedStops);
    // Every day must have a non-negative distance
    for (const day of days) {
      expect(day.distanceKm).toBeGreaterThanOrEqual(0);
    }
    // Total distance across all days must equal trail length
    const totalDist = days.reduce((sum, d) => sum + d.distanceKm, 0);
    expect(totalDist).toBeCloseTo(100, 1);
  });

  it('handles empty track points without crashing', () => {
    const trail: PlanTrail = {
      config: { name: 'Empty Trail' },
      track: { points: [], totalDistance: 50 },
      waypoints: [],
    };
    // Should not throw; should either return valid days or an empty array
    const days = computeDays(trail, []);
    expect(Array.isArray(days)).toBe(true);
    if (days.length > 0) {
      expect(days[0].distanceKm).toBe(50);
    }
  });

  it('handles stops beyond trail end gracefully', () => {
    const trail = makeFlatTrail(50);
    const stops: StopData[] = [{ km: 80, waypointName: 'Past End' }];
    // Stop at 80km on a 50km trail — should not produce negative day distance
    const days = computeDays(trail, stops);
    for (const day of days) {
      expect(day.distanceKm).toBeGreaterThanOrEqual(0);
    }
  });

  it('non-default baseKmh changes estimatedHours but not distances', () => {
    const trail = makeFlatTrail(100);
    const stops: StopData[] = [{ km: 60, waypointName: 'Camp' }];
    const fast = computeDays(trail, stops, null, null, 5);
    const slow = computeDays(trail, stops, null, null, 3);
    const base = computeDays(trail, stops); // default 4 km/h

    // Distances are identical regardless of pace.
    expect(fast.map(d => d.distanceKm)).toEqual(base.map(d => d.distanceKm));
    expect(slow.map(d => d.distanceKm)).toEqual(base.map(d => d.distanceKm));

    // Flat 60 km day: 12 h at 5, 15 h at 4, 20 h at 3.
    expect(fast[0].estimatedHours).toBe(12);
    expect(base[0].estimatedHours).toBe(15);
    expect(slow[0].estimatedHours).toBe(20);
  });

  it('default baseKmh keeps existing behavior byte-identical', () => {
    const trail = makeFlatTrail(80);
    const stops: StopData[] = [{ km: 40, waypointName: 'Mid' }];
    expect(computeDays(trail, stops)).toEqual(computeDays(trail, stops, null, null, 4));
  });
});
