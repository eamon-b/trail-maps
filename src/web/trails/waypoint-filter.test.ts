/**
 * The Waypoints datasheet filter, driven through the real trail viewer in jsdom.
 *
 * The filter's whole point is the *arithmetic*: with only the water rows on
 * screen, "Dist (km)" has to become the gap from the previous water point, not
 * the gap from whatever waypoint happened to precede it in the full list. So the
 * fixture below is hand-checked — every filtered leg differs from the unfiltered
 * one, and the expected numbers are written out in the assertions rather than
 * derived from the same code under test.
 *
 * It boots the real `my-trail.html` markup (which carries the filter bar) and
 * hands `initTrailViewer` a preloaded trail, so the markup, the renderer and the
 * event delegation are all the shipped ones. jsdom has no layout, so Leaflet
 * no-ops (the viewer already degrades for that) and the canvas is a stub.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

const rowText = (): string[] =>
  [...$('waypoints-container').querySelectorAll('tbody tr')].map(tr =>
    (tr.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

/** The cells of one waypoint row, by its index in the unfiltered array. */
function cells(waypointIndex: number): string[] {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (!row) throw new Error(`row ${waypointIndex} is not rendered`);
  return [...row.querySelectorAll('td')].map(td => (td.textContent ?? '').trim());
}

const headers = (): string[] =>
  [...$('waypoints-container').querySelectorAll('thead th')].map(th => th.textContent ?? '');

function clickFilter(which: 'all' | 'water' | 'resupply'): void {
  const btn = document.querySelector<HTMLButtonElement>(`#waypoint-filter [data-filter="${which}"]`);
  if (!btn) throw new Error(`missing filter button ${which}`);
  btn.click();
}

/**
 * Hand-checked fixture.
 *
 * Cumulative figures are the source of truth; the per-waypoint `distance`/
 * `ascent`/`descent` are the unfiltered leg values, and every one of them
 * differs from the corresponding filtered leg.
 *
 *   #  name            type          total km   totalAsc  totalDesc   raw leg km
 *   0  Trailhead       endpoint          0.0          0          0        0.0
 *   1  Creek Crossing  water             5.0        100         20        5.0
 *   2  Melrose         town             12.0        250         80        7.0
 *   3  Bluff Lookout   mountain         20.0        600        120        8.0
 *   4  Tank Hill       water-tank       33.0        800        300       13.0
 *   5  Hawker          supermarket      61.0       1200        900       28.0
 *   6  Spring Gully    spring           70.0       1300       1000        9.0
 *
 * `supermarket` and `spring` are alias types a foreign GPX might use — they must
 * still land in the resupply and water families.
 */
function makeTrail() {
  const wp = (
    name: string,
    type: string,
    distance: number,
    totalDistance: number,
    ascent: number,
    descent: number,
    totalAscent: number,
    totalDescent: number,
  ) => ({
    name,
    type,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
    elevation: 100 + totalAscent - totalDescent,
    distance,
    totalDistance,
    ascent,
    descent,
    totalAscent,
    totalDescent,
  });

  const points = Array.from({ length: 71 }, (_, i) => ({
    lat: -34 - i / 1000,
    lon: 138 + i / 1000,
    ele: 100 + i * 3,
    dist: i,
  }));

  return {
    config: { id: 'heysen', name: 'Test Trail', region: 'SA' },
    track: { points, totalDistance: 70, totalAscent: 1300, totalDescent: 1000 },
    waypoints: [
      wp('Trailhead', 'endpoint', 0, 0, 0, 0, 0, 0),
      wp('Creek Crossing', 'water', 5, 5, 100, 20, 100, 20),
      wp('Melrose', 'town', 7, 12, 150, 60, 250, 80),
      wp('Bluff Lookout', 'mountain', 8, 20, 350, 40, 600, 120),
      wp('Tank Hill', 'water-tank', 13, 33, 200, 180, 800, 300),
      wp('Hawker', 'supermarket', 28, 61, 400, 600, 1200, 900),
      wp('Spring Gully', 'spring', 9, 70, 100, 100, 1300, 1000),
    ],
    offTrailWaypoints: [
      { name: 'Hidden Spring', type: 'spring', lat: -34.02, lon: 138.02, distanceFromTrail: 200 },
      { name: 'Old Ruin', type: 'poi', lat: -34.03, lon: 138.03, distanceFromTrail: 400 },
    ],
    alternates: [
      {
        name: 'Ridge Alternate',
        type: 'alternate' as const,
        distance: 6,
        startDistance: 10,
        endDistance: 25,
        elevation: { ascent: 100, descent: 80 },
        points: [{ lat: -34.01, lon: 138.01, ele: 200 }],
      },
    ],
    sideTrips: [],
  };
}

