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

function stubFetch(detailStatus = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.startsWith('https://api.example.test')
        ? detailStatus === 200
          ? detail
          : { error: { code: 'not_found', message: 'Not found' } }
        : trail;
      const status = url.startsWith('https://api.example.test') ? detailStatus : 200;
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
