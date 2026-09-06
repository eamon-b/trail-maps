/**
 * OpenStreetMap POIs in the trail viewer.
 *
 * Two halves. The first exercises `trail-pois-ui` directly — the labels, the
 * tag summary, the escaping and the interleave ordering. The second boots the
 * real viewer against the real `my-trail.html` markup (the same rig as
 * `waypoint-filter.test.ts`) to pin the two properties that matter once POIs
 * share a table with waypoints:
 *
 *   1. a POI never moves a leg figure, and
 *   2. a POI row is inert — it carries none of the hooks the delegated
 *      `#waypoints-container` handler matches on, so it can't be mistaken for
 *      an expandable waypoint row.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TrailPOI } from '@lib/trail-types';
import {
  countPoisByCategory,
  defaultPoiFilterState,
  formatOffTrail,
  interleavePoisByDistance,
  mirrorPoiDistances,
  normalisePoiFilterState,
  poiControlHtml,
  poiDisplayName,
  poiKey,
  poiOsmUrl,
  poiPopupHtml,
  poiRowHtml,
  summarisePoiTags,
  visiblePois,
} from './trail-pois-ui';

const ROOT = path.resolve(__dirname, '../../..');

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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('POI naming and links', () => {
  it('falls back to the category when OSM has no name', () => {
    expect(poiDisplayName(poi({ name: null }))).toBe('Unnamed water');
    expect(poiDisplayName(poi({ name: '   ', category: 'transport' }))).toBe('Unnamed transport');
    expect(poiDisplayName(poi({ name: 'Wardan Café' }))).toBe('Wardan Café');
  });

  it('keys a POI by type *and* id, because OSM ids repeat across types', () => {
    expect(poiKey({ type: 'node', id: 12345 })).toBe('node/12345');
    expect(poiKey({ type: 'way', id: 12345 })).toBe('way/12345');
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

describe('POI markup', () => {
  it('escapes every OSM string in the popup', () => {
    const html = poiPopupHtml(
      poi({
        name: '<img src=x onerror="alert(1)">',
        tags: { description: '</div><script>alert(2)</script>' },
      })
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });

  it('credits OpenStreetMap and links the element', () => {
    const html = poiPopupHtml(poi({ type: 'way', id: 42 }));
    expect(html).toContain('© OpenStreetMap contributors');
    expect(html).toContain('https://www.openstreetmap.org/way/42');
  });

  it('renders a row that carries none of the expandable-row hooks', () => {
    const html = poiRowHtml(poi({ id: 9, distanceAlongTrail: 12.34, distanceFromTrail: 0.2 }));
    expect(html).toContain('data-poi-key="node/9"');
    expect(html).toContain('12.3');
    expect(html).toContain('200 m off trail');
    // The three attributes/classes the delegated handler matches on.
    expect(html).not.toContain('data-waypoint-index');
    expect(html).not.toContain('data-off-trail-index');
    expect(html).not.toContain('variant-expandable');
  });

  it('shows the OSM ele tag in the elevation column when there is one', () => {
    expect(poiRowHtml(poi({ tags: { ele: '117.6' } }))).toContain('>118<');
    expect(poiRowHtml(poi({ tags: { ele: 'about 100' } }))).toContain('—');
  });
});

// ---------------------------------------------------------------------------
// Filter state
// ---------------------------------------------------------------------------

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

  it('counts by category for the checkbox labels', () => {
    const counts = countPoisByCategory([
      poi({ category: 'water' }),
      poi({ category: 'water' }),
      poi({ category: 'emergency' }),
    ]);
    expect(counts).toEqual({ water: 2, camping: 0, resupply: 0, transport: 0, emergency: 1 });
  });
});

describe('the POI control', () => {
  it('renders nothing at all for a trail with no POIs', () => {
    expect(poiControlHtml(undefined, defaultPoiFilterState())).toBe('');
    expect(poiControlHtml([], defaultPoiFilterState())).toBe('');
  });

  it('credits OSM and reports how many of the total are shown', () => {
    const state = defaultPoiFilterState();
    state.categories.camping = false;
    const html = poiControlHtml([poi({ category: 'water' }), poi({ category: 'camping' })], state);
    expect(html).toContain('© OpenStreetMap contributors');
    expect(html).toContain('1 of 2 shown');
    expect(html).toContain('Points of interest (OpenStreetMap)');
  });
});

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

describe('interleaving POIs with table rows', () => {
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

  it('handles an empty table and an empty POI list', () => {
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
});

// ---------------------------------------------------------------------------
// The viewer, end to end in jsdom
// ---------------------------------------------------------------------------

interface TestWaypoint {
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation: number;
  distance: number;
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
}

function wp(name: string, type: string, distance: number, totalDistance: number): TestWaypoint {
  return {
    name,
    type,
    lat: -34,
    lon: 138,
    elevation: 100,
    distance,
    totalDistance,
    ascent: 10,
    descent: 10,
    totalAscent: 100,
    totalDescent: 100,
  };
}

function makeTrail(pois?: TrailPOI[]) {
  return {
    config: { id: 'cape_to_cape', name: 'Test Trail', region: 'WA' },
    track: {
      points: [
        { lat: -34, lon: 138, ele: 100, dist: 0 },
        { lat: -34.1, lon: 138.1, ele: 200, dist: 70 },
      ],
      totalDistance: 70,
      totalAscent: 100,
      totalDescent: 100,
    },
    waypoints: [
      wp('Trailhead', 'endpoint', 0, 0),
      wp('Creek Crossing', 'water', 5, 5),
      wp('Melrose', 'town', 7, 12),
      wp('Hawker', 'resupply', 49, 61),
    ],
    offTrailWaypoints: [],
    alternates: [],
    sideTrips: [],
    ...(pois ? { pois } : {}),
  };
}

const samplePois = (): TrailPOI[] => [
  poi({
    id: 101,
    category: 'water',
    name: 'Roadside tap',
    distanceAlongTrail: 3,
    tags: { amenity: 'drinking_water' },
  }),
  poi({
    id: 102,
    category: 'resupply',
    name: 'Corner Store',
    distanceAlongTrail: 12,
    tags: { shop: 'convenience' },
  }),
  poi({
    id: 103,
    category: 'transport',
    name: 'Bus stop',
    distanceAlongTrail: 65.5,
    tags: { highway: 'bus_stop' },
  }),
];

async function boot(trail: ReturnType<typeof makeTrail> = makeTrail()) {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const mod = await import('./trail-viewer');
  await mod.initTrailViewer('cape_to_cape', trail as never);
  return mod;
}

const rowText = (): string[] =>
  [...document.querySelectorAll('#waypoints-container tbody tr')].map(tr =>
    (tr.textContent ?? '').replace(/\s+/g, ' ').trim()
  );

/** The cells of one waypoint row, by its index in the unfiltered array. */
const cells = (index: number): string[] =>
  [...document.getElementById(`waypoint-row-${index}`)!.querySelectorAll('td')].map(td =>
    (td.textContent ?? '').trim()
  );

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
});

