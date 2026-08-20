/**
 * The pane-switch focus window: converting a map viewport, an elevation zoom,
 * and a set of visible list rows into the same km range, and back again.
 *
 * The behaviour these lock down is issue #22 — switching panes used to reset the
 * new pane to the whole trail instead of keeping the section you were looking
 * at — so the round trips (map → range → map) matter as much as the individual
 * conversions.
 */

import {
  boundsForKmRange,
  firstIndexInFocus,
  focusFromItems,
  isSameFocus,
  isValidFocus,
  kmRangeInBounds,
  normalizeFocus,
  MIN_FOCUS_SPAN_KM,
  type FocusBounds,
  type FocusTrackPoint,
} from '../guide-focus';

/**
 * A straight south-to-north track: one point per km, 0..100 km, climbing 0.01°
 * of latitude per km from -35 with longitude fixed at 138.
 */
const straightTrack: FocusTrackPoint[] = Array.from({ length: 101 }, (_, i) => ({
  lat: -35 + i * 0.01,
  lon: 138,
  dist: i,
}));

const TOTAL_KM = 100;

/** Viewport helper in [lon, lat] corner order (what MapLibre reports). */
const boundsOf = (
  west: number,
  south: number,
  east: number,
  north: number,
): FocusBounds => ({ ne: [east, north], sw: [west, south] });

describe('normalizeFocus', () => {
  it('floors the span so a pinpoint focus is still renderable', () => {
    const focus = normalizeFocus({ startKm: 42, endKm: 42 }, TOTAL_KM);
    expect(focus.endKm - focus.startKm).toBeCloseTo(MIN_FOCUS_SPAN_KM, 6);
    // ...and stays centred on what was asked for.
    expect((focus.startKm + focus.endKm) / 2).toBeCloseTo(42, 6);
  });

  it('shifts a window that runs off the end back inside the trail', () => {
    expect(normalizeFocus({ startKm: 95, endKm: 130 }, TOTAL_KM)).toEqual({
      startKm: 65,
      endKm: 100,
    });
  });
});

describe('isValidFocus', () => {
  it('rejects nothing, backwards, and non-finite windows', () => {
    expect(isValidFocus(null)).toBe(false);
    expect(isValidFocus(undefined)).toBe(false);
    expect(isValidFocus({ startKm: 10, endKm: 4 })).toBe(false);
    expect(isValidFocus({ startKm: NaN, endKm: 4 })).toBe(false);
    expect(isValidFocus({ startKm: -1, endKm: 4 })).toBe(false);
    expect(isValidFocus({ startKm: 4, endKm: 10 })).toBe(true);
  });
});

describe('isSameFocus', () => {
  it('treats a sub-2% difference as the same section', () => {
    expect(isSameFocus({ startKm: 10, endKm: 20 }, { startKm: 10.1, endKm: 20.1 })).toBe(true);
  });

  it('separates windows that differ visibly', () => {
    expect(isSameFocus({ startKm: 10, endKm: 20 }, { startKm: 12, endKm: 22 })).toBe(false);
    expect(isSameFocus({ startKm: 10, endKm: 20 }, { startKm: 0, endKm: 100 })).toBe(false);
  });

  it('is never true against a missing window', () => {
    expect(isSameFocus(null, { startKm: 0, endKm: 10 })).toBe(false);
    expect(isSameFocus({ startKm: 0, endKm: 10 }, null)).toBe(false);
  });
});

describe('kmRangeInBounds', () => {
  it('reports the stretch of trail inside the viewport', () => {
    // Latitudes for km 40..50 inclusive.
    const focus = kmRangeInBounds(
      straightTrack,
      boundsOf(137.9, -34.6, 138.1, -34.5),
      TOTAL_KM,
    )!;
    expect(focus.startKm).toBeCloseTo(40, 6);
    expect(focus.endKm).toBeCloseTo(50, 6);
  });

  it('reports the whole trail when the whole trail is in view', () => {
    const focus = kmRangeInBounds(straightTrack, boundsOf(130, -40, 145, -30), TOTAL_KM)!;
    expect(focus).toEqual({ startKm: 0, endKm: 100 });
  });

  it('returns null when the trail is not in view, so the old focus stands', () => {
    expect(kmRangeInBounds(straightTrack, boundsOf(150, -20, 151, -19), TOTAL_KM)).toBeNull();
  });

  it('returns null for a trail with no geometry', () => {
    expect(kmRangeInBounds([], boundsOf(137, -36, 139, -34), TOTAL_KM)).toBeNull();
  });

  it('picks the section under the viewport, not a distant one that doubles back', () => {
    // A trail that visits the same place twice: km 0..10 heads north, then the
    // track jumps far away and only returns at km 90..100. A naive min/max over
    // every in-view point would call that "km 0 to 100".
    const doublesBack: FocusTrackPoint[] = [
      ...Array.from({ length: 11 }, (_, i) => ({ lat: -35 + i * 0.001, lon: 138, dist: i })),
      ...Array.from({ length: 79 }, (_, i) => ({ lat: -30, lon: 145, dist: 11 + i })),
      ...Array.from({ length: 11 }, (_, i) => ({ lat: -35 + i * 0.001, lon: 138, dist: 90 + i })),
    ];
    const focus = kmRangeInBounds(doublesBack, boundsOf(137.9, -35.1, 138.1, -34.9), TOTAL_KM)!;
    // The viewport centre (-35.0, 138.0) sits in the *first* pass.
    expect(focus.startKm).toBeCloseTo(0, 6);
    expect(focus.endKm).toBeCloseTo(10, 6);
  });

  it('never reports a hair-thin window from a deeply zoomed viewport', () => {
    const focus = kmRangeInBounds(
      straightTrack,
      boundsOf(137.999, -34.6005, 138.001, -34.5995),
      TOTAL_KM,
    )!;
    expect(focus.endKm - focus.startKm).toBeGreaterThanOrEqual(MIN_FOCUS_SPAN_KM);
  });
});

