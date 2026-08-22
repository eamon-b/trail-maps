/**
 * Smoke test for the shared GPX import pipeline under the mobile toolchain.
 *
 * The point is not to re-test `importGpx` (that lives in src/lib/*.test.ts and
 * runs under Vitest) but to prove that `@lib/gpx-import` and its
 * fast-xml-parser adapter resolve and run through Metro/Babel — Hermes has no
 * DOMParser, so this adapter is the only way the app can read a GPX file.
 */

import { importGpx } from '@lib/gpx-import';
import { fxpXmlAdapter } from '@lib/xml-adapter-fxp';

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
