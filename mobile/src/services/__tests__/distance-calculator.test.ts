import type { TrackPoint, TrailWaypoint } from '../../lib/trail-utils';
import { calculateElevationBetween } from '@lib/track-geometry';
import { estimateHikingTime } from '@lib/day-calculator';
import {
  calculateDistancesToWaypoints,
  getNextWaypointsByType,
  formatEtaMinutes,
} from '../distance-calculator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrackPoints(totalKm: number, count: number): TrackPoint[] {
  const points: TrackPoint[] = [];
  for (let i = 0; i < count; i++) {
    const frac = i / (count - 1);
    points.push({
      lat: -33 + frac * 0.1,
      lon: 115 + frac * 0.1,
      ele: 200 + Math.sin(frac * Math.PI * 10) * 100,
      dist: frac * totalKm,
    });
  }
  return points;
}

function makeAscendingPoints(): TrackPoint[] {
  return [
    { lat: 0, lon: 0, ele: 100, dist: 0 },
    { lat: 0, lon: 0, ele: 200, dist: 1 },
    { lat: 0, lon: 0, ele: 300, dist: 2 },
  ];
}

function makeDescendingPoints(): TrackPoint[] {
  return [
    { lat: 0, lon: 0, ele: 300, dist: 0 },
    { lat: 0, lon: 0, ele: 200, dist: 1 },
    { lat: 0, lon: 0, ele: 100, dist: 2 },
  ];
}

function makeMixedPoints(): TrackPoint[] {
  return [
    { lat: 0, lon: 0, ele: 100, dist: 0 },
    { lat: 0, lon: 0, ele: 250, dist: 1 },
    { lat: 0, lon: 0, ele: 180, dist: 2 },
    { lat: 0, lon: 0, ele: 320, dist: 3 },
    { lat: 0, lon: 0, ele: 200, dist: 4 },
  ];
}

function makeWaypoints(stops: { name: string; type: string; km: number }[]): TrailWaypoint[] {
  return stops.map((s, i) => ({
    id: `wp-${i}`,
    name: s.name,
    lat: -33,
    lon: 115,
    type: s.type,
    totalDistance: s.km,
  }));
}

// ---------------------------------------------------------------------------
// calculateElevationBetween
// ---------------------------------------------------------------------------

