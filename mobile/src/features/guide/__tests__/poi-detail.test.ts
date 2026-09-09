/**
 * The POI detail screen's pure helpers: the maps hand-off URL per platform,
 * and the standing promise that only the shared summariser mints links.
 */

import { summarisePoiTags } from '@lib/poi-display';
import { mapsUrlFor, poiDetailLines } from '../poi-detail';

describe('mapsUrlFor', () => {
  it('uses the geo: scheme on Android, with a labelled pin', () => {
    expect(mapsUrlFor(-34.9285, 138.6007, 'Mount Lofty', 'android')).toBe(
      'geo:-34.9285,138.6007?q=-34.9285,138.6007(Mount%20Lofty)',
    );
  });

  it('uses the maps: scheme on iOS', () => {
    expect(mapsUrlFor(-34.9285, 138.6007, 'Mount Lofty', 'ios')).toBe(
      'maps:?ll=-34.9285,138.6007&q=Mount%20Lofty',
    );
  });

  it('falls back to an OpenStreetMap map view on any other platform', () => {
    expect(mapsUrlFor(-34.9285, 138.6007, 'Mount Lofty', 'web')).toBe(
      'https://www.openstreetmap.org/?mlat=-34.9285&mlon=138.6007#map=16/-34.9285/138.6007',
    );
  });

  it('encodes a label that would otherwise break out of the query', () => {
    // An OSM `name` is free text: "&", "#" and the closing ")" of the geo:
    // pin syntax all have to survive as literal characters.
    const label = 'Bob & Jan’s Tank (#3)';
    const android = mapsUrlFor(-34, 138, label, 'android');
    const ios = mapsUrlFor(-34, 138, label, 'ios');

    expect(android).toBe(
      'geo:-34,138?q=-34,138(Bob%20%26%20Jan%E2%80%99s%20Tank%20(%233))',
    );
    expect(ios).toBe('maps:?ll=-34,138&q=Bob%20%26%20Jan%E2%80%99s%20Tank%20(%233)');
    // No raw separator leaks into the query portion.
    expect(ios.split('&q=')[1]).not.toMatch(/[&#]/);
  });
});

describe('poiDetailLines', () => {
  it('is the shared summariser, so the screen and the web page agree', () => {
    const tags = { amenity: 'drinking_water', operator: 'SA Water' };
    expect(poiDetailLines({ tags })).toEqual(summarisePoiTags(tags));
  });

  it('gives a javascript: website no href, so the screen has nothing to open', () => {
    const lines = poiDetailLines({
      // The untrusted tag under test: an OSM `website` can hold anything.
      tags: { amenity: 'cafe', website: 'javascript:alert(1)' },
    });
    const website = lines.find((line) => line.label === 'Website');

    expect(website).toEqual({ label: 'Website', value: 'javascript:alert(1)' });
    expect(website?.href).toBeUndefined();
  });

  it('links only the tags the shared guards cleared', () => {
    const lines = poiDetailLines({
      tags: {
        amenity: 'cafe',
        website: 'example.com',
        phone: '+61 8 8555 1234',
        operator: 'Someone',
      },
    });
    const linked = lines.filter((line) => line.href);

    expect(linked.map((line) => [line.label, line.href])).toEqual([
      ['Phone', 'tel:+61885551234'],
      ['Website', 'https://example.com/'],
    ]);
    // Everything else is inert text.
    expect(lines.filter((line) => !line.href).map((line) => line.label)).toEqual([
      'OSM tag',
      'Operator',
    ]);
  });
});
