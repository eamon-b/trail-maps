/**
 * The planner's sync arm, driven through the real page in jsdom.
 *
 * The question these ask is not "does the client send the right JSON" —
 * `src/web/api/plans.test.ts` does that — but "does a plan being edited in a
 * browser end up on the server exactly once per settled edit, and does the
 * page tell the truth about what happened". So they boot the shipped plan
 * markup with `VITE_API_BASE_URL` stubbed and a scripted `fetch`, and then
 * press the buttons.
 *
 *   hand-checked track — 8 points, one every 10 km, flat
 *   waypoints: Trailhead 0, Camp One 10, Salida 30, High Hut 45, Trail End 70
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BUNDLED_PLAN_FILLS, inlinePlanShell } from '../../../scripts/lib/plan-shell';
import type { PlanDocument } from '@lib/plan-types';

const ROOT = path.resolve(__dirname, '../../..');
const TRAIL_ID = 'sync-fixture';
const API = 'https://api.example.test';

const $ = (id: string): HTMLElement => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node;
};

// ---------------------------------------------------------------------------
// The least Leaflet the viewer needs
// ---------------------------------------------------------------------------

function installLeafletStub(): void {
  const layer = (): object => new Proxy({}, { get: () => () => layerSingleton });
  const layerSingleton: object = new Proxy({}, { get: () => () => layerSingleton });
  const L = {
    map: () => layerSingleton,
    tileLayer: layer,
    control: { scale: layer },
    layerGroup: layer,
    polyline: layer,
    divIcon: (opts: unknown) => opts,
    marker: () => layerSingleton,
  };
  (globalThis as unknown as { L: unknown }).L = L;
}

// ---------------------------------------------------------------------------
// The scripted server
// ---------------------------------------------------------------------------

interface Recorded {
  method: string;
  path: string;
  body: unknown;
  authorization: string | undefined;
}

interface Reply {
  status: number;
  body?: unknown;
}

let requests: Recorded[] = [];
/** Answers one request; `null` means "throw, as a dead network does". */
let handler: (req: Recorded) => Reply | null;

function installFetchStub(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const full = String(url);
    expect(full.startsWith(API)).toBe(true);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const req: Recorded = {
      method: init?.method ?? 'GET',
      path: full.slice(API.length),
      body: init?.body === undefined || init?.body === null ? undefined : JSON.parse(String(init.body)),
      authorization: headers.Authorization,
    };
    requests.push(req);
    const reply = handler(req);
    if (!reply) throw new TypeError('Failed to fetch');
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: '',
      text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const putsOf = (): Recorded[] => requests.filter(r => r.method === 'PUT');

/** The plan entry the server would return for a document. */
const entryFor = (document: PlanDocument, updatedAt: string) => ({
  id: document.id,
  trailId: document.trailId,
  document: { ...document, updatedAt },
  shareId: null,
  updatedAt,
});

/** The default server: no plan stored, every PUT accepted. */
function plainServer(stamp = '2026-07-01T10:00:00.000Z'): (req: Recorded) => Reply {
  return req => {
    if (req.method === 'GET' && req.path.startsWith('/v1/plans?')) {
      return { status: 200, body: { plans: [], nextCursor: null, syncedAt: stamp } };
    }
    if (req.method === 'PUT') {
      return { status: 200, body: entryFor(req.body as PlanDocument, stamp) };
    }
    throw new Error(`unscripted ${req.method} ${req.path}`);
  };
}

// ---------------------------------------------------------------------------
// Fixture and boot
// ---------------------------------------------------------------------------

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
    config: { id: TRAIL_ID, name: 'Sync Fixture', shortName: 'Fixture' },
    track: { points, totalDistance: 70, totalAscent: 0, totalDescent: 0 },
    waypoints: [
      wp('w_start', 'Trailhead', 'endpoint', 0),
      wp('w_camp1', 'Camp One', 'campsite', 10),
      wp('w_town', 'Salida', 'town', 30),
      wp('w_hut', 'High Hut', 'hut', 45),
      wp('w_end', 'Trail End', 'endpoint', 70),
    ],
  };
}

