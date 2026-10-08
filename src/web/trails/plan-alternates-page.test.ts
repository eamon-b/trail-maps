/**
 * Alternates in the Stops tab, driven through the real plan viewer in jsdom:
 * a card where the alternate branches off, taking it, its places listed in
 * place of the bypassed ones, the card where it rejoins, and going back.
 *
 *   main route — 8 points, one every 10 km, flat
 *
 *     km      0    10    20    30    40    50    60    70
 *                       └── Alt: Ridge (30 km) ──┘
 *
 *     w_start  Trailhead   endpoint   km 0
 *     w_camp1  Camp One    campsite   km 10
 *     w_town   Salida      town       km 30   bypassed by the alternate
 *     w_hut    High Hut    hut        km 45
 *     w_camp2  Camp Two    campsite   km 60
 *     w_end    Trail End   endpoint   km 70
 *
 *     on the alternate: w_ridge  Ridge Camp  campsite  15 km along it
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

const TRAIL_ID = 'alternates-fixture';

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

// ---------------------------------------------------------------------------
// Reading the page
// ---------------------------------------------------------------------------

const tabButton = (tab: string): HTMLButtonElement => {
  const btn = document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) throw new Error(`missing tab ${tab}`);
  return btn;
};

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const ALT = 'Alt: Ridge';

function makeTrail() {
  const at = (km: number) => ({ lat: -34 - km / 1000, lon: 138 + km / 1000 });
  const points = [0, 10, 20, 30, 40, 50, 60, 70].map(km => ({ ...at(km), ele: 100, dist: km }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    ...at(totalDistance),
  });
  const altPoints = [0, 1, 2, 3, 4, 5, 6].map(i => ({
    lat: -34.02 - i / 1000 + 0.01,
    lon: 138.02 + i / 300,
    ele: 100 + (i <= 3 ? i * 100 : (6 - i) * 100),
  }));
  return {
    config: { id: TRAIL_ID, name: 'Alternates Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 70, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_camp1', 'Camp One', 'campsite', 10),
      wp('w_town', 'Salida', 'town', 30),
      wp('w_hut', 'High Hut', 'hut', 45),
      wp('w_camp2', 'Camp Two', 'campsite', 60),
      wp('w_end', 'Trail End', 'endpoint', 70),
    ],
    alternates: [
      {
        name: ALT,
        type: 'alternate',
        points: altPoints,
        distance: 30,
        elevation: { ascent: 300, descent: 300 },
        startDistance: 20,
        endDistance: 40,
        waypoints: [{ ...wp('w_ridge', 'Ridge Camp', 'campsite', 35), elevation: 400 }],
      },
    ],
  };
}

async function boot(): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  markers = [];
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
  tabButton('stops').click();
}

/** The Stops list top to bottom: place names, and the alternate cards between them. */
const listOrder = (): string[] =>
  [...$('stops-list').querySelectorAll<HTMLElement>('.stop-name, .alt-card-title')].map(el =>
    (el.textContent ?? '').trim(),
  );

const altButton = (): HTMLButtonElement => {
  const btn = $('stops-list').querySelector<HTMLButtonElement>('.alt-card-btn');
  if (!btn) throw new Error('no alternate button');
  return btn;
};

const savedDocument = (): {
  alternates?: string[];
  stops: Array<{ waypointId?: string; km: number; name: string; alternate?: string }>;
} => {
  const raw = localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`);
  if (!raw) throw new Error('nothing saved');
  return JSON.parse(raw);
};

const flushSave = (): void => void vi.advanceTimersByTime(900);

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

describe('alternates in the Stops tab', () => {
  it('shows where an alternate branches off, with what it changes', async () => {
    await boot();
    expect(listOrder()).toEqual([
      'Camp One',
      `\u2442${ALT} branches off here`,
      'Salida',
      'High Hut',
      'Camp Two',
    ]);
    const stats = $('stops-list').querySelector('.alt-card-stats')?.textContent ?? '';
    expect(stats).toContain('30.0 km');
    expect(stats).toContain('10.0 km longer than the main route');
    expect(altButton().textContent?.trim()).toBe('Take this alternate');
  });

  it('taking it lists the alternate\'s places, then where it rejoins', async () => {
    await boot();
    altButton().click();
    expect(listOrder()).toEqual([
      'Camp One',
      `\u2442Taking ${ALT}`,
      'Ridge Camp',
      `\u21A9${ALT} rejoins the main route`,
      'High Hut',
      'Camp Two',
    ]);
    // Distances after the branch are along the alternate.
    expect(stopItem('Ridge Camp').querySelector('.stop-km')?.textContent).toBe('35.0 km');
    expect(stopItem('High Hut').querySelector('.stop-km')?.textContent).toBe('55.0 km');
    flushSave();
    expect(savedDocument().alternates).toEqual([ALT]);
  });

  it('a stop on the alternate is stored on it, and its day walks it', async () => {
    await boot();
    altButton().click();
    clickRow('Ridge Camp');
    flushSave();
    expect(savedDocument().stops).toEqual([
      { waypointId: 'w_ridge', km: 35, name: 'Ridge Camp', nights: 1, alternate: ALT },
    ]);

    tabButton('days').click();
    const cards = [...$('days-list').querySelectorAll<HTMLElement>('.day-card[data-day-index]')];
    // 35 km is the first day; the 45 km after it is too long to be one, so it
    // is "not planned yet" — measured along the route as planned.
    expect(cards.map(c => c.querySelector('.day-card-route')?.textContent?.trim())).toEqual([
      'Trailhead → Ridge Camp',
    ]);
    expect(cards[0].querySelector('.day-card-via')?.textContent?.trim()).toBe(`via ${ALT}`);
    expect(cards[0].querySelector('.day-card-stats')?.textContent).toContain('35.0 km');
    const unplanned = $('days-list').querySelector('.day-card.is-unplanned');
    expect(unplanned?.textContent).toContain('45.0 km');
  });

  it('going back to the main route drops the alternate\'s stops', async () => {
    await boot();
    altButton().click();
    clickRow('Ridge Camp');
    altButton().click();
    expect(listOrder()).toContain('Salida');
    expect(listOrder()).not.toContain('Ridge Camp');
    flushSave();
    expect(savedDocument().alternates).toBeUndefined();
    expect(savedDocument().stops).toEqual([]);
  });

  it('a stop on the bypassed main route goes when the alternate is taken', async () => {
    await boot();
    clickRow('Salida');
    clickRow('High Hut');
    altButton().click();
    flushSave();
    expect(savedDocument().stops.map(s => s.name)).toEqual(['High Hut']);
    expect(savedDocument().stops[0].km).toBe(45);
  });
});
