/**
 * The shared-plan page: someone else's plan, read-only, in this browser.
 *
 * Two things matter here. It must not offer to edit what it cannot save — the
 * Stops tab is the editor, and nothing about a plan being read belongs in this
 * browser's storage. And every string on the page came off the wire from an
 * account that is not this one, so the plan's name, its notes and the owner's
 * display name are treated as hostile: they reach the DOM as text, never as
 * markup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SHARED_PLAN_FILLS, inlinePlanShell } from '../../scripts/lib/plan-shell';
import type { PlanDocument } from '@lib/plan-types';

const ROOT = path.resolve(__dirname, '../..');
const API = 'https://api.example.test';
const TRAIL_ID = 'shared-fixture';
const SHARE_ID = 'abc123';

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

const HOSTILE_NAME = '<img src=x onerror="alert(1)">Mallory';
const HOSTILE_NOTE = '<script>alert(2)</script> rang ahead';

function installLeafletStub(): void {
  const singleton: object = new Proxy({}, { get: () => () => singleton });
  (globalThis as unknown as { L: unknown }).L = {
    map: () => singleton,
    tileLayer: () => singleton,
    control: { scale: () => singleton },
    layerGroup: () => singleton,
    polyline: () => singleton,
    divIcon: (opts: unknown) => opts,
    marker: () => singleton,
  };
}

function makeTrail() {
  const points = [0, 10, 20, 30, 40, 50, 60, 70].map(km => ({
    lat: -34 - km / 1000,
    lon: 138 + km / 1000,
    ele: 100,
    dist: km,
  }));
  const wp = (id: string, name: string, type: string, totalDistance: number) => ({
    id,
    name,
    type,
    totalDistance,
    lat: -34 - totalDistance / 1000,
    lon: 138 + totalDistance / 1000,
  });
  return {
    config: { id: TRAIL_ID, name: 'Shared Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 70, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_town', 'Salida', 'town', 30),
      wp('w_end', 'Trail End', 'endpoint', 70),
    ],
  };
}

const sharedDoc = (over: Partial<PlanDocument> = {}): PlanDocument => ({
  id: 'plan-1',
  trailId: TRAIL_ID,
  name: 'Mallory’s walk',
  direction: 'NOBO',
  startDate: '2026-04-01',
  stops: [{ waypointId: 'w_town', km: 30, name: 'Salida', nights: 2, note: HOSTILE_NOTE }],
  updatedAt: '2026-03-01T00:00:00.000Z',
  version: 1,
  ...over,
});

/** What the server and the site answer with, per test. */
let sharedReply: { status: number; body?: unknown } = { status: 200 };
let trailFound = true;
let requests: string[] = [];

