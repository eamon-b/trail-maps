import { describe, it, expect } from 'vitest';
import {
  routeBreakCrossings,
  routeBreakStarts,
  sliceAcrossRouteBreaks,
  splitAtRouteBreaks,
} from './route-breaks';
import type { RouteBreak } from './trail-types';

function points(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    lat: -34 + i,
    lon: 138 + i,
  }));
}

function routeBreak(overrides: Partial<RouteBreak> = {}): RouteBreak {
  return {
    index: 4,
    displayIndex: 2,
    km: 100,
    straightLineKm: 1.1,
    fromTrack: 'Stretch 1',
    toTrack: 'Stretch 2',
    ...overrides,
  };
}

describe('splitAtRouteBreaks', () => {
  it('returns one stretch for a continuous route', () => {
    const pts = points(6);

    expect(splitAtRouteBreaks(pts, undefined, 'points')).toEqual([pts]);
    expect(splitAtRouteBreaks(pts, [], 'points')).toEqual([pts]);
  });

  it('cuts before the first point after each break, keeping every point', () => {
    const pts = points(10);

    const stretches = splitAtRouteBreaks(
      pts,
      [routeBreak({ index: 4 }), routeBreak({ index: 7 })],
      'points'
    );

    expect(stretches.map((s) => s.length)).toEqual([4, 3, 3]);
    expect(stretches.flat()).toEqual(pts);
  });

  it('reads displayIndex when splitting the display copy', () => {
    const pts = points(6);

    const byPoints = splitAtRouteBreaks(
      pts,
      [routeBreak({ index: 4, displayIndex: 2 })],
      'points'
    );
    const byDisplay = splitAtRouteBreaks(
      pts,
      [routeBreak({ index: 4, displayIndex: 2 })],
      'displayPoints'
    );

    expect(byPoints.map((s) => s.length)).toEqual([4, 2]);
    expect(byDisplay.map((s) => s.length)).toEqual([2, 4]);
  });

  it('sorts cuts, so breaks out of order still split cleanly', () => {
    const stretches = splitAtRouteBreaks(
      points(10),
      [routeBreak({ index: 7 }), routeBreak({ index: 3 })],
      'points'
    );

    expect(stretches.map((s) => s.length)).toEqual([3, 4, 3]);
  });

  it('ignores an index outside the array rather than emitting an empty line', () => {
    const pts = points(5);

    expect(
      splitAtRouteBreaks(pts, [routeBreak({ index: 0 })], 'points')
    ).toEqual([pts]);
    expect(
      splitAtRouteBreaks(pts, [routeBreak({ index: 5 })], 'points')
    ).toEqual([pts]);
    expect(
      splitAtRouteBreaks(pts, [routeBreak({ index: 99 })], 'points')
    ).toEqual([pts]);
  });
});

describe('routeBreakCrossings', () => {
  it('spans the last point walked and the first one after the break', () => {
    const pts = points(10);

    const crossings = routeBreakCrossings(
      pts,
      [routeBreak({ index: 4, straightLineKm: 52.7 })],
      'points'
    );

    expect(crossings).toEqual([
      { from: pts[3], to: pts[4], straightLineKm: 52.7 },
    ]);
  });

  it('is empty for a trail with no breaks', () => {
    expect(routeBreakCrossings(points(5), undefined, 'points')).toEqual([]);
    expect(routeBreakCrossings(points(5), [], 'points')).toEqual([]);
  });

  it('skips a break that does not land inside the array', () => {
    expect(
      routeBreakCrossings(points(5), [routeBreak({ index: 0 })], 'points')
    ).toEqual([]);
    expect(
      routeBreakCrossings(points(5), [routeBreak({ index: 5 })], 'points')
    ).toEqual([]);
  });
});

describe('routeBreakStarts', () => {
  it('collects the index for the array named', () => {
    const breaks = [
      routeBreak({ index: 4, displayIndex: 2 }),
      routeBreak({ index: 9, displayIndex: 5 }),
    ];
    expect([...routeBreakStarts(breaks, 'points')]).toEqual([4, 9]);
    expect([...routeBreakStarts(breaks, 'displayPoints')]).toEqual([2, 5]);
  });

  it('is empty for a trail with no breaks, and drops indices that cut nothing', () => {
    expect(routeBreakStarts(undefined, 'points').size).toBe(0);
    expect(
      routeBreakStarts(
        [routeBreak({ index: 0 }), routeBreak({ index: Number.NaN })],
        'points'
      ).size
    ).toBe(0);
  });
});

describe('sliceAcrossRouteBreaks', () => {
  const pts = points(10);

  it('returns one piece when the range crosses no break', () => {
    expect(sliceAcrossRouteBreaks(pts, 2, 5, new Set([8]))).toEqual([pts.slice(2, 6)]);
  });

  it('cuts the range at each break inside it', () => {
    expect(sliceAcrossRouteBreaks(pts, 1, 8, new Set([4, 6]))).toEqual([
      pts.slice(1, 4),
      pts.slice(4, 6),
      pts.slice(6, 9),
    ]);
  });

  it('takes the range in either order', () => {
    expect(sliceAcrossRouteBreaks(pts, 8, 1, new Set([4]))).toEqual(
      sliceAcrossRouteBreaks(pts, 1, 8, new Set([4]))
    );
  });

  it('keeps a single-point piece when the range starts right before a break', () => {
    expect(sliceAcrossRouteBreaks(pts, 3, 6, new Set([4]))).toEqual([
      [pts[3]],
      pts.slice(4, 7),
    ]);
  });

  it('ignores a break at the start of the range: nothing before it is included', () => {
    expect(sliceAcrossRouteBreaks(pts, 4, 6, new Set([4]))).toEqual([pts.slice(4, 7)]);
  });

  it('clamps to the array and is empty for no points', () => {
    expect(sliceAcrossRouteBreaks(pts, -3, 20, new Set())).toEqual([pts]);
    expect(sliceAcrossRouteBreaks([], 0, 3, new Set())).toEqual([]);
  });
});
