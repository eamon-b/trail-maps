/**
 * The shared POI presentation rules.
 *
 * Everything here is platform-neutral, so these cases pin behaviour the web
 * page and Tracknotes both depend on: what an unnamed POI is called, which
 * tags survive the trip onto a phone, which POIs a filter shows, and how a
 * route param round-trips back to an OSM element. The markup and
 * `localStorage` cases stay in `src/web/trails/trail-pois-ui.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import type { TrailPOI } from './trail-types';
import {
  countPoisByCategory,
  defaultPoiFilterState,
  findPoiByRouteKey,
  formatOffTrail,
  interleavePoisByDistance,
  mirrorPoiDistances,
  normalisePoiFilterState,
  safeHttpUrl,
  parsePoiRouteKey,
  poiDisplayName,
  poiOsmUrl,
  poiRouteKey,
  slimPoi,
  summarisePoiTags,
  visiblePois,
  POI_DISPLAY_TAG_KEYS,
} from './poi-display';

function poi(over: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'water',
    lat: -34,
    lon: 138,
    name: 'Tap',
    tags: {},
    distanceAlongTrail: 1,
    distanceFromTrail: 0.05,
    ...over,
  };
}

describe('POI naming and links', () => {
  it('falls back to the category when OSM has no name', () => {
    expect(poiDisplayName(poi({ name: null }))).toBe('Unnamed water');
    expect(poiDisplayName(poi({ name: '   ', category: 'transport' }))).toBe('Unnamed transport');
    expect(poiDisplayName(poi({ name: 'Wardan Café' }))).toBe('Wardan Café');
  });

  it('links to the right OSM element, defaulting an unknown type to node', () => {
    expect(poiOsmUrl({ type: 'way', id: 7 })).toBe('https://www.openstreetmap.org/way/7');
    expect(poiOsmUrl({ type: 'nonsense', id: 7 })).toBe('https://www.openstreetmap.org/node/7');
  });

  it('shows sub-kilometre off-trail distances in metres', () => {
    expect(formatOffTrail(0.05)).toBe('50 m');
    expect(formatOffTrail(1.24)).toBe('1.2 km');
    expect(formatOffTrail(Number.NaN)).toBe('—');
  });
});

describe('the tag summary', () => {
  it('leads with the primary feature tag, so the classification can be judged', () => {
    const lines = summarisePoiTags({ amenity: 'drinking_water', shop: 'supermarket' });
    expect(lines[0]).toEqual({ label: 'OSM tag', value: 'amenity=drinking_water' });
    // Only one primary tag, the first that matches.
    expect(lines.filter(l => l.label === 'OSM tag')).toHaveLength(1);
  });

  it('picks up the useful detail tags and links websites and phones', () => {
    const lines = summarisePoiTags({
      shop: 'supermarket',
      opening_hours: 'Mo-Fr 08:00-18:00',
      website: 'example.com/shop',
      phone: '+61 8 9755 1000',
      fee: 'no',
    });
    const byLabel = Object.fromEntries(lines.map(l => [l.label, l]));
    expect(byLabel['Opening hours'].value).toBe('Mo-Fr 08:00-18:00');
    expect(byLabel['Website'].href).toBe('https://example.com/shop');
    expect(byLabel['Phone'].href).toBe('tel:+61897551000');
    expect(byLabel['Fee'].value).toBe('no');
  });

  it('de-duplicates phone/contact:phone rather than listing both', () => {
    const lines = summarisePoiTags({ phone: '123 456', 'contact:phone': '999 999' });
    expect(lines.filter(l => l.label === 'Phone')).toHaveLength(1);
    expect(lines[0].value).toBe('123 456');
  });

  it('refuses to link a non-http scheme — OSM tag values are free text', () => {
    const lines = summarisePoiTags({ website: 'javascript:alert(1)' });
    const website = lines.find(l => l.label === 'Website');
    expect(website?.value).toBe('javascript:alert(1)');
    expect(website?.href).toBeUndefined();
  });

  it('skips empty values and missing tags', () => {
    expect(summarisePoiTags({ description: '   ', fee: '' })).toEqual([]);
    expect(summarisePoiTags(undefined)).toEqual([]);
  });
});

describe('slimming a POI for the phone', () => {
  /** A realistically over-tagged OSM element: twenty tags, four of them useful. */
  const fatTags: Record<string, string> = {
    amenity: 'drinking_water',
    'drinking_water:legal': 'yes',
    'survey:date': '2024-03-01',
    source: 'survey',
    'source:date': '2023-11-02',
    check_date: '2024-03-01',
    bottle: 'yes',
    fountain: 'bubbler',
    indoor: 'no',
    wheelchair: 'limited',
    'ref:water': 'W-114',
    material: 'steel',
    colour: 'green',
    note: 'behind the toilet block',
    fixme: 'position approximate',
    seasonal: 'no',
    operator: 'DBCA',
    website: 'https://example.com',
    description: 'Tank fed from the shelter roof',
    ele: '117.6',
  };

  it('keeps only the tags a UI reads', () => {
    const slim = slimPoi(poi({ tags: fatTags }));
    expect(Object.keys(slim.tags).sort()).toEqual(
      ['amenity', 'description', 'ele', 'operator', 'website'].sort()
    );
    expect(Object.keys(slim.tags).every(key => POI_DISPLAY_TAG_KEYS.includes(key))).toBe(true);
    expect(slim.tags.description).toBe('Tank fed from the shelter roof');
  });

  it('always leaves a tags object, even when nothing survives', () => {
    expect(slimPoi(poi({ tags: { note: 'nope', source: '' } })).tags).toEqual({});
  });

  it('drops empty tag values rather than shipping the key', () => {
    expect(slimPoi(poi({ tags: { amenity: '', operator: 'DBCA' } })).tags).toEqual({
      operator: 'DBCA',
    });
  });

  it('rounds coordinates and distances to the precision the app displays', () => {
    const slim = slimPoi(
      poi({
        lat: -34.1234567891,
        lon: 138.9876543219,
        distanceAlongTrail: 12.3456,
        distanceFromTrail: 0.056789,
      })
    );
    expect(slim.lat).toBe(-34.123457);
    expect(slim.lon).toBe(138.987654);
    expect(slim.distanceAlongTrail).toBe(12.3);
    expect(slim.distanceFromTrail).toBe(0.06);
  });

  it('keeps the duplicate flag but drops the review-only distance', () => {
    const slim = slimPoi(poi({ duplicateOf: 'w_abc', duplicateDistanceM: 14.2 }));
    expect(slim.duplicateOf).toBe('w_abc');
    expect('duplicateDistanceM' in slim).toBe(false);
  });

  it('omits duplicateOf entirely when the POI is not a duplicate', () => {
    expect('duplicateOf' in slimPoi(poi())).toBe(false);
  });
});