describe('boundsForKmRange', () => {
  it('boxes the track points inside the range', () => {
    const box = boundsForKmRange(straightTrack, { startKm: 40, endKm: 50 })!;
    const [, north] = box.ne;
    const [, south] = box.sw;
    expect(south).toBeCloseTo(-34.6, 6);
    expect(north).toBeCloseTo(-34.5, 6);
  });

  it('pads a range that lands on a single point into a real box', () => {
    const box = boundsForKmRange(straightTrack, { startKm: 40, endKm: 40 })!;
    expect(box.ne[0]).toBeGreaterThan(box.sw[0]);
    expect(box.ne[1]).toBeGreaterThan(box.sw[1]);
  });

  it('falls back to the nearest point when the range holds none', () => {
    const sparse: FocusTrackPoint[] = [
      { lat: -35, lon: 138, dist: 0 },
      { lat: -34, lon: 139, dist: 100 },
    ];
    const box = boundsForKmRange(sparse, { startKm: 90, endKm: 95 })!;
    // Nearest point to the range midpoint (92.5 km) is the 100 km end.
    expect(box.ne[1]).toBeGreaterThan(-34.01);
    expect(box.sw[1]).toBeLessThan(-33.99);
  });

  it('returns null without geometry', () => {
    expect(boundsForKmRange([], { startKm: 0, endKm: 10 })).toBeNull();
  });

  it('round-trips a viewport back to the same section', () => {
    const viewport = boundsOf(137.9, -34.6, 138.1, -34.5);
    const focus = kmRangeInBounds(straightTrack, viewport, TOTAL_KM)!;
    const box = boundsForKmRange(straightTrack, focus)!;
    const back = kmRangeInBounds(straightTrack, box, TOTAL_KM)!;
    expect(isSameFocus(focus, back)).toBe(true);
  });
});

describe('focusFromItems', () => {
  const rows = [
    { totalDistance: 12 },
    { totalDistance: 18 },
    { totalDistance: 25 },
  ];

  it('spans the visible rows', () => {
    expect(focusFromItems(rows, TOTAL_KM)).toEqual({ startKm: 12, endKm: 25 });
  });

  it('floors the span when a single row is on screen', () => {
    const focus = focusFromItems([{ totalDistance: 30 }], TOTAL_KM)!;
    expect(focus.endKm - focus.startKm).toBeCloseTo(MIN_FOCUS_SPAN_KM, 6);
  });

  it('ignores rows without a distance, and reports nothing when none have one', () => {
    expect(focusFromItems([{ totalDistance: 5 }, {}], TOTAL_KM)).toEqual({
      startKm: 4.5,
      endKm: 5.5,
    });
    expect(focusFromItems([{}, {}], TOTAL_KM)).toBeNull();
    expect(focusFromItems([], TOTAL_KM)).toBeNull();
  });
});

describe('firstIndexInFocus', () => {
  const rows = [
    { totalDistance: 0 },
    { totalDistance: 10 },
    { totalDistance: 20 },
    { totalDistance: 30 },
  ];

  it('finds the first row at or after the focus start', () => {
    expect(firstIndexInFocus(rows, { startKm: 15, endKm: 25 })).toBe(2);
    expect(firstIndexInFocus(rows, { startKm: 20, endKm: 25 })).toBe(2);
    expect(firstIndexInFocus(rows, { startKm: 0, endKm: 100 })).toBe(0);
  });

  it('settles on the last row for a focus past the end', () => {
    expect(firstIndexInFocus(rows, { startKm: 99, endKm: 100 })).toBe(3);
  });

  it('has nothing to scroll to in an empty list', () => {
    expect(firstIndexInFocus([], { startKm: 0, endKm: 10 })).toBe(-1);
  });
});
