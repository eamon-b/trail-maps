import { distanceAxisTicks, elevationAxis, getMinMax, niceAxisTicks } from '../axis';

describe('getMinMax', () => {
  it('returns 0/0 for an empty array', () => {
    expect(getMinMax([])).toEqual({ min: 0, max: 0 });
  });

  it('finds the extremes', () => {
    expect(getMinMax([3, -1, 7, 2])).toEqual({ min: -1, max: 7 });
  });

  it('handles a single value', () => {
    expect(getMinMax([42])).toEqual({ min: 42, max: 42 });
  });
});

describe('niceAxisTicks', () => {
  it('returns [] for a non-positive target count', () => {
    expect(niceAxisTicks(0, 100, 0)).toEqual([]);
    expect(niceAxisTicks(0, 100, -3)).toEqual([]);
  });

  it('returns [min] for a zero/negative range', () => {
    expect(niceAxisTicks(50, 50, 4)).toEqual([50]);
    expect(niceAxisTicks(50, 10, 4)).toEqual([50]);
  });

  it('produces round, evenly spaced ticks within range', () => {
    const ticks = niceAxisTicks(0, 100, 5);
    expect(ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('snaps to 1/2/5 step families', () => {
    // range 47 over 5 → rough step ~9.4 → nice step 10
    const ticks = niceAxisTicks(3, 47, 5);
    expect(ticks[0]).toBe(10);
    expect(ticks.every((t, i) => i === 0 || t - ticks[i - 1] === 10)).toBe(true);
  });

  it('avoids floating-point artifacts', () => {
    const ticks = niceAxisTicks(0, 1, 5);
    for (const t of ticks) {
      expect(Number.isFinite(t)).toBe(true);
      // no long fractional tails
      expect(t).toBeCloseTo(Math.round(t * 1e6) / 1e6, 9);
    }
  });
});

describe('distanceAxisTicks', () => {
  it('labels km ticks in km, positioned in km', () => {
    const ticks = distanceAxisTicks(0, 100, 'km', 5);
    expect(ticks.map((t) => t.label)).toEqual(['0', '20', '40', '60', '80', '100']);
    expect(ticks.map((t) => t.pos)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('recomputes ticks for a zoomed window, all inside it', () => {
    const ticks = distanceAxisTicks(122.4, 124.4, 'km', 5);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (const t of ticks) {
      expect(t.pos).toBeGreaterThanOrEqual(122.4 - 1e-9);
      expect(t.pos).toBeLessThanOrEqual(124.4 + 1e-9);
    }
    // 2 km over ~5 steps → 0.5 km steps, labelled to a consistent one decimal.
    expect(ticks.map((t) => t.label)).toEqual(['122.5', '123.0', '123.5', '124.0']);
  });

  it('keeps sub-km labels distinct at maximum zoom', () => {
    // A 1 km window → 0.2 km steps; a fixed one-decimal format is enough here,
    // but the labels must never collapse into duplicates.
    const labels = distanceAxisTicks(50, 51, 'km', 5).map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels).toContain('50.2');
  });

  it('adds decimals when the step needs them', () => {
    const labels = distanceAxisTicks(10, 10.2, 'km', 5).map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    // 0.05 km steps → two decimals.
    expect(labels).toContain('10.05');
  });

  it('labels nice miles but keeps positions in km', () => {
    // ~161 km ≈ 100 mi → nice mi ticks 0/20/40/60/80/100 at their km offsets.
    const ticks = distanceAxisTicks(0, 160.9344, 'mi', 5);
    expect(ticks.map((t) => t.label)).toEqual(['0', '20', '40', '60', '80', '100']);
    // 20 mi sits at 32.19 km, 100 mi at 160.93 km.
    expect(ticks[1].pos).toBeCloseTo(32.187, 2);
    expect(ticks[ticks.length - 1].pos).toBeCloseTo(160.934, 2);
  });
});

describe('elevationAxis', () => {
  it('produces metre ticks and a padded metre domain for metric', () => {
    const axis = elevationAxis(90, 410, 'km', 4);
    expect(axis.ticks.map((t) => t.label)).toEqual(['100', '200', '300', '400']);
    expect(axis.ticks.map((t) => t.pos)).toEqual([100, 200, 300, 400]);
    // Domain pads out to enclose the data extremes.
    expect(axis.min).toBe(90);
    expect(axis.max).toBe(410);
  });

  it('labels feet but positions ticks in metres for imperial', () => {
    // 0–320 m ≈ 0–1050 ft → nice ft ticks 0/200/400/600/800/1000.
    const axis = elevationAxis(0, 320, 'mi', 4);
    expect(axis.ticks.map((t) => t.label)).toEqual(['0', '200', '400', '600', '800', '1000']);
    // 1000 ft → 304.8 m.
    expect(axis.ticks[axis.ticks.length - 1].pos).toBeCloseTo(304.8, 1);
  });
});