/** Boot the real my-trail markup with a preloaded trail. */
async function boot(trail: ReturnType<typeof makeTrail> = makeTrail()): Promise<void> {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const { initTrailViewer } = await import('./trail-viewer');
  await initTrailViewer('heysen', trail as never);
}

/** Capture what the export buttons download, name and body. */
function captureDownloads(): {
  files: Array<{ name: string; blob: Blob }>;
  restore: () => void;
} {
  const files: Array<{ name: string; blob: Blob }> = [];
  const originalCreate = document.createElement.bind(document);
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;
  let lastBlob: Blob | null = null;

  URL.createObjectURL = ((blob: Blob) => {
    lastBlob = blob;
    return 'blob:mock';
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  document.createElement = ((tag: string) => {
    const node = originalCreate(tag);
    if (tag === 'a') {
      (node as HTMLAnchorElement).click = () => {
        files.push({ name: (node as HTMLAnchorElement).download, blob: lastBlob! });
      };
    }
    return node;
  }) as typeof document.createElement;

  return {
    files,
    restore: () => {
      document.createElement = originalCreate;
      URL.createObjectURL = originalCreateUrl;
      URL.revokeObjectURL = originalRevokeUrl;
    },
  };
}

beforeEach(() => {
  // jsdom has no 2D canvas; the elevation profile only needs a no-op context.
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  Element.prototype.scrollIntoView = () => {};
  // jsdom predates Blob.text(); browsers have had it since 2019.
  if (typeof Blob.prototype.text !== 'function') {
    Blob.prototype.text = function (this: Blob) {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(this);
      });
    };
  }
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('the waypoints datasheet filter', () => {
  it('starts on All: every waypoint, the variant markers, and the stored legs', async () => {
    await boot();

    const text = rowText();
    expect(text.some(t => t.includes('Trailhead'))).toBe(true);
    expect(text.some(t => t.includes('Bluff Lookout'))).toBe(true);
    // Variant start/end markers are part of the unfiltered reading.
    expect(text.filter(t => t.includes('Ridge Alternate'))).toHaveLength(2);
    // Both off-trail waypoints, whatever their family.
    expect(text.some(t => t.includes('Hidden Spring'))).toBe(true);
    expect(text.some(t => t.includes('Old Ruin'))).toBe(true);

    expect(headers()).toEqual([
      'Location', 'Type', 'Elev (m)', 'Dist (km)', 'Total (km)',
      'Gain (m)', 'Loss (m)', 'Total Gain', 'Total Loss',
    ]);
    expect($('waypoint-filter-count').textContent).toBe('7 waypoints');
    expect($('waypoint-filter-summary').hidden).toBe(true);

    // Tank Hill's stored leg is 13.0 km — from Bluff Lookout, the row above it.
    expect(cells(4).slice(3, 7)).toEqual(['13.0', '33.0', '200', '180']);
  });

  it('filters to water and remeasures each leg from the previous water source', async () => {
    await boot();
    clickFilter('water');

    const names = rowText();
    expect(names.some(t => t.includes('Creek Crossing'))).toBe(true);
    expect(names.some(t => t.includes('Tank Hill'))).toBe(true);
    expect(names.some(t => t.includes('Spring Gully'))).toBe(true);
    // Everything that is not water is gone, variant markers included.
    expect(names.some(t => t.includes('Melrose'))).toBe(false);
    expect(names.some(t => t.includes('Bluff Lookout'))).toBe(false);
    expect(names.some(t => t.includes('Trailhead'))).toBe(false);
    expect(names.some(t => t.includes('Ridge Alternate'))).toBe(false);

    // Off-trail waypoints of the family survive; the others do not.
    expect(names.some(t => t.includes('Hidden Spring'))).toBe(true);
    expect(names.some(t => t.includes('Old Ruin'))).toBe(false);

    // The column is retitled so nobody reads a filtered gap as a stored leg.
    expect(headers()[3]).toBe('Leg (km)');
    expect(headers()[5]).toBe('Leg Gain (m)');
    expect(headers()[6]).toBe('Leg Loss (m)');

    // Leg | Total | Leg gain | Leg loss
    //   Creek Crossing: from the trailhead — 5.0 - 0, 100 - 0, 20 - 0
    expect(cells(1).slice(3, 7)).toEqual(['5.0', '5.0', '100', '20']);
    //   Tank Hill: from Creek Crossing — 33 - 5, 800 - 100, 300 - 20
    //   (unfiltered it reads 13.0 / 200 / 180)
    expect(cells(4).slice(3, 7)).toEqual(['28.0', '33.0', '700', '280']);
    //   Spring Gully: from Tank Hill — 70 - 33, 1300 - 800, 1000 - 300
    expect(cells(6).slice(3, 7)).toEqual(['37.0', '70.0', '500', '700']);

    // Total Gain / Total Loss stay cumulative along the whole trail.
    expect(cells(4).slice(7)).toEqual(['800', '300']);

    expect($('waypoint-filter-count').textContent).toBe('3 of 7 waypoints');
  });

  it('filters to food & resupply, accepting foreign type aliases', async () => {
    await boot();
    clickFilter('resupply');

    const names = rowText();
    // `town` is canonical, `supermarket` is an alias — both are food.
    expect(names.some(t => t.includes('Melrose'))).toBe(true);
    expect(names.some(t => t.includes('Hawker'))).toBe(true);
    expect(names.some(t => t.includes('Creek Crossing'))).toBe(false);
    expect(names.some(t => t.includes('Hidden Spring'))).toBe(false);

    //   Melrose: from the trailhead — 12 - 0, 250 - 0, 80 - 0
    expect(cells(2).slice(3, 7)).toEqual(['12.0', '12.0', '250', '80']);
    //   Hawker: from Melrose — 61 - 12, 1200 - 250, 900 - 80
    //   (unfiltered it reads 28.0 / 400 / 600)
    expect(cells(5).slice(3, 7)).toEqual(['49.0', '61.0', '950', '820']);

    expect($('waypoint-filter-count').textContent).toBe('2 of 7 waypoints');
  });

  it('returns to the unfiltered table when All is pressed again', async () => {
    await boot();
    clickFilter('water');
    clickFilter('all');

    expect(rowText().some(t => t.includes('Bluff Lookout'))).toBe(true);
    expect(headers()[3]).toBe('Dist (km)');
    expect(cells(4).slice(3, 7)).toEqual(['13.0', '33.0', '200', '180']);
    expect($('waypoint-filter-summary').hidden).toBe(true);
    expect(
      document.querySelector('#waypoint-filter [data-filter="all"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      document.querySelector('#waypoint-filter [data-filter="water"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('says so plainly when nothing matches', async () => {
    const trail = makeTrail();
    trail.waypoints = trail.waypoints.filter(w => w.type !== 'water' && w.type !== 'water-tank' && w.type !== 'spring');
    trail.offTrailWaypoints = [];
    await boot(trail);
    clickFilter('water');

    expect($('waypoints-container').textContent).toContain('No water waypoints on this trail.');
    expect($('waypoint-filter-summary').textContent).toBe('No water sources on this trail.');
    expect($('waypoint-filter-count').textContent).toBe('0 of 4 waypoints');
  });
});

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

describe('the leg summary', () => {
  it('names the longest dry stretch and averages the gaps, for water', async () => {
    await boot();
    clickFilter('water');

    // Gaps between visible rows: 28.0 (Creek → Tank) and 37.0 (Tank → Spring).
    // The 5.0 km from the trailhead is shown in the table but is not a gap
    // between two water sources, so it is not averaged in: (28 + 37) / 2 = 32.5.
    expect($('waypoint-filter-summary').hidden).toBe(false);
    expect($('waypoint-filter-summary').textContent).toBe(
      '3 water sources · 2 legs · longest dry stretch 37.0 km (Tank Hill → Spring Gully) · average 32.5 km',
    );
  });

  it('names the longest resupply leg — the thing the whole filter is for', async () => {
    await boot();
    clickFilter('resupply');

    expect($('waypoint-filter-summary').textContent).toBe(
      '2 resupply points · 1 leg · longest leg 49.0 km (Melrose → Hawker) · average 49.0 km',
    );
  });

  it('counts the walk out from the last water source as a dry stretch', async () => {
    // Drop Spring Gully (km 70) out of the water family, so the last water on
    // the trail is Tank Hill at km 33 of a 70 km walk. The longest gap between
    // two sources is only 28 km (Creek → Tank), but you still have to carry
    // 37 km from Tank Hill to the finish — reporting 28 as the "longest dry
    // stretch" would send someone out short of water.
    const trail = makeTrail();
    trail.waypoints = trail.waypoints.map(w =>
      w.name === 'Spring Gully' ? { ...w, type: 'poi' } : w,
    );
    await boot(trail);
    clickFilter('water');

    expect($('waypoint-filter-summary').textContent).toBe(
      '2 water sources · 1 leg · longest dry stretch 37.0 km (Tank Hill → trail end) · average 28.0 km',
    );
  });

  it('counts the walk in to the only water source, when there is just one', async () => {
    // One source at km 33: nothing to average, but the 33 km walk in is still
    // the dry stretch a hiker needs to know about.
    const trail = makeTrail();
    trail.waypoints = trail.waypoints.map(w =>
      w.name === 'Spring Gully' || w.name === 'Creek Crossing' ? { ...w, type: 'poi' } : w,
    );
    await boot(trail);
    clickFilter('water');

    expect($('waypoint-filter-summary').textContent).toBe(
      '1 water source · longest dry stretch 37.0 km (Tank Hill → trail end)',
    );
  });

  it('does not pretend a single match has a leg', async () => {
    const trail = makeTrail();
    trail.waypoints = trail.waypoints.filter(w => w.type !== 'supermarket');
    await boot(trail);
    clickFilter('resupply');

    expect($('waypoint-filter-summary').textContent).toBe(
      'Only one resupply point on this trail — no legs to measure.',
    );
  });
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

describe('the CSV export', () => {
  it('exports the unfiltered datasheet under its usual name', async () => {
    await boot();
    const downloads = captureDownloads();
    ($('export-csv-btn') as HTMLButtonElement).click();
    const csv = await downloads.files[0].blob.text();
    downloads.restore();

    expect(downloads.files[0].name).toBe('heysen-datasheet.csv');
    expect(csv).toContain('Location,Type,Elevation (m),Distance (km),Total (km),Gain (m),Loss (m)');
    expect(csv).toContain('Bluff Lookout');
    expect(csv).toContain('# Alternate Routes');
    expect(csv).toContain('Old Ruin');
    expect(csv).not.toContain('# View:');
  });

  it('exports exactly the filtered view, legs and all', async () => {
    await boot();
    clickFilter('resupply');
    expect($('export-csv-btn').textContent).toBe('Download CSV (food & resupply)');

    const downloads = captureDownloads();
    ($('export-csv-btn') as HTMLButtonElement).click();
    const csv = await downloads.files[0].blob.text();
    downloads.restore();

    expect(downloads.files[0].name).toBe('heysen-datasheet-resupply.csv');
    expect(csv).toContain('# View: food & resupply only (2 of 7 waypoints)');
    expect(csv).toContain('# 2 resupply points · 1 leg · longest leg 49.0 km (Melrose → Hawker)');
    expect(csv).toContain('Location,Type,Elevation (m),Leg (km),Total (km),Leg Gain (m),Leg Loss (m)');
    // Hawker's leg is the recomputed 49.0, not the stored 28.0. Type is CSV-quoted
    // (an editable, arbitrary string may contain a comma).
    expect(csv).toMatch(/"Hawker","supermarket",\d+,49\.0,61\.0,950,820,1200,900/);
    expect(csv).not.toContain('Bluff Lookout');
    // Nothing hidden from the table may appear in the export of it.
    expect(csv).not.toContain('# Alternate Routes');
    expect(csv).not.toContain('Old Ruin');
  });

  it('keeps off-trail members of the family in a filtered export', async () => {
    await boot();
    clickFilter('water');
    expect($('export-csv-btn').textContent).toBe('Download CSV (water)');

    const downloads = captureDownloads();
    ($('export-csv-btn') as HTMLButtonElement).click();
    const csv = await downloads.files[0].blob.text();
    downloads.restore();

    expect(downloads.files[0].name).toBe('heysen-datasheet-water.csv');
    expect(csv).toContain('# Off-Trail Waypoints');
    expect(csv).toContain('Hidden Spring');
    expect(csv).not.toContain('Old Ruin');
  });
});

// ---------------------------------------------------------------------------
// Type labels
// ---------------------------------------------------------------------------

describe('type badges', () => {
  it('read as labels, with the raw slug kept in the title', async () => {
    await boot();

    const badge = (waypointIndex: number): Element =>
      document.getElementById(`waypoint-row-${waypointIndex}`)!.querySelector('.waypoint-type')!;

    expect(badge(4).textContent).toBe('Water tank');
    expect(badge(4).getAttribute('title')).toBe('water-tank');
    expect(badge(4).classList.contains('type-water-tank')).toBe(true);

    expect(badge(0).textContent).toBe('Start / end');
    expect(badge(0).getAttribute('title')).toBe('endpoint');

    // An unknown imported type is prettified and gets no colour class.
    expect(badge(5).textContent).toBe('Supermarket');
    expect(badge(5).getAttribute('title')).toBe('supermarket');
    expect(badge(5).className.trim()).toBe('waypoint-type');

    // Off-trail rows get the same treatment.
    const offTrail = document.getElementById('off-trail-row-0')!.querySelector('.waypoint-type')!;
    expect(offTrail.textContent).toBe('Spring');
    expect(offTrail.getAttribute('title')).toBe('spring');
  });
});

// ---------------------------------------------------------------------------
// Delegation
// ---------------------------------------------------------------------------

/**
 * These are the regression that motivated moving the listeners off the tbody.
 *
 * The table is rebuilt with `innerHTML`, so a listener bound to the tbody after
 * the first render is discarded by the second — which silently broke row
 * expansion after the direction toggle long before the filter existed.
 */
describe('row expansion survives a re-render', () => {
  it('still expands rows after switching filters', async () => {
    await boot();

    // Baseline: it works on the first render.
    $('waypoint-row-1').click();
    expect(document.getElementById('waypoint-detail-1')).not.toBeNull();
    $('waypoint-row-1').click();
    expect(document.getElementById('waypoint-detail-1')).toBeNull();

    clickFilter('water');
    $('waypoint-row-4').click();
    expect(document.getElementById('waypoint-detail-4')).not.toBeNull();
    expect($('waypoint-row-4').getAttribute('aria-expanded')).toBe('true');

    clickFilter('all');
    // The re-render dropped the detail row, and the state went with it.
    expect(document.getElementById('waypoint-detail-4')).toBeNull();
    $('waypoint-row-4').click();
    expect(document.getElementById('waypoint-detail-4')).not.toBeNull();
  });

  it('still expands rows via the keyboard after switching filters', async () => {
    await boot();
    clickFilter('water');

    $('waypoint-row-6').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(document.getElementById('waypoint-detail-6')).not.toBeNull();
  });

  it('still expands rows after the direction toggle, and keeps the filter', async () => {
    await boot();
    clickFilter('water');

    ($('reverse-direction-btn') as HTMLButtonElement).click();

    // The filter is module state, so it survives the rebuild.
    expect($('waypoint-filter-count').textContent).toBe('3 of 7 waypoints');
    expect(rowText().some(t => t.includes('Bluff Lookout'))).toBe(false);
    expect(headers()[3]).toBe('Leg (km)');

    const firstRow = $('waypoints-container').querySelector('tbody tr') as HTMLElement;
    firstRow.click();
    expect($('waypoints-container').querySelectorAll('.waypoint-detail-row')).toHaveLength(1);
  });
});
