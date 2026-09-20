/**
 * What a click on a waypoint marker does on the plan page's map, per tab.
 *
 * `resupply-tab.test.ts` runs without Leaflet; this file stubs just enough of
 * it to capture the marker click handlers the viewer installs, so the two
 * meanings of "click a town" can be told apart: on the Days and Stops tabs it
 * opens a popup whose button adds or removes a camp stop, on the Resupply tab
 * it ticks or unticks the resupply option — the thing that tab highlights on
 * the map.
 *
 * The popup content is a real element the viewer builds and wires, so the stub
 * only has to remember what it was handed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');

/**
 * The bundled plan page as `build-trails.ts` assembles it: `plan-template.html`
 * with the shared `plan-shell.html` markup inlined at its marker.
 */
function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
  );
}

const TRAIL_ID = 'resupply-map-fixture';

interface StubMarker {
  html: string;
  opacity: number;
  handlers: Record<string, () => void>;
  /** The element passed to `bindPopup`, i.e. what the last click opened. */
  popup: HTMLElement | null;
}

let markers: StubMarker[] = [];

/** The least Leaflet the plan viewer needs to boot and draw markers. */
function installLeafletStub(): void {
  // A layer answers every method with itself (addTo, on, bringToBack, …); only
  // markers need real behaviour.
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
      const marker: StubMarker = { html: opts.icon.html, opacity: 1, handlers: {}, popup: null };
      markers.push(marker);
      const handle = {
        on: (event: string, fn: () => void) => void (marker.handlers[event] = fn),
        addTo: () => undefined,
        remove: () => void markers.splice(markers.indexOf(marker), 1),
        setOpacity: (value: number) => void (marker.opacity = value),
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

/**
 * The waypoint marker for a place — not the ⛺ flag that is dropped on top of
 * it once it is a stop, which carries the same `title` and no handlers.
 */
const marker = (name: string): StubMarker => {
  const found = markers.find(
    m => m.html.includes('waypoint-marker') && m.html.includes(`title="${name}"`),
  );
  if (!found) throw new Error(`no marker for ${name}`);
  return found;
};

const check = (optionId: string): HTMLInputElement =>
  document.getElementById(`resupply-opt-${optionId}`) as HTMLInputElement;

const tabButton = (tab: string): HTMLButtonElement =>
  document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`)!;

const savedPlan = (): { stops: unknown[]; resupplyStops?: string[] } => {
  vi.advanceTimersByTime(900);
  return JSON.parse(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`) ?? '{"stops":[]}');
};

/** Click a marker, then press the "Stop here" / "Remove stop" button it opened. */
const pressPopupButton = (name: string): void => {
  const found = marker(name);
  found.handlers.click();
  const button = found.popup?.querySelector<HTMLButtonElement>('.wp-popup-btn');
  if (!button) throw new Error(`the popup for ${name} has no stop button`);
  button.click();
};

function makeTrail() {
  const points = [0, 10, 20, 30].map(km => ({ lat: -34 - km / 1000, lon: 138 + km / 1000, ele: 100, dist: km }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id, name, type, totalDistance, lat: -34 - totalDistance / 1000, lon: 138 + totalDistance / 1000,
  });
  return {
    config: { id: TRAIL_ID, name: 'Map Fixture', shortName: 'Map' },
    track: { points, totalDistance: 30, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_1', 'Alpha', 'town', 10),
      wp('w_camp', 'Camp One', 'campsite', 15),
      wp('w_2', 'Bravo', 'town', 20),
    ],
  };
}

async function boot(): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
  markers = [];
  installLeafletStub();
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { L?: unknown }).L;
});

describe('clicking a waypoint marker', () => {
  it('opens a popup rather than silently toggling a stop', async () => {
    await boot();
    marker('Alpha').handlers.click();

    const popup = marker('Alpha').popup;
    expect(popup?.querySelector('.wp-popup-name')?.textContent).toBe('Alpha');
    expect(popup?.querySelector('.wp-popup-btn')?.textContent?.trim()).toBe('Stop here');
    // The click itself changed nothing — that is the whole point of the popup.
    expect(savedPlan().stops).toHaveLength(0);
  });

  it('toggles a camp stop from the popup button on the Days tab', async () => {
    await boot();
    pressPopupButton('Alpha');

    expect(savedPlan().stops).toHaveLength(1);
    expect(savedPlan().resupplyStops).toBeUndefined();

    // Re-opened, the popup now offers to take the stop away again.
    marker('Alpha').handlers.click();
    expect(marker('Alpha').popup?.querySelector('.wp-popup-btn')?.textContent?.trim()).toBe(
      'Remove stop',
    );
    pressPopupButton('Alpha');
    expect(savedPlan().stops).toHaveLength(0);
  });

  it('toggles the resupply tick on the Resupply tab, not a camp stop', async () => {
    await boot();
    tabButton('resupply').click();
    expect(check('w_1').checked).toBe(true);

    marker('Alpha').handlers.click();

    expect(marker('Alpha').popup).toBeNull();
    expect(check('w_1').checked).toBe(false);
    expect(check('w_2').checked).toBe(true);
    expect(savedPlan().resupplyStops).toEqual(['w_2']);
    expect(savedPlan().stops).toHaveLength(0);

    marker('Alpha').handlers.click();
    expect(check('w_1').checked).toBe(true);
  });

  it('fades an unticked option on the map and restores it when re-ticked', async () => {
    await boot();
    tabButton('resupply').click();
    check('w_2').click();
    expect(marker('Bravo').opacity).toBe(0.4);
    expect(marker('Alpha').opacity).toBe(1);

    check('w_2').click();
    expect(marker('Bravo').opacity).toBe(1);
  });

  it('rings a planned stop on every tab, and only once a plan exists', async () => {
    await boot();
    // A fresh plan has every option ticked for the carries, but nothing planned.
    expect(markers.some(m => m.html.includes('planned-resupply'))).toBe(false);

    tabButton('resupply').click();
    check('w_2').click(); // an explicit selection: everything but Bravo

    expect(marker('Alpha').html).toContain('planned-resupply');
    expect(marker('Bravo').html).not.toContain('planned-resupply');
    // The camp-stop marker is not a resupply option, so it never gets the ring.
    expect(marker('Camp One').html).not.toContain('planned-resupply');

    // The ring stays when the hiker leaves the tab that made the plan.
    tabButton('days').click();
    expect(marker('Alpha').html).toContain('planned-resupply');
  });

  it('still offers a camp stop for a waypoint that is not a resupply option', async () => {
    await boot();
    tabButton('resupply').click();
    pressPopupButton('Camp One');

    expect(savedPlan().stops).toHaveLength(1);
    expect(check('w_1').checked).toBe(true);
    expect(check('w_2').checked).toBe(true);
  });
});
