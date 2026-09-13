/**
 * The Resupply tab, driven through the real plan viewer in jsdom.
 *
 * The point of the tab is arithmetic the read-only list could not do: ticking
 * fewer towns has to *merge* the carries between them, not just hide rows. So
 * the fixture below is hand-checked and the expected distances, climbs, days and
 * food weights are written out in the assertions rather than derived from the
 * code under test.
 *
 * It boots the shipped `plan-template.html` markup with a preloaded trail, so
 * the HTML, the renderers and the event delegation are all the real ones. jsdom
 * has no layout, so Leaflet is absent (the viewer already degrades for that),
 * the canvas is a stub, and the 800 ms debounced save is stepped with fake
 * timers.
 *
 *   hand-checked track — 6 points, one every 10 km
 *
 *     km      0     10     20     30     40     50
 *     ele     0    100    300    200    600    700
 *     step        +100   +200   -100   +400   +100
 *
 *   resupply options (ids are what a selection stores)
 *
 *     w_1  Alpha    town          km 10.00   plain on-trail town
 *     w_2  Bravo    town-access   km 20.00  ┐ one turn-off, "Mill Road":
 *     w_3  Charlie  food          km 20.05  ┘ two options, at most one stop
 *     w_4  Delta    resupply      km 30.00
 *     w_5  Echo     town          km 40.00
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'resupply-fixture';

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

/** The checkbox for one option, by waypoint id. */
const check = (optionId: string): HTMLInputElement => {
  const node = document.getElementById(`resupply-opt-${optionId}`);
  if (!node) throw new Error(`option ${optionId} is not rendered`);
  return node as HTMLInputElement;
};

const tabButton = (tab: string): HTMLButtonElement => {
  const btn = document.querySelector<HTMLButtonElement>(`.tab-btn[data-tab="${tab}"]`);
  if (!btn) throw new Error(`missing tab ${tab}`);
  return btn;
};

/** The resupply datasheet's rows, cell by cell. */
const legRows = (): string[][] =>
  [...$('datasheet-body').querySelectorAll('tbody tr')].map(tr =>
    [...tr.querySelectorAll('td')].map(td => (td.textContent ?? '').trim()),
  );

const legHeaders = (): string[] =>
  [...$('datasheet-body').querySelectorAll('thead th')].map(th => (th.textContent ?? '').trim());

const countText = (): string => ($('resupply-count').textContent ?? '').trim();

const rowNames = (): string[] =>
  [...$('resupply-list').querySelectorAll('.resupply-name')].map(el => (el.textContent ?? '').trim());

function makeTrail() {
  const ELE = [0, 100, 300, 200, 600, 700];
  const points = ELE.map((ele, i) => ({
    lat: -34 - (i * 10) / 1000,
    lon: 138 + (i * 10) / 1000,
    ele,
    dist: i * 10,
  }));

  const wp = (
    id: string,
    name: string,
    type: string,
    totalDistance: number,
    extra: Record<string, unknown> = {},
  ) => ({
    id,
    name,
    type,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
    totalDistance,
    ...extra,
  });

  return {
    config: { id: TRAIL_ID, name: 'Resupply Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 50, totalAscent: 800, totalDescent: 100 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_1', 'Alpha', 'town', 10),
      wp('w_2', 'Bravo', 'town-access', 20, {
        accessName: 'Mill Road',
        offTrailKm: 22,
        accessMode: 'hitch',
        acceptsBoxes: true,
        description: 'General store and post office. Closed Sundays.',
      }),
      wp('w_3', 'Charlie', 'food', 20.05, { accessName: 'Mill Road' }),
      wp('w_camp', 'Camp One', 'campsite', 25),
      wp('w_4', 'Delta', 'resupply', 30),
      wp('w_5', 'Echo', 'town', 40),
    ],
  };
}

/** Boot the shipped plan markup with a preloaded trail, on the Resupply tab. */
async function boot(openResupply = true): Promise<void> {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
  if (openResupply) tabButton('resupply').click();
}

/** Let the 800 ms debounced save land. */
const flushSave = (): void => void vi.advanceTimersByTime(900);

