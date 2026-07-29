import {
  clampWindow,
  hitTestMarkers,
  nearestPointByKm,
  xToKm,
  MIN_WINDOW_KM,
} from '../geometry';

describe('clampWindow', () => {
  it('keeps a valid window untouched', () => {
    expect(clampWindow(10, 40, 100)).toEqual({ startKm: 10, endKm: 40 });
  });

  it('orders reversed inputs', () => {
    expect(clampWindow(40, 10, 100)).toEqual({ startKm: 10, endKm: 40 });
  });

  it('enforces the minimum window span', () => {
    const w = clampWindow(50, 50.5, 100);
    expect(w.endKm - w.startKm).toBeCloseTo(MIN_WINDOW_KM, 6);
    // re-centered on the original midpoint (50.25)
    expect((w.startKm + w.endKm) / 2).toBeCloseTo(50.25, 6);
  });

  it('shifts (not squashes) a window that runs off the start', () => {
    const w = clampWindow(-10, 20, 100);
    expect(w.startKm).toBe(0);
    expect(w.endKm).toBeCloseTo(30, 6);
  });

  it('shifts a window that runs off the end', () => {
    const w = clampWindow(90, 130, 100);
    expect(w.endKm).toBe(100);
    expect(w.startKm).toBeCloseTo(60, 6);
  });

  it('caps the span at the whole trail', () => {
    expect(clampWindow(-50, 200, 100)).toEqual({ startKm: 0, endKm: 100 });
  });

  it('handles a trail shorter than the minimum span', () => {
    const w = clampWindow(0, 1, 1);
    expect(w).toEqual({ startKm: 0, endKm: 1 });
  });

  it('returns an empty window for a zero-length trail', () => {
    expect(clampWindow(0, 10, 0)).toEqual({ startKm: 0, endKm: 0 });
  });
});

describe('hitTestMarkers', () => {
  const markers = [
    { id: 'a', x: 10, y: 10 },
    { id: 'b', x: 100, y: 50 },
    { id: 'c', x: 105, y: 52 },
  ];

  it('returns null when nothing is within radius', () => {
    expect(hitTestMarkers(markers, 300, 300, 20)).toBeNull();
  });

  it('hits a marker inside the radius', () => {
    expect(hitTestMarkers(markers, 12, 11, 20)).toBe('a');
  });

  it('picks the nearest when several are within radius', () => {
    // Closer to c (105,52) than b (100,50).
    expect(hitTestMarkers(markers, 104, 52, 20)).toBe('c');
  });
});

describe('nearestPointByKm', () => {
  const pts = [
    { dist: 0, ele: 0 },
    { dist: 5, ele: 10 },
    { dist: 10, ele: 20 },
  ];

  it('returns null for empty input', () => {
    expect(nearestPointByKm([], 3)).toBeNull();
  });

  it('snaps to the nearest point', () => {
    expect(nearestPointByKm(pts, 4)).toEqual({ dist: 5, ele: 10 });
    expect(nearestPointByKm(pts, 1)).toEqual({ dist: 0, ele: 0 });
  });
});

describe('xToKm', () => {
  it('maps the plot edges to the window edges', () => {
    const layout = { left: 44, chartWidth: 300 };
    const window = { startKm: 10, endKm: 40 };
    expect(xToKm(44, window, layout)).toBeCloseTo(10, 6);
    expect(xToKm(344, window, layout)).toBeCloseTo(40, 6);
    expect(xToKm(194, window, layout)).toBeCloseTo(25, 6);
  });
});
