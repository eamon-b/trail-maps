/**
 * The Stops tab, the waypoint popup and the day cards, driven through the real
 * plan viewer in jsdom.
 *
 * The day planner's claim is that a plan is built by tapping places: tick a
 * place and it becomes tonight's stop, say you are staying two nights and every
 * later date moves on a day. So these tests boot the shipped plan markup with a
 * preloaded trail and go through the page — the rows, the popup button, the
 * nights stepper — rather than calling the editor directly (`plan-editor.test.ts`
 * does that).
 *
 *   hand-checked track — 8 points, one every 10 km, flat
 *
 *     km      0    10    20    30    40    50    60    70
 *
 *   waypoints (⚑ = an overnight candidate, the Stops tab's default list)
 *
 *     w_start  Trailhead   endpoint        km 0
 *     w_camp1  Camp One    campsite   ⚑    km 10
 *     w_water  Dry Creek   water           km 15
 *     w_town   Salida      town       ⚑    km 30   three POIs within 1 km
 *     w_hut    High Hut    hut        ⚑    km 45
 *     w_road   Mill Road   road-crossing   km 55
 *     w_camp2  Camp Two    campsite   ⚑    km 60
 *     w_end    Trail End   endpoint        km 70
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');

/** The bundled plan page as `build-trails.ts` assembles it. */
function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
  );
}

const TRAIL_ID = 'stops-fixture';

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

// ---------------------------------------------------------------------------
// The least Leaflet the viewer needs, plus the popup content it hands over
// ---------------------------------------------------------------------------

interface StubMarker {
  html: string;
  handlers: Record<string, () => void>;
  popup: HTMLElement | null;
}

let markers: StubMarker[] = [];

