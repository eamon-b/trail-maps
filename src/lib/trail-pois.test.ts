import { describe, it, expect } from 'vitest';
import { buildRouteScale } from './trail-pois';
import type { TrackPoint } from './trail-types';

describe('buildRouteScale', () => {
  it('flattens a 150,000-point track without one call per point', () => {
    // JavaScriptCore (Safari) refuses a call with more than 65,536 arguments,
    // which `kmScale.push(...km)` became on a long import. V8 does not, so the
    // limit is imposed here.
    const N = 150_000;
    const points: TrackPoint[] = Array.from({ length: N }, (_, i) => ({
      lat: -34 + i * 1e-6,
      lon: 138,
      ele: 0,
      dist: i * 0.0001,
    }));

    const realPush = Array.prototype.push;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      if (items.length > 65536) throw new RangeError('Maximum call stack size exceeded.');
      return realPush.apply(this, items);
    };
    let scale;
    try {
      scale = buildRouteScale({
        track: { points, displayPoints: points, totalDistance: 15, totalAscent: 0, totalDescent: 0 },
        alternates: [],
        sideTrips: [],
      });
    } finally {
      Array.prototype.push = realPush;
    }

    expect(scale.kmScale).toHaveLength(N);
    expect(scale.kmScale[N - 1]).toBeCloseTo((N - 1) * 0.0001, 9);
  });
});
