/**
 * Elevation backfill — the terrain-API lookup that rescues a GPX recorded
 * without `<ele>`, plus the re-derivation it triggers on a built trail.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyElevation,
  backfillElevation,
  estimateElevationRequests,
  interpolateBySampledDistance,
  planElevationSamples,
  trailElevationIsUsable,
  trailHasElevation,
  type ElevationFetch,
} from './elevation-backfill';
import { importGpx } from './gpx-import';

/** Points spaced ~110 m apart along a meridian. */
function line(count: number): { lat: number; lon: number }[] {
  return Array.from({ length: count }, (_, i) => ({ lat: -33 + i * 0.001, lon: 151 }));
}

/**
 * A fetch stub that answers with `elevationFor(lat)` and records every batch it
 * was asked about.
 */
function stubFetch(
  elevationFor: (lat: number) => number,
  onCall?: (batch: { latitude: number; longitude: number }[]) => void
): { fetch: ElevationFetch; batches: { latitude: number; longitude: number }[][] } {
  const batches: { latitude: number; longitude: number }[][] = [];
  const fetchImpl: ElevationFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as { locations: { latitude: number; longitude: number }[] };
    batches.push(body.locations);
    onCall?.(body.locations);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: body.locations.map(loc => ({
          latitude: loc.latitude,
          longitude: loc.longitude,
          elevation: elevationFor(loc.latitude),
        })),
      }),
    };
  };
  return { fetch: fetchImpl, batches };
}

