/**
 * Correcting a waypoint's category on an imported trail's page.
 *
 * Automatic classification is a guess, so the fix has to be a real edit: a
 * control on the page, a write to IndexedDB, and a page that immediately agrees
 * with what was written. The failure modes worth a test are all *integration*
 * ones — a control that shows up on a read-only bundled page, a badge that
 * updates while the write silently failed, a filter that still lists a waypoint
 * under the old category, an edit that reaches only one of the three lists a
 * waypoint id can appear in.
 *
 * Two harnesses, on purpose:
 *   - `boot()` drives the shared viewer with a hand-written callback, which is
 *     the only way to test the "no callback at all" (bundled) case and a write
 *     that rejects.
 *   - `bootPage()` drives the real `my-trail.html` + `my-trail.ts` against
 *     `fake-indexeddb`, which is what proves a correction survives a reload.
 *
 * jsdom has no layout, so Leaflet no-ops (the viewer already degrades for that)
 * and the canvas is a stub.
 */

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ProcessedTrail } from '@lib/trail-types';
import { closeImportedTrailsDb, getTrail, putTrail } from './imported-trails-db';

const ROOT = path.resolve(__dirname, '../..');

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

/** The category `<select>` inside an expanded row's detail panel, if any. */
function typeSelect(): HTMLSelectElement | null {
  return document.querySelector<HTMLSelectElement>('select.waypoint-type-select');
}

function requireSelect(): HTMLSelectElement {
  const select = typeSelect();
  if (!select) throw new Error('no category control is rendered');
  return select;
}