function installLeafletStub(): void {
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const mapObj = layer();
  const L = {
    map: () => mapObj,
    tileLayer: layer,
    control: { scale: layer },
    layerGroup: layer,
    polyline: layer,
    divIcon: (opts: { html: string }) => opts,
    marker: (_latLng: unknown, opts: { icon: { html: string } }) => {
      const marker: StubMarker = { html: opts.icon.html, handlers: {}, popup: null };
      markers.push(marker);
      const handle = {
        on: (event: string, fn: () => void) => void (marker.handlers[event] = fn),
        addTo: () => undefined,
        remove: () => void markers.splice(markers.indexOf(marker), 1),
        setOpacity: () => undefined,
        bindPopup: (content: HTMLElement) => {
          marker.popup = content;
          return handle;
        },
        openPopup: () => handle,
      };
      return handle;
    },
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

/** The waypoint marker for a place, not the ⛺ flag dropped on it once it is a stop. */
const marker = (name: string): StubMarker => {
  const found = markers.find(
    m => m.html.includes('waypoint-marker') && m.html.includes(`title="${name}"`),
  );
  if (!found) throw new Error(`no marker for ${name}`);
  return found;
};

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

const tabButton = (tab: string): HTMLButtonElement => {
  const btn = document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) throw new Error(`missing tab ${tab}`);
  return btn;
};

const stopNames = (): string[] =>
  [...$('stops-list').querySelectorAll('.stop-name')].map(el => (el.textContent ?? '').trim());

/** One row of the Stops tab, by the name it shows. */
const stopItem = (name: string): HTMLElement => {
  const found = [...$('stops-list').querySelectorAll<HTMLElement>('.stop-item')].find(
    item => (item.querySelector('.stop-name')?.textContent ?? '').trim() === name,
  );
  if (!found) throw new Error(`no stop row for ${name}`);
  return found;
};

const clickRow = (name: string): void => {
  stopItem(name).querySelector<HTMLElement>('.stop-row')!.click();
};

/** The services a row reports: the flags whose glyph is not greyed out. */
const servicesOn = (name: string): string[] =>
  [...stopItem(name).querySelectorAll<HTMLElement>('.stop-svc')]
    .filter(el => !el.classList.contains('is-off'))
    .map(el => el.title);

const dayCards = (): HTMLElement[] => [...$('days-list').querySelectorAll<HTMLElement>('.day-card')];

const dayText = (selector: string): string[] =>
  dayCards().map(card => (card.querySelector(selector)?.textContent ?? '').trim());

const savedDocument = (): {
  stops: Array<{ waypointId?: string; km: number; name: string; nights: number; note?: string; booked?: boolean }>;
} => {
  const raw = localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`);
  if (!raw) throw new Error('nothing saved');
  return JSON.parse(raw);
};

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeTrail() {
  const points = [0, 10, 20, 30, 40, 50, 60, 70].map(km => ({
    lat: -34 - km / 1000,
    lon: 138 + km / 1000,
    ele: 100,
    dist: km,
  }));

  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
  });

  const poi = (
    id: number,
    name: string,
    category: string,
    tags: Record<string, string>,
    distanceAlongTrail: number,
  ) => ({
    id,
    type: 'node',
    category,
    name,
    tags,
    lat: -34 - distanceAlongTrail / 1000,
    lon: 138 + distanceAlongTrail / 1000,
    distanceAlongTrail,
    distanceFromTrail: 0.2,
  });

  return {
    config: { id: TRAIL_ID, name: 'Stops Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 70, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_camp1', 'Camp One', 'campsite', 10),
      wp('w_water', 'Dry Creek', 'water', 15),
      wp('w_town', 'Salida', 'town', 30),
      wp('w_hut', 'High Hut', 'hut', 45),
      wp('w_road', 'Mill Road', 'road-crossing', 55),
      wp('w_camp2', 'Camp Two', 'campsite', 60),
      wp('w_end', 'Trail End', 'endpoint', 70),
    ],
    pois: [
      poi(1, 'Salida Foods', 'resupply', { shop: 'supermarket' }, 29.8),
      poi(2, 'The Palace', 'other', { tourism: 'hotel' }, 30.3),
      poi(3, 'Main St stop', 'transport', { highway: 'bus_stop' }, 30.1),
      // Two kilometres past Salida, so outside the 1 km services radius.
      poi(4, 'Far Cafe', 'restaurant', { amenity: 'cafe' }, 32),
    ],
  };
}

/** Boot the shipped plan markup with the fixture, on the Stops tab by default. */
async function boot(tab: 'days' | 'stops' = 'stops'): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  markers = [];
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
  if (tab === 'stops') tabButton('stops').click();
}

/** Let the 800 ms debounced save land. */
const flushSave = (): void => void vi.advanceTimersByTime(900);

/** Set the plan's start date the way the header does. */
const setStartDate = (iso: string): void => {
  const input = $('plan-start-date') as HTMLInputElement;
  input.value = iso;
  input.dispatchEvent(new Event('change'));
};

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
  installLeafletStub();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { L?: unknown }).L;
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe('the Stops tab list', () => {
  it('offers the places you can sleep, not every waypoint', async () => {
    await boot();
    expect(stopNames()).toEqual(['Camp One', 'Salida', 'High Hut', 'Camp Two']);
  });

  it('shows every waypoint once "Show all waypoints" is ticked, and remembers it', async () => {
    await boot();
    const showAll = $('stops-show-all') as HTMLInputElement;
    showAll.click();

    expect(stopNames()).toContain('Dry Creek');
    expect(stopNames()).toContain('Mill Road');
    expect(stopNames()).toHaveLength(8);
    // A view setting, not part of the plan — its own key, not the document.
    expect(localStorage.getItem(`trail-plan-ui-${TRAIL_ID}`)).toBe('{"showAllWaypoints":true}');

    await boot();
    expect(($('stops-show-all') as HTMLInputElement).checked).toBe(true);
    expect(stopNames()).toHaveLength(8);
  });

  it('keeps the filter box working over whichever list is showing', async () => {
    await boot();
    const filter = $('stops-filter') as HTMLInputElement;
    filter.value = 'camp';
    filter.dispatchEvent(new Event('input'));
    expect(stopNames()).toEqual(['Camp One', 'Camp Two']);

    filter.value = 'creek';
    filter.dispatchEvent(new Event('input'));
    expect(stopNames()).toEqual([]);
    expect($('stops-list').textContent).toContain('No waypoints match');
  });
});

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

describe('the services strip', () => {
  it('reads the OSM POIs within a kilometre of the stop', async () => {
    await boot();
    expect(servicesOn('Salida')).toEqual(['Lodging', 'Shop', 'Transport']);
    // The cafe is 2 km along the trail, so it is not this stop's cafe.
    expect(servicesOn('Salida')).not.toContain('Food');
    expect(servicesOn('Camp One')).toEqual([]);
    expect($('stops-footer').textContent).toBe('© OpenStreetMap contributors');
  });

  it('says so, rather than showing six grey glyphs, when the trail has no POI data', async () => {
    const html = bundledPlanPageHtml();
    document.documentElement.innerHTML = html
      .replace(/<!DOCTYPE html>/i, '')
      .replace(/<\/?html[^>]*>/gi, '');
    vi.resetModules();
    markers = [];
    const { initPlanViewer } = await import('./plan-viewer');
    // `pois: undefined` is how CDT and Te Araroa arrive: never fetched, which
    // is not the same as "nothing near this stop".
    const withoutPois: Record<string, unknown> = { ...makeTrail() };
    delete withoutPois.pois;
    await initPlanViewer(TRAIL_ID, withoutPois as never);
    tabButton('stops').click();

    expect($('stops-list').querySelectorAll('.stop-svc')).toHaveLength(0);
    expect($('stops-footer').textContent).toBe('No OpenStreetMap data for this trail yet');
  });
});

// ---------------------------------------------------------------------------
// Toggling
// ---------------------------------------------------------------------------

describe('ticking a stop', () => {
  it('splits the trail into days and stores the waypoint id', async () => {
    await boot();
    expect($('days-list').textContent).toContain('Add stops in the Stops tab');

    clickRow('Salida');

    expect(stopItem('Salida').classList.contains('is-stop')).toBe(true);
    tabButton('days').click();
    expect(dayText('.day-card-route')).toEqual(['Trailhead → Salida', 'Salida → Trail End']);

    flushSave();
    expect(savedDocument().stops).toEqual([
      { waypointId: 'w_town', km: 30, name: 'Salida', nights: 1 },
    ]);
  });

  it('unticks the same row again', async () => {
    await boot();
    clickRow('Salida');
    clickRow('Salida');
    expect(stopItem('Salida').classList.contains('is-stop')).toBe(false);
    flushSave();
    expect(savedDocument().stops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Nights, notes, booked
// ---------------------------------------------------------------------------

describe('the editor under a ticked row', () => {
  it('pushes every later date on by a day and says where the rest day is', async () => {
    await boot();
    setStartDate('2026-03-01');
    tabButton('stops').click();
    clickRow('Camp One');
    clickRow('Salida');

    tabButton('days').click();
    expect(dayText('.day-card-date')).toEqual([
      'Sun, 1 Mar 2026',
      'Mon, 2 Mar 2026',
      'Tue, 3 Mar 2026',
    ]);

    tabButton('stops').click();
    stopItem('Camp One').querySelector<HTMLButtonElement>('.nights-btn[data-nights-delta="1"]')!.click();
    expect(stopItem('Camp One').querySelector('.nights-value')?.textContent).toBe('2');

    tabButton('days').click();
    // Day 1 still ends on the 1st; the rest day at Camp One moves the rest.
    expect(dayText('.day-card-date')).toEqual([
      'Sun, 1 Mar 2026',
      'Tue, 3 Mar 2026',
      'Wed, 4 Mar 2026',
    ]);
    expect(dayText('.day-card-rest')).toEqual(['+1 rest day at Camp One', '', '']);

    // Two nights is one rest day, three is two.
    tabButton('stops').click();
    stopItem('Camp One').querySelector<HTMLButtonElement>('.nights-btn[data-nights-delta="1"]')!.click();
    tabButton('days').click();
    expect(dayText('.day-card-rest')[0]).toBe('+2 rest days at Camp One');
  });

  it('will not go below one night', async () => {
    await boot();
    clickRow('Salida');
    const minus = stopItem('Salida').querySelector<HTMLButtonElement>('.nights-btn[data-nights-delta="-1"]')!;
    expect(minus.disabled).toBe(true);
    minus.click();
    expect(stopItem('Salida').querySelector('.nights-value')?.textContent).toBe('1');
  });

  it('shows a note and a Booked badge on the day card and in the datasheet', async () => {
    await boot();
    clickRow('Salida');

    const note = stopItem('Salida').querySelector<HTMLInputElement>('.stop-note')!;
    note.value = 'rang ahead, 2 beds';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    stopItem('Salida').querySelector<HTMLInputElement>('.stop-booked-check')!.click();

    flushSave();
    expect(savedDocument().stops[0]).toMatchObject({
      name: 'Salida',
      note: 'rang ahead, 2 beds',
      booked: true,
    });

    tabButton('days').click();
    const firstCard = dayCards()[0];
    expect(firstCard.querySelector('.booked-badge')?.textContent?.trim()).toBe('Booked');
    expect(firstCard.querySelector('.stop-note-text')?.textContent).toBe('rang ahead, 2 beds');

    // The datasheet for that day repeats both at the stop it ends on.
    firstCard.click();
    expect($('datasheet-body').querySelector('.ds-stop-meta')?.textContent).toContain(
      'rang ahead, 2 beds',
    );
  });

  it('escapes a note rather than letting it into the page as markup', async () => {
    await boot();
    clickRow('Salida');
    const note = stopItem('Salida').querySelector<HTMLInputElement>('.stop-note')!;
    note.value = '<img src=x onerror=alert(1)>';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    note.dispatchEvent(new Event('change', { bubbles: true }));

    tabButton('days').click();
    expect(dayCards()[0].querySelector('img')).toBeNull();
    expect(dayCards()[0].querySelector('.stop-note-text')?.textContent).toBe(
      '<img src=x onerror=alert(1)>',
    );
  });

  it('brings a note back after a reload', async () => {
    await boot();
    clickRow('High Hut');
    const note = stopItem('High Hut').querySelector<HTMLInputElement>('.stop-note')!;
    note.value = 'key under the tank';
    note.dispatchEvent(new Event('input', { bubbles: true }));
    flushSave();

    await boot();
    expect(stopItem('High Hut').classList.contains('is-stop')).toBe(true);
    expect(stopItem('High Hut').querySelector<HTMLInputElement>('.stop-note')!.value).toBe(
      'key under the tank',
    );
  });
});

// ---------------------------------------------------------------------------
// Direction
// ---------------------------------------------------------------------------

describe('flipping the direction', () => {
  it('relabels the button and mirrors the stop without moving it', async () => {
    await boot();
    clickRow('Salida');
    flushSave();
    expect($('direction-label').textContent).toBe('NOBO');

    ($('direction-toggle') as HTMLButtonElement).click();

    expect($('direction-label').textContent).toBe('SOBO');
    // The list runs the other way, the same place is still ticked, and the
    // stored km is untouched — it is NOBO-absolute by contract.
    expect(stopNames()).toEqual(['Camp Two', 'High Hut', 'Salida', 'Camp One']);
    expect(stopItem('Salida').classList.contains('is-stop')).toBe(true);
    expect(stopItem('Salida').querySelector('.stop-km')?.textContent).toBe('40.0 km');
    flushSave();
    expect(savedDocument().stops).toEqual([
      { waypointId: 'w_town', km: 30, name: 'Salida', nights: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

describe('a waypoint marker on the Days tab', () => {
  it('opens a popup and only toggles the stop from its button', async () => {
    await boot('days');

    marker('Salida').handlers.click();
    const popup = marker('Salida').popup!;
    expect(popup.querySelector('.wp-popup-name')?.textContent).toBe('Salida');
    expect(popup.querySelector('.wp-popup-sub')?.textContent).toContain('30.0 km');
    // The popup carries the same services strip the list row does.
    expect(
      [...popup.querySelectorAll<HTMLElement>('.stop-svc')]
        .filter(el => !el.classList.contains('is-off'))
        .map(el => el.title),
    ).toEqual(['Lodging', 'Shop', 'Transport']);

    // The click itself did nothing — a mis-aimed tap no longer rewrites the plan.
    expect(dayCards()).toHaveLength(0);

    popup.querySelector<HTMLButtonElement>('.wp-popup-btn')!.click();
    expect(dayCards()).toHaveLength(2);

    marker('Salida').handlers.click();
    const reopened = marker('Salida').popup!;
    expect(reopened.querySelector('.wp-popup-btn')?.textContent?.trim()).toBe('Remove stop');
    reopened.querySelector<HTMLButtonElement>('.wp-popup-btn')!.click();
    expect(dayCards()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

describe('a plan saved before the day planner', () => {
  it('is migrated on boot, keyed to the waypoints it matched', async () => {
    localStorage.setItem(
      `trail-plan-${TRAIL_ID}`,
      JSON.stringify({
        name: 'Old plan',
        startDate: '2026-03-01',
        stops: [{ km: 30, waypointName: 'Salida' }],
      }),
    );

    await boot();

    expect(($('plan-name-input') as HTMLInputElement).value).toBe('Old plan');
    expect(stopItem('Salida').classList.contains('is-stop')).toBe(true);
    expect(savedDocument().stops).toEqual([
      { waypointId: 'w_town', km: 30, name: 'Salida', nights: 1 },
    ]);

    tabButton('days').click();
    expect(dayText('.day-card-route')).toEqual(['Trailhead → Salida', 'Salida → Trail End']);
    // The legacy key is left where it is; it is tiny and harmless.
    expect(localStorage.getItem(`trail-plan-${TRAIL_ID}`)).not.toBeNull();
  });
});
