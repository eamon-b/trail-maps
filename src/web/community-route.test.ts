/**
 * community-route.html boots from `?id=`, draws the trail through the shared
 * viewer, escapes the route's text, and falls back to "not found".
 */

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { importGpx } from '@lib/gpx-import';
import { closeImportedTrailsDb, getTrail } from './imported-trails-db';
import { localCopyId } from './community-ui';

const ROOT = path.resolve(__dirname, '../..');
const ID = 'c_abcdefghijklmnop';

function loadPage(search: string): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/community-route.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  window.history.replaceState({}, '', `/community-route.html${search}`);
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise(r => setTimeout(r, 20));
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;

const trail = importGpx(
  fs.readFileSync(path.join(ROOT, 'data/trails/cape_to_cape/Cape_to_Cape_Track.gpx'), 'utf8'),
).trail;

const detail = {
  id: ID,
  name: 'Cape <b>to</b> Cape',
  status: 'unverified',
  country: 'AU',
  state: 'WA',
  lengthKm: 120,
  ascentM: 2000,
  hasElevation: true,
  waypointCount: 10,
  bbox: [0, 0, 0, 0],
  start: { lat: 0, lon: 0 },
  submittedBy: 'Robin',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  verifiedAt: null,
  reviewed: false,
  trailUrl: 'https://data.example.test/community/v1/x.json',
  md5: 'abc',
  bytes: 1,
  description: 'Line one\n<script>alert(1)</script>',
  credit: null,
  licence: 'CC0-1.0',
  checks: [],
};

beforeEach(async () => {
  vi.resetModules();
  await closeImportedTrailsDb();
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  Element.prototype.scrollIntoView = () => {};
  window.localStorage.clear();
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubFetch(detailStatus = 200, detailBody: object = detail, trailStatus = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.startsWith('https://api.example.test')
        ? detailStatus === 200
          ? detailBody
          : { error: { code: 'not_found', message: 'Not found' } }
        : trailStatus === 200
          ? trail
          : { error: 'gone' };
      const status = url.startsWith('https://api.example.test') ? detailStatus : trailStatus;
      return { ok: status < 300, status, statusText: '', text: async () => JSON.stringify(body) };
    }),
  );
}