/** Pick a category the way a user would, and let the async save settle. */
async function choose(select: HTMLSelectElement, value: string): Promise<void> {
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

async function flush(times = 40): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const badgeIn = (row: HTMLElement): HTMLElement =>
  row.querySelector<HTMLElement>('.waypoint-type')!;

const rowNames = (): string[] =>
  [...$('waypoints-container').querySelectorAll('tbody tr')].map(tr =>
    (tr.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

function clickFilter(which: 'all' | 'water' | 'resupply'): void {
  document.querySelector<HTMLButtonElement>(`#waypoint-filter [data-filter="${which}"]`)!.click();
}

/**
 * Fixture with ids on every waypoint, because ids — not array positions — are
 * what the editor addresses.
 *
 * `Bluff Lookout` is deliberately a `mountain` (in no family), `Old Mill` an
 * unknown `fire-trail` type from the file's own vocabulary, and `uw_shared`
 * appears three times over: on the main route, in the off-trail list and on an
 * alternate.
 */
function makeTrail(): ProcessedTrail {
  const wp = (id: string, name: string, type: string, km: number) => ({
    id,
    name,
    type,
    lat: -34 - km / 1000,
    lon: 138 + km / 1000,
    elevation: 100 + km,
    distance: km,
    totalDistance: km,
    ascent: km * 10,
    descent: km * 2,
    totalAscent: km * 10,
    totalDescent: km * 2,
    trackIndex: km,
  });

  const points = Array.from({ length: 41 }, (_, i) => ({
    lat: -34 - i / 1000,
    lon: 138 + i / 1000,
    ele: 100 + i * 3,
    dist: i,
  }));

  return {
    config: { id: 'u_test', name: 'Imported Walk', region: 'Imported', source: 'imported' },
    track: {
      points,
      displayPoints: points,
      totalDistance: 40,
      totalAscent: 400,
      totalDescent: 80,
    },
    waypoints: [
      wp('uw_trailhead', 'Trailhead', 'endpoint', 0),
      wp('uw_creek', 'Creek Crossing', 'water', 5),
      wp('uw_bluff', 'Bluff Lookout', 'mountain', 12),
      wp('uw_mill', 'Old Mill', 'fire-trail', 20),
      wp('uw_shared', 'Junction Hut', 'waypoint', 30),
      wp('uw_tank', 'Tank Hill', 'water-tank', 40),
    ],
    offTrailWaypoints: [
      {
        id: 'uw_shared',
        name: 'Junction Hut',
        type: 'waypoint',
        lat: -34.03,
        lon: 138.03,
        distanceFromTrail: 600,
      },
    ],
    alternates: [
      {
        name: 'Ridge Alternate',
        type: 'alternate',
        distance: 6,
        startDistance: 10,
        endDistance: 25,
        elevation: { ascent: 100, descent: 80 },
        points: [{ lat: -34.01, lon: 138.01, ele: 200, dist: 0 }],
        waypoints: [
          {
            id: 'uw_shared',
            name: 'Junction Hut',
            type: 'waypoint',
            lat: -34.03,
            lon: 138.03,
            elevation: 130,
            distance: 1,
            totalDistance: 11,
            ascent: 10,
            descent: 5,
            totalAscent: 110,
            totalDescent: 85,
            variantTrackIndex: 0,
          },
        ],
      },
    ],
    sideTrips: [],
    climate: null,
    climateLocations: null,
    direction: null,
  } as unknown as ProcessedTrail;
}

function loadMarkup(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
}

/** Boot the shared viewer with an explicit (or absent) edit callback. */
async function boot(
  onWaypointTypeChange?: (waypointId: string, nextType: string) => Promise<void> | void,
  trail: ProcessedTrail = makeTrail(),
): Promise<void> {
  loadMarkup();
  vi.resetModules();
  const { initTrailViewer } = await import('./trails/trail-viewer');
  await initTrailViewer(
    'u_test',
    trail as never,
    onWaypointTypeChange ? { onWaypointTypeChange } : undefined,
  );
}

/** Seed IndexedDB and boot the real page, wiring included. */
async function bootPage(trail: ProcessedTrail = makeTrail()): Promise<string> {
  await putTrail({
    id: 'u_test',
    name: trail.config.name,
    lengthKm: trail.track.totalDistance,
    createdAt: Date.now(),
    trail,
  });

  loadMarkup();
  window.history.replaceState({}, '', '/my-trail.html?id=u_test');
  vi.resetModules();
  await import('./my-trail');
  await flush();
  return 'u_test';
}

/** Expand one waypoint row by its index in the unfiltered array. */
function expandRow(waypointIndex: number): HTMLElement {
  const row = $(`waypoint-row-${waypointIndex}`);
  row.click();
  return row;
}

beforeEach(async () => {
  vi.resetModules();
  await closeImportedTrailsDb();
  // Wipe the store so each test starts from nothing.
  try {
    const existing = await getTrail('u_test');
    if (existing) {
      const { deleteTrail } = await import('./imported-trails-db');
      await deleteTrail('u_test');
    }
  } catch {
    // No database yet.
  }

  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Where the control appears
// ---------------------------------------------------------------------------

describe('the category control is opt-in', () => {
  it('is absent on a read-only page — the bundled trail case', async () => {
    await boot();

    const row = expandRow(2);
    // The panel itself is there; only the editor is missing.
    expect(document.getElementById('waypoint-detail-2')).not.toBeNull();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(typeSelect()).toBeNull();
    expect(document.querySelector('.waypoint-type-edit')).toBeNull();
  });

  it('appears, labelled and linked, when the page can save a change', async () => {
    await boot(() => undefined);
    expandRow(2);

    const select = requireSelect();
    // A real <label for>, not a floating bit of text.
    const label = document.querySelector<HTMLLabelElement>('.waypoint-type-edit-label')!;
    expect(label.textContent?.trim()).toBe('Category');
    expect(label.htmlFor).toBe(select.id);
    expect(select.id).not.toBe('');

    // Live region for the save result.
    const status = document.querySelector('.waypoint-type-edit-status')!;
    expect(status.getAttribute('aria-live')).toBe('polite');

    // The hint points at the section of the generated doc about this control.
    const help = document.querySelector<HTMLAnchorElement>('.waypoint-type-help')!;
    expect(help.getAttribute('href')).toBe('./how-import-works.html#fixing-a-category');

    // Preselected to the waypoint's current type, and offering the vocabulary
    // by label rather than by slug.
    expect(select.value).toBe('mountain');
    const options = [...select.options].map(o => o.value);
    expect(options).toContain('water');
    expect(options).toContain('waypoint');
    expect([...select.options].find(o => o.value === 'waypoint')!.textContent).toBe('Unclassified');
    expect([...select.options].find(o => o.value === 'water')!.textContent).toBe('Water source');
  });

  it('keeps a type from the file that is not in our vocabulary', async () => {
    await boot(() => undefined);
    expandRow(3);

    const select = requireSelect();
    // `fire-trail` is the GPX's own word. Offering only our types would mean an
    // unrelated edit silently rewrote it.
    expect(select.value).toBe('fire-trail');
    expect(select.options[0].value).toBe('fire-trail');
    expect(select.options[0].textContent).toBe('Fire trail (from your file)');
    expect(select.options[0].selected).toBe(true);
  });

  it('offers the control on off-trail rows too', async () => {
    await boot(() => undefined);
    $('off-trail-row-0').click();

    const select = requireSelect();
    expect(select.dataset.waypointId).toBe('uw_shared');
    expect(select.value).toBe('waypoint');
  });
});

// ---------------------------------------------------------------------------
// What a change does to the page
// ---------------------------------------------------------------------------

describe('changing a category', () => {
  it('repaints the badge, the row tint and the filter membership', async () => {
    const seen: Array<[string, string]> = [];
    await boot((id, next) => {
      seen.push([id, next]);
    });

    const row = expandRow(2);
    expect(badgeIn(row).textContent).toBe('Mountain');
    expect(rowNames().some(t => t.includes('Bluff Lookout'))).toBe(true);

    await choose(requireSelect(), 'water');

    // Addressed by id, not by the row's position in the table.
    expect(seen).toEqual([['uw_bluff', 'water']]);

    expect(badgeIn(row).textContent).toBe('Water source');
    expect(badgeIn(row).classList.contains('type-water')).toBe(true);
    expect(badgeIn(row).title).toBe('water');
    // The panel stays open, so the user keeps their place.
    expect(document.getElementById('waypoint-detail-2')).not.toBeNull();
    expect(document.querySelector('.waypoint-type-edit-status')?.textContent).toBe(
      'Saved as Water source',
    );

    // And the water filter now counts it.
    clickFilter('water');
    expect(rowNames().some(t => t.includes('Bluff Lookout'))).toBe(true);
    // Creek Crossing and Tank Hill were the water rows; Bluff Lookout is now a
    // third.
    expect($('waypoint-filter-count').textContent).toBe('3 of 6 waypoints');
  });

  it('tints a row that becomes a resupply point', async () => {
    await boot(() => undefined);
    const row = expandRow(2);
    expect(row.className).not.toContain('highlight');

    await choose(requireSelect(), 'food');
    expect(row.classList.contains('highlight-resupply')).toBe(true);

    await choose(requireSelect(), 'town');
    expect(row.classList.contains('highlight-town')).toBe(true);
    expect(row.classList.contains('highlight-resupply')).toBe(false);
  });

  it('rebuilds the table when the change drops the row out of a filtered view', async () => {
    await boot(() => undefined);
    clickFilter('water');
    expect(rowNames().some(t => t.includes('Creek Crossing'))).toBe(true);

    expandRow(1);
    await choose(requireSelect(), 'poi');

    // It is no longer water, so it is no longer in the water view — and the
    // announcement says so, because the control the user was using is gone.
    expect(rowNames().some(t => t.includes('Creek Crossing'))).toBe(false);
    expect($('waypoint-type-announce').hidden).toBe(false);
    expect($('waypoint-type-announce').textContent).toContain('Saved as Point of interest');
    // Only Tank Hill is left in the water view.
    expect($('waypoint-filter-count').textContent).toBe('1 of 6 waypoints');
  });

  it('does nothing when the value did not actually change', async () => {
    const calls: string[] = [];
    await boot(id => {
      calls.push(id);
    });
    expandRow(2);

    const select = requireSelect();
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// When the write fails
// ---------------------------------------------------------------------------

describe('a failed write', () => {
  it('reverts the control, says why, and leaves the trail untouched', async () => {
    const trail = makeTrail();
    await boot(() => Promise.reject(new Error('storage is full')), trail);

    const row = expandRow(2);
    await choose(requireSelect(), 'water');

    const select = requireSelect();
    // Reverted, not left showing a value that was never saved.
    expect(select.value).toBe('mountain');
    expect(select.disabled).toBe(false);
    expect(badgeIn(row).textContent).toBe('Mountain');
    // In-memory trail unmutated.
    expect(trail.waypoints[2].type).toBe('mountain');

    const status = document.querySelector('.waypoint-type-edit-status')!;
    expect(status.textContent).toBe('Not saved: storage is full');
    expect(status.classList.contains('is-error')).toBe(true);
    // An error is not a polite update; it has to interrupt.
    expect(status.getAttribute('role')).toBe('alert');
  });
});

// ---------------------------------------------------------------------------
// Persistence, through the real page
// ---------------------------------------------------------------------------

describe('a correction on the real my-trail page', () => {
  it('round-trips through IndexedDB and survives a reload', async () => {
    await bootPage();

    expandRow(2);
    await choose(requireSelect(), 'campsite');

    const stored = await getTrail('u_test');
    expect(stored?.trail.waypoints.find(w => w.id === 'uw_bluff')?.type).toBe('campsite');
    // Nothing else was rewritten on the way through.
    expect(stored?.trail.waypoints.find(w => w.id === 'uw_creek')?.type).toBe('water');
    expect(stored?.name).toBe('Imported Walk');

    // Reload: the badge and the control both come back on the new value.
    await bootPageAgain();
    expect(badgeIn($('waypoint-row-2')).textContent).toBe('Campsite');
    expandRow(2);
    expect(requireSelect().value).toBe('campsite');
  });

  it('updates every list the same waypoint id appears in', async () => {
    await bootPage();

    // uw_shared is on the main route, in the off-trail list and on an alternate.
    expandRow(4);
    await choose(requireSelect(), 'hut');

    const trail = (await getTrail('u_test'))!.trail;
    expect(trail.waypoints.find(w => w.id === 'uw_shared')?.type).toBe('hut');
    expect(trail.offTrailWaypoints.find(w => w.id === 'uw_shared')?.type).toBe('hut');
    expect(trail.alternates[0].waypoints?.find(w => w.id === 'uw_shared')?.type).toBe('hut');
  });

  it('serialises two quick edits so neither is clobbered', async () => {
    await bootPage();

    // Fire the second change while the first write is still in flight.
    const first = $('waypoint-row-2');
    first.click();
    const selectA = requireSelect();
    selectA.value = 'campsite';
    selectA.dispatchEvent(new Event('change', { bubbles: true }));

    first.click(); // collapse
    const second = $('waypoint-row-3');
    second.click();
    const selectB = requireSelect();
    selectB.value = 'hut';
    selectB.dispatchEvent(new Event('change', { bubbles: true }));

    await flush();

    const trail = (await getTrail('u_test'))!.trail;
    // Both survive: the second write read what the first one stored.
    expect(trail.waypoints.find(w => w.id === 'uw_bluff')?.type).toBe('campsite');
    expect(trail.waypoints.find(w => w.id === 'uw_mill')?.type).toBe('hut');
  });

  it('reports a write that cannot happen instead of pretending it did', async () => {
    await bootPage();
    expandRow(2);

    // Delete the record from under the page — the same shape of failure as a
    // storage eviction or a second tab removing the trail.
    const { deleteTrail } = await import('./imported-trails-db');
    await deleteTrail('u_test');

    await choose(requireSelect(), 'campsite');

    const select = requireSelect();
    expect(select.value).toBe('mountain');
    expect(document.querySelector('.waypoint-type-edit-status')?.textContent).toMatch(
      /Not saved:.*no longer/,
    );
    expect(badgeIn($('waypoint-row-2')).textContent).toBe('Mountain');
  });
});

/** Re-open `my-trail.html` against whatever is currently in IndexedDB. */
async function bootPageAgain(): Promise<void> {
  loadMarkup();
  window.history.replaceState({}, '', '/my-trail.html?id=u_test');
  vi.resetModules();
  await import('./my-trail');
  await flush();
}
