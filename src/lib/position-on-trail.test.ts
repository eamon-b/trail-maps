import { describe, expect, it } from 'vitest';
import { haversineDistance } from './distance';
import { routeBreakStarts } from './route-breaks';
import {
  snapToTrail,
  isOffTrail,
  OFF_TRAIL_THRESHOLD_M,
  type SnapPoint,
} from './position-on-trail';

// A straight track along the equator: 0.001° lon ≈ 111.3 m apart.
const TRACK: SnapPoint[] = [
  { lat: 0, lon: 0.0, dist: 0.0 },
  { lat: 0, lon: 0.001, dist: 0.111 },
  { lat: 0, lon: 0.002, dist: 0.223 },
  { lat: 0, lon: 0.003, dist: 0.334 },
  { lat: 0, lon: 0.004, dist: 0.446 },
];

describe('snapToTrail', () => {
  it('returns null when there is no geometry', () => {
    expect(snapToTrail(0, 0, [])).toBeNull();
  });

  it('snaps a coordinate on the trail to the nearest point km', () => {
    const result = snapToTrail(0, 0.002, TRACK);
    expect(result).not.toBeNull();
    expect(result!.index).toBe(2);
    expect(result!.currentKm).toBeCloseTo(0.223, 3);
    expect(result!.offTrailMeters).toBeCloseTo(0, 0);
  });

  it('reports off-trail metres for a coordinate beside the trail', () => {
    // ~111 m north of the lon=0.002 point.
    const result = snapToTrail(0.001, 0.002, TRACK);
    expect(result!.index).toBe(2);
    expect(result!.offTrailMeters).toBeGreaterThan(100);
    expect(result!.offTrailMeters).toBeLessThan(120);
  });

  it('uses the hint window for a cheap nearby re-snap', () => {
    const first = snapToTrail(0, 0.0, TRACK)!;
    const next = snapToTrail(0, 0.001, TRACK, first.index);
    expect(next!.index).toBe(1);
    expect(next!.currentKm).toBeCloseTo(0.111, 3);
  });

  it('falls back to a full scan when the hint is far from the fix', () => {
    // Hint says index 0, but the fix is really at the far end of the track.
    const result = snapToTrail(0, 0.004, TRACK, 0);
    expect(result!.index).toBe(4);
    expect(result!.currentKm).toBeCloseTo(0.446, 3);
  });
});

/** Cumulative-km ladder for a list of lat/lon pairs, as the build writes it. */
function ladder(coords: [number, number][]): SnapPoint[] {
  let km = 0;
  return coords.map(([lat, lon], i) => {
    if (i > 0) km += haversineDistance(coords[i - 1][0], coords[i - 1][1], lat, lon) / 1000;
    return { lat, lon, dist: km };
  });
}