/** A GPX with no `<ele>` at all — the case the backfill exists for. */
function flatGpx(count: number): string {
  const pts = line(count)
    .map(p => `<trkpt lat="${p.lat}" lon="${p.lon}"></trkpt>`)
    .join('');
  return `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">
    <metadata><name>No Elevation</name></metadata>
    <wpt lat="-32.995" lon="151"><name>Middle</name></wpt>
    <trk><name>Flat</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

describe('backfillElevation', () => {
  it('batches the lookup and returns one elevation per point', async () => {
    const { fetch, batches } = stubFetch(() => 100);
    const points = line(250);

    const elevations = await backfillElevation(points, { fetch, batchSize: 100, delayMs: 0 });

    expect(elevations).toHaveLength(250);
    expect(batches.map(b => b.length)).toEqual([100, 100, 50]);
    expect(batches[0][0]).toEqual({ latitude: -33, longitude: 151 });
    expect(elevations.every(e => e === 100)).toBe(true);
  });

  it('reports progress after every batch', async () => {
    const { fetch } = stubFetch(() => 10);
    const onProgress = vi.fn();

    await backfillElevation(line(120), { fetch, batchSize: 50, delayMs: 0, onProgress });

    expect(onProgress.mock.calls).toEqual([
      [50, 120],
      [100, 120],
      [120, 120],
    ]);
  });

  it('samples long tracks and interpolates the rest', async () => {
    const { fetch, batches } = stubFetch(lat => (lat + 33) * 10000); // 0 → 1000 m over the line
    const points = line(1000);

    const elevations = await backfillElevation(points, {
      fetch,
      batchSize: 100,
      delayMs: 0,
      maxSamples: 100,
    });

    // Only the sampled points were looked up...
    const lookedUp = batches.reduce((sum, b) => sum + b.length, 0);
    expect(lookedUp).toBe(100);
    // ...but every point got an elevation, interpolated along the line.
    expect(elevations).toHaveLength(1000);
    expect(elevations[0]).toBeCloseTo(0, 5);
    expect(elevations[999]).toBeCloseTo(9990, 0);
    // A point between two samples lands on the straight line between them.
    expect(elevations[5]).toBeCloseTo(50, 0);
    expect(elevations[505]).toBeCloseTo(5050, 0);
  });

  it('aborts between batches without applying anything', async () => {
    const controller = new AbortController();
    const { fetch, batches } = stubFetch(() => 5, () => controller.abort());

    await expect(
      backfillElevation(line(300), {
        fetch,
        batchSize: 100,
        delayMs: 0,
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(batches).toHaveLength(1);
  });

  it('refuses to start when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch, batches } = stubFetch(() => 5);

    await expect(
      backfillElevation(line(10), { fetch, delayMs: 0, signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(batches).toHaveLength(0);
  });

  it('throws on an HTTP failure', async () => {
    const failing: ElevationFetch = async () => ({
      ok: false,
      status: 504,
      statusText: 'Gateway Timeout',
      json: async () => ({}),
    });

    await expect(backfillElevation(line(5), { fetch: failing, delayMs: 0 })).rejects.toThrow(/504/);
  });

  it('throws when the response does not line up with the request', async () => {
    const short: ElevationFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ elevation: 1 }] }),
    });

    await expect(backfillElevation(line(5), { fetch: short, delayMs: 0 })).rejects.toThrow(
      /1 results for 5 points/
    );
  });

  it('treats DEM voids as no data rather than NaN', async () => {
    const voids: ElevationFetch = async (_url, init) => {
      const body = JSON.parse(init.body) as { locations: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: body.locations.map(() => ({ elevation: null })) }),
      };
    };

    const elevations = await backfillElevation(line(4), { fetch: voids, delayMs: 0 });
    expect(elevations).toEqual([0, 0, 0, 0]);
  });

  it('returns an empty array for an empty track without calling out', async () => {
    const { fetch, batches } = stubFetch(() => 1);
    expect(await backfillElevation([], { fetch })).toEqual([]);
    expect(batches).toHaveLength(0);
  });
});

describe('planElevationSamples', () => {
  it('keeps every point when the track is under the cap', () => {
    expect(planElevationSamples([0, 10, 20], 100)).toEqual([0, 1, 2]);
  });

  it('spreads samples by distance, not by index', () => {
    // Points 0-8 are packed into the first 10 m (a stationary GPS), 9 is 1 km on.
    const cumulative = [0, 1, 2, 3, 4, 5, 6, 7, 8, 1000];
    const samples = planElevationSamples(cumulative, 3);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(9);
    // Index-even sampling would have picked 0, 4, 9; distance-even picks the
    // far point for the middle sample too.
    expect(samples).toEqual([0, 9]);
  });

  it('always anchors both ends', () => {
    const cumulative = Array.from({ length: 500 }, (_, i) => i * 10);
    const samples = planElevationSamples(cumulative, 50);
    expect(samples).toHaveLength(50);
    expect(samples[0]).toBe(0);
    expect(samples[49]).toBe(499);
  });

  it('survives a zero-length track', () => {
    expect(planElevationSamples([0, 0, 0, 0], 2)).toEqual([0, 3]);
  });
});

describe('interpolateBySampledDistance', () => {
  it('clamps outside the sampled range and interpolates inside it', () => {
    const cumulative = [0, 100, 200, 300, 400];
    const out = interpolateBySampledDistance(cumulative, [0, 4], [0, 400]);
    expect(out).toEqual([0, 100, 200, 300, 400]);
  });

  it('handles repeated coordinates without dividing by zero', () => {
    const out = interpolateBySampledDistance([0, 0, 0], [0, 2], [10, 20]);
    expect(out.every(Number.isFinite)).toBe(true);
  });
});

describe('estimateElevationRequests', () => {
  it('counts batches of the sampled points', () => {
    expect(estimateElevationRequests(0)).toBe(0);
    expect(estimateElevationRequests(1)).toBe(1);
    expect(estimateElevationRequests(250)).toBe(3);
    // Capped by maxSamples, so a huge track is still 20 requests.
    expect(estimateElevationRequests(100000)).toBe(20);
    expect(estimateElevationRequests(300, { batchSize: 50 })).toBe(6);
  });
});

describe('trailHasElevation', () => {
  it('reads an all-zero profile as missing data', () => {
    expect(trailHasElevation([{ ele: 0 }, { ele: 0 }])).toBe(false);
    expect(trailHasElevation([{ ele: 0 }, { ele: 12 }])).toBe(true);
    expect(trailHasElevation([])).toBe(false);
    expect(trailHasElevation([{ ele: null }, { ele: undefined }])).toBe(false);
  });
});

describe('trailElevationIsUsable', () => {
  it('prefers the explicit marker, falling back to the track', () => {
    const flat = { track: { points: [{ ele: 0 }, { ele: 0 }] } };
    const hilly = { track: { points: [{ ele: 0 }, { ele: 50 }] } };

    expect(trailElevationIsUsable(flat)).toBe(false);
    expect(trailElevationIsUsable(hilly)).toBe(true);
    expect(trailElevationIsUsable({ config: { elevationSource: 'none' }, ...hilly })).toBe(false);
    expect(trailElevationIsUsable({ config: { elevationSource: 'backfilled' }, ...flat })).toBe(true);
  });
});

describe('applyElevation', () => {
  it('marks the trail and re-derives ascent, display points and waypoint stats', async () => {
    const { trail, report } = importGpx(flatGpx(40));
    expect(report.hasElevation).toBe(false);
    expect(trail.config.elevationSource).toBe('none');
    expect(trail.track.totalAscent).toBe(0);
    expect(trail.waypoints).toHaveLength(1);
    expect(trail.waypoints[0].elevation).toBe(0);

    // A steady climb: 25 m per 0.001° of latitude southward.
    const { fetch } = stubFetch(lat => (lat + 33) * 25000);
    const elevations = await backfillElevation(trail.track.points, { fetch, delayMs: 0 });
    const updated = applyElevation(trail, elevations);

    expect(updated.config.elevationSource).toBe('backfilled');
    expect(updated.track.totalAscent).toBeGreaterThan(500);
    expect(updated.track.totalDescent).toBe(0);
    // The profile climbs from ~0 to ~975 m; the ends are pulled in a little by
    // the smoothing window, which is exactly what it is there to do.
    expect(updated.track.points[0].ele).toBeLessThan(50);
    expect(updated.track.points[39].ele).toBeGreaterThan(900);
    expect(updated.track.points[20].ele).toBeCloseTo(500, -1);
    // Distances are untouched — no coordinate moved.
    expect(updated.track.points.map(p => p.dist)).toEqual(trail.track.points.map(p => p.dist));
    expect(updated.track.totalDistance).toBe(trail.track.totalDistance);
    // The mid-track waypoint now sits at a real height, with a real climb behind it.
    expect(updated.waypoints[0].elevation).toBeGreaterThan(0);
    expect(updated.waypoints[0].totalAscent).toBeGreaterThan(0);
    expect(updated.waypoints[0].id).toBe(trail.waypoints[0].id);
    // The display copy tracks the full-resolution elevations.
    expect(trailHasElevation(updated.track.displayPoints)).toBe(true);
    // ...and the input trail was left alone.
    expect(trail.track.totalAscent).toBe(0);
    expect(trail.config.elevationSource).toBe('none');
  });

  it('updates a simplified display copy, which is a strict subset of the track', async () => {
    // 4,000 points forces buildTrail's display simplification (target 3,000).
    const { trail } = importGpx(flatGpx(4000), { targetPoints: 0 });
    expect(trail.track.displayPoints.length).toBeLessThan(trail.track.points.length);

    const { fetch } = stubFetch(lat => (lat + 33) * 1000);
    const elevations = await backfillElevation(trail.track.points, {
      fetch,
      delayMs: 0,
      maxSamples: 200,
    });
    const updated = applyElevation(trail, elevations);

    expect(updated.track.displayPoints).toHaveLength(trail.track.displayPoints.length);
    expect(trailHasElevation(updated.track.displayPoints)).toBe(true);
    // Every display point still carries the elevation of its full-resolution twin.
    const byCoord = new Map(updated.track.points.map(p => [`${p.lat},${p.lon}`, p.ele]));
    for (const dp of updated.track.displayPoints) {
      expect(dp.ele).toBe(byCoord.get(`${dp.lat},${dp.lon}`));
    }
  });

  it('rejects an elevation array that does not line up with the track', () => {
    const { trail } = importGpx(flatGpx(10));
    expect(() => applyElevation(trail, [1, 2, 3])).toThrow(/3 values for 10 track points/);
  });
});
