/**
 * "Once a resupply plan is made, those points should be clearly highlighted in
 * the other screens" — the web half of it, driven through the real plan viewer
 * in jsdom, exactly as `resupply-tab.test.ts` drives the Resupply tab itself.
 *
 * The rule under test is the one the phone already follows: only an *explicit*
 * selection highlights. A fresh plan has every option ticked so the carries can
 * be measured, but nothing has been planned yet, so nothing is badged.
 *
 *   resupply options (ids are what a selection stores)
 *
 *     w_1  Alpha    town          km 10.00
 *     w_2  Bravo    town-access   km 20.00  ┐ one turn-off, "Mill Road"
 *     w_3  Charlie  food          km 20.05  ┘
 *     w_5  Echo     town          km 40.00
 *
 * Alpha and Echo are used for the assertions: each is a group of its own, so a
 * tick there plans that waypoint and nothing else, whatever the turn-off rule
 * at Mill Road does.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'planned-highlight-fixture';

/** The bundled plan page as the build ships it: the template with the shell inlined. */
function bundledPlanPageHtml(): string {
  return inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS
  );
}

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

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

/** Every element anywhere on the page carrying the planned marking. */
const plannedElements = (): Element[] => [
  ...document.querySelectorAll('.planned-resupply, .planned-badge'),
];

/** The names on the Stops-tab rows that are badged as planned. */
const plannedStopNames = (): string[] =>
  [...$('stops-list').querySelectorAll('.stop-row.planned-resupply')].map(row =>
    (row.querySelector('.stop-name')?.textContent ?? '').trim(),
  );

/** "Day 1", "Day 2" … for the day cards that are badged as planned. */
const plannedDayNumbers = (): string[] =>
  [...$('days-list').querySelectorAll('.day-card.planned-resupply')].map(card =>
    (card.querySelector('.day-card-number')?.textContent ?? '').trim(),
  );

/** The names on the datasheet rows that are badged as planned. */
const plannedDatasheetNames = (): string[] =>
  [...$('datasheet-body').querySelectorAll('.ds-row.planned-resupply')].map(row =>
    (row.querySelector('.ds-name')?.textContent ?? '').replace('Planned resupply', '').trim(),
  );

const stopRow = (km: number): HTMLElement => {
  const row = $('stops-list').querySelector<HTMLElement>(`.stop-row[data-km="${km}"]`);
  if (!row) throw new Error(`no stop row at km ${km}`);
  return row;
};

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
    config: { id: TRAIL_ID, name: 'Planned Highlight Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 50, totalAscent: 800, totalDescent: 100 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_1', 'Alpha', 'town', 10),
      wp('w_2', 'Bravo', 'town-access', 20, { accessName: 'Mill Road', offTrailKm: 22 }),
      wp('w_3', 'Charlie', 'food', 20.05, { accessName: 'Mill Road' }),
      wp('w_camp', 'Camp One', 'campsite', 25),
      wp('w_5', 'Echo', 'town', 40),
    ],
  };
}

async function boot(): Promise<void> {
  const html = bundledPlanPageHtml();
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(TRAIL_ID, makeTrail() as never);
}

/**
 * Make a plan of exactly `ids`: "None" first, so the stored selection becomes
 * explicit, then tick the ones asked for. Leaves the Resupply tab open.
 */
function planExactly(ids: string[]): void {
  tabButton('resupply').click();
  $('resupply-none').click();
  for (const id of ids) check(id).click();
}