describe('snapToTrail on a thinned track', () => {
  // A CDT-like spacing: vertices ~900 m apart along a meridian.
  const SPARSE = ladder([
    [40.0, -106],
    [40.0081, -106],
    [40.0162, -106],
    [40.0243, -106],
  ]);

  it('reports a fix on a long segment as on the trail, at the interpolated km', () => {
    const a = SPARSE[1];
    const b = SPARSE[2];
    const mid = { lat: (a.lat + b.lat) / 2, lon: -106 };

    const result = snapToTrail(mid.lat, mid.lon, SPARSE)!;

    // A vertex snap read this as ~450 m off trail, at one end's km.
    expect(result.offTrailMeters).toBeLessThan(1);
    expect(isOffTrail(result.offTrailMeters)).toBe(false);
    expect(result.currentKm).toBeCloseTo((a.dist + b.dist) / 2, 3);
    // `index` is the segment's start vertex.
    expect(result.index).toBe(1);
  });

  it('measures the perpendicular distance to the segment, not to a vertex', () => {
    const a = SPARSE[1];
    const b = SPARSE[2];
    // 30 m east of the segment midpoint.
    const lat = (a.lat + b.lat) / 2;
    const lon = -106 + 30 / (111_320 * Math.cos((lat * Math.PI) / 180));

    const result = snapToTrail(lat, lon, SPARSE)!;
    expect(result.offTrailMeters).toBeGreaterThan(29);
    expect(result.offTrailMeters).toBeLessThan(31);
    expect(isOffTrail(result.offTrailMeters)).toBe(false);
  });

  it('interpolates inside the hint window as well', () => {
    const a = SPARSE[2];
    const b = SPARSE[3];
    const lat = a.lat + 0.25 * (b.lat - a.lat);
    const result = snapToTrail(lat, -106, SPARSE, 2)!;
    expect(result.index).toBe(2);
    expect(result.currentKm).toBeCloseTo(a.dist + 0.25 * (b.dist - a.dist), 3);
  });

  it('finds the true nearest segment from far away, whatever the vertex spacing', () => {
    // A long track whose nearest segment to the fix is one long leg among many
    // short ones: a coarse every-Nth-vertex scan settles on the short legs.
    const coords: [number, number][] = [];
    for (let i = 0; i <= 2000; i++) coords.push([0, i * 0.001]); // 2 km of dense line…
    coords.push([1, 2]); // …then one 111 km leg north…
    for (let i = 1; i <= 2000; i++) coords.push([1 + i * 0.001, 2]); // …and dense again.
    const track = ladder(coords);

    // 5 km west of the long leg's midpoint, nowhere near any vertex.
    const lat = 0.5;
    const lon = 2 - 5 / 111.32;
    const result = snapToTrail(lat, lon, track)!;

    expect(result.index).toBe(2000);
    expect(result.offTrailMeters).toBeGreaterThan(4900);
    expect(result.offTrailMeters).toBeLessThan(5100);
    const leg = track[2001].dist - track[2000].dist;
    expect(result.currentKm).toBeCloseTo(track[2000].dist + leg / 2, 0);

    // Brute force over every segment agrees.
    let bestKm = NaN;
    let bestM = Infinity;
    for (let i = 0; i + 1 < track.length; i++) {
      for (let s = 0; s <= 100; s++) {
        const t = s / 100;
        const p = {
          lat: track[i].lat + t * (track[i + 1].lat - track[i].lat),
          lon: track[i].lon + t * (track[i + 1].lon - track[i].lon),
        };
        const m = haversineDistance(lat, lon, p.lat, p.lon);
        if (m < bestM) {
          bestM = m;
          bestKm = track[i].dist + t * (track[i + 1].dist - track[i].dist);
        }
      }
    }
    expect(result.offTrailMeters).toBeLessThanOrEqual(bestM + 1);
    expect(Math.abs(result.currentKm - bestKm)).toBeLessThan(1.2);
  });
});

describe('snapToTrail across a route break', () => {
  // Two stretches with a ferry between them: index 2 is the first point after
  // the break, so the straight line 1 → 2 is water, not trail.
  const TRACK_WITH_BREAK: SnapPoint[] = [
    { lat: 0, lon: 0.0, dist: 0 },
    { lat: 0, lon: 0.01, dist: 1.113 },
    { lat: 0, lon: 0.05, dist: 1.113 },
    { lat: 0, lon: 0.06, dist: 2.226 },
  ];
  const BREAKS = routeBreakStarts([{ index: 2, displayIndex: 2 }], 'points');

  it('never snaps a fix onto the crossing between two stretches', () => {
    // Mid-ferry: right on the straight line between the landings.
    const result = snapToTrail(0, 0.03, TRACK_WITH_BREAK, undefined, BREAKS)!;
    // It snaps to a landing, and says it is ~2.2 km from the trail.
    expect([1, 2]).toContain(result.index);
    expect(result.currentKm).toBeCloseTo(1.113, 3);
    expect(result.offTrailMeters).toBeGreaterThan(2000);
    expect(isOffTrail(result.offTrailMeters)).toBe(true);
  });

  it('respects the break inside the hint window too', () => {
    const result = snapToTrail(0, 0.045, TRACK_WITH_BREAK, 1, BREAKS)!;
    expect(result.index).toBe(2);
    expect(result.offTrailMeters).toBeGreaterThan(500);
  });

  it('still snaps onto either stretch normally', () => {
    const result = snapToTrail(0, 0.055, TRACK_WITH_BREAK, undefined, BREAKS)!;
    expect(result.index).toBe(2);
    expect(result.offTrailMeters).toBeLessThan(1);
    expect(result.currentKm).toBeCloseTo(1.113 + 1.113 / 2, 3);
  });

  it('without the breaks, the crossing reads as trail (why callers must pass them)', () => {
    const result = snapToTrail(0, 0.03, TRACK_WITH_BREAK)!;
    expect(result.offTrailMeters).toBeLessThan(1);
  });
});

describe('isOffTrail', () => {
  it('is false for null and on-trail distances', () => {
    expect(isOffTrail(null)).toBe(false);
    expect(isOffTrail(OFF_TRAIL_THRESHOLD_M)).toBe(false);
  });

  it('is true beyond the threshold', () => {
    expect(isOffTrail(OFF_TRAIL_THRESHOLD_M + 1)).toBe(true);
  });
});
