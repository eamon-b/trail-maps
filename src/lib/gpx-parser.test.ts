/**
 * Semantics of the unified GPX parser.
 *
 * The build pipeline used to have its own jsdom parser (`parseGpxNode` in
 * scripts/build-trails.ts) that disagreed with this one on `<rte>` fallback,
 * name defaults and waypoint descriptions. These tests pin the unified
 * behaviour that both now share, plus the `<wpt><type>` round trip.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { parseGpx, generateGpx, GPX_MAX_POINT_COUNT } from './gpx-parser';
import { flattenGpx } from './trail-ingest';
import type { GpxWaypoint } from './types';

const FIXTURES = resolve(__dirname, '../../tests/fixtures/gpx');
const fixture = (name: string): string => readFileSync(resolve(FIXTURES, `${name}.gpx`), 'utf-8');

describe('parseGpx', () => {
  it('parses tracks, segments, waypoints and the metadata name', () => {
    const data = parseGpx(fixture('simple-trail'));

    expect(data.metadataName).toBe('Simple Test Trail');
    expect(data.tracks).toHaveLength(1);
    expect(data.tracks[0].name).toBe('Main Track');
    expect(data.tracks[0].segments).toHaveLength(1);
    expect(data.tracks[0].segments[0].points[0]).toEqual({
      lat: -33.8688,
      lon: 151.2093,
      ele: 10,
      time: null,
    });
    expect(data.waypoints).toHaveLength(3);
    expect(data.waypoints[0].name).toBe('Start');
  });

  it('reads <wpt><ele> (the old pipeline parser dropped it)', () => {
    const data = parseGpx(fixture('waypoint-types'));
    expect(data.waypoints[0].ele).toBe(12.5);
    // Waypoint without <ele> keeps the lenient 0 default.
    expect(data.waypoints[1].ele).toBe(0);
  });

  it('reads an explicit <wpt><type>', () => {
    const data = parseGpx(fixture('waypoint-types'));
    expect(data.waypoints[0].type).toBe('mountain');
    expect(data.waypoints[1].type).toBeUndefined();
  });

  it('defaults missing <ele> to 0 rather than failing', () => {
    const data = parseGpx(fixture('no-elevation'));
    expect(data.tracks[0].segments[0].points.map(p => p.ele)).toEqual([0, 0, 0]);
  });

  it('coerces a non-numeric <ele> to 0 instead of NaN', () => {
    // A NaN here poisons ascent totals and Naismith time estimates downstream,
    // and hasElevation's Number.isFinite check would suppress any warning.
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/1">
        <trk><name>Bad Ele</name><trkseg>
          <trkpt lat="1" lon="2"><ele>N/A</ele></trkpt>
          <trkpt lat="1.1" lon="2.1"><ele>unknown</ele></trkpt>
          <trkpt lat="1.2" lon="2.2"><ele>42</ele></trkpt>
        </trkseg></trk>
      </gpx>`;
    const eles = parseGpx(xml).tracks[0].segments[0].points.map(p => p.ele);
    expect(eles).toEqual([0, 0, 42]);
    expect(eles.every(e => Number.isFinite(e))).toBe(true);
  });

  it('parses <rte> as routes', () => {
    const data = parseGpx(fixture('route-only'));
    expect(data.tracks).toHaveLength(0);
    expect(data.routes).toHaveLength(1);
    expect(data.routes[0].name).toBe('Planned Route');
    expect(data.routes[0].points).toHaveLength(4);
  });

  it('rejects an unparseable coordinate instead of plotting 0,0', () => {
    expect(() => parseGpx(fixture('bad-coordinates'))).toThrow(/Invalid lat/);
  });

  it('rejects malformed XML', () => {
    expect(() => parseGpx('<gpx><trk></gpx>')).toThrow(/Invalid GPX XML/);
  });

  it('enforces the file-size cap', () => {
    expect(() => parseGpx(fixture('simple-trail'), undefined, { maxFileSize: 10 })).toThrow(
      /too large/
    );
  });

  it('enforces the point-count cap', () => {
    expect(() => parseGpx(fixture('simple-trail'), undefined, { maxPointCount: 3 })).toThrow(
      /too many points/
    );
    expect(GPX_MAX_POINT_COUNT).toBe(100000);
  });

  it('accepts namespace-prefixed elements', () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://example.com/x">
        <trk><name>Prefixed</name><trkseg>
          <trkpt lat="1" lon="2"><ele>3</ele></trkpt>
        </trkseg></trk>
      </gpx>`;
    const data = parseGpx(xml);
    expect(data.tracks[0].segments[0].points[0].ele).toBe(3);
  });
});

describe('flattenGpx', () => {
  it('flattens segments into one point list per track', () => {
    const gpx = flattenGpx(parseGpx(fixture('multi-track')));
    expect(gpx.tracks.map(t => t.name)).toEqual(['Main Route', 'Alt Detour', 'ST: Waterfall Lookout']);
    expect(gpx.tracks[0].points).toHaveLength(3);
  });

  it('falls back to <rte> points when the file has no <trk>', () => {
    const gpx = flattenGpx(parseGpx(fixture('route-only')));
    expect(gpx.name).toBe('Route Only Trail');
    expect(gpx.tracks).toHaveLength(1);
    expect(gpx.tracks[0].name).toBe('Route');
    expect(gpx.tracks[0].points).toHaveLength(4);
  });

  it('classifies waypoint names and strips the prefix', () => {
    const gpx = flattenGpx(parseGpx(fixture('simple-trail')));
    const campsite = gpx.waypoints.find(w => w.name === 'Campsite One');
    expect(campsite?.type).toBe('campsite');
  });

  it('prefers an explicit <type> over name-based classification', () => {
    const gpx = flattenGpx(parseGpx(fixture('waypoint-types')));
    expect(gpx.waypoints[0]).toMatchObject({ name: 'Bay Lookout', type: 'mountain' });
    // No <type>: the `C:` prefix still drives the classification.
    expect(gpx.waypoints[1]).toMatchObject({ name: 'Cliff Camp', type: 'campsite' });
  });

  it('leaves an absent <desc> undefined rather than empty', () => {
    const gpx = flattenGpx(parseGpx(fixture('simple-trail')));
    expect(gpx.waypoints[0].description).toBeUndefined();
  });

  it('names an unnamed track "Unnamed"', () => {
    const gpx = flattenGpx(
      parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>')
    );
    expect(gpx.tracks[0].name).toBe('Unnamed');
  });
});

describe('generateGpx → parseGpx round trip', () => {
  it('preserves an explicit waypoint type', () => {
    const waypoints: GpxWaypoint[] = [
      { lat: -33.5, lon: 151.5, ele: 42, name: 'Tank Hill', desc: 'On the ridge', type: 'water-tank' },
    ];
    const xml = generateGpx('Round Trip', [{ lat: -33.5, lon: 151.5, ele: 42, time: null }], waypoints);

    expect(xml).toContain('<type>water-tank</type>');

    const reparsed = parseGpx(xml);
    expect(reparsed.waypoints[0]).toEqual({
      lat: -33.5,
      lon: 151.5,
      ele: 42,
      name: 'Tank Hill',
      desc: 'On the ridge',
      type: 'water-tank',
    });
  });

  it('survives flattening without re-deriving the type from the cleaned name', () => {
    const xml = generateGpx(
      'Round Trip',
      [{ lat: -33.5, lon: 151.5, ele: 0, time: null }],
      [{ lat: -33.5, lon: 151.5, ele: 0, name: 'Cliff Camp', desc: '', type: 'water-tank' }]
    );
    const gpx = flattenGpx(parseGpx(xml));
    expect(gpx.waypoints[0]).toMatchObject({ name: 'Cliff Camp', type: 'water-tank' });
  });

  it('omits <type> when the waypoint has none', () => {
    const xml = generateGpx(
      'Round Trip',
      [],
      [{ lat: 1, lon: 2, ele: 0, name: 'Plain', desc: '' }]
    );
    expect(xml).not.toContain('<type>');
  });
});
