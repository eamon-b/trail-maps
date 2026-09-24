/**
 * "Plan the next few days" on the web plan page, driven through the real plan
 * viewer in jsdom — the section's buttons, radios and checkboxes, the map
 * preview it draws, the document it writes and the Stops tab's "You are here".
 * The search itself is `day-suggest.test.ts`'s business; the module helpers
 * are `plan-suggest.test.ts`'s. This file is about the page.
 *
 * Helpers are copied from `plan-stops.test.ts` rather than shared.
 *
 *   track — 201 points, one every km, flat, 200 km
 *
 *     w_start   Trailhead   endpoint   km 0
 *     w_c8 …    Camp 8 …    campsite   every 8 km, km 8 … 192
 *     w_end     Trail End   endpoint   km 200
 *
 * At the default 4 km/h and 8 h/day, hours mode aims each day at 8 h = 32 km
 * (window ±2.5 h, so 22–42 km). Camps every 8 km put a camp exactly on every
 * 32 km, so the best three-day plan from km 0 is Camp 32 → 64 → 96.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';
import type { PlanDocument } from '@lib/plan-types';

const ROOT = path.resolve(__dirname, '../../..');

/** The bundled plan page as `build-trails.ts` assembles it. */
function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS,
  );
}

const TRAIL_ID = 'next-days-fixture';
const TOTAL_KM = 200;

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

// ---------------------------------------------------------------------------
// The least Leaflet the viewer needs, recording what the preview draws
// ---------------------------------------------------------------------------

interface StubMarker {
  html: string;
  handlers: Record<string, () => void>;
}

interface PolylineCall {
  latLngs: unknown;
  opts: { dashArray?: string; color?: string } | undefined;
}

let markers: StubMarker[] = [];
let markerCalls: string[] = [];
let polylineCalls: PolylineCall[] = [];
let fitBoundsCalls = 0;

