/**
 * The upload page's "Share with the community" step, driven through jsdom on
 * the real upload.html: hidden without an API, the link form for an unlinked
 * browser, live checks gating the button, and a submit that sends the trail
 * (plus the GPX as base64) and links to the new route's page.
 */

import 'fake-indexeddb/auto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { closeImportedTrailsDb } from './imported-trails-db';

const ROOT = path.resolve(__dirname, '../..');
const GPX = fs.readFileSync(path.join(ROOT, 'data/trails/cape_to_cape/Cape_to_Cape_Track.gpx'), 'utf8');

function loadUploadPage(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/upload.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  window.history.replaceState({}, '', '/upload.html');
}

function chooseFile(name: string, text: string): void {
  const input = document.getElementById('file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [new File([text], name, { type: 'application/gpx+xml' })],
    configurable: true,
  });
  input.dispatchEvent(new Event('change'));
}

async function flush(): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 60; i++) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

async function importAndSave(): Promise<void> {
  await import('./upload');
  chooseFile('Cape_to_Cape_Track.gpx', GPX);
  await flush();
  $('save-btn').click();
  await flush();
}

/** The share module is imported lazily; wait for it to open the panel. */
async function waitForPanel(): Promise<void> {
  for (let i = 0; i < 100 && $('community-share').hidden; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

beforeEach(async () => {
  vi.resetModules();
  await closeImportedTrailsDb();
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  Element.prototype.scrollIntoView = () => {};
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
  loadUploadPage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('upload.html community share', () => {
  it('stays hidden in a build without an API', async () => {
    vi.stubEnv('VITE_API_BASE_URL', '');
    await importAndSave();
    expect($('saved').hidden).toBe(false);
    expect($('community-share').hidden).toBe(true);
  });

  it('asks an unlinked browser to link first', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    await importAndSave();
    await waitForPanel();
    expect($('community-share').hidden).toBe(false);
    expect($('community-form').hidden).toBe(true);
    expect($('community-link').textContent).toContain('Link this browser');
  });

  it('gates submit on the checks and the rights box, then submits', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    window.localStorage.setItem(
      'tracknotes.webSession',
      JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Robin', expiresAt: null }),
    );
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 201,
          statusText: '',
          text: async () => JSON.stringify({ id: 'c_abcdefghijklmnop' }),
        };
      }),
    );

    await importAndSave();
    await waitForPanel();
    expect($('community-form').hidden).toBe(false);
    expect($('community-identity').textContent).toContain('Robin');
    expect($<HTMLInputElement>('community-name').value).toBe('Cape to Cape Track');

    const submit = $<HTMLButtonElement>('community-submit');
    // Empty description: the metadata check fails.
    expect(submit.disabled).toBe(true);
    expect($('community-checks').textContent).toMatch(/Fail/);

    const desc = $<HTMLTextAreaElement>('community-description');
    desc.value = 'Coastal walk from Cape Naturaliste to Cape Leeuwin along the Leeuwin-Naturaliste ridge.';
    desc.dispatchEvent(new Event('input'));
    const country = $<HTMLSelectElement>('community-country');
    country.value = 'AU';
    country.dispatchEvent(new Event('change'));
    const state = $<HTMLSelectElement>('community-state');
    state.value = 'WA';
    state.dispatchEvent(new Event('change'));
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(submit.disabled).toBe(true); // rights not confirmed

    const rights = $<HTMLInputElement>('community-rights');
    rights.checked = true;
    rights.dispatchEvent(new Event('change'));
    expect($('community-checks').textContent ?? '', 'checks').not.toMatch(/^Fail/);
    expect(submit.disabled).toBe(false);

    $<HTMLFormElement>('community-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.example.test/v1/community/routes');
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ country: 'AU', state: 'WA', rightsConfirmed: true, credit: null });
    expect(typeof body.gpxBase64).toBe('string');
    expect(body.trail.track.points.length).toBeGreaterThan(20);
    expect($('community-done').hidden).toBe(false);
    expect($<HTMLAnchorElement>('community-done-link').getAttribute('href')).toBe(
      './community-route.html?id=c_abcdefghijklmnop',
    );
  });

  it('shows the server checks on a 422', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
    window.localStorage.setItem(
      'tracknotes.webSession',
      JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Robin', expiresAt: null }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 422,
        statusText: '',
        text: async () =>
          JSON.stringify({
            error: { code: 'checks_failed', message: 'Checks failed' },
            checks: [{ id: 'duplicate', level: 'fail', message: 'Server says duplicate-ish' }],
          }),
      })),
    );
    await importAndSave();
    await waitForPanel();
    const desc = $<HTMLTextAreaElement>('community-description');
    desc.value = 'Coastal walk from Cape Naturaliste to Cape Leeuwin along the ridge.';
    desc.dispatchEvent(new Event('input'));
    const country = $<HTMLSelectElement>('community-country');
    country.value = 'AU';
    country.dispatchEvent(new Event('change'));
    const rights = $<HTMLInputElement>('community-rights');
    rights.checked = true;
    rights.dispatchEvent(new Event('change'));

    $<HTMLFormElement>('community-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect($('community-checks').textContent).toContain('Server says duplicate-ish');
    expect($('community-error').hidden).toBe(false);
    expect($('community-done').hidden).toBe(true);
  });
});
