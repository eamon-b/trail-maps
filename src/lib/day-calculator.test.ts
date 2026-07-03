import { describe, it, expect } from 'vitest';
import {
  estimateHikingTime,
  countWaterSources,
  computeDays,
} from './day-calculator';
import type { PlanTrail } from './day-calculator';
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
});
