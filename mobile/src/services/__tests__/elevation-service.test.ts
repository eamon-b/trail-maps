import {
  pickElevationSamplePoints,
  fetchElevations,
  dropNullElevationSamples,
  backfillTrackElevation,
  applyElevationToTrail,
  ELEVATION_BATCH_SIZE,
  MAX_ELEVATION_SAMPLES,
} from '../elevation-service';
import type { Trail, TrackPoint } from '../../lib/trail-utils';

function buildPoints(count: number, totalKm: number): TrackPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    lat: -35 - i * 0.001,
    lon: 148 + i * 0.001,
    ele: 0,
    dist: (totalKm * i) / (count - 1),
  }));
}

describe('pickElevationSamplePoints', () => {
  it('returns every point when under the sample cap', () => {
    const points = buildPoints(10, 9);
    const { dists, coords } = pickElevationSamplePoints(points);

    expect(dists).toEqual(points.map((p) => p.dist));
    expect(coords).toHaveLength(10);
    expect(coords[3]).toEqual({ lat: points[3].lat, lon: points[3].lon });
  });

  it('caps dense tracks at the max sample count and keeps endpoints', () => {
    const points = buildPoints(5000, 100);
    const { dists, coords } = pickElevationSamplePoints(points);

    expect(dists.length).toBeLessThanOrEqual(MAX_ELEVATION_SAMPLES);
    expect(coords.length).toBe(dists.length);
    expect(dists[0]).toBe(0);
    expect(dists[dists.length - 1]).toBe(100);
    // Evenly spaced by distance: gaps close to total/(samples-1)
    const expectedGap = 100 / (MAX_ELEVATION_SAMPLES - 1);
    for (let i = 1; i < dists.length; i++) {
      expect(dists[i]).toBeGreaterThan(dists[i - 1]);
      expect(Math.abs(dists[i] - dists[i - 1] - expectedGap)).toBeLessThan(expectedGap);
    }
  });

  it('respects a custom max sample count', () => {
    const points = buildPoints(1000, 50);
    const { dists } = pickElevationSamplePoints(points, 10);
    expect(dists.length).toBeLessThanOrEqual(10);
    expect(dists[0]).toBe(0);
    expect(dists[dists.length - 1]).toBe(50);
  });

  it('returns empty arrays for an empty track', () => {
    expect(pickElevationSamplePoints([])).toEqual({ dists: [], coords: [] });
  });
});

describe('fetchElevations', () => {
  beforeEach(() => {
    (global.fetch as unknown) = jest.fn();
  });

  function coordList(count: number) {
    return Array.from({ length: count }, (_, i) => ({ lat: -35 - i * 0.01, lon: 148 + i * 0.01 }));
  }

  it('fetches a single batch for up to 100 coordinates', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ elevation: Array.from({ length: 100 }, (_, i) => i) }),
    });

    const result = await fetchElevations(coordList(100));

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(100);
    expect(result[42]).toBe(42);

    const url = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(url).toContain('api.open-meteo.com/v1/elevation');
    // CSV coordinate params
    const params = new URLSearchParams(url.split('?')[1]);
    expect(params.get('latitude')!.split(',')).toHaveLength(100);
    expect(params.get('longitude')!.split(',')).toHaveLength(100);
  });

  it('splits requests into batches of 100', async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      const params = new URLSearchParams(url.split('?')[1]);
      const count = params.get('latitude')!.split(',').length;
      return { ok: true, json: async () => ({ elevation: new Array(count).fill(7) }) };
    });

    const progress: [number, number][] = [];
    const result = await fetchElevations(coordList(250), (done, total) => progress.push([done, total]));

    expect(global.fetch).toHaveBeenCalledTimes(3);
    const batchSizes = (global.fetch as jest.Mock).mock.calls.map((call) => {
      const params = new URLSearchParams((call[0] as string).split('?')[1]);
      return params.get('latitude')!.split(',').length;
    });
    expect(batchSizes).toEqual([ELEVATION_BATCH_SIZE, ELEVATION_BATCH_SIZE, 50]);
    expect(result).toHaveLength(250);
    expect(progress).toEqual([[100, 250], [200, 250], [250, 250]]);
  });

  it('throws on an HTTP error', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'rate limited',
    });

    await expect(fetchElevations(coordList(5))).rejects.toThrow('Elevation API error: 429');
  });

  it('throws when the response shape is wrong', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ elevation: [1, 2] }), // wrong length
    });

    await expect(fetchElevations(coordList(5))).rejects.toThrow('unexpected response');
  });

  it('preserves null elevations (DEM gaps) verbatim', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({ elevation: [100, null, 300] }),
    });

    expect(await fetchElevations(coordList(3))).toEqual([100, null, 300]);
  });
});

