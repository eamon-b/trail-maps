/**
 * The trail page's downloads, as text: the CSV's quoting and the GPX's
 * structure. `waypoint-filter.test.ts` drives the same writers through the
 * page's buttons.
 */

import { describe, it, expect } from 'vitest';
import { buildGpx, csvQuote, type GpxExportTrail } from './trail-export';

describe('csvQuote', () => {
  it('quotes a field and doubles any quote inside it', () => {
    expect(csvQuote('Camp "Two", north')).toBe('"Camp ""Two"", north"');
    expect(csvQuote(undefined)).toBe('""');
  });

  it('neutralises a value a spreadsheet would run as a formula', () => {
    expect(csvQuote('=HYPERLINK("http://evil.test","x")')).toBe(
      `"'=HYPERLINK(""http://evil.test"",""x"")"`,
    );
    for (const lead of ['+', '-', '@', '\t', '\r']) {
      expect(csvQuote(`${lead}1+1`)).toBe(`"'${lead}1+1"`);
    }
  });

  it('leaves ordinary text alone, a formula character later in it included', () => {
    expect(csvQuote('Hut = water tank')).toBe('"Hut = water tank"');
    expect(csvQuote('Mt. Lofty')).toBe('"Mt. Lofty"');
  });
});

/** Six points along a parallel, with a break before index 3 (a ferry). */
function trail(over: Partial<GpxExportTrail> = {}): GpxExportTrail {
  const points = [0, 1, 2, 10, 11, 12].map(i => ({ lat: -41, lon: 174 + i / 100, ele: 10 + i }));
  return {
    config: { name: 'Strait <Walk>', region: 'NZ' },
    track: {
      points,
      totalDistance: 4,
      breaks: [{ index: 3, displayIndex: 3, km: 2, straightLineKm: 6, fromTrack: 'North', toTrack: 'South' }],
    },
    waypoints: [{ name: 'Wharf', type: 'gap', lat: -41, lon: 174.02 }],
    ...over,
  };
}

const parse = (xml: string): Document => new DOMParser().parseFromString(xml, 'application/xml');

describe('buildGpx', () => {
  it('writes one trkseg per stretch, so a GPS app never draws across a route break', () => {
    const doc = parse(buildGpx(trail()));
    expect(doc.querySelector('parsererror')).toBeNull();
    const tracks = doc.querySelectorAll('trk');
    expect(tracks).toHaveLength(1);
    const segments = [...tracks[0].querySelectorAll('trkseg')];
    expect(segments.map(seg => seg.querySelectorAll('trkpt').length)).toEqual([3, 3]);
    expect(segments[1].querySelector('trkpt')?.getAttribute('lon')).toBe(String(174 + 10 / 100));
    expect(doc.querySelector('trk > name')?.textContent).toBe('Strait <Walk>');
  });

  it('keeps a continuous route in one segment', () => {
    const doc = parse(buildGpx(trail({ track: { ...trail().track, breaks: undefined } })));
    expect(doc.querySelectorAll('trkseg')).toHaveLength(1);
    expect(doc.querySelectorAll('trkpt')).toHaveLength(6);
  });

  it('exports alternates and side trips as typed tracks of their own', () => {
    const doc = parse(
      buildGpx(
        trail({
          alternates: [{ name: 'Ridge Alt', type: 'alternate', points: [{ lat: -41, lon: 174 }, { lat: -41.1, lon: 174 }] }],
          sideTrips: [
            { name: 'Summit', type: 'side-trip', points: [{ lat: -41, lon: 174.1, ele: 900 }] },
            { name: 'No geometry', type: 'side-trip', points: [] },
          ],
        }),
      ),
    );
    const tracks = [...doc.querySelectorAll('trk')];
    expect(tracks.map(trk => trk.querySelector('name')?.textContent)).toEqual([
      'Strait <Walk>',
      'Ridge Alt',
      'Summit',
    ]);
    expect(tracks.map(trk => trk.querySelector('type')?.textContent ?? null)).toEqual([
      null,
      'alternate',
      'side-trip',
    ]);
    expect(tracks[2].querySelector('ele')?.textContent).toBe('900');
  });
});
