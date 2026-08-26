/**
 * End-to-end walkthrough of the three GPX-import pages, driven through jsdom.
 *
 * These pages have no server and no framework: `upload.html`, `my-trail.html`
 * and `my-plan.html` are static markup plus a boot script that wires the shared
 * viewers to IndexedDB. That makes the interesting failures *integration*
 * failures — an element id that drifted between the HTML and its script, a
 * viewer that still tries to fetch when it was handed a trail, plan state
 * written under one key and read under another — none of which a unit test on
 * either side would catch.
 *
 * So this drives the real files: it reads the actual HTML into the document,
 * imports the actual boot module, and clicks the actual buttons, with
 * `fake-indexeddb` standing in for browser storage. The fixtures are real too —
 * the 4,935-point, four-track Cape to Cape GPX is the multi-track case, and
 * `no-elevation.gpx` is the degraded one.
 *
 * What jsdom cannot do is layout, so Leaflet no-ops (the viewer already guards
 * for that) and the canvas is a stub. Map rendering is not what these tests are
 * for.
 */

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { closeImportedTrailsDb, getTrail, listTrailSummaries } from './imported-trails-db';

const ROOT = path.resolve(__dirname, '../..');

/** Load one of the real pages into the document, with a given query string. */
function loadPage(file: string, search = ''): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web', file), 'utf8');
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  window.history.replaceState({}, '', `/${file}${search}`);
}

const fixture = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Hand a File to the page's file input the way a picker would. */
function chooseFile(name: string, text: string): void {
  const input = document.getElementById('file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [new File([text], name, { type: 'application/gpx+xml' })],
    configurable: true,
  });
  input.dispatchEvent(new Event('change'));
}

/**
 * Drain the microtask queue and the timer queue several times over.
 *
 * The pages chain promises across `requestAnimationFrame` and `setTimeout`
 * boundaries (the "Processing…" paint yield), so a single `await` is not enough
 * and the number of hops is not worth pinning down precisely.
 */