/** Add a camp stop, so the Days tab shows day cards rather than its empty note. */
function addCampStop(km: number): void {
  tabButton('stops').click();
  stopRow(km).click();
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Nothing chosen yet
// ---------------------------------------------------------------------------

describe('before a resupply plan is made', () => {
  it('badges nothing, although every option is ticked for the carries', async () => {
    await boot();
    addCampStop(25);

    tabButton('days').click();
    expect(plannedElements()).toEqual([]);

    tabButton('stops').click();
    expect(plannedElements()).toEqual([]);

    // …and the Resupply tab still plans the full set of carries.
    tabButton('resupply').click();
    expect(($('resupply-count').textContent ?? '').trim()).toBe('4 of 4 selected');
    expect($('datasheet-body').querySelectorAll('tbody tr')).toHaveLength(4);
  });

  it('badges nothing for an explicit empty selection either', async () => {
    await boot();
    planExactly([]);
    tabButton('days').click();
    expect(plannedElements()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A plan of two stops
// ---------------------------------------------------------------------------

describe('with two stops planned', () => {
  it('badges exactly those rows on the Stops tab', async () => {
    await boot();
    planExactly(['w_1', 'w_5']);

    tabButton('stops').click();
    expect(plannedStopNames()).toEqual(['Alpha', 'Echo']);
    // Every badge says what it means, for a reader who never opened the tab.
    const badge = $('stops-list').querySelector('.stop-row.planned-resupply .planned-badge');
    expect(badge?.textContent).toBe('Planned resupply');
    expect(badge?.getAttribute('title')).toBe('Planned resupply — ticked in the Resupply tab');
  });

  it('badges the day cards the stops fall in, and names them', async () => {
    await boot();
    addCampStop(25);
    planExactly(['w_1']);

    tabButton('days').click();
    // Day 1 runs km 0–25 and holds Alpha; day 2 runs 25–50 and holds nothing.
    expect(plannedDayNumbers()).toEqual(['Day 1']);
    expect(
      $('days-list')
        .querySelector('.day-card.planned-resupply .planned-badge')
        ?.getAttribute('title'),
    ).toBe('Planned resupply: Alpha');

    // …and the legend explains the marking wherever it appears.
    expect($('resupply-body').textContent).toContain('marks a stop you ticked');
  });

  it('badges the datasheet rows, including a day boundary', async () => {
    await boot();
    // Camp at Echo itself, so the day ends on a planned stop — a row the day
    // plan names, not a waypoint record.
    addCampStop(40);
    planExactly(['w_1', 'w_5']);

    tabButton('days').click();
    expect(plannedDatasheetNames()).toEqual(['Alpha', 'Echo']);

    // Day 1 (km 0–40) holds Alpha and ends at Echo.
    ($('days-list').querySelector('.day-card') as HTMLElement).click();
    expect(plannedDatasheetNames()).toEqual(['Alpha', 'Echo']);
    expect(
      $('datasheet-body').querySelector('.ds-row.ds-end')?.classList.contains('planned-resupply'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Keeping up with the hiker
// ---------------------------------------------------------------------------

describe('changing the selection', () => {
  it('moves the badges with it', async () => {
    await boot();
    addCampStop(25);
    planExactly(['w_1', 'w_5']);

    tabButton('stops').click();
    expect(plannedStopNames()).toEqual(['Alpha', 'Echo']);

    tabButton('resupply').click();
    check('w_1').click(); // drop Alpha

    tabButton('stops').click();
    expect(plannedStopNames()).toEqual(['Echo']);
    tabButton('days').click();
    expect(plannedDayNumbers()).toEqual(['Day 2']);

    // Clearing the plan altogether clears every badge.
    tabButton('resupply').click();
    $('resupply-none').click();
    tabButton('stops').click();
    expect(plannedElements()).toEqual([]);
  });

  it('survives a direction flip, where the same places are at mirrored km', async () => {
    await boot();
    planExactly(['w_1', 'w_5']);

    ($('direction-toggle') as HTMLButtonElement).click();

    tabButton('stops').click();
    // Walked the other way, Echo (now km 10) comes before Alpha (now km 40).
    expect(plannedStopNames()).toEqual(['Echo', 'Alpha']);
  });

  it('comes back badged after a reload', async () => {
    await boot();
    planExactly(['w_5']);
    vi.advanceTimersByTime(900);

    await boot();
    tabButton('stops').click();
    expect(plannedStopNames()).toEqual(['Echo']);
  });
});

// ---------------------------------------------------------------------------
// A trail with nothing to resupply at
// ---------------------------------------------------------------------------

describe('a trail with no resupply options', () => {
  it('renders no marking at all (an imported GPX, on my-plan.html)', async () => {
    const html = bundledPlanPageHtml();
    document.documentElement.innerHTML = html
      .replace(/<!DOCTYPE html>/i, '')
      .replace(/<\/?html[^>]*>/gi, '');

    const trail = makeTrail();
    trail.waypoints = trail.waypoints.filter(wp => wp.type === 'campsite' || wp.type === 'endpoint');

    vi.resetModules();
    const { initPlanViewer } = await import('./plan-viewer');
    await initPlanViewer(TRAIL_ID, trail as never);

    tabButton('stops').click();
    expect(plannedElements()).toEqual([]);
    tabButton('days').click();
    expect(plannedElements()).toEqual([]);
    expect($('resupply-section').hidden).toBe(true);
  });
});