/** A plan for the fixture trail as the server might hold it. */
const serverDoc = (over: Partial<PlanDocument> = {}): PlanDocument => ({
  id: 'plan-server',
  trailId: TRAIL_ID,
  name: 'From the phone',
  direction: 'NOBO',
  startDate: '2026-09-09',
  stops: [{ waypointId: 'w_hut', km: 45, name: 'High Hut', nights: 1 }],
  updatedAt: '2099-01-01T00:00:00.000Z',
  version: 1,
  ...over,
});

const linkedSession = (): void => {
  localStorage.setItem(
    'tracknotes.webSession',
    JSON.stringify({ userId: 'u1', token: 'tok_secret', displayName: 'Robin', expiresAt: null }),
  );
};

async function boot(trailId = TRAIL_ID): Promise<void> {
  const html = inlinePlanShell(
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-template.html'), 'utf8'),
    fs.readFileSync(path.join(ROOT, 'src/web/trails/plan-shell.html'), 'utf8'),
    BUNDLED_PLAN_FILLS,
  );
  document.documentElement.innerHTML = html
    .replace(/<!DOCTYPE html>/i, '')
    .replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const { initPlanViewer } = await import('./plan-viewer');
  await initPlanViewer(trailId, makeTrail() as never);
  // The boot read happens after the first render; let it and its follow-up land.
  await vi.advanceTimersByTimeAsync(0);
}

/** Tick a place on the Stops tab. */
function clickStop(name: string): void {
  const item = [...$('stops-list').querySelectorAll<HTMLElement>('.stop-item')].find(
    el => (el.querySelector('.stop-name')?.textContent ?? '').trim() === name,
  );
  if (!item) throw new Error(`no stop row for ${name}`);
  item.querySelector<HTMLElement>('.stop-row')!.click();
}

const openStopsTab = (): void => {
  document.querySelector<HTMLButtonElement>('.tab-btn[data-tab="stops"]')!.click();
};

