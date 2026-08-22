/**
 * The mobile side of elevation backfill: keeping the trail and the import
 * report in step.
 *
 * The lookup, the sampling and the interpolation are all `@lib` concerns and
 * are covered under Vitest (src/lib/elevation-backfill.test.ts). What is unique
 * here is the pairing — that the report the review screen renders and
 * `saveImport` persists ends up describing the trail that was actually built,
 * and that a failed lookup leaves the original import completely untouched so
 * the user can still save without elevation.
 *
 * `global.fetch` is stubbed rather than injected: the flow deliberately does not
 * expose a fetch seam, since the screen has no business choosing one.
 */

import { importGpx } from '@lib/gpx-import';
import { fxpXmlAdapter } from '@lib/xml-adapter-fxp';
import {
  backfillImportElevation,
  elevationRequestEstimate,
} from '../elevation-backfill-flow';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A track climbing steadily east — and, crucially, with no `<ele>` anywhere. */
const FLAT_GPX = buildGpx(12);

function buildGpx(pointCount: number): string {
  const points = Array.from(
    { length: pointCount },
    (_, i) => `<trkpt lat="${-33.87 - i * 0.01}" lon="${151.2 + i * 0.01}"></trkpt>`,
  ).join('\n      ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>No Elevation Walk</name></metadata>
  <trk><trkseg>
      ${points}
  </trkseg></trk>
</gpx>`;
}

function importFlat() {
  return importGpx(FLAT_GPX, { adapter: fxpXmlAdapter });
}

/** Open-Elevation's response shape, climbing 40 m per requested location. */
function elevationResponse(body: string) {
  const parsed = JSON.parse(body) as { locations: unknown[] };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      results: parsed.locations.map((_, i) => ({ elevation: 100 + i * 40 })),
    }),
  };
}

const mockFetch = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  (global as unknown as { fetch: unknown }).fetch = mockFetch;
});

afterEach(() => {
  delete (global as unknown as { fetch?: unknown }).fetch;
});

// ---------------------------------------------------------------------------

describe('backfillImportElevation', () => {
  it('applies a fetched profile and brings the report with it', async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) =>
      elevationResponse(init.body),
    );

    const imported = importFlat();
    // Precondition: this is exactly the import the "Fetch elevation" button offers on.
    expect(imported.report.hasElevation).toBe(false);
    expect(imported.trail.config.elevationSource).toBe('none');

    const backfilled = await backfillImportElevation(imported);

    expect(backfilled.trail.config.elevationSource).toBe('backfilled');
    expect(backfilled.trail.track.totalAscent).toBeGreaterThan(0);
    expect(backfilled.trail.track.points[0].ele).toBeGreaterThan(0);
    // saveImport persists this straight into the registry row.
    expect(backfilled.report.hasElevation).toBe(true);
  });

  it('drops the stale no-elevation warning and says where the data came from', async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) =>
      elevationResponse(init.body),
    );

    const imported = importFlat();
    expect(imported.report.warnings.some((w) => w.startsWith('No elevation data'))).toBe(true);

    const { report } = await backfillImportElevation(imported);

    expect(report.warnings.some((w) => w.startsWith('No elevation data'))).toBe(false);
    expect(report.warnings.some((w) => /Open-Elevation/.test(w))).toBe(true);
  });

  it('carries the rest of the report through unchanged', async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) =>
      elevationResponse(init.body),
    );

    const imported = importFlat();
    const { report } = await backfillImportElevation(imported);

    expect(report.trailId).toBe(imported.report.trailId);
    expect(report.name).toBe(imported.report.name);
    expect(report.pointCount).toBe(imported.report.pointCount);
    expect(report.waypointCount).toBe(imported.report.waypointCount);
  });

  it('forwards progress so the screen can count points', async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) =>
      elevationResponse(init.body),
    );

    const imported = importFlat();
    const progress: [number, number][] = [];

    await backfillImportElevation(imported, {
      onProgress: (done, total) => progress.push([done, total]),
    });

    // One batch for a 12-point track: done and total both land on the point count.
    expect(progress).toEqual([[12, 12]]);
  });

  it('rejects on a service failure and leaves the import untouched', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 503, statusText: 'Service Unavailable' });

    const imported = importFlat();

    await expect(backfillImportElevation(imported)).rejects.toThrow(/503/);

    // The review screen still has something to save.
    expect(imported.report.hasElevation).toBe(false);
    expect(imported.report.warnings.some((w) => w.startsWith('No elevation data'))).toBe(true);
    expect(imported.trail.config.elevationSource).toBe('none');
    expect(imported.trail.track.points.every((p) => !p.ele)).toBe(true);
  });

  it('rejects with an AbortError when the user leaves the screen', async () => {
    mockFetch.mockImplementation(async (_url: string, init: { body: string }) =>
      elevationResponse(init.body),
    );

    const controller = new AbortController();
    controller.abort();
    const imported = importFlat();

    await expect(
      backfillImportElevation(imported, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(imported.trail.config.elevationSource).toBe('none');
  });
});

describe('elevationRequestEstimate', () => {
  it('is one request for a short track', () => {
    expect(elevationRequestEstimate(importFlat().trail)).toBe(1);
  });

  it('counts batches, and caps with the sampler', () => {
    expect(elevationRequestEstimate({ track: { points: new Array(250) } })).toBe(3);
    // Beyond the 2,000-sample cap the figure stops growing — 20 requests, always.
    expect(elevationRequestEstimate({ track: { points: new Array(60_000) } })).toBe(20);
  });
});