describe('community-route.html', () => {
  it('renders the route, escaped, and saves a copy to My trails', async () => {
    stubFetch();
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('trail-panel').hidden).toBe(false);
    expect($('trail-title').textContent).toBe('Cape <b>to</b> Cape');
    expect($('route-description').innerHTML).toContain('&lt;script&gt;');
    expect($('route-description').innerHTML).toContain('<br>');
    expect($('status-badge').textContent).toBe('Unverified');
    expect($('route-region').textContent).toBe('Western Australia, Australia');
    expect($('edit-btn').hidden).toBe(true);

    $('save-btn').click();
    await waitFor(() => !$('save-note').hidden && ($('save-note').textContent ?? '').includes('Saved'));
    const saved = await getTrail(localCopyId(ID));
    expect(saved?.trail.config.id).toBe(localCopyId(ID));
    expect(saved?.name).toBe('Cape <b>to</b> Cape');
  });

  it('shows a hidden route to its owner as details only, with no track to fetch', async () => {
    stubFetch(200, { ...detail, status: 'hidden', trailUrl: null, isOwner: true, review: { status: 'skipped' } });
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('trail-title').textContent).toBe('Cape <b>to</b> Cape');
    expect($('trail-body').hidden).toBe(true);
    expect($('no-track-note').hidden).toBe(false);
    expect($('no-track-note').textContent).toMatch(/hidden/);
    expect($('save-btn').hidden).toBe(true);
    expect($('edit-btn').hidden).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the details up when the track download 404s', async () => {
    stubFetch(200, detail, 404);
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('trail-body').hidden).toBe(true);
    expect($('no-track-note').textContent).toMatch(/could not be downloaded/);
    expect($('route-description').innerHTML).toContain('&lt;script&gt;');
  });

  it('shows not found for an unknown route', async () => {
    stubFetch(404);
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('missing-panel').hidden);
    expect($('missing-panel').hidden).toBe(false);
  });

  it('shows not found for a malformed id without fetching', async () => {
    stubFetch();
    loadPage('?id=heysen');
    await import('./community-route');
    await waitFor(() => !$('missing-panel').hidden);
    expect($('missing-panel').hidden).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('community-route.html: owner, report and the no-track view', () => {
  const SESSION = { userId: 'u1', token: 'tok', displayName: 'Robin', expiresAt: null };

  /** Route requests by method: GET detail, PATCH (echoing the new text), report, trail. */
  function stubApi(detailBody: object, trailStatus = 200): Array<{ url: string; init: RequestInit }> {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, init });
        let status = 200;
        let body: unknown;
        if (!url.startsWith('https://api.example.test')) {
          status = trailStatus;
          body = trailStatus === 200 ? trail : { error: 'gone' };
        } else if (init.method === 'PATCH') {
          body = { ...detailBody, ...JSON.parse(String(init.body)) };
        } else if (init.method === 'POST') {
          body = { ok: true };
        } else {
          body = detailBody;
        }
        return { ok: status < 300, status, statusText: '', text: async () => JSON.stringify(body) };
      }),
    );
    return calls;
  }

  it('hides Report from the owner, and an edit renames Save, the export and the title', async () => {
    window.localStorage.setItem('tracknotes.webSession', JSON.stringify(SESSION));
    stubApi({ ...detail, isOwner: true, review: { status: 'skipped' } });
    const blobs: Blob[] = [];
    URL.createObjectURL = (blob: Blob) => {
      blobs.push(blob);
      return 'blob:x';
    };
    URL.revokeObjectURL = () => {};
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('report-btn').hidden).toBe(true);
    expect($('edit-btn').hidden).toBe(false);

    $('edit-btn').click();
    (document.getElementById('edit-name') as HTMLInputElement).value = 'Cape Walk Renamed';
    $('edit-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => $('trail-title').textContent === 'Cape Walk Renamed');
    expect($('trail-title').textContent).toBe('Cape Walk Renamed');
    expect(document.title).toContain('Cape Walk Renamed');
    expect($('edit-form').hidden).toBe(true);

    $('save-btn').click();
    await waitFor(() => ($('save-note').textContent ?? '').includes('Saved'));
    const saved = await getTrail(localCopyId(ID));
    expect(saved?.name).toBe('Cape Walk Renamed');
    expect(saved?.trail.config.name).toBe('Cape Walk Renamed');

    $('export-tracknotes-btn').click();
    expect(blobs).toHaveLength(1);
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blobs[0]);
    });
    const handoff = JSON.parse(text);
    expect(JSON.stringify(handoff)).toContain('Cape Walk Renamed');
    expect(JSON.stringify(handoff)).not.toContain('Cape <b>to</b> Cape');
  });

  it('sends a report with the stored session and says thanks', async () => {
    window.localStorage.setItem('tracknotes.webSession', JSON.stringify(SESSION));
    const calls = stubApi(detail);
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('report-btn').hidden).toBe(false);
    $('report-btn').click();
    expect($('report-form').hidden).toBe(false);
    $('report-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await waitFor(() => !$('report-done').hidden);
    const report = calls.find(c => c.url.endsWith('/report'))!;
    expect((report.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect($('report-done').hidden).toBe(false);
  });

  it('keeps Report but drops the direction toggle when only the download failed', async () => {
    stubApi(detail, 404);
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('trail-body').hidden).toBe(true);
    expect($('direction-meta').hidden).toBe(true);
    expect($('save-btn').hidden).toBe(true);
    expect($('report-btn').hidden).toBe(false);
    $('report-btn').click();
    // Unlinked: the link form, not the report form.
    expect($('report-form').hidden).toBe(true);
    expect($('report-link').textContent).toContain('Link this browser');
  });

  it('offers no Report or direction toggle on a hidden route', async () => {
    window.localStorage.setItem('tracknotes.webSession', JSON.stringify(SESSION));
    stubApi({ ...detail, status: 'hidden', trailUrl: null, isOwner: true, review: { status: 'skipped' } });
    loadPage(`?id=${ID}`);
    await import('./community-route');
    await waitFor(() => !$('trail-panel').hidden);

    expect($('report-btn').hidden).toBe(true);
    expect($('direction-meta').hidden).toBe(true);
  });
});
