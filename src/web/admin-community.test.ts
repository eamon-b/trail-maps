/**
 * The admin queue renders text from users and from the AI review: route
 * names, credits, report notes, the review's summary, concerns and error, and
 * the last status note. None of it may reach the page as markup.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const XSS = '<img src=x onerror=alert(1)>';

function loadPage(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/admin-community.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
}

const route = {
  id: 'c_abcdefghijklmnop',
  name: `Name ${XSS}`,
  status: 'hidden',
  country: 'AU',
  state: 'VIC',
  lengthKm: 12,
  ascentM: 300,
  hasElevation: true,
  waypointCount: 3,
  bbox: [0, 0, 1, 1],
  start: { lat: 0, lon: 0 },
  submittedBy: `Sam ${XSS}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  verifiedAt: null,
  reviewed: true,
  trailUrl: null,
  md5: '0'.repeat(32),
  bytes: 1,
  description: `Description ${XSS}`,
  credit: `Credit ${XSS}`,
  licence: 'CC0-1.0',
  checks: [{ id: 'metadata', level: 'warn', message: `Check ${XSS}` }],
  statusNote: `Note ${XSS}`,
  reportCount: 1,
  reports: [{ reason: 'spam', note: `Report ${XSS}`, createdAt: '2026-10-02T00:00:00Z' }],
  review: {
    status: 'done',
    verdict: 'reject',
    confidence: 0.9,
    summary: `Summary ${XSS}`,
    concerns: [`Concern ${XSS}`],
    error: `Error ${XSS}`,
    suggestedCountry: 'AU',
    suggestedState: 'VIC',
  },
};

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem(
    'tracknotes.webSession',
    JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Admin', expiresAt: null }),
  );
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, statusText: '', text: async () => JSON.stringify({ routes: [route] }) })),
  );
  loadPage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('admin-community.html', () => {
  it('escapes every user and review string it renders', async () => {
    await import('./admin-community');
    const list = document.getElementById('admin-list')!;
    await waitFor(() => list.querySelector('.admin-row') !== null);

    expect(list.querySelector('.admin-row')).not.toBeNull();
    expect(list.querySelector('img')).toBeNull();
    const text = list.textContent ?? '';
    for (const label of ['Name', 'Sam', 'Description', 'Credit', 'Check', 'Note', 'Report', 'Summary', 'Concern', 'Error']) {
      expect(text, label).toContain(`${label} ${XSS}`);
    }
    expect(document.getElementById('admin-identity')!.textContent).toContain('Admin');
  });
});
