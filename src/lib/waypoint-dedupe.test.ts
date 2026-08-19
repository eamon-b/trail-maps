import { describe, it, expect } from 'vitest';
import {
  dedupeNearDuplicateWaypoints,
  WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS,
  type DedupableWaypoint,
} from './waypoint-dedupe';

/**
 * Fixtures sit on the 133 deg meridian at lat -23 so metre offsets map onto
 * latitude on the same spherical earth `distance.ts` uses (radius 6371 km).
 */
const BASE_LAT = -23;
const BASE_LON = 133;
const LAT_DEG_PER_METER = 180 / (Math.PI * 6371000);

/** A waypoint `northMeters` north of the fixture origin. */
function wp(overrides: Partial<DedupableWaypoint> & { northMeters?: number } = {}): DedupableWaypoint {
  const { northMeters = 0, ...rest } = overrides;
  return {
    id: 'w_0',
    name: 'Rocky Bar Gap',
    type: 'campsite',
    lat: BASE_LAT + northMeters * LAT_DEG_PER_METER,
    lon: BASE_LON,
    ...rest,
  };
}

describe('dedupeNearDuplicateWaypoints', () => {
  it('merges a same-name same-type pair a few metres apart', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', northMeters: 0, totalDistance: 205.2 }),
      wp({ id: 'w_b', northMeters: 24, totalDistance: 205.23 }),
    ]);

    expect(result.waypoints).toHaveLength(1);
    expect(result.waypoints[0].id).toBe('w_a');
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0]).toMatchObject({
      name: 'Rocky Bar Gap',
      type: 'campsite',
      survivorId: 'w_a',
      droppedIds: ['w_b'],
      droppedCount: 1,
    });
    expect(result.merges[0].maxSeparationMeters).toBeCloseTo(24, 0);
    expect(result.droppedIds).toEqual(['w_b']);
  });

  it('keeps the survivor own coordinates and km stats', () => {
    const survivor = wp({ id: 'w_a', northMeters: 0, totalDistance: 100, totalAscent: 1000 });
    const result = dedupeNearDuplicateWaypoints([
      survivor,
      wp({ id: 'w_b', northMeters: 40, totalDistance: 100.04, totalAscent: 1010 }),
    ]);

    expect(result.waypoints[0]).toMatchObject({
      lat: survivor.lat,
      lon: survivor.lon,
      totalDistance: 100,
      totalAscent: 1000,
    });
  });

  it('does not merge waypoints beyond the radius, and does at the boundary', () => {
    const pair = (meters: number): DedupableWaypoint[] => [
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1 }),
      wp({ id: 'w_b', northMeters: meters, totalDistance: 1.2 }),
    ];

    // 125 m (the widest real pair, AAWT "Cope Hut") merges under the default.
    expect(dedupeNearDuplicateWaypoints(pair(125)).waypoints).toHaveLength(1);
    // Just outside the default radius stays split.
    expect(dedupeNearDuplicateWaypoints(pair(WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS + 5)).waypoints).toHaveLength(2);
    // A tighter configured radius splits a pair the default would merge.
    expect(dedupeNearDuplicateWaypoints(pair(60), { radiusMeters: 30 }).waypoints).toHaveLength(2);
    expect(dedupeNearDuplicateWaypoints(pair(60), { radiusMeters: 60.5 }).waypoints).toHaveLength(1);
  });

  it('never merges across types even at the same spot', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', type: 'campsite', northMeters: 0, totalDistance: 5 }),
      wp({ id: 'w_b', type: 'water-tank', northMeters: 3, totalDistance: 5 }),
    ]);

    expect(result.waypoints).toHaveLength(2);
    expect(result.merges).toEqual([]);
  });

  it('never merges different names at the same spot', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', name: 'Hugh Gorge', northMeters: 0, totalDistance: 5 }),
      wp({ id: 'w_b', name: 'Hugh Gorge Junction', northMeters: 3, totalDistance: 5 }),
    ]);

    expect(result.waypoints).toHaveLength(2);
  });

  it('appends the dropped rows distinct descriptions', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1, description: 'Tent sites' }),
      wp({ id: 'w_b', northMeters: 20, totalDistance: 1.02, description: 'Rainwater tank' }),
      wp({ id: 'w_c', northMeters: 25, totalDistance: 1.03, description: 'Tent sites' }),
    ]);

    expect(result.waypoints).toHaveLength(1);
    expect(result.waypoints[0].description).toBe('Tent sites\n\nRainwater tank');
  });

  it('carries a description over when the survivor had none', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1 }),
      wp({ id: 'w_b', northMeters: 20, totalDistance: 1.02, description: 'Rainwater tank' }),
    ]);

    expect(result.waypoints[0].description).toBe('Rainwater tank');
  });

  it('records every retired id in mergedIds, and never the survivor own id', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1, mergedIds: ['w_old'] }),
      wp({ id: 'w_b', northMeters: 20, totalDistance: 1.02, mergedIds: ['w_older'] }),
      wp({ id: 'w_c', northMeters: 30, totalDistance: 1.03 }),
    ]);

    expect(result.waypoints[0].mergedIds).toEqual(['w_old', 'w_b', 'w_older', 'w_c']);
    expect(result.waypoints[0].mergedIds).not.toContain('w_a');
    expect(result.droppedIds).toEqual(['w_b', 'w_c']);
  });

  it('collapses a three-member cluster chained through the radius', () => {
    // 0 m - 100 m - 200 m: the outer two are 200 m apart (beyond the radius) but
    // single linkage through the middle pin keeps them in one cluster.
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a', northMeters: 0, totalDistance: 10 }),
      wp({ id: 'w_b', northMeters: 100, totalDistance: 10.1 }),
      wp({ id: 'w_c', northMeters: 200, totalDistance: 10.2 }),
    ]);

    expect(result.waypoints).toHaveLength(1);
    expect(result.merges).toHaveLength(1);
    expect(result.merges[0].droppedIds).toEqual(['w_b', 'w_c']);
    expect(result.merges[0].maxSeparationMeters).toBeCloseTo(200, 0);
  });

  it('keeps the earliest km as survivor regardless of input order', () => {
    const later = wp({ id: 'w_late', northMeters: 30, totalDistance: 265.2 });
    const earlier = wp({ id: 'w_early', northMeters: 0, totalDistance: 265.1 });

    expect(dedupeNearDuplicateWaypoints([later, earlier]).waypoints[0].id).toBe('w_early');
    expect(dedupeNearDuplicateWaypoints([earlier, later]).waypoints[0].id).toBe('w_early');
  });

  it('tiebreaks on id when km ties, deterministically', () => {
    const first = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_zzz', northMeters: 0, totalDistance: 25.4 }),
      wp({ id: 'w_aaa', northMeters: 58, totalDistance: 25.4 }),
    ]);
    const reversed = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_aaa', northMeters: 58, totalDistance: 25.4 }),
      wp({ id: 'w_zzz', northMeters: 0, totalDistance: 25.4 }),
    ]);

    expect(first.waypoints[0].id).toBe('w_aaa');
    expect(reversed.waypoints[0].id).toBe('w_aaa');
  });

  it('honours preferIds so later views keep the main-route survivor', () => {
    const rows = [
      wp({ id: 'w_variant_first', northMeters: 0, totalDistance: 265.41 }),
      wp({ id: 'w_main_survivor', northMeters: 40, totalDistance: 265.42 }),
    ];

    expect(dedupeNearDuplicateWaypoints(rows).waypoints[0].id).toBe('w_variant_first');
    expect(
      dedupeNearDuplicateWaypoints(rows, { preferIds: ['w_main_survivor'] }).waypoints[0].id
    ).toBe('w_main_survivor');
  });

  it('re-derives segment stats for the row after a dropped one', () => {
    const rows: DedupableWaypoint[] = [
      wp({ id: 'w_a', name: 'Start', northMeters: 0, distance: 2, totalDistance: 2, ascent: 50, totalAscent: 50, descent: 10, totalDescent: 10 }),
      wp({ id: 'w_b', northMeters: 1000, distance: 1, totalDistance: 3, ascent: 30, totalAscent: 80, descent: 5, totalDescent: 15 }),
      wp({ id: 'w_c', northMeters: 1050, distance: 0.05, totalDistance: 3.05, ascent: 2, totalAscent: 82, descent: 1, totalDescent: 16 }),
      wp({ id: 'w_d', name: 'End', northMeters: 3000, distance: 1.95, totalDistance: 5, ascent: 40, totalAscent: 122, descent: 20, totalDescent: 36 }),
    ];

    const result = dedupeNearDuplicateWaypoints(rows);

    expect(result.waypoints.map(w => w.id)).toEqual(['w_a', 'w_b', 'w_d']);
    // Untouched rows come back as the very same objects.
    expect(result.waypoints[0]).toBe(rows[0]);
    // "End" now follows w_b directly: 5 - 3 km, 122 - 80 m up, 36 - 15 m down.
    expect(result.waypoints[2]).toMatchObject({ distance: 2, ascent: 42, descent: 21 });
    expect(result.waypoints[2].totalDistance).toBe(5);
  });

  it('re-derives segment stats for a survivor whose predecessor was dropped', () => {
    // The later pin survives (preferred), so its own segment must be measured
    // from the row before the dropped one, not from the dropped one.
    const rows: DedupableWaypoint[] = [
      wp({ id: 'w_a', name: 'Start', northMeters: 0, distance: 1, totalDistance: 1, ascent: 10, totalAscent: 10, descent: 0, totalDescent: 0 }),
      wp({ id: 'w_b', northMeters: 1000, distance: 1, totalDistance: 2, ascent: 20, totalAscent: 30, descent: 5, totalDescent: 5 }),
      wp({ id: 'w_keep', northMeters: 1100, distance: 0.1, totalDistance: 2.1, ascent: 3, totalAscent: 33, descent: 1, totalDescent: 6 }),
    ];

    const result = dedupeNearDuplicateWaypoints(rows, { preferIds: ['w_keep'] });

    expect(result.waypoints.map(w => w.id)).toEqual(['w_a', 'w_keep']);
    expect(result.waypoints[1]).toMatchObject({ distance: 1.1, ascent: 23, descent: 6, totalDistance: 2.1 });
  });

  it('leaves segment stats alone when nothing merges', () => {
    const rows: DedupableWaypoint[] = [
      wp({ id: 'w_a', name: 'One', northMeters: 0, distance: 1, totalDistance: 1 }),
      wp({ id: 'w_b', name: 'Two', northMeters: 2000, distance: 2, totalDistance: 3 }),
    ];

    const result = dedupeNearDuplicateWaypoints(rows);

    expect(result.waypoints).toEqual(rows);
    expect(result.merges).toEqual([]);
  });

  it('handles rows without km data (off-trail lists) by input order', () => {
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_second', northMeters: 115 }),
      wp({ id: 'w_first', northMeters: 0 }),
    ]);

    expect(result.waypoints).toHaveLength(1);
    // No km to compare, so the id tiebreak decides — stable across input order.
    expect(result.waypoints[0].id).toBe('w_first');
  });

  it('is a no-op for empty, single and radius-disabled inputs', () => {
    expect(dedupeNearDuplicateWaypoints([]).waypoints).toEqual([]);
    expect(dedupeNearDuplicateWaypoints([]).merges).toEqual([]);

    const single = [wp({ id: 'w_a' })];
    expect(dedupeNearDuplicateWaypoints(single).waypoints).toEqual(single);

    const pair = [
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1 }),
      wp({ id: 'w_b', northMeters: 10, totalDistance: 1.01 }),
    ];
    expect(dedupeNearDuplicateWaypoints(pair, { radiusMeters: 0 }).waypoints).toEqual(pair);
    expect(dedupeNearDuplicateWaypoints(pair, { radiusMeters: 0 }).merges).toEqual([]);
  });

  it('does not mutate its input', () => {
    const rows = [
      wp({ id: 'w_a', northMeters: 0, totalDistance: 1, description: 'A' }),
      wp({ id: 'w_b', northMeters: 20, totalDistance: 1.02, description: 'B' }),
    ];
    const snapshot = JSON.parse(JSON.stringify(rows));

    dedupeNearDuplicateWaypoints(rows);

    expect(JSON.parse(JSON.stringify(rows))).toEqual(snapshot);
  });

  it('merges independent clusters of the same name separately', () => {
    // Two distinct sites that happen to share a name, each with its own pair.
    const far = 5000;
    const result = dedupeNearDuplicateWaypoints([
      wp({ id: 'w_a1', northMeters: 0, totalDistance: 1 }),
      wp({ id: 'w_a2', northMeters: 30, totalDistance: 1.03 }),
      wp({ id: 'w_b1', northMeters: far, totalDistance: 6 }),
      wp({ id: 'w_b2', northMeters: far + 30, totalDistance: 6.03 }),
    ]);

    expect(result.waypoints.map(w => w.id)).toEqual(['w_a1', 'w_b1']);
    expect(result.merges).toHaveLength(2);
    expect(result.droppedIds).toEqual(['w_a2', 'w_b2']);
  });
});