function installFetchStub(): void {
  globalThis.fetch = (async (url: string | URL | Request) => {
    const full = String(url);
    requests.push(full);
    if (full.startsWith(`${API}/v1/shared/plans/`)) {
      return {
        ok: sharedReply.status >= 200 && sharedReply.status < 300,
        status: sharedReply.status,
        statusText: '',
        text: async () =>
          sharedReply.body === undefined ? '' : JSON.stringify(sharedReply.body),
      } as unknown as Response;
    }
    if (full.includes('/data/generated/')) {
      return {
        ok: trailFound,
        status: trailFound ? 200 : 404,
        json: async () => makeTrail(),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch ${full}`);
  }) as unknown as typeof fetch;
}

/** Boot the page as Vite assembles it, with `?s=` in the address bar. */
async function boot(search = `?s=${SHARE_ID}`): Promise<void> {
  const html = inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/shared-plan.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    SHARED_PLAN_FILLS,
  );
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');
  window.history.replaceState({}, '', `/shared-plan.html${search}`);

  vi.resetModules();
  await import('./shared-plan');
  // The page fetches the plan, then the trail, then boots the viewer — all
  // microtasks here, since both responses are resolved doubles.
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  localStorage.clear();
  requests = [];
  trailFound = true;
  sharedReply = {
    status: 200,
    body: { document: sharedDoc(), trailId: TRAIL_ID, ownerDisplayName: HOSTILE_NAME },
  };
  vi.stubEnv('VITE_API_BASE_URL', API);
  installLeafletStub();
  installFetchStub();
});

afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as { L?: unknown }).L;
});

describe('the shared plan page', () => {
  it('draws the plan it was given, read-only', async () => {
    await boot();

    // The days come from the shared document, not from anything stored here.
    expect($('days-list').textContent).toContain('Salida');
    expect($('days-list').textContent).toContain('+1 rest day at Salida');

    // The editor is gone, not merely inert.
    expect(document.querySelector('.tab-btn[data-tab="stops"]')?.hasAttribute('hidden')).toBe(true);
    expect($('tab-stops').hasAttribute('hidden')).toBe(true);

    // The header is text, not fields.
    expect(document.getElementById('plan-name-input')).toBeNull();
    expect(document.querySelector('.plan-name-static')?.textContent).toBe('Mallory’s walk');
    expect($('plan-date-group').textContent).toContain('Start:');
    expect(document.getElementById('plan-start-date')).toBeNull();
  });

  it('says whose plan it is, and offers the app link', async () => {
    await boot();

    expect($('shared-by').textContent).toBe(`Shared by ${HOSTILE_NAME}`);
    expect(($('open-in-app') as HTMLAnchorElement).hidden).toBe(false);
    expect(($('open-in-app') as HTMLAnchorElement).getAttribute('href')).toBe(
      `tracknotes://plan/${SHARE_ID}`,
    );
    // Not linked, so there is nowhere to copy it to.
    expect($('copy-to-plans').hidden).toBe(true);
  });

  it('treats the owner’s name and notes as text, never as markup', async () => {
    await boot();

    // The name went in as text: the tag is shown, not run.
    expect(document.querySelector('img')).toBeNull();
    expect($('shared-by').textContent).toContain('<img src=x');

    expect($('days-list').querySelector('script')).toBeNull();
    expect($('days-list').innerHTML).toContain('&lt;script&gt;');
    expect($('days-list').textContent).toContain('rang ahead');
  });

  it('writes nothing to this browser', async () => {
    await boot();

    expect(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`)).toBeNull();
    expect(localStorage.length).toBe(0);
    // Not even the view preference the editable planner keeps per trail.
    expect(localStorage.getItem(`trail-plan-ui-${TRAIL_ID}`)).toBeNull();
  });

  it('has no sync arm of its own', async () => {
    await boot();

    // `initPlanSync` never runs in read-only mode, so the controls it would
    // have claimed are still sitting there hidden and unwired.
    expect(($('sync-btn') as HTMLButtonElement).hidden).toBe(true);
    expect(($('share-btn') as HTMLButtonElement).hidden).toBe(true);
    expect(requests.filter(url => url.includes('/v1/plans'))).toHaveLength(0);
  });

  it('offers to copy the plan once this browser is linked', async () => {
    localStorage.setItem(
      'tracknotes.webSession',
      JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Robin', expiresAt: null }),
    );
    await boot();

    expect($('copy-to-plans').hidden).toBe(false);
  });

  it('says so when the link is no longer shared', async () => {
    sharedReply = { status: 404, body: { error: { code: 'not_found', message: 'nope' } } };
    await boot();

    expect($('plan-missing').hidden).toBe(false);
    expect($('plan-missing-detail').textContent).toMatch(/no longer shared/);
    expect($('plan-shell').hidden).toBe(true);
  });

  it('says so when this site does not carry the trail', async () => {
    trailFound = false;
    await boot();

    expect($('plan-missing').hidden).toBe(false);
    expect($('plan-missing-detail').textContent).toBe(
      'This plan is for a trail this site does not have.',
    );
  });

  it('asks for a link when there is none', async () => {
    await boot('');

    expect($('plan-missing').hidden).toBe(false);
    expect($('plan-missing-title').textContent).toBe('No plan link');
    expect(requests).toHaveLength(0);
  });
});
