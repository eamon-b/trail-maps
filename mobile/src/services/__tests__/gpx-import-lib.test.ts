/**
 * Smoke test for the shared import libraries under the mobile toolchain.
 *
 * The point is not to re-test them (that lives in `src/lib/*.test.ts` and runs
 * under Vitest) but to prove that every `@lib` module the import flow reaches
 * resolves and *runs* through Metro/Babel with the RN resolver. Three of them
 * are easy to get wrong in ways Vitest never sees:
 *
 * - `@lib/gpx-import` + `@lib/xml-adapter-fxp` — Hermes has no DOMParser, so
 *   the fast-xml-parser adapter is the only way the app can read a GPX file,
 *   and `fast-xml-parser` has to be a *mobile* dependency, not just a root one.
 * - `@lib/trail-handoff` — the web → mobile bridge, reached from
 *   `features/import/import-gpx.ts`.
 * - `@lib/elevation-backfill` — reached from
 *   `features/import/elevation-backfill-flow.ts` and from the plan screen; it
 *   touches `fetch` and `AbortSignal`, so it is exercised here rather than just
 *   imported.
 *
 * **One caveat worth knowing.** Jest resolves `fast-xml-parser` to its
 * pre-bundled CommonJS build (`lib/fxp.cjs`, all six of its dependencies
 * inlined), while Metro has package `exports` enabled and takes the ESM source
 * (`src/fxp.js`) with those dependencies resolved separately. So a green run
 * here proves the CJS tree works, not the exact module graph Hermes loads. The
 * thing that proves *that* is `npx expo export --platform android`, which runs
 * `hermesc` over the real graph. Run it after touching this dependency.
 */

import { importGpx } from '@lib/gpx-import';
import { fxpXmlAdapter } from '@lib/xml-adapter-fxp';
import {
  handoffImportReport,
  parseHandoffJson,
  serializeTrailHandoff,
} from '@lib/trail-handoff';
import {
  applyElevation,
  backfillElevation,
  estimateElevationRequests,
  trailElevationIsUsable,
} from '@lib/elevation-backfill';

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Phone Import</name></metadata>
  <wpt lat="-33.8688" lon="151.2093"><name>C: First Camp</name></wpt>
  <trk>
    <name>Day 1</name>
    <trkseg>
      <trkpt lat="-33.8688" lon="151.2093"><ele>10</ele></trkpt>
      <trkpt lat="-33.8700" lon="151.2100"><ele>25</ele></trkpt>
      <trkpt lat="-33.8750" lon="151.2150"><ele>40</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** The degraded case the backfill offer exists for: coordinates, no `<ele>`. */
const NO_ELEVATION_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>Flat</name>
    <trkseg>
      <trkpt lat="-33.8688" lon="151.2093"/>
      <trkpt lat="-33.8700" lon="151.2100"/>
      <trkpt lat="-33.8750" lon="151.2150"/>
    </trkseg>
  </trk>
</gpx>`;

describe('@lib/gpx-import on mobile', () => {
  it('parses a GPX file through the fast-xml-parser adapter', () => {
    const { trail, report } = importGpx(SAMPLE_GPX, { adapter: fxpXmlAdapter });

    expect(report.name).toBe('Phone Import');
    expect(report.trailId).toMatch(/^u_[a-z0-9]+$/);
    expect(report.hasElevation).toBe(true);
    expect(trail.track.points).toHaveLength(3);
    expect(trail.config.direction).toBeDefined();
    expect(trail.waypoints[0]).toMatchObject({ name: 'First Camp', type: 'campsite' });
    expect(trail.waypoints[0].id).toMatch(/^uw_/);
  });

  it('rejects malformed XML instead of building a broken trail', () => {
    expect(() => importGpx('<gpx><trk></gpx>', { adapter: fxpXmlAdapter })).toThrow(/Invalid GPX XML/);
  });

  it('never mints a server-known id', () => {
    const { trail } = importGpx(SAMPLE_GPX, { adapter: fxpXmlAdapter });
    expect(trail.config.id.startsWith('u_')).toBe(true);
    expect(trail.waypoints.every(w => w.id?.startsWith('uw_'))).toBe(true);
  });
});

describe('@lib/trail-handoff on mobile', () => {
  it('round-trips a trail through the handoff envelope', () => {
    const { trail } = importGpx(SAMPLE_GPX, { adapter: fxpXmlAdapter });

    // This is exactly what `features/import/import-gpx.ts` does for a
    // `.tracknotes.json` file: serialize on web, parse here, synthesize a
    // report so the review screen never learns which branch it got.
    const reread = parseHandoffJson(serializeTrailHandoff(trail));

    expect(reread.config.id).toBe(trail.config.id);
    expect(reread.config.source).toBe('imported');
    expect(reread.track.points).toHaveLength(trail.track.points.length);

    const report = handoffImportReport(reread);
    expect(report.trailId).toBe(trail.config.id);
    expect(report.hasElevation).toBe(true);
    expect(report.waypointCount).toBe(reread.waypoints.length);
  });

  it('rejects a file that is not a handoff with a readable message', () => {
    expect(() => parseHandoffJson('{"format":"something-else"}')).toThrow(
      /not a Tracknotes trail file/,
    );
    expect(() => parseHandoffJson('not json at all')).toThrow(/not valid JSON/);
  });
});

describe('@lib/elevation-backfill on mobile', () => {
  it('fetches a profile through an injected fetch and applies it', async () => {
    const { trail } = importGpx(NO_ELEVATION_GPX, { adapter: fxpXmlAdapter });
    expect(trailElevationIsUsable(trail)).toBe(false);
    expect(estimateElevationRequests(trail.track.points.length)).toBeGreaterThan(0);

    const fetchMock = jest.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body)) as { locations: unknown[] };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ results: body.locations.map((_, i) => ({ elevation: 100 + i * 10 })) }),
      };
    });

    const elevations = await backfillElevation(trail.track.points, {
      fetch: fetchMock as never,
      delayMs: 0,
    });
    expect(fetchMock).toHaveBeenCalled();

    const filled = applyElevation(trail, elevations);
    expect(filled.config.elevationSource).toBe('backfilled');
    expect(trailElevationIsUsable(filled)).toBe(true);
  });

  it('aborts with an AbortError rather than a DOMException Hermes lacks', async () => {
    const { trail } = importGpx(NO_ELEVATION_GPX, { adapter: fxpXmlAdapter });
    const controller = new AbortController();
    controller.abort();

    await expect(
      backfillElevation(trail.track.points, {
        fetch: (() => {
          throw new Error('should never be called');
        }) as never,
        signal: controller.signal,
        delayMs: 0,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
