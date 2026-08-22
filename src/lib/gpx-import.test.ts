/**
 * `importGpx` — the runtime ingestion entry point used by the web upload page
 * and the mobile document picker.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { hashString, importGpx, mintImportedWaypointIds } from './gpx-import';
import { fxpXmlAdapter } from './xml-adapter-fxp';

const FIXTURES = resolve(__dirname, '../../tests/fixtures/gpx');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, `${name}.gpx`), 'utf-8');

/** A synthetic GPX with configurable elevation, for the report flags. */
function syntheticGpx(eles: number[]): string {
  const pts = eles
    .map((ele, i) => `<trkpt lat="${-33 + i * 0.001}" lon="${151 + i * 0.001}"><ele>${ele}</ele></trkpt>`)
    .join('');
  return `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">
    <metadata><name>Synthetic</name></metadata>
    <trk><name>Synth</name><trkseg>${pts}</trkseg></trk></gpx>`;
}

describe('importGpx', () => {
  it('builds a usable trail from a simple file', () => {
    const { trail, report } = importGpx(fixture('simple-trail'));

    expect(trail.track.points.length).toBe(19);
    expect(trail.waypoints.map(w => w.name)).toEqual(['Start', 'Campsite One', 'End']);
    expect(trail.config.name).toBe('Simple Test Trail');
    expect(trail.config.source).toBe('imported');
    expect(trail.config.direction).toEqual({ default: 'Start → End', reversed: 'End → Start' });
    expect(trail.config.lengthKm).toBeGreaterThan(0);
    expect(report.name).toBe('Simple Test Trail');
    expect(report.tracksFound).toBe(1);
    expect(report.tracksCombined).toBe(1);
    expect(report.waypointCount).toBe(3);
    expect(report.offTrailWaypointCount).toBe(0);
    expect(report.simplified).toBe(false);
  });

  it('mints u_ / uw_ ids that can never collide with registry ids', () => {
    const { trail, report } = importGpx(fixture('simple-trail'));

    expect(report.trailId).toMatch(/^u_[a-z0-9]+$/);
    expect(trail.config.id).toBe(report.trailId);
    for (const wp of trail.waypoints) {
      expect(wp.id).toMatch(/^uw_[a-z0-9]+$/);
    }
    expect(new Set(trail.waypoints.map(w => w.id)).size).toBe(trail.waypoints.length);
  });

  it('gives the same id to the same file every time', () => {
    const a = importGpx(fixture('simple-trail'));
    const b = importGpx(fixture('simple-trail'));
    expect(a.report.trailId).toBe(b.report.trailId);
    expect(a.trail.waypoints.map(w => w.id)).toEqual(b.trail.waypoints.map(w => w.id));

    const other = importGpx(fixture('waypoint-types'));
    expect(other.report.trailId).not.toBe(a.report.trailId);
  });

  it('honours an explicit name and id', () => {
    const { trail, report } = importGpx(fixture('simple-trail'), { name: 'My Walk', id: 'u_fixed' });
    expect(report.name).toBe('My Walk');
    expect(trail.config.name).toBe('My Walk');
    expect(trail.config.shortName).toBe('My Walk');
    expect(report.trailId).toBe('u_fixed');
  });

  it('falls back to the track name, then a generic name', () => {
    const noMetadata = '<gpx><trk><name>Track Name Only</name><trkseg>' +
      '<trkpt lat="-33" lon="151"/><trkpt lat="-33.01" lon="151.01"/></trkseg></trk></gpx>';
    expect(importGpx(noMetadata).report.name).toBe('Track Name Only');

    const anonymous = '<gpx><trk><trkseg>' +
      '<trkpt lat="-33" lon="151"/><trkpt lat="-33.01" lon="151.01"/></trkseg></trk></gpx>';
    expect(importGpx(anonymous).report.name).toBe('Imported trail');
  });

  it('flags a file with no elevation data', () => {
    const { trail, report } = importGpx(fixture('no-elevation'));
    expect(report.hasElevation).toBe(false);
    expect(report.elevationLooksNoisy).toBe(false);
    expect(trail.track.totalAscent).toBe(0);
    expect(report.warnings.some(w => /No elevation data/.test(w))).toBe(true);
  });

  it('does not flag clean elevation as noisy', () => {
    // A smooth 0 → 1000m climb.
    const eles = Array.from({ length: 200 }, (_, i) => i * 5);
    const { report } = importGpx(syntheticGpx(eles));
    expect(report.hasElevation).toBe(true);
    expect(report.elevationLooksNoisy).toBe(false);
  });

  it('flags barometric noise and keeps the ascent total sane', () => {
    // A gentle climb buried under ±40m sample-to-sample jitter.
    const eles = Array.from({ length: 400 }, (_, i) => i * 0.5 + (i % 2 === 0 ? 40 : -40));
    const { trail, report } = importGpx(syntheticGpx(eles));

    expect(report.hasElevation).toBe(true);
    expect(report.elevationLooksNoisy).toBe(true);
    expect(report.warnings.some(w => /noisy/.test(w))).toBe(true);

    const rawAscent = importGpx(syntheticGpx(eles), { cleanElevation: false }).trail.track.totalAscent;
    expect(rawAscent).toBeGreaterThan(10000);
    expect(trail.track.totalAscent).toBeLessThan(rawAscent / 5);
  });

  it('reports gaps when several tracks are chained into one route', () => {
    const far = `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">
      <trk><name>Leg 1</name><trkseg>
        <trkpt lat="-33.0" lon="151.0"><ele>10</ele></trkpt>
        <trkpt lat="-33.01" lon="151.0"><ele>12</ele></trkpt>
      </trkseg></trk>
      <trk><name>Leg 2</name><trkseg>
        <trkpt lat="-33.2" lon="151.0"><ele>14</ele></trkpt>
        <trkpt lat="-33.21" lon="151.0"><ele>16</ele></trkpt>
      </trkseg></trk>
    </gpx>`;
    const { report } = importGpx(far);

    expect(report.tracksFound).toBe(2);
    expect(report.tracksCombined).toBe(2);
    expect(report.gapWarnings.length).toBeGreaterThan(0);
    expect(report.warnings.some(w => /gap between/.test(w))).toBe(true);
  });

  it('handles an <rte>-only file', () => {
    const { trail, report } = importGpx(fixture('route-only'));
    expect(trail.track.points).toHaveLength(4);
    expect(report.name).toBe('Route Only Trail');
    expect(report.tracksFound).toBe(1);
  });

  it('respects an explicit <wpt><type>', () => {
    const { trail } = importGpx(fixture('waypoint-types'));
    const lookout = trail.waypoints.find(w => w.name === 'Bay Lookout');
    expect(lookout?.type).toBe('mountain');
    expect(trail.waypoints.find(w => w.name === 'Cliff Camp')?.type).toBe('campsite');
  });

  it('simplifies to the point budget and reports it', () => {
    const eles = Array.from({ length: 800 }, (_, i) => 100 + Math.sin(i / 7) * 30);
    const { trail, report } = importGpx(syntheticGpx(eles), { targetPoints: 200 });

    expect(report.simplified).toBe(true);
    expect(report.sourcePointCount).toBe(800);
    expect(trail.track.points.length).toBeLessThan(300);
    expect(report.pointCount).toBe(trail.track.points.length);
    // Track indices still address the built track after simplification.
    for (const wp of trail.waypoints) expect(trail.track.points[wp.trackIndex]).toBeDefined();
  });

  it('keeps full resolution when targetPoints is 0', () => {
    const eles = Array.from({ length: 300 }, () => 100);
    const { trail, report } = importGpx(syntheticGpx(eles), { targetPoints: 0 });
    expect(report.simplified).toBe(false);
    expect(trail.track.points).toHaveLength(300);
  });

  it('rejects a file with no track or route points', () => {
    expect(() => importGpx(fixture('empty-track'))).toThrow(/no track or route points/);
  });

  it('rejects a bad coordinate', () => {
    expect(() => importGpx(fixture('bad-coordinates'))).toThrow(/Invalid lat/);
  });

  it('honours the parser caps', () => {
    expect(() => importGpx(fixture('simple-trail'), { limits: { maxPointCount: 2 } })).toThrow(
      /too many points/
    );
  });

  it('produces the same trail through the fast-xml-parser adapter', () => {
    const viaDom = importGpx(fixture('simple-trail'));
    const viaFxp = importGpx(fixture('simple-trail'), { adapter: fxpXmlAdapter });
    expect(viaFxp.trail).toEqual(viaDom.trail);
    expect(viaFxp.report).toEqual(viaDom.report);
  });
});

