import {
  buildLod,
  buildLodLevels,
  selectLodLevel,
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