describe('POIs in the viewer', () => {
  it('renders no control and no rows for a trail that was never enriched', async () => {
    await boot();
    expect(document.getElementById('poi-control')?.hidden ?? true).toBe(true);
    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(0);
  });

  it('interleaves POI rows into the datasheet by trail km', async () => {
    await boot(makeTrail(samplePois()));

    const text = rowText();
    const at = (needle: string) => text.findIndex(t => t.includes(needle));
    expect(at('Trailhead')).toBeLessThan(at('Roadside tap'));
    expect(at('Roadside tap')).toBeLessThan(at('Creek Crossing'));
    // Tie at km 12 — the curated waypoint reads first.
    expect(at('Melrose')).toBeLessThan(at('Corner Store'));
    expect(at('Corner Store')).toBeLessThan(at('Hawker'));
    expect(at('Bus stop')).toBe(text.length - 1);

    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(3);
    expect(document.body.innerHTML).toContain('© OpenStreetMap contributors');
  });

  it('leaves every leg figure untouched — POIs are not part of the arithmetic', async () => {
    await boot();
    const without = [0, 1, 2, 3].map(cells);

    await boot(makeTrail(samplePois()));
    const with_ = [0, 1, 2, 3].map(cells);

    expect(with_).toEqual(without);
    // The count is still about waypoints only.
    expect(document.getElementById('waypoint-filter-count')!.textContent).toContain('4 waypoint');
  });

  it('does not let a POI row hijack the delegated waypoint-row handler', async () => {
    await boot(makeTrail(samplePois()));

    const poiRow = document.querySelector<HTMLElement>('tr.poi-row')!;
    poiRow.click();
    expect(document.querySelectorAll('[id^="waypoint-detail-"]')).toHaveLength(0);

    // …and a real waypoint row still expands with POI rows on screen.
    document.getElementById('waypoint-row-1')!.click();
    expect(document.getElementById('waypoint-detail-1')).not.toBeNull();
  });

  it('hides POIs everywhere from the master switch, and remembers the choice', async () => {
    await boot(makeTrail(samplePois()));

    const master = document.getElementById('poi-enabled') as HTMLInputElement;
    master.checked = false;
    master.dispatchEvent(new Event('change', { bubbles: true }));

    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(0);
    expect(window.localStorage.getItem('trail-maps-poi-filter')).toContain('"enabled":false');

    // A fresh page load starts from the stored choice.
    await boot(makeTrail(samplePois()));
    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(0);
    expect((document.getElementById('poi-enabled') as HTMLInputElement).checked).toBe(false);
  });

  it('drops one category at a time', async () => {
    await boot(makeTrail(samplePois()));

    const box = document.querySelector<HTMLInputElement>('[data-poi-category="transport"]')!;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));

    const text = rowText();
    expect(text.some(t => t.includes('Bus stop'))).toBe(false);
    expect(text.some(t => t.includes('Roadside tap'))).toBe(true);
    expect(document.querySelector('.poi-control-count')!.textContent).toContain('2 of 3 shown');
  });

  it('shows only the matching POI family under a datasheet filter', async () => {
    await boot(makeTrail(samplePois()));

    document.querySelector<HTMLButtonElement>('#waypoint-filter [data-filter="water"]')!.click();

    const text = rowText();
    expect(text.some(t => t.includes('Roadside tap'))).toBe(true);
    expect(text.some(t => t.includes('Corner Store'))).toBe(false);
    expect(text.some(t => t.includes('Bus stop'))).toBe(false);
  });

  it('escapes an OSM name in the rendered table', async () => {
    await boot(
      makeTrail([poi({ id: 5, name: '<img src=x onerror=alert(1)>', distanceAlongTrail: 2 })])
    );
    expect(document.querySelector('#waypoints-container img')).toBeNull();
    expect(rowText().some(t => t.includes('<img src=x onerror=alert(1)>'))).toBe(true);
  });

  it('setTrailPois adds POIs after boot', async () => {
    const mod = await boot();
    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(0);

    mod.setTrailPois(samplePois());
    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(3);
    expect(document.getElementById('poi-control')!.hidden).toBe(false);
  });

  it('setTrailPois called before boot is applied to the trail that arrives', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
    document.documentElement.innerHTML = html
      .replace(/<!DOCTYPE html>/i, '')
      .replace(/<\/?html[^>]*>/gi, '');

    vi.resetModules();
    const mod = await import('./trail-viewer');
    mod.setTrailPois(samplePois());
    await mod.initTrailViewer('cape_to_cape', makeTrail() as never);

    expect(document.querySelectorAll('tr.poi-row')).toHaveLength(3);
  });

  it('re-measures POI km when the trail direction is reversed', async () => {
    await boot(makeTrail(samplePois()));

    document.getElementById('reverse-direction-btn')!.click();

    const busStop = [...document.querySelectorAll('tr.poi-row')].find(tr =>
      (tr.textContent ?? '').includes('Bus stop')
    )!;
    // 70 − 65.5 = 4.5 km from the new start.
    expect([...busStop.querySelectorAll('td')][4].textContent!.trim()).toBe('4.5');
  });
});