describe('the POI filter state', () => {
  it('defaults to everything shown', () => {
    const state = defaultPoiFilterState();
    expect(state.enabled).toBe(true);
    expect(Object.values(state.categories).every(Boolean)).toBe(true);
  });

  it('survives junk in storage', () => {
    expect(normalisePoiFilterState(null)).toEqual(defaultPoiFilterState());
    expect(normalisePoiFilterState('nope')).toEqual(defaultPoiFilterState());
    const partial = normalisePoiFilterState({
      enabled: false,
      categories: { water: false, bogus: 1 },
    });
    expect(partial.enabled).toBe(false);
    expect(partial.categories.water).toBe(false);
    expect(partial.categories.camping).toBe(true);
  });

  it('hides everything when the master switch is off', () => {
    const state = defaultPoiFilterState();
    state.enabled = false;
    expect(visiblePois([poi()], state)).toEqual([]);
  });

  it('filters by category, but keeps an unknown category the checkboxes cannot reach', () => {
    const state = defaultPoiFilterState();
    state.categories.water = false;
    const pois = [
      poi({ id: 1, category: 'water' }),
      poi({ id: 2, category: 'camping' }),
      poi({ id: 3, category: 'ferry' as TrailPOI['category'] }),
    ];
    expect(visiblePois(pois, state).map(p => p.id)).toEqual([2, 3]);
  });

  it('never shows a POI that duplicates a curated waypoint', () => {
    // The waypoint is the one marker for that place; two pins a few metres
    // apart is the thing this flag exists to prevent.
    const state = defaultPoiFilterState();
    const pois = [poi({ id: 1 }), poi({ id: 2, duplicateOf: 'w_abc' })];
    expect(visiblePois(pois, state).map(p => p.id)).toEqual([1]);
  });

  it('leaves duplicates out of the checkbox counts, so counts match markers', () => {
    const counts = countPoisByCategory([
      poi({ category: 'camping' }),
      poi({ category: 'camping', duplicateOf: 'w_abc' }),
    ]);
    expect(counts.camping).toBe(1);
  });

  it('counts by category for the checkbox labels', () => {
    const counts = countPoisByCategory([
      poi({ category: 'water' }),
      poi({ category: 'water' }),
      poi({ category: 'emergency' }),
    ]);
    expect(counts).toEqual({
      water: 2,
      camping: 0,
      resupply: 0,
      restaurant: 0,
      transport: 0,
      emergency: 1,
    });
  });
});