describe('dropNullElevationSamples', () => {
  it('drops null-elevation samples, keeping dists/eles aligned', () => {
    const { dists, eles } = dropNullElevationSamples([0, 5, 10, 15], [100, null, 300, null]);
    expect(dists).toEqual([0, 10]);
    expect(eles).toEqual([100, 300]);
  });

  it('does not fabricate ascent across a null-DEM gap', () => {
    // Three samples with a null in the middle. Zero-filling the gap would make
    // the profile climb 0->100 then 100->0 then 0->200 (fake ~300m of ascent).
    // Dropping the null lets the interpolator run straight 100->200 (0 ascent).
    const dists = [0, 5, 10];
    const rawEles: (number | null)[] = [100, null, 200];
    const { dists: vd, eles: ve } = dropNullElevationSamples(dists, rawEles);

    const points: TrackPoint[] = buildPoints(11, 10);
    const filled = backfillTrackElevation(points, vd, ve);

    let ascent = 0;
    let descent = 0;
    for (let i = 1; i < filled.length; i++) {
      const d = filled[i].ele - filled[i - 1].ele;
      if (d > 0) ascent += d;
      else descent += Math.abs(d);
    }
    // Monotonic 100 -> 200 across the whole track: 100m ascent, no descent,
    // and no phantom dip at the null sample.
    expect(descent).toBe(0);
    expect(ascent).toBeCloseTo(100, 5);
    filled.forEach((p) => expect(p.ele).toBeGreaterThanOrEqual(100));
  });
});

describe('backfillTrackElevation', () => {
  const point = (dist: number): TrackPoint => ({ lat: -35, lon: 148, ele: 0, dist });

  it('linearly interpolates between samples', () => {
    const result = backfillTrackElevation(
      [point(0), point(2.5), point(5), point(7.5), point(10)],
      [0, 10],
      [100, 200],
    );

    expect(result.map((p) => p.ele)).toEqual([100, 125, 150, 175, 200]);
  });

  it('clamps points outside the sampled range', () => {
    const result = backfillTrackElevation(
      [point(0), point(1), point(9), point(10)],
      [2, 8],
      [50, 350],
    );

    expect(result[0].ele).toBe(50);
    expect(result[1].ele).toBe(50);
    expect(result[2].ele).toBe(350);
    expect(result[3].ele).toBe(350);
  });

  it('interpolates across multiple segments and rounds to 0.1m', () => {
    const result = backfillTrackElevation(
      [point(0), point(1), point(2), point(3)],
      [0, 2, 3],
      [0, 100, 40],
    );

    expect(result.map((p) => p.ele)).toEqual([0, 50, 100, 40]);

    const rounded = backfillTrackElevation([point(1)], [0, 3], [0, 100]);
    expect(rounded[0].ele).toBe(33.3);
  });

  it('does not mutate the input points', () => {
    const input = [point(0), point(5)];
    backfillTrackElevation(input, [0, 5], [10, 20]);
    expect(input[0].ele).toBe(0);
    expect(input[1].ele).toBe(0);
  });

  it('throws on empty or mismatched samples', () => {
    expect(() => backfillTrackElevation([point(0)], [], [])).toThrow();
    expect(() => backfillTrackElevation([point(0)], [0, 1], [5])).toThrow();
  });
});

describe('applyElevationToTrail', () => {
  function flatTrail(): Trail {
    const points: TrackPoint[] = [
      { lat: -35.0, lon: 148.0, ele: 0, dist: 0 },
      { lat: -35.01, lon: 148.01, ele: 0, dist: 5 },
      { lat: -35.02, lon: 148.02, ele: 0, dist: 10 },
    ];
    return {
      config: {
        id: 'custom-test',
        name: 'Test',
        shortName: 'TEST',
        region: 'Custom',
        lengthKm: 10,
        direction: { default: 'Start to End', reversed: 'End to Start' },
      },
      track: {
        points,
        displayPoints: [points[0], points[2]].map((p) => ({ ...p })),
        totalDistance: 10,
        totalAscent: 0,
        totalDescent: 0,
      },
      waypoints: [
        {
          id: 'wp-0', name: 'Start', lat: -35.0, lon: 148.0, type: 'endpoint',
          elevation: 0, distance: 0, totalDistance: 0, ascent: 0, descent: 0,
          totalAscent: 0, totalDescent: 0, trackIndex: 0,
        },
        {
          id: 'wp-1', name: 'End', lat: -35.02, lon: 148.02, type: 'endpoint',
          elevation: 0, distance: 10, totalDistance: 10, ascent: 0, descent: 0,
          totalAscent: 0, totalDescent: 0, trackIndex: 2,
        },
      ],
      alternates: [],
      sideTrips: [],
    };
  }

  it('backfills points, recomputes totals, and updates waypoints', () => {
    const trail = flatTrail();
    const result = applyElevationToTrail(trail, [0, 5, 10], [100, 300, 250]);

    expect(result.track.points.map((p) => p.ele)).toEqual([100, 300, 250]);
    expect(result.track.displayPoints!.map((p) => p.ele)).toEqual([100, 250]);
    expect(result.track.totalAscent).toBe(200);
    expect(result.track.totalDescent).toBe(50);

    // Waypoint stats re-run (elevation + segment ascent/descent)
    expect(result.waypoints[0].elevation).toBe(100);
    expect(result.waypoints[1].elevation).toBe(250);
    expect(result.waypoints[1].ascent).toBe(200);
    expect(result.waypoints[1].descent).toBe(50);
    expect(result.waypoints[1].totalAscent).toBe(200);
    expect(result.waypoints[1].totalDescent).toBe(50);

    // Distances untouched
    expect(result.track.totalDistance).toBe(10);
    expect(result.waypoints[1].totalDistance).toBe(10);

    // Input not mutated
    expect(trail.track.points[0].ele).toBe(0);
    expect(trail.track.totalAscent).toBe(0);
    expect(trail.waypoints[1].elevation).toBe(0);
  });
});