beforeEach(() => {
  // jsdom has no 2D canvas; the elevation profile only needs a no-op context.
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Default selection
// ---------------------------------------------------------------------------

describe('the Resupply tab with nothing chosen yet', () => {
  it('ticks every option and plans a leg between each turn-off', async () => {
    await boot();

    expect(countText()).toBe('5 of 5 selected');
    expect(['w_1', 'w_2', 'w_3', 'w_4', 'w_5'].every(id => check(id).checked)).toBe(true);

    // Four groups (Bravo and Charlie share Mill Road), so five carries:
    // trail start → Alpha → Mill Road → Delta → Echo → trail end.
    expect($('datasheet-title').textContent).toBe('Resupply plan');
    expect(legRows()).toHaveLength(5);
    expect($('datasheet-subtitle').textContent).toBe(
      '4 stops · longest carry 10.0 km / 1 day · 3.4 kg food in total',
    );
  });

  it('collapses two ticks at one turn-off into a single stop', async () => {
    await boot();

    // Mill Road is one row of the table, named for both places you can reach.
    const routes = legRows().map(cells => cells[1]);
    expect(routes).toEqual([
      'Trail Start → Alpha',
      'Alpha → Bravo / Charlie',
      'Bravo / Charlie → Delta',
      'Delta → Echo',
      'Echo → Trail End',
    ]);
    expect(routes.filter(route => route.includes('Bravo'))).toHaveLength(2);
  });

  it('shows the turn-off as a group header and the access detail as a subline', async () => {
    await boot();

    const headers = [...$('resupply-list').querySelectorAll('.resupply-group-header')].map(el =>
      (el.textContent ?? '').trim(),
    );
    expect(headers).toEqual(['⤴ Mill Road · km 20.0']);

    const sub = $('resupply-list').querySelector('.resupply-row[data-id="w_2"] .resupply-sub');
    expect(sub?.textContent).toBe('22.0 km hitch · General store and post office. · accepts boxes');
  });

  it('omits the Arrive column until the camp plan has stops and a start date', async () => {
    await boot();
    expect(legHeaders()).toEqual([
      '#', 'From → To', 'Distance', 'Ascent', 'Descent', 'Est. days', 'Food',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Unticking
// ---------------------------------------------------------------------------

describe('unticking options', () => {
  it('merges the carries either side of every option dropped', async () => {
    await boot();

    check('w_4').click(); // Delta
    check('w_5').click(); // Echo

    expect(countText()).toBe('3 of 5 selected');
    const rows = legRows();
    expect(rows).toHaveLength(3);

    // The last carry now runs Mill Road (km 20) → trail end (km 50): 30.0 km,
    // climbing 200→600→700 with one 100 m drop on the way (+500 / -100).
    // Naismith: 30/4 + 500/600 = 8.33 h → 2 days at 8 h → 2 × 680 g = 1.4 kg.
    expect(rows[2]).toEqual([
      '3', 'Bravo / Charlie → Trail End', '30.0 km', '+500 m', '-100 m', '2', '1.4 kg',
    ]);
    expect($('datasheet-subtitle').textContent).toBe(
      '2 stops · longest carry 30.0 km / 2 days · 2.7 kg food in total',
    );
  });

  it('keeps the Days-tab summary in step with the table', async () => {
    await boot();
    check('w_4').click();
    check('w_5').click();

    tabButton('days').click();
    expect($('resupply-body').textContent).toContain(
      '2 stops · longest carry 30.0 km / 2 days · 2.7 kg food in total',
    );

    // …and the collapsible's link is how you get back to the picker.
    $('resupply-edit-link').click();
    expect(tabButton('resupply').classList.contains('active')).toBe(true);
    expect($('datasheet-title').textContent).toBe('Resupply plan');
  });
});

// ---------------------------------------------------------------------------
// All / None
// ---------------------------------------------------------------------------

describe('the All and None buttons', () => {
  it('empties and refills the plan', async () => {
    await boot();

    $('resupply-none').click();
    expect(countText()).toBe('0 of 5 selected');
    expect(legRows()).toHaveLength(0);
    expect($('datasheet-body').textContent).toContain('No resupply stops ticked');
    expect(['w_1', 'w_2', 'w_3', 'w_4', 'w_5'].some(id => check(id).checked)).toBe(false);

    $('resupply-all').click();
    expect(countText()).toBe('5 of 5 selected');
    expect(legRows()).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

describe('the filter box', () => {
  it('narrows the rows without changing the selection', async () => {
    await boot();
    check('w_5').click();

    const filter = $('resupply-filter') as HTMLInputElement;
    filter.value = 'brav';
    filter.dispatchEvent(new Event('input'));

    expect(rowNames()).toEqual(['Bravo']);
    // Still "4 of 5": the filter hides rows, it does not untick them.
    expect(countText()).toBe('4 of 5 selected');
    expect(legRows()).toHaveLength(4);

    // A turn-off's own name keeps everything reachable from it.
    filter.value = 'mill road';
    filter.dispatchEvent(new Event('input'));
    expect(rowNames()).toEqual(['Bravo', 'Charlie']);
  });
});

// ---------------------------------------------------------------------------
// Persistence and direction
// ---------------------------------------------------------------------------

describe('a saved selection', () => {
  it('comes back after a reload', async () => {
    await boot();
    check('w_4').click();
    check('w_5').click();
    flushSave();

    expect(JSON.parse(localStorage.getItem(`trail-plan-${TRAIL_ID}`)!).resupplyStops).toEqual([
      'w_1', 'w_2', 'w_3',
    ]);

    await boot();
    expect(countText()).toBe('3 of 5 selected');
    expect(check('w_4').checked).toBe(false);
    expect(check('w_5').checked).toBe(false);
    expect(check('w_1').checked).toBe(true);
    expect(legRows()).toHaveLength(3);
  });

  it('survives a direction flip, because ids do not change under reversal', async () => {
    await boot();
    check('w_1').click(); // drop Alpha

    ($('direction-toggle') as HTMLButtonElement).click();

    // Walked the other way the same places appear in the opposite order…
    expect(rowNames()).toEqual(['Echo', 'Delta', 'Charlie', 'Bravo', 'Alpha']);
    // …and exactly the same ones are ticked.
    expect(countText()).toBe('4 of 5 selected');
    expect(check('w_1').checked).toBe(false);
    expect(['w_2', 'w_3', 'w_4', 'w_5'].every(id => check(id).checked)).toBe(true);
    expect(legRows()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Arrive column
// ---------------------------------------------------------------------------

describe('the Arrive column', () => {
  it('appears once there is a camp plan with a start date', async () => {
    await boot(false);

    const date = $('plan-start-date') as HTMLInputElement;
    date.value = '2026-03-01';
    date.dispatchEvent(new Event('change'));

    // One camp stop, added from the Stops tab the way the page does it.
    tabButton('stops').click();
    const row = $('stops-list').querySelector<HTMLElement>('.stop-row[data-km="25"]');
    row!.click();

    tabButton('resupply').click();
    expect(legHeaders()).toContain('Arrive');
    // The first carry ends at Alpha (km 10), inside day 1 — the 1st of March.
    expect(legRows()[0][7]).toBe('Day 1 (1 Mar)');
  });
});