describe('interleaving POIs with rows', () => {
  const rows = [{ distance: 0 }, { distance: 5 }, { distance: 12 }];

  it('places each POI at its km', () => {
    const merged = interleavePoisByDistance(
      rows,
      [poi({ id: 1, distanceAlongTrail: 3 }), poi({ id: 2, distanceAlongTrail: 20 })],
      row => row.distance
    );
    expect(
      merged.map(e => (e.kind === 'poi' ? `poi${e.poi.id}` : `row${e.item.distance}`))
    ).toEqual(['row0', 'poi1', 'row5', 'row12', 'poi2']);
  });

  it('puts the curated row first on a tie', () => {
    const merged = interleavePoisByDistance(
      rows,
      [poi({ id: 7, distanceAlongTrail: 5 })],
      r => r.distance
    );
    expect(merged.map(e => e.kind)).toEqual(['item', 'item', 'poi', 'item']);
  });

  it('sorts unsorted POI input and leaves the rows in the order given', () => {
    const merged = interleavePoisByDistance(
      rows,
      [poi({ id: 2, distanceAlongTrail: 8 }), poi({ id: 1, distanceAlongTrail: 2 })],
      row => row.distance
    );
    const poiOrder = merged.filter(e => e.kind === 'poi').map(e => (e as { poi: TrailPOI }).poi.id);
    expect(poiOrder).toEqual([1, 2]);
  });

  it('handles an empty list of rows and an empty POI list', () => {
    expect(interleavePoisByDistance([], [poi()], () => 0)).toHaveLength(1);
    expect(interleavePoisByDistance(rows, [], r => r.distance)).toHaveLength(3);
  });
});

describe('reversing a trail', () => {
  it('mirrors POI km about the trail total and re-sorts', () => {
    const mirrored = mirrorPoiDistances(
      [poi({ id: 1, distanceAlongTrail: 3 }), poi({ id: 2, distanceAlongTrail: 120 })],
      130
    )!;
    expect(mirrored.map(p => [p.id, p.distanceAlongTrail])).toEqual([
      [2, 10],
      [1, 127],
    ]);
    // Cross-track distance is direction-independent.
    expect(mirrored[0].distanceFromTrail).toBe(0.05);
  });

  it('leaves an un-enriched trail un-enriched', () => {
    expect(mirrorPoiDistances(undefined, 130)).toBeUndefined();
  });

  describe('POIs on variants', () => {
    // A 62 km trail; a terminus leaves at km 60 and runs 10 km due north, a
    // side trip leaves at km 20 and runs 4 km, an alternate spans km 30-40 (12 km).
    const line = (lat0: number, n: number) =>
      Array.from({ length: n + 1 }, (_, i) => ({ lat: lat0 + i * 0.009, lon: 140 }));
    const variants = {
      sideTrips: [
        { startDistance: 60, distance: 10, points: line(-40, 10) },
        { startDistance: 20, distance: 4, points: line(-41, 4) },
      ],
      alternates: [{ startDistance: 30, endDistance: 40, distance: 12, points: line(-42, 12) }],
    };

    it('keeps a terminus POI past the trail end on the terminus, not at km 0', () => {
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 66, lat: -40 + 6 * 0.009, lon: 140, distanceFromTrail: 0 })],
        62,
        variants
      )!;
      expect(m.distanceAlongTrail).toBeCloseTo(8, 5); // junction mirrors to 2, then 6 km out
    });

    it('moves a side-trip POI with its junction', () => {
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 23, lat: -41 + 3 * 0.009, lon: 140, distanceFromTrail: 0.01 })],
        62,
        variants
      )!;
      expect(m.distanceAlongTrail).toBeCloseTo(45, 5); // 62 - 20 + 3
    });

    it('enters an alternate from its far end', () => {
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 33, lat: -42 + 3 * 0.009, lon: 140, distanceFromTrail: 0 })],
        62,
        variants
      )!;
      expect(m.distanceAlongTrail).toBeCloseTo(31, 5); // 62 - 40 + (12 - 3)
    });

    // The main line beside that alternate, 0.1 km east, km 30-42 one per km.
    const mainBeside = Array.from({ length: 13 }, (_, i) => ({
      lat: -42 + i * 0.009,
      lon: 140.0012,
      dist: 30 + i,
    }));

    it('keeps a main-route POI beside a parallel alternate on the main line', () => {
      // 0.04 km from the main line (as the fetch recorded), 0.06 km from the alternate.
      const onMain = poi({ distanceAlongTrail: 33, lat: -42 + 3 * 0.009, lon: 140.0007, distanceFromTrail: 0.041 });
      const [m] = mirrorPoiDistances([onMain], 62, { ...variants, mainLine: mainBeside })!;
      expect(m.distanceAlongTrail).toBe(29);
    });

    it('measures to the main line, not its nearest vertex, at a sparse junction', () => {
      // Main points 2 km apart; the POI sits 0.05 km off the middle of that
      // segment, a km from either vertex, and 0.06 km from the alternate.
      const sparseMain = [
        { lat: -42 + 2 * 0.009, lon: 140.0013, dist: 32 },
        { lat: -42 + 4 * 0.009, lon: 140.0013, dist: 34 },
      ];
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 33, lat: -42 + 3 * 0.009, lon: 140.0007, distanceFromTrail: 0.05 })],
        62,
        { ...variants, mainLine: sparseMain }
      )!;
      expect(m.distanceAlongTrail).toBe(29);
    });

    it('still moves an alternate POI the main line does not explain', () => {
      const farMain = mainBeside.map(p => ({ ...p, lon: 141 }));
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 33, lat: -42 + 3 * 0.009, lon: 140, distanceFromTrail: 0 })],
        62,
        { ...variants, mainLine: farMain }
      )!;
      expect(m.distanceAlongTrail).toBeCloseTo(31, 5);
    });

    it('walks a POI on an alternate with one junction out from the mirrored junction', () => {
      // `reverseAlternates` keeps a start-only alternate reading out from its
      // mirrored junction (62 - 30 = 32), like a side trip, so a POI 3 km along
      // it sits at 35 — not 29, which would be a mirror about the main line.
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 33, lat: -42 + 3 * 0.009, lon: 140, distanceFromTrail: 0 })],
        62,
        { alternates: [{ ...variants.alternates[0], endDistance: undefined }] }
      )!;
      expect(m.distanceAlongTrail).toBe(35);
    });

    it('mirrors a main-route POI in a variant\'s span about the main line', () => {
      const [m] = mirrorPoiDistances(
        [poi({ distanceAlongTrail: 22, lat: -35, lon: 138, distanceFromTrail: 0.05 })],
        62,
        variants
      )!;
      expect(m.distanceAlongTrail).toBe(40);
    });
  });
});