function installLeafletStub(): void {
  const layer = (): object => {
    const obj: object = new Proxy({}, { get: () => () => obj });
    return obj;
  };
  const mapObj: object = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'fitBounds'
          ? () => {
              fitBoundsCalls++;
              return mapObj;
            }
          : () => mapObj,
    },
  );
  const L = {
    map: () => mapObj,
    tileLayer: layer,
    control: { scale: layer },
    layerGroup: layer,
    latLngBounds: layer,
    polyline: (latLngs: unknown, opts?: PolylineCall['opts']) => {
      polylineCalls.push({ latLngs, opts });
      return layer();
    },
    divIcon: (opts: { html: string }) => opts,
    marker: (_latLng: unknown, opts: { icon: { html: string } }) => {
      const marker: StubMarker = { html: opts.icon.html, handlers: {} };
      markers.push(marker);
      markerCalls.push(opts.icon.html);
      const handle = {
        on: (event: string, fn: () => void) => void (marker.handlers[event] = fn),
        addTo: () => handle,
        remove: () => void markers.splice(markers.indexOf(marker), 1),
        setOpacity: () => undefined,
        bindPopup: () => handle,
        openPopup: () => handle,
      };
      return handle;
    },
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const latAt = (km: number): number => -34 - km / 1000;
const lonAt = (km: number): number => 138 + km / 1000;

function makeTrail() {
  const points = Array.from({ length: TOTAL_KM + 1 }, (_, km) => ({
    lat: latAt(km),
    lon: lonAt(km),
    ele: 100,
    dist: km,
  }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: latAt(totalDistance),
    lon: lonAt(totalDistance),
  });
  const camps = [];
  for (let km = 8; km < TOTAL_KM; km += 8) camps.push(wp(`w_c${km}`, `Camp ${km}`, 'campsite', km));
  return {
    config: { id: TRAIL_ID, name: 'Next Days Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: TOTAL_KM, totalAscent: 0, totalDescent: 0 },
    waypoints: [wp('w_start', 'Trailhead', 'endpoint', 0), ...camps, wp('w_end', 'Trail End', 'endpoint', TOTAL_KM)],
  };
}

function storedPlan(stops: PlanDocument['stops']): PlanDocument {
  return {
    id: 'plan-fixture',
    trailId: TRAIL_ID,
    name: 'Fixture plan',
    direction: 'NOBO',
    startDate: null,
    stops,
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  } as PlanDocument;
}

const campStop = (km: number) => ({ waypointId: `w_c${km}`, km, name: `Camp ${km}`, nights: 1 });

function loadPage(): void {
  document.documentElement.innerHTML = bundledPlanPageHtml()
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  markers = [];
  markerCalls = [];
  polylineCalls = [];
  fitBoundsCalls = 0;
}

/** Boot the shipped plan markup with the fixture, on the Days tab. */
async function boot(): Promise<void> {
  loadPage();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

// ---------------------------------------------------------------------------
// Reading and driving the page
// ---------------------------------------------------------------------------

const tabButton = (tab: string): HTMLButtonElement => {
  const btn = document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) throw new Error(`missing tab ${tab}`);
  return btn;
};

const section = (): HTMLElement => $('next-days-body');

const ndAction = (action: string, root: ParentNode = section()): HTMLButtonElement => {
  const btn = root.querySelector<HTMLButtonElement>(`[data-nd-action="${action}"]`);
  if (!btn) throw new Error(`no ${action} button`);
  return btn;
};

const options = (): HTMLElement[] => [...section().querySelectorAll<HTMLElement>('.nd-option')];

const optionDayNames = (option: HTMLElement): string[] =>
  [...option.querySelectorAll('.nd-day-name')].map(el => (el.textContent ?? '').trim());

const fromLine = (): string => (section().querySelector('.nd-from-name')?.textContent ?? '').trim();

/** The walked days — not the dashed "Not planned yet" card after them. */
const dayCards = (): HTMLElement[] => [...$('days-list').querySelectorAll<HTMLElement>('.day-card[data-day-index]')];

const dayRoutes = (): string[] =>
  dayCards().map(card => (card.querySelector('.day-card-route')?.textContent ?? '').trim());

const savedDocument = (): PlanDocument => {
  const raw = localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`);
  if (!raw) throw new Error('nothing saved');
  return JSON.parse(raw);
};

const savedUiPrefs = (): { suggest?: { mode: string; distance: { on: boolean }; ascent: { on: boolean }; hours: { on: boolean } } } =>
  JSON.parse(localStorage.getItem(`trail-plan-ui-${TRAIL_ID}`) ?? '{}');

/** Let the 800 ms debounced save land. */
const flushSave = (): void => void vi.advanceTimersByTime(900);

/** A browser fix exactly on the track point at `km`. */
function mockGeolocationAt(km: number): void {
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (ok: (pos: { coords: { latitude: number; longitude: number } }) => void) =>
        ok({ coords: { latitude: latAt(km), longitude: lonAt(km) } }),
    },
  });
}

const dispatchChange = (input: HTMLInputElement): void =>
  void input.dispatchEvent(new Event('change', { bubbles: true }));

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
  delete (navigator as unknown as { geolocation?: unknown }).geolocation;
  delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView;
});

// ---------------------------------------------------------------------------
// Suggesting
// ---------------------------------------------------------------------------

describe('the Plan the next few days section', () => {
  it('sits in the Days tab and, in Hours & pace mode, lists options and previews the first', async () => {
    await boot();
    const sectionEl = $('next-days-section');
    expect($('tab-days').contains(sectionEl)).toBe(true);
    expect(ndAction('suggest').textContent).toBe('Suggest plans');
    expect(section().querySelector<HTMLInputElement>('[data-nd="mode"][value="hours"]')!.checked).toBe(true);
    expect(fromLine()).toBe('Trailhead · 0.0 km');
    expect(options()).toHaveLength(0);

    polylineCalls = [];
    markerCalls = [];
    ndAction('suggest').click();

    expect(options().length).toBeGreaterThan(1);
    expect(optionDayNames(options()[0])).toEqual(['Day 1 → Camp 32', 'Day 2 → Camp 64', 'Day 3 → Camp 96']);
    expect(options()[0].classList.contains('is-previewed')).toBe(true);
    expect(ndAction('preview', options()[0]).textContent).toBe('Shown on map');

    // Option 1 went straight onto the map: a dashed line per day and a numbered flag per night.
    const dashed = polylineCalls.filter(call => call.opts?.dashArray === '8 6');
    expect(dashed).toHaveLength(3);
    const flags = markerCalls.filter(html => html.includes('suggest-flag-icon'));
    expect(flags).toHaveLength(3);
    expect(flags[0]).toContain('title="Camp 32"');
    expect(fitBoundsCalls).toBeGreaterThan(0);
  });

  it('writes option 1 into the saved plan with "Use this plan", then drops the results', async () => {
    await boot();
    ndAction('suggest').click();
    ndAction('apply', options()[0]).click();

    flushSave();
    expect(savedDocument().stops).toEqual([campStop(32), campStop(64), campStop(96)]);
    expect(dayRoutes()).toEqual(['Trailhead → Camp 32', 'Camp 32 → Camp 64', 'Camp 64 → Camp 96']);
    expect(options()).toHaveLength(0);
    // The next search would now start where the plan ends.
    expect(fromLine()).toBe('Camp 96 · 96.0 km');
  });

  it('keeps a stop beyond the window, and replaces the ones inside it', async () => {
    localStorage.setItem(
      `trail-plan-doc-${TRAIL_ID}`,
      JSON.stringify(storedPlan([campStop(40), campStop(160)])),
    );
    mockGeolocationAt(0);
    await boot();
    // Without a location the search would start at the last stop (km 160).
    expect(fromLine()).toBe('Camp 160 · 160.0 km');
    ndAction('locate').click();
    expect(fromLine()).toBe('Your location · 0.0 km');

    ndAction('suggest').click();
    expect(optionDayNames(options()[0])).toEqual(['Day 1 → Camp 32', 'Day 2 → Camp 64', 'Day 3 → Camp 96']);
    ndAction('apply', options()[0]).click();

    flushSave();
    expect(savedDocument().stops).toEqual([campStop(32), campStop(64), campStop(96), campStop(160)]);
  });
});

// ---------------------------------------------------------------------------
// Distance & climb
// ---------------------------------------------------------------------------

describe('Distance & climb mode', () => {
  it('shows the ranges, refuses to search with none on, and remembers the inputs', async () => {
    await boot();
    expect(section().querySelector('.nd-ranges')).toBeNull();

    const ranges = section().querySelector<HTMLInputElement>('[data-nd="mode"][value="ranges"]')!;
    ranges.checked = true;
    dispatchChange(ranges);

    const rangeRows = [...section().querySelectorAll<HTMLElement>('.nd-range')];
    expect(rangeRows.map(row => row.dataset.range)).toEqual(['distance', 'ascent', 'hours']);
    expect(ndAction('suggest').disabled).toBe(false);
    expect(savedUiPrefs().suggest?.mode).toBe('ranges');

    // Only distance starts switched on; untick every range that is on.
    for (const key of ['distance', 'ascent', 'hours']) {
      const box = section().querySelector<HTMLInputElement>(`.nd-range[data-range="${key}"] [data-nd="range-on"]`)!;
      if (box.checked) {
        box.checked = false;
        dispatchChange(box);
      }
    }

    expect(ndAction('suggest').disabled).toBe(true);
    expect(section().textContent).toContain('Switch on at least one range');
    const saved = savedUiPrefs().suggest!;
    expect(saved.mode).toBe('ranges');
    expect([saved.distance.on, saved.ascent.on, saved.hours.on]).toEqual([false, false, false]);

    // And it is still like that after a reload.
    await boot();
    expect(section().querySelector<HTMLInputElement>('[data-nd="mode"][value="ranges"]')!.checked).toBe(true);
    expect(ndAction('suggest').disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Your location
// ---------------------------------------------------------------------------

describe('"Use my location"', () => {
  it('plans from the snapped km and marks "You are here" in the Stops tab', async () => {
    const scrollIntoView = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = scrollIntoView;
    mockGeolocationAt(50);
    await boot();

    ndAction('locate').click();
    expect(fromLine()).toBe('Your location · 50.0 km');
    // With a fix the button offers a fresh one; with no stop in the plan there
    // is no "From last stop" to choose.
    expect(ndAction('locate').textContent).toBe('Update location');
    expect(document.querySelector('[data-nd-action="toggle-from"]')).toBeNull();

    tabButton('stops').click();
    const divider = $('stops-here');
    expect(divider.textContent).toBe('You are here');
    const next = divider.nextElementSibling as HTMLElement;
    expect(next.classList.contains('stop-item')).toBe(true);
    expect(next.dataset.km).toBe('56');
    expect((divider.previousElementSibling as HTMLElement).dataset.km).toBe('48');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Read-only
// ---------------------------------------------------------------------------

describe('a shared, read-only plan', () => {
  it('has no suggestions section', async () => {
    loadPage();
    const { initPlanViewer } = await import('./plan-viewer');
    await initPlanViewer(TRAIL_ID, makeTrail() as never, {
      readOnly: true,
      preloadedPlan: storedPlan([campStop(32)]),
    });
    expect(document.getElementById('next-days-section')).toBeNull();
    expect(document.getElementById('next-days-body')).toBeNull();
    expect(dayRoutes()[0]).toBe('Trailhead → Camp 32');
  });
});

// ---------------------------------------------------------------------------
// Not planned yet
// ---------------------------------------------------------------------------

describe('the "Not planned yet" card', () => {
  it('shows the long tail after an early stop as unplanned, not as a numbered day', async () => {
    localStorage.setItem(`trail-plan-doc-${TRAIL_ID}`, JSON.stringify(storedPlan([campStop(32)])));
    await boot();

    expect(dayRoutes()).toEqual(['Trailhead → Camp 32']);
    const unplanned = $('days-list').querySelectorAll<HTMLElement>('.day-card.is-unplanned');
    expect(unplanned).toHaveLength(1);
    expect(unplanned[0].dataset.dayIndex).toBeUndefined();
    expect(unplanned[0].querySelector('.day-card-number')?.textContent).toBe('Not planned yet');
    expect(unplanned[0].querySelector('.day-card-route')?.textContent).toBe('Camp 32 → Trail End');
    expect(unplanned[0].textContent).toContain('168.0 km');
  });
});
