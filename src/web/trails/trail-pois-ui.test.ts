/**
 * OpenStreetMap POIs in the trail viewer.
 *
 * Two halves. The first exercises the web-only markup in `trail-pois-ui` — the
 * popup, the datasheet row, the control and the escaping that guards them (the
 * platform-neutral rules they build on are covered in
 * `src/lib/poi-display.test.ts`). The second boots the real viewer against the
 * real `my-trail.html` markup (the same rig as `waypoint-filter.test.ts`) to
 * pin the two properties that matter once POIs share a table with waypoints:
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
  defaultPoiFilterState,
  poiControlHtml,
  poiKey,
  poiPopupHtml,
  poiRowHtml,
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

describe('POI keys', () => {
  it('keys a POI by type *and* id, because OSM ids repeat across types', () => {
    expect(poiKey({ type: 'node', id: 12345 })).toBe('node/12345');
    expect(poiKey({ type: 'way', id: 12345 })).toBe('way/12345');
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
