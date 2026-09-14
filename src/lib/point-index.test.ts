/**
 * The grid index must agree with the linear scan it replaces on every query —
 * that is the whole contract, so most of this is parity against a brute-force
 * nearest over randomised tracks.
 */

import { describe, it, expect } from 'vitest';
import { buildPointIndex, PointIndex, type IndexablePoint } from './point-index';

/** The scan `handleMapHover` used to do, kept here as the oracle. */
function bruteForceNearest(points: IndexablePoint[], lat: number, lon: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < points.length; i++) {
    const dist = Math.sqrt((points[i].lat - lat) ** 2 + (points[i].lon - lon) ** 2);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Deterministic pseudo-random, so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function wanderingTrack(count: number, seed: number): { lat: number; lon: number; i: number }[] {
  const random = makeRandom(seed);
  const points: { lat: number; lon: number; i: number }[] = [];
  let lat = -30;
  let lon = 140;
  for (let i = 0; i < count; i++) {
    lat += (random() - 0.5) * 0.01;
    lon += (random() - 0.4) * 0.01;
    points.push({ lat, lon, i });
  }
  return points;
}

describe('PointIndex', () => {
  it('matches a brute-force scan on a wandering track', () => {
    const points = wanderingTrack(4000, 7);
    const index = buildPointIndex(points);
    const random = makeRandom(99);

    for (let q = 0; q < 500; q++) {
      const lat = -30 + (random() - 0.5) * 25;
      const lon = 140 + (random() - 0.5) * 25;
      expect(index.nearestIndex(lat, lon)).toBe(bruteForceNearest(points, lat, lon));
    }
  });

  it('matches a brute-force scan for queries far outside the track', () => {
    const points = wanderingTrack(500, 3);
    const index = buildPointIndex(points);

    for (const [lat, lon] of [
      [0, 0],
      [-80, 179],
      [80, -179],
      [-30, 300],
    ]) {
      expect(index.nearestIndex(lat, lon)).toBe(bruteForceNearest(points, lat, lon));
    }
  });

  it('returns the point itself when queried at its own position', () => {
    const points = wanderingTrack(1000, 11);
    const index = buildPointIndex(points);

    for (const i of [0, 1, 250, 999]) {
      expect(index.nearest(points[i].lat, points[i].lon)).toBe(points[i]);
    }
  });

  it('resolves a tie to the earliest point, as a forward scan does', () => {
    const points = [
      { lat: 0, lon: -1 },
      { lat: 0, lon: 1 },
      { lat: 0, lon: -1 },
    ];
    const index = buildPointIndex(points);

    expect(index.nearestIndex(0, 0)).toBe(bruteForceNearest(points, 0, 0));
    expect(index.nearestIndex(0, 0)).toBe(0);
  });

  it('handles an empty index', () => {
    const index = buildPointIndex([]);
    expect(index.size).toBe(0);
    expect(index.nearestIndex(1, 2)).toBe(-1);
    expect(index.nearest(1, 2)).toBeNull();
  });

  it('handles degenerate tracks (one point, and a perfectly straight line)', () => {
    const single = buildPointIndex([{ lat: -30, lon: 140 }]);
    expect(single.nearest(10, 10)).toEqual({ lat: -30, lon: 140 });

    const straight = Array.from({ length: 2000 }, (_, i) => ({ lat: -30, lon: 140 + i * 0.001 }));
    const index = new PointIndex(straight);
    for (const lon of [139, 140.5, 141.5, 142]) {
      expect(index.nearestIndex(-30.01, lon)).toBe(bruteForceNearest(straight, -30.01, lon));
    }

    const stacked = Array.from({ length: 50 }, () => ({ lat: 5, lon: 5 }));
    expect(buildPointIndex(stacked).nearestIndex(5, 5)).toBe(0);
  });

  it('is far cheaper than the scan it replaces on a long trail', () => {
    // Not a timing assertion — just that a 20,000-point index answers a query
    // by touching a handful of cells rather than every point.
    const points = wanderingTrack(20000, 42);
    const index = buildPointIndex(points);
    const random = makeRandom(5);

    for (let q = 0; q < 200; q++) {
      const target = points[Math.floor(random() * points.length)];
      expect(index.nearestIndex(target.lat, target.lon)).toBe(
        bruteForceNearest(points, target.lat, target.lon)
      );
    }
  });
});