/** Let the 800 ms debounce fire and every request it starts settle. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(900);
  await vi.advanceTimersByTimeAsync(0);
};

const storedPlan = (): PlanDocument =>
  JSON.parse(localStorage.getItem(`trail-plan-doc-${TRAIL_ID}`) ?? '{}') as PlanDocument;

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
  localStorage.clear();
  requests = [];
  handler = plainServer();
  vi.useFakeTimers();
  vi.stubEnv('VITE_API_BASE_URL', API);
  installLeafletStub();
  installFetchStub();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  delete (globalThis as { L?: unknown }).L;
});

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

describe('a browser that is not linked', () => {
  it('shows the Sync button, opens the dialog and never talks to the server', async () => {
    await boot();
    const sync = $('sync-btn') as HTMLButtonElement;
    expect(sync.hidden).toBe(false);
    expect(sync.textContent).toBe('Sync');
    expect($('share-btn').hidden).toBe(true);
    expect(requests).toHaveLength(0);

    sync.click();
    expect(($('link-dialog') as HTMLDialogElement).hasAttribute('open')).toBe(true);
    expect($('link-unlinked').hidden).toBe(false);
    expect($('link-linked').hidden).toBe(true);
    // The label is offered, not demanded.
    expect(($('link-label') as HTMLInputElement).value).not.toBe('');
  });

  it('links on a good code and pushes the local plan straight away', async () => {
    handler = req => {
      if (req.method === 'POST' && req.path === '/v1/devices/link') {
        return {
          status: 201,
          body: { userId: 'u1', token: 'tok_linked', displayName: 'Robin', expiresAt: null },
        };
      }
      return plainServer()(req);
    };

    await boot();
    openStopsTab();
    clickStop('Salida');
    await settle();
    expect(requests).toHaveLength(0);

    $('sync-btn').click();
    ($('link-code') as HTMLInputElement).value = ' ab2d-3f4g ';
    $('link-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(requests[0]).toMatchObject({ method: 'POST', path: '/v1/devices/link' });
    expect((requests[0].body as { code: string }).code).toBe('AB2D3F4G');
    expect(requests[1]).toMatchObject({ method: 'GET' });
    expect(putsOf()).toHaveLength(1);
    expect((putsOf()[0].body as PlanDocument).stops).toHaveLength(1);
    expect(putsOf()[0].authorization).toBe('Bearer tok_linked');
    expect($('sync-btn').textContent).toBe('Robin');
    expect($('sync-status').textContent).toMatch(/^Synced \d\d:\d\d$/);
  });

  it('says why a code was refused and stays unlinked', async () => {
    handler = req => {
      if (req.path === '/v1/devices/link') {
        return { status: 404, body: { error: { code: 'code_invalid', message: 'nope' } } };
      }
      return plainServer()(req);
    };

    await boot();
    $('sync-btn').click();
    ($('link-code') as HTMLInputElement).value = 'AB2D3F4G';
    $('link-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect($('link-error').hidden).toBe(false);
    expect($('link-error').textContent).toMatch(/not valid or has expired/);
    expect(localStorage.getItem('tracknotes.webSession')).toBeNull();
    expect($('sync-btn').textContent).toBe('Sync');
  });

  it('will not send a code that is not a code', async () => {
    await boot();
    $('sync-btn').click();
    ($('link-code') as HTMLInputElement).value = 'AB2';
    $('link-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(requests).toHaveLength(0);
    expect($('link-error').textContent).toMatch(/8-character code/);
  });
});

// ---------------------------------------------------------------------------
// Pushing edits
// ---------------------------------------------------------------------------

describe('a linked browser', () => {
  it('sends one PUT for a burst of toggles, not one each', async () => {
    linkedSession();
    await boot();
    // The boot push of the empty plan; the burst is what is being counted.
    expect(putsOf()).toHaveLength(1);
    requests = [];

    openStopsTab();
    clickStop('Camp One');
    clickStop('Salida');
    clickStop('High Hut');
    clickStop('Salida');
    await settle();

    expect(putsOf()).toHaveLength(1);
    const sent = putsOf()[0].body as PlanDocument;
    expect(sent.stops.map(s => s.name)).toEqual(['Camp One', 'High Hut']);
    // The server's clock, not ours, on the document afterwards.
    expect(storedPlan().updatedAt).toBe('2026-07-01T10:00:00.000Z');
    expect($('sync-status').textContent).toMatch(/^Synced /);
  });

  it('sends nothing more when nothing changed', async () => {
    linkedSession();
    await boot();
    requests = [];
    await settle();
    expect(putsOf()).toHaveLength(0);
  });

  it('takes a server copy that is newer than the local one, header and all', async () => {
    linkedSession();
    handler = req => {
      if (req.method === 'GET') {
        return {
          status: 200,
          body: {
            plans: [entryFor(serverDoc(), '2099-01-01T00:00:00.000Z')],
            nextCursor: null,
            syncedAt: '2099-01-01T00:00:00.000Z',
          },
        };
      }
      throw new Error('the newer copy must not be pushed back');
    };

    await boot();

    expect(($('plan-name-input') as HTMLInputElement).value).toBe('From the phone');
    expect(($('plan-start-date') as HTMLInputElement).value).toBe('2026-09-09');
    expect($('days-list').textContent).toContain('High Hut');
    expect(storedPlan().id).toBe('plan-server');
    expect(putsOf()).toHaveLength(0);
  });

  it('keeps the local plan when it is the newer one', async () => {
    linkedSession();
    handler = req => {
      if (req.method === 'GET') {
        return {
          status: 200,
          body: {
            plans: [entryFor(serverDoc({ updatedAt: '2000-01-01T00:00:00.000Z' }), '2000-01-01T00:00:00.000Z')],
            nextCursor: null,
            syncedAt: 'now',
          },
        };
      }
      return { status: 200, body: entryFor(req.body as PlanDocument, '2026-07-01T10:00:00.000Z') };
    };

    await boot();

    expect(($('plan-name-input') as HTMLInputElement).value).toBe('My Fixture plan');
    expect(putsOf()).toHaveLength(1);
  });

  it('adopts the id the server already holds for this trail, and re-PUTs once', async () => {
    linkedSession();
    let firstPut = true;
    handler = req => {
      if (req.method === 'GET') {
        return { status: 200, body: { plans: [], nextCursor: null, syncedAt: 'now' } };
      }
      if (req.method === 'PUT' && firstPut) {
        firstPut = false;
        return {
          status: 409,
          body: {
            error: { code: 'plan_exists', message: 'This trail already has a plan' },
            existingId: 'plan-server',
          },
        };
      }
      return { status: 200, body: entryFor(req.body as PlanDocument, '2026-07-01T10:00:00.000Z') };
    };

    await boot();

    const puts = putsOf();
    expect(puts).toHaveLength(2);
    expect(puts[1].path).toBe('/v1/plans/plan-server');
    expect((puts[1].body as PlanDocument).id).toBe('plan-server');
    expect(storedPlan().id).toBe('plan-server');
    expect($('sync-status').textContent).toMatch(/^Synced /);
  });

  it('waits for the network to come back rather than losing the edit', async () => {
    linkedSession();
    handler = req =>
      req.method === 'GET'
        ? { status: 200, body: { plans: [], nextCursor: null, syncedAt: 'now' } }
        : null;

    await boot();
    expect($('sync-status').textContent).toBe('Offline, will retry');
    expect($('sync-status').className).toBe('sync-warn');

    openStopsTab();
    clickStop('Salida');
    await settle();
    // The local save is unaffected: the plan is on this device either way.
    expect(storedPlan().stops.map(stop => stop.name)).toEqual(['Salida']);
    expect($('sync-status').textContent).toBe('Offline, will retry');

    handler = plainServer();
    requests = [];
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(putsOf()).toHaveLength(1);
    expect((putsOf()[0].body as PlanDocument).stops).toHaveLength(1);
    expect($('sync-status').textContent).toMatch(/^Synced /);
  });

  it('forgets a token the server no longer accepts', async () => {
    linkedSession();
    handler = req =>
      req.method === 'GET'
        ? { status: 200, body: { plans: [], nextCursor: null, syncedAt: 'now' } }
        : { status: 401, body: { error: { code: 'unauthorized', message: 'no' } } };

    await boot();

    expect(localStorage.getItem('tracknotes.webSession')).toBeNull();
    expect($('sync-status').textContent).toBe('Browser unlinked \u2014 link again');
    expect($('sync-btn').textContent).toBe('Sync');
    expect($('share-btn').hidden).toBe(true);
  });

  it('reports any other refusal by its code, and does not hammer the server', async () => {
    linkedSession();
    handler = req =>
      req.method === 'GET'
        ? { status: 200, body: { plans: [], nextCursor: null, syncedAt: 'now' } }
        : { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } };

    await boot();

    expect($('sync-status').textContent).toBe('Sync failed: rate_limited');
    expect(putsOf()).toHaveLength(1);
  });

  it('shares the plan and shows the link the server minted', async () => {
    linkedSession();
    handler = req => {
      if (req.path.endsWith('/share') && req.method === 'POST') {
        return {
          status: 200,
          body: { shareId: 'abc123', url: 'https://site.test/shared-plan.html?s=abc123' },
        };
      }
      if (req.path.endsWith('/share') && req.method === 'DELETE') return { status: 204 };
      return plainServer()(req);
    };

    await boot();
    expect($('share-btn').hidden).toBe(false);

    $('share-btn').click();
    await vi.advanceTimersByTimeAsync(0);

    expect($('share-panel').hidden).toBe(false);
    expect(($('share-url') as HTMLInputElement).value).toBe(
      'https://site.test/shared-plan.html?s=abc123',
    );

    $('share-unshare').click();
    await vi.advanceTimersByTimeAsync(0);
    expect($('share-panel').hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Imported trails
// ---------------------------------------------------------------------------

describe('an imported trail', () => {
  it('says its plan stays here, and has no machinery behind the button', async () => {
    linkedSession();
    await boot('u_abc123');

    const sync = $('sync-btn') as HTMLButtonElement;
    expect(sync.textContent).toBe('Imported trails stay on this device');
    expect(sync.disabled).toBe(true);
    expect(document.getElementById('share-btn')).toBeNull();
    expect(document.getElementById('link-dialog')).toBeNull();
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// No API configured
// ---------------------------------------------------------------------------

describe('a build with no API base url', () => {
  it('has no sync controls at all', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    linkedSession();
    await boot();

    expect(document.getElementById('sync-btn')).toBeNull();
    expect(document.getElementById('share-btn')).toBeNull();
    expect(document.getElementById('link-dialog')).toBeNull();
    expect(requests).toHaveLength(0);
  });
});
