/**
 * The moderation page renders text from users: comment text, waypoint names
 * and descriptions, display names, report details. None of it may reach the
 * page as markup. And its buttons call the endpoints they say.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const XSS = '<img src=x onerror=alert(1)>';

function loadPage(): void {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/admin-moderation.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');
}

async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
}

const report = {
  id: 'r1',
  reporterUserId: 'u2',
  reporterDisplayName: `Reporter ${XSS}`,
  reason: 'offensive',
  detail: `Detail ${XSS}`,
  createdAt: '2026-10-02T00:00:00Z',
};

const comment = {
  id: '11111111-1111-4111-8111-111111111111',
  trailId: 'heysen',
  waypointId: 'w_abcd',
  userId: '22222222-2222-4222-8222-222222222222',
  displayName: `Author ${XSS}`,
  userBanned: false,
  userAdmin: false,
  userDeleted: false,
  text: `Text ${XSS}`,
  waterStatus: null,
  observedAt: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  deletedAt: '2026-10-03T00:00:00Z',
  deletedBy: 'reports',
  restoredAt: null,
  photoUrls: ['javascript:alert(1)', 'https://photos.example.test/a.jpg'],
  reportCount: 1,
  reports: [report],
  review: {
    status: 'done' as const,
    trigger: 'report' as const,
    verdict: 'remove' as const,
    confidence: 0.95,
    summary: `Summary ${XSS}`,
    categories: ['spam'],
    hid: true,
    reviewedAt: '2026-10-03T00:00:00Z',
  },
};

const waypoint = {
  id: 'hw_33333333-3333-4333-8333-333333333333',
  trailId: 'heysen',
  name: `Name ${XSS}`,
  type: 'water',
  lat: -34.5,
  lon: 138.5,
  description: `Description ${XSS}`,
  displayName: `Sharer ${XSS}`,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  userId: '44444444-4444-4444-8444-444444444444',
  userBanned: true,
  userAdmin: false,
  userDeleted: false,
  deletedAt: null,
  deletedBy: null,
  restoredAt: null,
  reportCount: 1,
  reports: [report],
  review: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
  window.localStorage.setItem(
    'tracknotes.webSession',
    JSON.stringify({ userId: 'u1', token: 'tok', displayName: 'Admin', expiresAt: null })
  );
  vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test');
  fetchMock = vi.fn(async (input: string) => {
    const body = input.includes('/v1/admin/comments?')
      ? { comments: [comment] }
      : input.includes('/v1/admin/waypoints?')
        ? { waypoints: [waypoint] }
        : { userId: comment.userId, banned: true, removedComments: 1, removedWaypoints: 0 };
    return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify(body) };
  });
  vi.stubGlobal('fetch', fetchMock);
  // jsdom has no CSS.escape; the ids here need no escaping.
  vi.stubGlobal('CSS', { escape: (s: string) => s });
  loadPage();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('admin-moderation.html', () => {
  it('escapes every user string it renders, and drops unsafe photo links', async () => {
    await import('./admin-moderation');
    await waitFor(() => document.querySelectorAll('.admin-row').length === 2);

    const page = document.querySelector('.community-page')!;
    expect(page.querySelector('img')).toBeNull();
    const text = page.textContent ?? '';
    for (const label of ['Author', 'Text', 'Reporter', 'Detail', 'Name', 'Description', 'Sharer', 'Summary']) {
      expect(text, label).toContain(`${label} ${XSS}`);
    }
    const links = [...document.querySelectorAll<HTMLAnchorElement>('#admin-comments a')].map(a => a.href);
    expect(links).toEqual(['https://photos.example.test/a.jpg']);
    expect(text).toContain('Hidden by the automated review');
    expect(text).toContain('remove · 95% · spam');
    expect(text).toContain('after a report');
    expect(text).toContain('owner banned');
  });

  it('names who hid a row, and shows a review that failed or was screen-flagged', async () => {
    const { stateLabel, reviewHtml } = await import('./admin-moderation');
    expect(stateLabel('reports', '2026-10-03T00:00:00Z')).toBe('Hidden by reports');
    expect(stateLabel('reports', '2026-10-03T00:00:00Z', { status: 'done', trigger: 'report', verdict: 'keep' })).toBe(
      'Hidden by reports'
    );
    expect(stateLabel(null, null)).toBe('Live');
    expect(reviewHtml(null)).toBe('');
    expect(reviewHtml({ status: 'failed', trigger: 'report', error: 'RateLimitError 429' })).toContain(
      'Failed (RateLimitError 429) — reporters decide'
    );
    expect(reviewHtml({ status: 'pending', trigger: 'screen', screenCategories: ['S10'] })).toContain(
      'flagged by the screen (S10)'
    );
  });

  it('offers no ban controls for a deleted account or an admin', async () => {
    const { commentRowHtml, waypointRowHtml } = await import('./admin-moderation');
    const deleted = document.createElement('div');
    deleted.innerHTML = commentRowHtml({ ...comment, userBanned: true, userDeleted: true } as never);
    expect(deleted.querySelector('[data-action="unban"], [data-action="ban"], [data-action="ban-remove"]')).toBeNull();
    expect(deleted.textContent).toContain('Account deleted');
    const admin = document.createElement('div');
    admin.innerHTML = waypointRowHtml({ ...waypoint, userBanned: false, userAdmin: true } as never);
    expect(admin.querySelector('[data-action="ban"], [data-action="ban-remove"]')).toBeNull();
  });

  it('restores a hidden comment and bans with content removal after confirming', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await import('./admin-moderation');
    await waitFor(() => document.querySelectorAll('.admin-row').length === 2);

    const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click();
    click('#admin-comments button[data-action="restore"]');
    await waitFor(() => fetchMock.mock.calls.some(([u]) => String(u).includes('/restore')));
    const restore = fetchMock.mock.calls.find(([u]) => String(u).includes('/restore'))!;
    expect(restore[0]).toBe(`https://api.example.test/v1/admin/comments/${comment.id}/restore`);
    expect(restore[1].method).toBe('POST');

    await waitFor(
      () => document.querySelector('#admin-comments button[data-action="ban-remove"]:not([disabled])') !== null
    );
    click('#admin-comments button[data-action="ban-remove"]');
    await waitFor(() => fetchMock.mock.calls.some(([u]) => String(u).includes('/ban')));
    const ban = fetchMock.mock.calls.find(([u]) => String(u).includes('/ban'))!;
    expect(ban[0]).toBe(`https://api.example.test/v1/admin/users/${comment.userId}/ban`);
    expect(JSON.parse(ban[1].body)).toEqual({ banned: true, removeContent: true });

    // The banned waypoint owner is offered an unban, not another ban.
    expect(document.querySelector('#admin-waypoints button[data-action="unban"]')).not.toBeNull();
    expect(document.querySelector('#admin-waypoints button[data-action="ban"]')).toBeNull();
  });
});
