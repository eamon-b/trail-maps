import {
  buildProfileMarkers,
  clampWindow,
  hitTestMarkers,
  kmToX,
  nearestPointByKm,
  panWindowByPixels,
  xToKm,
  zoomWindowAtFocal,
  MIN_WINDOW_KM,
  type MarkerPlot,
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

describe('kmToX', () => {
  const layout = { left: 44, chartWidth: 300 };

  it('maps the window edges to the plot edges', () => {
    const window = { startKm: 10, endKm: 40 };
    expect(kmToX(10, window, layout)).toBeCloseTo(44, 6);
    expect(kmToX(40, window, layout)).toBeCloseTo(344, 6);
    expect(kmToX(25, window, layout)).toBeCloseTo(194, 6);
  });

  it('round-trips with xToKm at any zoom', () => {
    for (const window of [
      { startKm: 0, endKm: 1300 },
      { startKm: 612.5, endKm: 613.5 },
    ]) {
      for (const x of [44, 120, 250, 344]) {
        expect(kmToX(xToKm(x, window, layout), window, layout)).toBeCloseTo(x, 6);
      }
    }
  });

  it('degrades to the left edge for a zero-span window', () => {
    expect(kmToX(5, { startKm: 5, endKm: 5 }, layout)).toBe(44);
  });
});

describe('panWindowByPixels', () => {
  const base = { startKm: 40, endKm: 60 };
  const chartWidth = 200; // 20 km over 200 px → 0.1 km / px

  it('drags the trail with the finger (right → earlier km)', () => {
    expect(panWindowByPixels(base, 50, chartWidth, 100)).toEqual({ startKm: 35, endKm: 55 });
  });

  it('drags left → later km', () => {
    expect(panWindowByPixels(base, -50, chartWidth, 100)).toEqual({ startKm: 45, endKm: 65 });
  });

  it('preserves the span while panning', () => {
    for (const dx of [-500, -37, 0, 12, 900]) {
      const w = panWindowByPixels(base, dx, chartWidth, 100);
      expect(w.endKm - w.startKm).toBeCloseTo(20, 6);
    }
  });

  it('parks against the trail start instead of running off it', () => {
    expect(panWindowByPixels(base, 1000, chartWidth, 100)).toEqual({ startKm: 0, endKm: 20 });
  });

  it('parks against the trail end instead of running off it', () => {
    expect(panWindowByPixels(base, -1000, chartWidth, 100)).toEqual({ startKm: 80, endKm: 100 });
  });

  it('is a no-op when fully zoomed out', () => {
    expect(panWindowByPixels({ startKm: 0, endKm: 100 }, -300, chartWidth, 100)).toEqual({
      startKm: 0,
      endKm: 100,
    });
  });

  it('returns the base window for degenerate layout/trail input', () => {
    expect(panWindowByPixels(base, 50, 0, 100)).toEqual(base);
    expect(panWindowByPixels(base, 50, chartWidth, 0)).toEqual(base);
    expect(panWindowByPixels({ startKm: 5, endKm: 5 }, 50, chartWidth, 100)).toEqual({
      startKm: 5,
      endKm: 5,
    });
  });
});

describe('zoomWindowAtFocal', () => {
  const layout = { left: 40, chartWidth: 200 };
  const total = 100;

  it('halves the span when zooming in 2x', () => {
    const w = zoomWindowAtFocal({ startKm: 0, endKm: 100 }, 2, 140, layout, total);
    expect(w.endKm - w.startKm).toBeCloseTo(50, 6);
  });

  it('keeps the km under the focal point pinned', () => {
    const base = { startKm: 20, endKm: 60 };
    const focalX = 140; // halfway across the plot → 40 km
    const focalKm = xToKm(focalX, base, layout);
    for (const scale of [0.5, 1, 1.7, 4, 20]) {
      const w = zoomWindowAtFocal(base, scale, focalX, layout, total);
      // Only pinned while the window has not been shifted off an end.
      if (w.startKm > 0 && w.endKm < total) {
        expect(xToKm(focalX, w, layout)).toBeCloseTo(focalKm, 6);
      }
    }
  });

  it('anchors on the left edge focal point', () => {
    const w = zoomWindowAtFocal({ startKm: 0, endKm: 100 }, 2, layout.left, layout, total);
    expect(w).toEqual({ startKm: 0, endKm: 50 });
  });

  it('anchors on the right edge focal point', () => {
    const w = zoomWindowAtFocal(
      { startKm: 0, endKm: 100 },
      2,
      layout.left + layout.chartWidth,
      layout,
      total,
    );
    expect(w).toEqual({ startKm: 50, endKm: 100 });
  });

  it('clamps a focal point in the y-axis gutter to the left edge', () => {
    const w = zoomWindowAtFocal({ startKm: 0, endKm: 100 }, 2, 0, layout, total);
    expect(w).toEqual({ startKm: 0, endKm: 50 });
  });

  it('floors the span at the minimum window', () => {
    const w = zoomWindowAtFocal({ startKm: 0, endKm: 100 }, 1000, 140, layout, total);
    expect(w.endKm - w.startKm).toBeCloseTo(MIN_WINDOW_KM, 6);
  });

  it('honours an explicit minimum window', () => {
    const w = zoomWindowAtFocal({ startKm: 0, endKm: 100 }, 1000, 140, layout, total, 5);
    expect(w.endKm - w.startKm).toBeCloseTo(5, 6);
  });

  it('caps zoom-out at the whole trail', () => {
    expect(zoomWindowAtFocal({ startKm: 40, endKm: 60 }, 0.01, 140, layout, total)).toEqual({
      startKm: 0,
      endKm: 100,
    });
  });

  it('never escapes [0, totalKm]', () => {
    for (const base of [
      { startKm: 0, endKm: 4 },
      { startKm: 96, endKm: 100 },
      { startKm: 48, endKm: 52 },
    ]) {
      for (const scale of [0.2, 0.9, 1.4, 8]) {
        for (const focalX of [40, 100, 240]) {
          const w = zoomWindowAtFocal(base, scale, focalX, layout, total);
          expect(w.startKm).toBeGreaterThanOrEqual(0);
          expect(w.endKm).toBeLessThanOrEqual(total + 1e-9);
          expect(w.endKm).toBeGreaterThan(w.startKm);
        }
      }
    }
  });

  it('clamps the span to a trail shorter than the minimum window', () => {
    expect(zoomWindowAtFocal({ startKm: 0, endKm: 0.5 }, 4, 140, layout, 0.5)).toEqual({
      startKm: 0,
      endKm: 0.5,
    });
  });

  it('returns the base window for degenerate input', () => {
    const base = { startKm: 10, endKm: 20 };
    expect(zoomWindowAtFocal(base, 2, 140, { left: 40, chartWidth: 0 }, total)).toEqual(base);
    expect(zoomWindowAtFocal(base, 2, 140, layout, 0)).toEqual(base);
    expect(zoomWindowAtFocal(base, 0, 140, layout, total)).toEqual(base);
  });
});

describe('buildProfileMarkers', () => {
  // A 100 px wide plot over a 0–100 km window, elevation domain 0–1000 m.
  const plot: MarkerPlot = {
    startKm: 0,
    endKm: 100,
    left: 0,
    chartWidth: 100,
    top: 0,
    chartHeight: 200,
    eleMin: 0,
    eleRange: 1000,
  };
  const resolve = (wp: { id: string }) =>
    wp.id === 'fav' ? { color: 'FAV', radius: 6 } : { color: 'STD', radius: 4 };

  it('places markers at their km/elevation pixel positions', () => {
    const markers = buildProfileMarkers(
      [{ id: 'a', type: 'water', totalDistance: 50, elevation: 500 }],
      plot,
      resolve,
    );
    expect(markers).toHaveLength(1);
    // 50 km → x=50; 500 m → y = top + height - (500/1000)*height = 100.
    expect(markers[0].x).toBeCloseTo(50, 6);
    expect(markers[0].y).toBeCloseTo(100, 6);
  });

  it('drops markers outside the window or without a distance', () => {
    const markers = buildProfileMarkers(
      [
        { id: 'before', type: 'water', totalDistance: -5, elevation: 100 },
        { id: 'after', type: 'water', totalDistance: 150, elevation: 100 },
        { id: 'nodist', type: 'water', elevation: 100 },
        { id: 'in', type: 'water', totalDistance: 25, elevation: 100 },
      ],
      plot,
      resolve,
    );
    expect(markers.map((m) => m.id)).toEqual(['in']);
  });

  it('applies resolved color + radius (favorite emphasis)', () => {
    const markers = buildProfileMarkers(
      [
        { id: 'fav', type: 'camp', totalDistance: 10, elevation: 0 },
        { id: 'std', type: 'camp', totalDistance: 20, elevation: 0 },
      ],
      plot,
      resolve,
    );
    expect(markers[0]).toMatchObject({ id: 'fav', color: 'FAV', radius: 6 });
    expect(markers[1]).toMatchObject({ id: 'std', color: 'STD', radius: 4 });
  });

  it('falls back to the floor when elevation is missing', () => {
    const markers = buildProfileMarkers(
      [{ id: 'a', type: 'water', totalDistance: 50 }],
      plot,
      resolve,
    );
    // ele = eleMin (0) → y at the plot floor (top + height = 200).
    expect(markers[0].y).toBeCloseTo(200, 6);
  });
});