describe('hashString', () => {
  it('is stable, short and base36', () => {
    expect(hashString('hello')).toBe(hashString('hello'));
    expect(hashString('hello')).toMatch(/^[a-z0-9]{12}$/);
  });

  it('separates similar inputs', () => {
    const ids = new Set(['a', 'b', 'ab', 'ba', ''].map(hashString));
    expect(ids.size).toBe(5);
  });

  it('needs no crypto or Node globals', () => {
    expect(typeof hashString('x')).toBe('string');
  });
});

describe('mintImportedWaypointIds', () => {
  it('namespaces ids under uw_ and keeps them unique per position', () => {
    const config = {
      id: 'u_abc',
      name: 'T',
      shortName: 'T',
      region: 'Imported',
      lengthKm: 0,
      gpxFile: '',
    };
    const ids = mintImportedWaypointIds(
      [
        { name: 'Same', lat: 1, lon: 2, type: 'waypoint' },
        { name: 'Same', lat: 1, lon: 2, type: 'waypoint' },
      ],
      config
    );
    expect(ids[0]).toMatch(/^uw_/);
    expect(ids[0]).not.toBe(ids[1]);
    expect(mintImportedWaypointIds([{ name: 'Same', lat: 1, lon: 2, type: 'waypoint' }], config)[0]).toBe(
      ids[0]
    );
  });
});