async function flush(times = 60): Promise<void> {
  for (let round = 0; round < 6; round++) {
    for (let i = 0; i < times; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

beforeEach(async () => {
  vi.resetModules();
  await closeImportedTrailsDb();

  // jsdom has no 2D canvas; the elevation profile only needs a no-op context.
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
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
// Upload
// ---------------------------------------------------------------------------

describe('upload.html', () => {
  it('ingests a real multi-track GPX and reports what it found', async () => {
    loadPage('upload.html');
    await import('./upload');

    chooseFile('Cape_to_Cape_Track.gpx', fixture('data/trails/cape_to_cape/Cape_to_Cape_Track.gpx'));
    await flush();

    expect($('error').hidden, $('error-message').textContent ?? '').toBe(true);
    expect($('report').hidden).toBe(false);

    const stats = $('report-stats').textContent ?? '';
    expect(stats).toMatch(/Distance:\s*1\d\d\.\d km/);
    expect(stats).toContain('Elevation data: present');
    // Four <trk> elements in the file — the report must say so rather than
    // silently chaining them.
    expect(stats).toMatch(/Tracks in file: 4/);
    expect(Number($('report-stats').textContent?.match(/Waypoints: (\d+)/)?.[1])).toBeGreaterThan(0);

    // Classification is a guess, so the report has to account for it: how many
    // types were read out of the names, and how many waypoints are still
    // uncategorised and therefore invisible to the plan calculator.
    expect(stats).toMatch(/Not categorised:/);
    const note = $('report').textContent ?? '';
    expect(note).toContain('Category');
    expect(
      $('report').querySelector('a[href*="types-guessed-from-the-name"]'),
      'the report links to how categories are worked out',
    ).not.toBeNull();

    expect(($('trail-name') as HTMLInputElement).value).toBe('Cape to Cape Track');
    // Elevation is present, so the backfill offer stays hidden.
    expect($('elevation-backfill').hidden).toBe(true);
  });

  it('offers an elevation backfill when the file has no <ele>', async () => {
    loadPage('upload.html');
    await import('./upload');

    chooseFile('flat.gpx', fixture('tests/fixtures/gpx/no-elevation.gpx'));
    await flush();

    expect($('report').hidden).toBe(false);
    expect($('report-stats').textContent).toContain('Elevation data: missing');
    expect($('elevation-backfill').hidden).toBe(false);
    expect($('fetch-elevation-btn').textContent).toMatch(/Fetch elevation.*requests/);
    // And the warning explains what that costs the plan.
    expect($('report-warnings').hidden).toBe(false);
    expect($('report-warning-list').textContent).toMatch(/distance-only/);
  });

  it('rejects a file with unparseable coordinates instead of plotting 0°N 0°E', async () => {
    loadPage('upload.html');
    await import('./upload');

    chooseFile('bad.gpx', fixture('tests/fixtures/gpx/bad-coordinates.gpx'));
    await flush();

    expect($('error').hidden).toBe(false);
    expect($('error-message').textContent).toMatch(/coordinate|lat|lon/i);
    expect($('report').hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upload → my-trail → my-plan → delete
// ---------------------------------------------------------------------------

describe('the full import journey', () => {
  /** Import a fixture and press Save; returns the stored trail id. */
  async function importAndSave(file: string, text: string, name?: string): Promise<string> {
    loadPage('upload.html');
    await import('./upload');
    chooseFile(file, text);
    await flush();

    if (name !== undefined) ($('trail-name') as HTMLInputElement).value = name;
    ($('save-btn') as HTMLButtonElement).click();
    await flush();

    expect($('saved').hidden, ($('save-error').textContent ?? '') || 'save failed').toBe(false);
    const summaries = await listTrailSummaries();
    return summaries[0].id;
  }

  it('carries a trail from upload through both viewers, export, reload and delete', async () => {
    const gpx = fixture('data/trails/cape_to_cape/Cape_to_Cape_Track.gpx');
    const id = await importAndSave('Cape_to_Cape_Track.gpx', gpx, 'My Cape Walk');

    expect(id).toMatch(/^u_[a-z0-9]+$/);
    const stored = await getTrail(id);
    expect(stored?.trail.config.name).toBe('My Cape Walk');
    // The edited name is the identity everywhere, not just on the row.
    expect(stored?.trail.config.shortName).toBe('My Cape Walk');
    expect(stored?.name).toBe('My Cape Walk');

    // --- trail page ------------------------------------------------------
    vi.resetModules();
    loadPage('my-trail.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-trail');
    await flush();

    expect($('trail-panel').hidden).toBe(false);
    expect($('missing-panel').hidden).toBe(true);
    expect($('trail-title').textContent).toBe('My Cape Walk');
    expect(Number($('distance').textContent)).toBeGreaterThan(100);
    // Rendered with thousands separators.
    expect(Number(($('points').textContent ?? '').replace(/,/g, ''))).toBeGreaterThan(1000);
    expect($('waypoints-container').textContent).toContain('Cape Naturaliste Lighthouse');
    expect(($('plan-link') as HTMLAnchorElement).getAttribute('href')).toBe(
      `./my-plan.html?id=${id}`,
    );

    // Type badges read as labels ("Water tank", not "water-tank"), with the raw
    // slug kept in `title` so the underlying value stays discoverable.
    const badges = [...$('waypoints-container').querySelectorAll('.waypoint-type')];
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.getAttribute('title')).toBeTruthy();
      expect(badge.textContent, 'badge shows a label, not a slug').not.toMatch(/-/);
    }
    // The filter bar reports what is on screen out of the whole set.
    expect($('waypoint-filter-count').textContent).toMatch(/^\d+ waypoints$/);

    // --- reverse direction (must not re-fetch: there is nothing to fetch) --
    const firstWaypointBefore = $('waypoints-container').querySelector('tbody tr')?.textContent;
    ($('reverse-direction-btn') as HTMLButtonElement).click();
    await flush();
    const firstWaypointAfter = $('waypoints-container').querySelector('tbody tr')?.textContent;
    expect(firstWaypointAfter).not.toBe(firstWaypointBefore);
    expect(JSON.parse(window.localStorage.getItem('trailDirectionPrefs') ?? '{}')[id]).toBe(true);

    // Flip back so the exports below describe the stored direction.
    ($('reverse-direction-btn') as HTMLButtonElement).click();
    await flush();

    // --- exports ---------------------------------------------------------
    const downloads = captureDownloads();
    ($('export-gpx-btn') as HTMLButtonElement).click();
    ($('export-csv-btn') as HTMLButtonElement).click();
    ($('export-tracknotes-btn') as HTMLButtonElement).click();
    // The opaque u_ hash would make a useless file name; the user's name wins.
    expect(downloads.names).toEqual([
      'my-cape-walk.gpx',
      'my-cape-walk-datasheet.csv',
      'my-cape-walk.tracknotes.json',
    ]);
    downloads.restore();

    // --- plan page, and its state key ------------------------------------
    vi.resetModules();
    loadPage('my-plan.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-plan');
    await flush();

    expect($('plan-missing').hidden).toBe(true);
    expect($('plan-shell').hidden).toBe(false);
    expect($('datasheet-body').textContent).toContain('Cape Naturaliste Lighthouse');

    (document.querySelector('.tab-btn[data-tab="stops"]') as HTMLButtonElement).click();
    await flush(20);
    const row = [...document.querySelectorAll('.stop-row')].find(node =>
      node.textContent?.includes('Yallingup'),
    ) as HTMLElement;
    row.click();
    // The save is debounced; the assertion is that it lands under `id`.
    await new Promise(resolve => setTimeout(resolve, 1100));
    const saved = window.localStorage.getItem(`trail-plan-${id}`);
    expect(saved, 'plan state saved under the import id, not some other key').toBeTruthy();
    expect(JSON.parse(saved!).stops).toHaveLength(1);

    // --- reload: the plan comes back -------------------------------------
    vi.resetModules();
    loadPage('my-plan.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-plan');
    await flush();
    expect($('days-list').textContent).toContain('Yallingup');

    // --- delete ----------------------------------------------------------
    vi.resetModules();
    loadPage('my-trail.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-trail');
    await flush();
    window.confirm = () => true;
    ($('delete-trail-btn') as HTMLButtonElement).click();
    await flush();

    expect(await getTrail(id)).toBeNull();
    expect(await listTrailSummaries()).toHaveLength(0);
    // The id is a content hash: re-importing the same file lands on it again,
    // so anything left in localStorage would come back attached to what the
    // user thinks is a fresh trail.
    expect(window.localStorage.getItem(`trail-plan-${id}`)).toBeNull();
    expect(JSON.parse(window.localStorage.getItem('trailDirectionPrefs') ?? '{}')[id]).toBeUndefined();
  });

  it('shows the friendly empty state for an id that is not in storage', async () => {
    loadPage('my-trail.html', '?id=u_doesnotexist');
    await import('./my-trail');
    await flush();
    expect($('missing-panel').hidden).toBe(false);
    expect($('trail-panel').hidden).toBe(true);

    vi.resetModules();
    loadPage('my-plan.html', '?id=u_doesnotexist');
    await import('./my-plan');
    await flush();
    expect($('plan-missing').hidden).toBe(false);
    expect($('plan-shell').hidden).toBe(true);
  });

  it('labels the plan distance-only when the trail has no elevation', async () => {
    const id = await importAndSave('flat.gpx', fixture('tests/fixtures/gpx/no-elevation.gpx'));

    vi.resetModules();
    loadPage('my-plan.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-plan');
    await flush();

    expect($('days-list').textContent).toMatch(/Distance-only estimate/);
  });
});

// ---------------------------------------------------------------------------
// XSS
// ---------------------------------------------------------------------------

/**
 * Every string on these pages is user-controlled now.
 *
 * Before imports existed, waypoint names and descriptions came from curated
 * data in this repo, so an unescaped interpolation in the viewers was latent
 * rather than exploitable. A GPX file the user uploads is neither, and the
 * viewers are shared with the bundled trail pages — so the escaping has to hold
 * on the *viewer* side, not just in the boot scripts.
 */
describe('hostile input never becomes markup', () => {
  const PAYLOAD = '<img src=x onerror=xss()>';
  const ATTR_PAYLOAD = '" onmouseover="xss()';

  const HOSTILE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name><![CDATA[${PAYLOAD}]]></name></metadata>
  <wpt lat="-33.8688" lon="151.2093">
    <name><![CDATA[${PAYLOAD}]]></name>
    <type><![CDATA[${ATTR_PAYLOAD}]]></type>
    <desc><![CDATA[See ${PAYLOAD} and http://evil.test/"onmouseover="xss()]]></desc>
  </wpt>
  <trk><name>t</name><trkseg>
    <trkpt lat="-33.8688" lon="151.2093"><ele>10</ele></trkpt>
    <trkpt lat="-33.8700" lon="151.2100"><ele>25</ele></trkpt>
    <trkpt lat="-33.8750" lon="151.2150"><ele>40</ele></trkpt>
  </trkseg></trk>
</gpx>`;

  /** Nothing anywhere in the document may carry an inline event handler. */
  function expectNoInjection(): void {
    expect(document.querySelector('img')).toBeNull();
    for (const node of document.querySelectorAll('*')) {
      for (const attr of node.attributes) {
        expect(attr.name.startsWith('on'), `${attr.name} on <${node.tagName}>`).toBe(false);
      }
    }
  }

  it('renders a hostile GPX safely on upload, my-trail and my-plan', async () => {
    loadPage('upload.html');
    await import('./upload');
    chooseFile('evil.gpx', HOSTILE_GPX);
    await flush();

    expect($('report').hidden).toBe(false);
    ($('trail-name') as HTMLInputElement).value = PAYLOAD;
    ($('save-btn') as HTMLButtonElement).click();
    await flush();
    expectNoInjection();
    // The name survives as *text* — escaping must not mangle what is stored.
    expect($('saved-name').textContent).toBe(PAYLOAD);

    const id = (await listTrailSummaries())[0].id;
    expect((await getTrail(id))?.trail.config.name).toBe(PAYLOAD);

    vi.resetModules();
    loadPage('my-trail.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-trail');
    await flush();

    expect($('trail-title').textContent).toBe(PAYLOAD);
    // The waypoint table is the path that renders name, type and description.
    expect($('waypoints-container').textContent).toContain(PAYLOAD);
    expectNoInjection();

    // Expanding a row is what renders the description (and its auto-linker).
    const first = $('waypoints-container').querySelector('tbody tr') as HTMLElement;
    first?.click();
    await flush(20);
    expectNoInjection();
    // The auto-linker puts its match inside `href="…"`. A quote in the URL must
    // survive as part of the attribute *value* rather than closing it — which
    // is what `expectNoInjection` above proves, since a breakout would have
    // produced a real `onmouseover` attribute. Here we just confirm the whole
    // hostile string stayed in one attribute.
    const autoLinked = [...document.querySelectorAll('a[href^="http://evil.test"]')];
    expect(autoLinked).toHaveLength(1);
    expect(autoLinked[0].getAttribute('href')).toContain('"onmouseover=');

    vi.resetModules();
    loadPage('my-plan.html', `?id=${encodeURIComponent(id)}`);
    await import('./my-plan');
    await flush();
    (document.querySelector('.tab-btn[data-tab="stops"]') as HTMLButtonElement).click();
    await flush(20);
    expectNoInjection();
  });
});

/**
 * Capture the `download` attribute of every anchor the exports click, without
 * letting jsdom try to navigate.
 */
function captureDownloads(): { names: string[]; restore: () => void } {
  const names: string[] = [];
  const originalCreate = document.createElement.bind(document);
  const originalCreateUrl = URL.createObjectURL;
  const originalRevokeUrl = URL.revokeObjectURL;

  URL.createObjectURL = () => 'blob:mock';
  URL.revokeObjectURL = () => {};
  document.createElement = ((tag: string) => {
    const node = originalCreate(tag);
    if (tag === 'a') {
      (node as HTMLAnchorElement).click = () => {
        names.push((node as HTMLAnchorElement).download);
      };
    }
    return node;
  }) as typeof document.createElement;

  return {
    names,
    restore: () => {
      document.createElement = originalCreate;
      URL.createObjectURL = originalCreateUrl;
      URL.revokeObjectURL = originalRevokeUrl;
    },
  };
}