describe('route keys', () => {
  it('round-trips through the slash-free form a route param can carry', () => {
    const key = poiRouteKey({ type: 'way', id: 12345 });
    expect(key).toBe('way-12345');
    expect(key).not.toContain('/');
    expect(parsePoiRouteKey(key)).toEqual({ type: 'way', id: 12345 });
  });

  it('rejects anything that is not an OSM element reference', () => {
    // A deep link or a stale saved URL can hand us any string at all.
    expect(parsePoiRouteKey('foo-1')).toBeNull();
    expect(parsePoiRouteKey('node-x')).toBeNull();
    expect(parsePoiRouteKey('node-1-2')).toBeNull();
    expect(parsePoiRouteKey('node/1')).toBeNull();
    expect(parsePoiRouteKey('node-')).toBeNull();
    expect(parsePoiRouteKey('')).toBeNull();
  });

  it('finds the POI a key names, and nothing when it is gone', () => {
    const pois = [poi({ type: 'node', id: 5 }), poi({ type: 'way', id: 5 })];
    expect(findPoiByRouteKey(pois, 'way-5')).toBe(pois[1]);
    expect(findPoiByRouteKey(pois, 'relation-5')).toBeNull();
    expect(findPoiByRouteKey(pois, 'nonsense')).toBeNull();
    expect(findPoiByRouteKey(undefined, 'node-5')).toBeNull();
  });
});

describe('safeHttpUrl', () => {
  it('keeps http(s) URLs', () => {
    expect(safeHttpUrl('https://ok.org')).toBe('https://ok.org/');
    expect(safeHttpUrl('http://a.b/c')).toBe('http://a.b/c');
  });

  it('reads a bare host as https', () => {
    expect(safeHttpUrl('example.com')).toBe('https://example.com/');
    expect(safeHttpUrl('  www.hut.org.nz/book ')).toBe('https://www.hut.org.nz/book');
  });

  it('reads a bare host with a port as a host, not a scheme', () => {
    expect(safeHttpUrl('example.com:8080/x')).toBe('https://example.com:8080/x');
    expect(safeHttpUrl('www.hut.org.nz:443')).toBe('https://www.hut.org.nz/');
    expect(safeHttpUrl('hut.org.nz:8443?a=1')).toBe('https://hut.org.nz:8443/?a=1');
  });

  it('rejects every other scheme, however it is dressed up', () => {
    for (const value of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      '\njavascript:alert(1)',
      'java\tscript:alert(1)',
      'javascript:1',
      'data:text/html,<script>1</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'mailto:a@b.org',
      'tel:123',
      'localhost:3000',
    ]) {
      expect(safeHttpUrl(value), value).toBeUndefined();
    }
  });

  it('only ever returns an http(s) URL for a protocol-relative one', () => {
    expect(safeHttpUrl('//example.com/x')).toBe('https://example.com/x');
  });
});
