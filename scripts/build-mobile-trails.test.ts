/**
 * `processTrail` — the point-budget pass that produces `mobile/assets/trails/*`.
 *
 * The case that matters here is a trail with route breaks. Simplifying the
 * whole point array at once lets Douglas-Peucker drop the points either side of
 * a break and join them with a line across the water; on Te Araroa a single
 * pass to 5,000 points loses a boundary point at three of its six breaks. So
 * each stretch is simplified alone and the breaks are re-anchored.
 */

import { describe, it, expect } from 'vitest';
import { processTrail } from './build-mobile-trails';
import type { RouteBreak, TrackPoint } from '../src/lib/trail-types';

/**
 * A stretch of `count` points running south from `startLat`, 11 m apart, made
 * to wander so Douglas-Peucker cannot collapse it to its two endpoints the way
 * it would a straight line.
 */
function stretch(
  startLat: number,
  count: number,
  startDist: number
): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: startLat - i * 0.0001,
    lon: 174 + Math.sin(i / 3) * 0.002,
    ele: 100 + (i % 7),
    dist: startDist + i * 0.011,
  }));
}

/** Two 8,000-point stretches with a 50 km jump between them. */
function brokenTrail() {
  const first = stretch(-41, 8000, 0);
  const second = stretch(-41.5, 8000, first[first.length - 1].dist);
  const points = [...first, ...second];
  const breaks: RouteBreak[] = [
    {
      index: first.length,
      displayIndex: 2,
      km: first[first.length - 1].dist,
      straightLineKm: 52.7,
      fromTrack: 'Stretch 1',
      toTrack: 'Stretch 2',
    },
  ];
  return {
    config: { id: 'test', name: 'Test', shortName: 'Test', lengthKm: 176 },
    track: {
      points,
      displayPoints: [
        points[0],
        points[1],
        points[first.length],
        points[points.length - 1],
      ],
      totalDistance: 176,
      totalAscent: 100,
      totalDescent: 100,
      breaks,
    },
    waypoints: [],
  };
}

describe('processTrail', () => {
  it('carries the breaks onto the phone', () => {
    const out = processTrail(brokenTrail());

    expect(out.track.breaks).toHaveLength(1);
    expect(out.track.breaks?.[0]).toMatchObject({
      straightLineKm: 52.7,
      fromTrack: 'Stretch 1',
      toTrack: 'Stretch 2',
    });
  });

  it('re-anchors index onto the simplified array, at the same place', () => {
    const source = brokenTrail();
    const firstPointAfterBreak =
      source.track.points[source.track.breaks[0].index];

    const out = processTrail(source);
    const rebuilt = out.track.points[out.track.breaks![0].index];

    // Coordinates are rounded to 6dp by truncatePoints, so compare rounded.
    expect(rebuilt.lat).toBeCloseTo(firstPointAfterBreak.lat, 6);
    expect(rebuilt.lon).toBeCloseTo(firstPointAfterBreak.lon, 6);
    // And the point before it is still the last one walked, 0.5 degrees north.
    expect(out.track.points[out.track.breaks![0].index - 1].lat).toBeCloseTo(
      -41.7999,
      3
    );
  });

  it('simplifies to roughly the point budget despite the extra pass', () => {
    const out = processTrail(brokenTrail());

    expect(out.track.points.length).toBeLessThanOrEqual(5200);
    expect(out.track.points.length).toBeGreaterThan(1000);
  });

  it('leaves displayIndex alone — displayPoints are not re-simplified', () => {
    const out = processTrail(brokenTrail());

    expect(out.track.displayPoints).toHaveLength(4);
    expect(out.track.breaks?.[0].displayIndex).toBe(2);
  });

  it('emits no breaks field for a continuous trail', () => {
    const trail = brokenTrail();
    const continuous = {
      ...trail,
      track: { ...trail.track, breaks: undefined },
    };

    const out = processTrail(continuous);

    expect(out.track.breaks).toBeUndefined();
    expect(out.track.points.length).toBeGreaterThan(1000);
  });
});