describe('calculateElevationBetween', () => {
  it('ascending segment returns positive gain and zero loss', () => {
    const result = calculateElevationBetween(0, 2, makeAscendingPoints());
    expect(result.gain).toBe(200);
    expect(result.loss).toBe(0);
  });

  it('descending segment returns zero gain and positive loss', () => {
    const result = calculateElevationBetween(0, 2, makeDescendingPoints());
    expect(result.gain).toBe(0);
    expect(result.loss).toBe(200);
  });

  it('mixed terrain returns both gain and loss', () => {
    const result = calculateElevationBetween(0, 4, makeMixedPoints());
    // Gains: 100→250 (+150), 180→320 (+140) = 290
    // Losses: 250→180 (-70), 320→200 (-120) = 190
    expect(result.gain).toBe(290);
    expect(result.loss).toBe(190);
  });

  it('reversed start/end (startKm > endKm) returns same result via min/max', () => {
    const points = makeMixedPoints();
    const forward = calculateElevationBetween(0, 4, points);
    const reversed = calculateElevationBetween(4, 0, points);
    expect(reversed).toEqual(forward);
  });

  it('single-point range returns {0, 0}', () => {
    const points = makeAscendingPoints();
    const result = calculateElevationBetween(1, 1, points);
    expect(result).toEqual({ gain: 0, loss: 0 });
  });

  it('empty trackPoints returns {0, 0}', () => {
    const result = calculateElevationBetween(0, 10, []);
    expect(result).toEqual({ gain: 0, loss: 0 });
  });

  it('rounds to integers', () => {
    const points: TrackPoint[] = [
      { lat: 0, lon: 0, ele: 100.3, dist: 0 },
      { lat: 0, lon: 0, ele: 200.7, dist: 1 },
      { lat: 0, lon: 0, ele: 150.1, dist: 2 },
    ];
    const result = calculateElevationBetween(0, 2, points);
    expect(Number.isInteger(result.gain)).toBe(true);
    expect(Number.isInteger(result.loss)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// calculateDistancesToWaypoints
// ---------------------------------------------------------------------------

describe('calculateDistancesToWaypoints', () => {
  const trackPoints = makeTrackPoints(100, 500);

  it('returns only waypoints ahead of currentKm', () => {
    const waypoints = makeWaypoints([
      { name: 'Behind', type: 'campsite', km: 5 },
      { name: 'At', type: 'campsite', km: 10 },
      { name: 'Ahead', type: 'campsite', km: 50 },
    ]);
    const result = calculateDistancesToWaypoints(10, waypoints, trackPoints);
    expect(result).toHaveLength(1);
    expect(result[0].waypoint.name).toBe('Ahead');
  });

  it('computes correct trailDistanceKm for each waypoint', () => {
    const waypoints = makeWaypoints([
      { name: 'WP1', type: 'water', km: 30 },
      { name: 'WP2', type: 'town', km: 60 },
    ]);
    const result = calculateDistancesToWaypoints(10, waypoints, trackPoints);
    expect(result[0].trailDistanceKm).toBe(20);
    expect(result[1].trailDistanceKm).toBe(50);
  });

  it('includes elevation gain/loss per waypoint', () => {
    const waypoints = makeWaypoints([
      { name: 'WP1', type: 'water', km: 50 },
    ]);
    const result = calculateDistancesToWaypoints(0, waypoints, trackPoints);
    expect(result[0].elevationGain).toBeGreaterThanOrEqual(0);
    expect(result[0].elevationLoss).toBeGreaterThanOrEqual(0);
  });

  it('returns empty array when no waypoints ahead', () => {
    const waypoints = makeWaypoints([
      { name: 'Behind', type: 'campsite', km: 5 },
    ]);
    const result = calculateDistancesToWaypoints(10, waypoints, trackPoints);
    expect(result).toEqual([]);
  });

  it('computes per-waypoint Naismith etaMinutes matching estimateHikingTime', () => {
    const waypoints = makeWaypoints([
      { name: 'WP1', type: 'water', km: 30 },
    ]);
    const [wd] = calculateDistancesToWaypoints(10, waypoints, trackPoints);
    // Same call measure-service makes: estimateHikingTime over the km span
    // with the track's gain/loss between the two positions.
    const { gain, loss } = calculateElevationBetween(10, 30, trackPoints);
    expect(wd.etaMinutes).toBeCloseTo(estimateHikingTime(20, gain, loss) * 60, 5);
    expect(wd.etaMinutes).toBeGreaterThan(0);
  });

  it('flat-ground ETA follows the 4 km/h Naismith base rate', () => {
    const flat: TrackPoint[] = [
      { lat: 0, lon: 0, ele: 100, dist: 0 },
      { lat: 0, lon: 0, ele: 100, dist: 4 },
      { lat: 0, lon: 0, ele: 100, dist: 8 },
    ];
    const waypoints = makeWaypoints([{ name: 'W', type: 'water', km: 4 }]);
    const [wd] = calculateDistancesToWaypoints(0, waypoints, flat);
    expect(wd.etaMinutes).toBe(60); // 4 km at 4 km/h
  });

  it('treats missing totalDistance as 0', () => {
    const waypoints: TrailWaypoint[] = [
      { id: 'wp-0', name: 'No Dist', lat: -33, lon: 115, type: 'campsite' },
    ];
    // currentKm = 0, totalDistance defaults to 0, so 0 > 0 is false → not ahead
    const result = calculateDistancesToWaypoints(0, waypoints, trackPoints);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getNextWaypointsByType
// ---------------------------------------------------------------------------

describe('getNextWaypointsByType', () => {
  const trackPoints = makeTrackPoints(100, 500);

  it('returns first campsite, water, town, shelter', () => {
    const waypoints = makeWaypoints([
      { name: 'Camp 1', type: 'campsite', km: 20 },
      { name: 'Water 1', type: 'water', km: 25 },
      { name: 'Town 1', type: 'town', km: 30 },
      { name: 'Shelter 1', type: 'shelter', km: 35 },
      { name: 'Camp 2', type: 'campsite', km: 50 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result.campsite?.waypoint.name).toBe('Camp 1');
    expect(result.water?.waypoint.name).toBe('Water 1');
    expect(result.town?.waypoint.name).toBe('Town 1');
    expect(result.shelter?.waypoint.name).toBe('Shelter 1');
  });

  it('maps water-tank to water key', () => {
    const waypoints = makeWaypoints([
      { name: 'Tank', type: 'water-tank', km: 20 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result.water?.waypoint.name).toBe('Tank');
  });

  it('maps hut to shelter key', () => {
    const waypoints = makeWaypoints([
      { name: 'Mountain Hut', type: 'hut', km: 20 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result.shelter?.waypoint.name).toBe('Mountain Hut');
  });

  it('never maps the new registry types (hazard/lookout/junction) to any NEXT slot', () => {
    // A hazard between here and the next real water must not surface as
    // "NEXT WATER" (or any other card) — decision 3 exclusion.
    const waypoints = makeWaypoints([
      { name: 'Cliff edge', type: 'hazard', km: 15 },
      { name: 'Big View', type: 'lookout', km: 16 },
      { name: 'Fork', type: 'junction', km: 17 },
      { name: 'Real creek', type: 'water', km: 20 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result.water?.waypoint.name).toBe('Real creek');
    expect(result.campsite).toBeUndefined();
    expect(result.town).toBeUndefined();
    expect(result.shelter).toBeUndefined();
  });

  it('ignores unrecognized types', () => {
    const waypoints = makeWaypoints([
      { name: 'POI', type: 'poi', km: 20 },
      { name: 'Lookout', type: 'lookout', km: 25 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result.campsite).toBeUndefined();
    expect(result.water).toBeUndefined();
    expect(result.town).toBeUndefined();
    expect(result.shelter).toBeUndefined();
  });

  it('returns empty object when nothing ahead', () => {
    const waypoints = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 5 },
    ]);
    const result = getNextWaypointsByType(10, waypoints, trackPoints);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// formatEtaMinutes
// ---------------------------------------------------------------------------

describe('formatEtaMinutes', () => {
  it('rounds to 5 minutes under an hour', () => {
    expect(formatEtaMinutes(48)).toBe('~50 min');
    expect(formatEtaMinutes(52)).toBe('~50 min');
    expect(formatEtaMinutes(12)).toBe('~10 min');
  });

  it('floors tiny estimates at ~5 min (never promises less)', () => {
    expect(formatEtaMinutes(1)).toBe('~5 min');
    expect(formatEtaMinutes(0)).toBe('~5 min');
  });

  it('switches to hours above 60 minutes', () => {
    expect(formatEtaMinutes(130)).toBe('~2 h 10 min');
    expect(formatEtaMinutes(120)).toBe('~2 h');
  });

  it('carries a rounded-up 60 into the next hour (never "~60 min")', () => {
    expect(formatEtaMinutes(59.9)).toBe('~1 h');
    expect(formatEtaMinutes(60)).toBe('~1 h');
    expect(formatEtaMinutes(58)).toBe('~1 h'); // 58 rounds to 60 → carries
  });

  it('carries a rounded-up minute part into the next hour above 60 min', () => {
    expect(formatEtaMinutes(119.5)).toBe('~2 h'); // 119.5 rounds to 120
    expect(formatEtaMinutes(118)).toBe('~2 h'); // 118 rounds to 120
  });
});
