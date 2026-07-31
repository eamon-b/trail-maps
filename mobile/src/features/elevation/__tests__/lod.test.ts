import {
  buildLod,
  buildLodLevels,
  selectLodLevel,
  selectWindowPoints,
  sliceByKm,
  LOD_COARSE_SAMPLES,
  LOD_FINE_SAMPLES,
  type ProfilePoint,
} from '../lod';

function pt(dist: number, ele: number): ProfilePoint {
  return { lat: 0, lon: 0, dist, ele };
}

/** A gentle ramp with a controllable length. */
function ramp(n: number): ProfilePoint[] {
  return Array.from({ length: n }, (_, i) => pt(i, 100 + Math.sin(i / 10) * 5));
}

describe('buildLod', () => {
  it('returns a copy when already at/under target', () => {
    const pts = ramp(50);
    const out = buildLod(pts, 500);
    expect(out).toHaveLength(50);
    expect(out).not.toBe(pts);
    expect(out).toEqual(pts);
  });

  it('downsamples large inputs to roughly the target count', () => {
    const out = buildLod(ramp(5000), 500);
    expect(out.length).toBeLessThanOrEqual(520);
    expect(out.length).toBeGreaterThan(100);
  });

  it('keeps output sorted by distance', () => {
    const out = buildLod(ramp(5000), 500);
    for (let i = 1; i < out.length; i++) {
      expect(out[i].dist).toBeGreaterThanOrEqual(out[i - 1].dist);
    }
  });

  it('always retains the first and last points', () => {
    const pts = ramp(5000);
    const out = buildLod(pts, 500);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  it('preserves a lone spike (extreme) that stride-sampling would drop', () => {
    const pts = ramp(5000);
    // Inject a sharp spike at an index unlikely to be hit by even striding.
    const spikeIdx = 2317;
    pts[spikeIdx] = pt(spikeIdx, 9999);
    const out = buildLod(pts, 500);
    const maxEle = Math.max(...out.map((p) => p.ele));
    expect(maxEle).toBe(9999);
    expect(out.some((p) => p.dist === spikeIdx && p.ele === 9999)).toBe(true);
  });

  it('preserves a lone trough (minimum)', () => {
    const pts = ramp(5000);
    pts[1234] = pt(1234, -500);
    const out = buildLod(pts, 500);
    expect(Math.min(...out.map((p) => p.ele))).toBe(-500);
  });

  it('handles a degenerate zero-span input without throwing', () => {
    const flat = Array.from({ length: 1000 }, () => pt(5, 100));
    const out = buildLod(flat, 100);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(1000);
  });

  it('returns [] for empty input', () => {
    expect(buildLod([], 500)).toEqual([]);
  });
});

describe('buildLodLevels', () => {
  it('builds coarse and fine levels with the fine one denser', () => {
    const { coarse, fine } = buildLodLevels(ramp(6000));
    expect(coarse.length).toBeLessThanOrEqual(LOD_COARSE_SAMPLES + 20);
    expect(fine.length).toBeLessThanOrEqual(LOD_FINE_SAMPLES + 20);
    expect(fine.length).toBeGreaterThan(coarse.length);
  });
});

describe('selectLodLevel', () => {
  it('uses coarse for the full trail', () => {
    expect(selectLodLevel(100, 100)).toBe('coarse');
  });

  it('switches to fine once zoomed past the threshold', () => {
    expect(selectLodLevel(20, 100)).toBe('fine');
    expect(selectLodLevel(70, 100)).toBe('coarse');
  });

  it('is safe for a zero-length trail', () => {
    expect(selectLodLevel(0, 0)).toBe('coarse');
  });
});

describe('sliceByKm', () => {
  // dist 0..99 at 1 km spacing.
  const pts = ramp(100);

  it('returns [] for empty input', () => {
    expect(sliceByKm([], 0, 10)).toEqual([]);
  });

  it('keeps one neighbour on each side of the window', () => {
    const out = sliceByKm(pts, 10, 20);
    expect(out[0].dist).toBe(9);
    expect(out[out.length - 1].dist).toBe(21);
  });

  it('covers every point inside the window', () => {
    const out = sliceByKm(pts, 10.5, 20.5);
    expect(out[0].dist).toBe(10);
    expect(out[out.length - 1].dist).toBe(21);
    for (let km = 11; km <= 20; km++) {
      expect(out.some((p) => p.dist === km)).toBe(true);
    }
  });

  it('clamps at the track ends instead of over-reading', () => {
    const head = sliceByKm(pts, 0, 3);
    expect(head[0].dist).toBe(0);
    const tail = sliceByKm(pts, 96, 99);
    expect(tail[tail.length - 1].dist).toBe(99);
  });

  it('returns the whole track for a window covering it', () => {
    expect(sliceByKm(pts, -50, 500)).toHaveLength(pts.length);
  });

  it('orders a reversed window', () => {
    expect(sliceByKm(pts, 20, 10)).toEqual(sliceByKm(pts, 10, 20));
  });

  it('returns a single neighbour for a window past the end', () => {
    const out = sliceByKm(pts, 200, 300);
    expect(out.map((p) => p.dist)).toEqual([99]);
  });
});

describe('selectWindowPoints', () => {
  // 6000-point track (dist 0..5999 km) — well over the fine LOD budget.
  const raw = ramp(6000);
  const levels = buildLodLevels(raw);

  it('uses an LOD level when the raw slice blows the budget', () => {
    const out = selectWindowPoints(raw, levels, 0, 5999, 5999);
    expect(out.length).toBeLessThanOrEqual(LOD_COARSE_SAMPLES + 4);
  });

  it('draws the raw track once a zoomed slice fits the budget', () => {
    const out = selectWindowPoints(raw, levels, 100, 101, 5999);
    // Raw 1 km slice: dists 99..102 (window + one neighbour each side).
    expect(out.map((p) => p.dist)).toEqual([99, 100, 101, 102]);
  });

  it('shows more detail zoomed in than the LOD level would', () => {
    const zoomed = selectWindowPoints(raw, levels, 1000, 1010, 5999);
    const fromLevel = sliceByKm(levels.fine, 1000, 1010);
    expect(zoomed.length).toBeGreaterThan(fromLevel.length);
  });

  it('respects an explicit budget', () => {
    const out = selectWindowPoints(raw, levels, 0, 100, 5999, 10);
    expect(out.length).toBeLessThan(102);
    expect(out.length).toBeGreaterThan(0);
  });

  it('never exceeds the raw slice for a small track', () => {
    const small = ramp(50);
    const smallLevels = buildLodLevels(small);
    expect(selectWindowPoints(small, smallLevels, 0, 49, 49)).toHaveLength(50);
  });

  it('is safe for an empty track', () => {
    expect(selectWindowPoints([], buildLodLevels<ProfilePoint>([]), 0, 10, 10)).toEqual([]);
  });
});
