import { getMinMax, niceAxisTicks } from '../axis';

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
