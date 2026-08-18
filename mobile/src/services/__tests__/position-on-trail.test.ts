import {
  snapToTrail,
  isOffTrail,
  OFF_TRAIL_THRESHOLD_M,
  type SnapPoint,
} from '../position-on-trail';

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

describe('isOffTrail', () => {
  it('is false for null and on-trail distances', () => {
    expect(isOffTrail(null)).toBe(false);
    expect(isOffTrail(OFF_TRAIL_THRESHOLD_M)).toBe(false);
  });

  it('is true beyond the threshold', () => {
    expect(isOffTrail(OFF_TRAIL_THRESHOLD_M + 1)).toBe(true);
  });
});
