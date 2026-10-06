/**
 * fast-xml-parser vs DOMParser parity.
 *
 * The mobile app parses GPX through fast-xml-parser (Hermes has no DOMParser)
 * while web and the build script go through the DOM. If the two adapters ever
 * disagree, the same file would produce different trails on different
 * platforms — so every fixture has to come out deep-equal through both.
 *
 * The DOM side here is jsdom's DOMParser, installed globally by vitest's jsdom
 * environment; the build script's adapter (scripts/lib/xml-adapter-jsdom.ts)
 * wraps the same jsdom implementation through the same `wrapDomDocument`.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { parseGpx } from './gpx-parser';
import { flattenGpx } from './trail-ingest';
import { domParserXmlAdapter } from './xml-adapter';
import { fxpXmlAdapter } from './xml-adapter-fxp';

const FIXTURES = resolve(__dirname, '../../tests/fixtures/gpx');
const fixtureNames = readdirSync(FIXTURES).filter(f => f.endsWith('.gpx'));

describe('XML adapter parity', () => {
  it('has fixtures to compare', () => {
    expect(fixtureNames.length).toBeGreaterThan(4);
  });

  for (const name of fixtureNames) {
    const xml = readFileSync(resolve(FIXTURES, name), 'utf-8');

    it(`${name}: fast-xml-parser matches DOMParser`, () => {
      let domResult: unknown;
      let domThrew: string | null = null;
      try {
        domResult = parseGpx(xml, domParserXmlAdapter);
      } catch (e) {
        domThrew = e instanceof Error ? e.message : String(e);
      }

      let fxpResult: unknown;
      let fxpThrew: string | null = null;
      try {
        fxpResult = parseGpx(xml, fxpXmlAdapter);
      } catch (e) {
        fxpThrew = e instanceof Error ? e.message : String(e);
      }

      // Both must agree on whether the file is acceptable at all.
      expect(fxpThrew === null).toBe(domThrew === null);
      if (domThrew !== null) return;

      expect(fxpResult).toEqual(domResult);
    });
  }

  it('agrees after flattening too (names, types, rte fallback)', () => {
    const flattenable = [
      'simple-trail.gpx',
      'route-only.gpx',
      'waypoint-types.gpx',
      'multi-track.gpx',
      'waypoint-extensions.gpx',
    ];
    for (const name of flattenable) {
      const xml = readFileSync(resolve(FIXTURES, name), 'utf-8');
      expect(flattenGpx(parseGpx(xml, fxpXmlAdapter))).toEqual(
        flattenGpx(parseGpx(xml, domParserXmlAdapter))
      );
    }
  });

  it('resolves namespace-prefixed tags the same way', () => {
    const xml = `<?xml version="1.0"?>
      <gpx xmlns="http://www.topografix.com/GPX/1/1" xmlns:gpxx="http://example.com/x">
        <metadata><gpxx:name>Prefixed Trail</gpxx:name></metadata>
        <trk><name>T</name><trkseg>
          <trkpt lat="1" lon="2"><ele>3</ele><time>2020-01-01T00:00:00Z</time></trkpt>
        </trkseg></trk>
      </gpx>`;
    expect(parseGpx(xml, fxpXmlAdapter)).toEqual(parseGpx(xml, domParserXmlAdapter));
  });

  it('decodes entities the same way', () => {
    const xml = `<gpx><wpt lat="1" lon="2"><name>Bill &amp; Ben&apos;s &lt;Hut&gt;</name></wpt></gpx>`;
    const viaFxp = parseGpx(xml, fxpXmlAdapter);
    expect(viaFxp.waypoints[0].name).toBe("Bill & Ben's <Hut>");
    expect(viaFxp).toEqual(parseGpx(xml, domParserXmlAdapter));
  });

  it('reads a field from the element itself, not from something nested in it', () => {
    const xml = readFileSync(resolve(FIXTURES, 'nested-fields.gpx'), 'utf-8');
    for (const adapter of [fxpXmlAdapter, domParserXmlAdapter]) {
      const gpx = parseGpx(xml, adapter);
      expect(gpx.metadataName).toBe('Nested Fields Trail');
      expect(gpx.waypoints.map(w => [w.name, w.type])).toEqual([
        ['Ridge Hut', 'hut'],
        ['Tank With No Type', undefined],
      ]);
      expect(gpx.tracks[0].name).toBe('');
      expect(gpx.tracks[0].segments[0].points[0]).toMatchObject({ ele: 10, time: null });
    }
  });

  it('decodes numeric character references the same way, and only once', () => {
    const xml = readFileSync(resolve(FIXTURES, 'character-references.gpx'), 'utf-8');
    const viaFxp = parseGpx(xml, fxpXmlAdapter);
    expect(viaFxp.metadataName).toBe('O\'Connor&Sons Track');
    expect(viaFxp.waypoints[0].name).toBe('Bill\'s Hut – café');
    expect(viaFxp.waypoints[0].desc).toBe('Literal &#39; stays literal; so does &amp; in CDATA');
    expect(viaFxp.tracks[0].name).toBe('Day 1 \u{1F3D5}');
    expect(viaFxp).toEqual(parseGpx(xml, domParserXmlAdapter));
  });

  it('decodes character references in attributes too', () => {
    const xml = `<gpx><wpt lat="&#45;33.5" lon="151"><name>x</name></wpt></gpx>`;
    expect(parseGpx(xml, fxpXmlAdapter).waypoints[0].lat).toBe(-33.5);
    expect(parseGpx(xml, fxpXmlAdapter)).toEqual(parseGpx(xml, domParserXmlAdapter));
  });

  it('both adapters reject malformed XML', () => {
    expect(() => parseGpx('<gpx><trk></gpx>', fxpXmlAdapter)).toThrow(/Invalid GPX XML/);
    expect(() => parseGpx('<gpx><trk></gpx>', domParserXmlAdapter)).toThrow(/Invalid GPX XML/);
  });

  it('both adapters reject a bad coordinate', () => {
    const xml = readFileSync(resolve(FIXTURES, 'bad-coordinates.gpx'), 'utf-8');
    expect(() => parseGpx(xml, fxpXmlAdapter)).toThrow(/Invalid lat/);
    expect(() => parseGpx(xml, domParserXmlAdapter)).toThrow(/Invalid lat/);
  });
});
