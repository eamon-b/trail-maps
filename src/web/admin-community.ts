/**
 * Boot script for `admin-community.html` — the community-route review queue.
 * Spec: `plans/community-routes.md`.
 *
 * Needs a linked browser whose account the worker treats as an admin; a 403
 * says so. The server decides who is an admin — this page only renders what
 * `GET /v1/admin/community/routes` returns, and every action is re-checked
 * there.
 */

import type { CommunityRouteDetail } from '@lib/community-types';
import { ApiError, NetworkError, getApiBase } from './api/client';
import {
  adminListCommunityRoutes,
  adminRerunReview,
  adminSetCommunityStatus,
  communityRouteHref,
  deleteCommunityRoute,
} from './api/community';
import { clearSession, loadSession, type WebSession } from './api/session';
import { checksListHtml, regionLabel, reviewHtml, statusBadgeHtml } from './community-ui';
import { renderLinkForm } from './link-browser';
import { escapeHtml } from './web-utils';

function $(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`admin-community.html is missing #${id}`);
  return node;
}

/** Hidden or confidently rejected by the AI review: an admin should look first. */
function needsAttention(route: CommunityRouteDetail): boolean {
  return route.status === 'hidden' || route.review?.verdict === 'reject';
}

/** Queue order: attention first, then unverified, then verified; newest first within. */
function sortAdminQueue(routes: readonly CommunityRouteDetail[]): CommunityRouteDetail[] {
  const rank = (r: CommunityRouteDetail): number =>
    needsAttention(r) ? 0 : r.status === 'unverified' ? 1 : r.status === 'verified' ? 2 : 3;
  return [...routes].sort(
    (a, b) => rank(a) - rank(b) || (b.reportCount ?? 0) - (a.reportCount ?? 0) || b.createdAt.localeCompare(a.createdAt),
  );
}

function rowHtml(route: CommunityRouteDetail): string {
  const id = escapeHtml(route.id);
  const reports = route.reports ?? [];
  const reportList =
    reports.length > 0
      ? `<ul>${reports
          .map(
            r =>
              `<li>${escapeHtml(r.reason)}${r.note ? `: ${escapeHtml(r.note)}` : ''} <span class="community-hint">${escapeHtml(
                r.createdAt,
              )}</span></li>`,
          )
          .join('')}</ul>`
      : '';
  const btn = (action: string, label: string, enabled: boolean, cls = ''): string =>
    `<button type="button" class="community-btn ${cls}" data-action="${action}" data-id="${id}"${enabled ? '' : ' disabled'}>${label}</button>`;

  return `
    <article class="admin-row${needsAttention(route) ? ' admin-row-attention' : ''}" data-row="${id}">
      <h3><a href="./${escapeHtml(communityRouteHref(route.id))}" target="_blank" rel="noopener">${escapeHtml(
        route.name,
      )}</a> ${statusBadgeHtml(route.status)}</h3>
      <dl>
        <dt>Id</dt><dd><code>${id}</code></dd>
        <dt>Region</dt><dd>${escapeHtml(regionLabel(route.country, route.state))}</dd>
        <dt>Length</dt><dd>${escapeHtml(route.lengthKm.toFixed(1))} km · ${escapeHtml(Math.round(route.ascentM))} m ascent · ${escapeHtml(
          route.waypointCount,
        )} waypoints</dd>
        <dt>Submitted</dt><dd>${escapeHtml(route.submittedBy ?? '(no name)')} · ${escapeHtml(route.createdAt)}</dd>
        <dt>Credit</dt><dd>${escapeHtml(route.credit ?? '—')}</dd>
        <dt>Reports</dt><dd>${escapeHtml(route.reportCount ?? reports.length)}${reportList}</dd>
        ${route.statusNote ? `<dt>Last note</dt><dd>${escapeHtml(route.statusNote)}</dd>` : ''}
      </dl>
      <details>
        <summary>Description</summary>
        <p class="community-description">${escapeHtml(route.description).replace(/\r?\n/g, '<br>')}</p>
      </details>
      <details${needsAttention(route) ? ' open' : ''}>
        <summary>AI review${route.review?.error ? ` (error: ${escapeHtml(route.review.error)})` : ''}</summary>
        ${reviewHtml(route.review)}
        ${
          route.review?.suggestedCountry
            ? `<p class="import-note">Suggested region: ${escapeHtml(
                regionLabel(route.review.suggestedCountry, route.review.suggestedState ?? null),
              )}</p>`
            : ''
        }
      </details>
      <details>
        <summary>Automatic checks</summary>
        ${checksListHtml(route.checks ?? [])}
      </details>
      <div class="admin-row-actions">
        <input type="text" class="community-input" data-note="${id}" maxlength="500" placeholder="Note (optional)" aria-label="Note for ${escapeHtml(route.name)}">
        ${btn('verify', 'Verify', route.status !== 'verified', 'is-primary')}
        ${btn('unverify', 'Unverify', route.status === 'verified')}
        ${btn('hide', 'Hide', route.status !== 'hidden')}
        ${btn('restore', 'Restore', route.status === 'hidden')}
        ${btn('review', 'Re-run review', true)}
        ${btn('delete', 'Delete', true, 'is-danger')}
      </div>
      <p class="import-error" data-error="${id}" hidden></p>
    </article>`;
}

function init(): void {
  const status = $('admin-status');
  const linkBox = $('admin-link');
  const errorEl = $('admin-error');
  const toolbar = $('admin-toolbar');
  const list = $('admin-list');

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  if (!getApiBase()) {
    status.textContent = 'This build has no API configured (VITE_API_BASE_URL).';
    return;
  }

  let session: WebSession | null = null;
  let routes: CommunityRouteDetail[] = [];

  const askToLink = (): void => {
    status.hidden = true;
    toolbar.hidden = true;
    list.innerHTML = '';
    linkBox.hidden = false;
    renderLinkForm(linkBox, 'The review queue needs an admin account. Link this browser to the Tracknotes app on that phone.', linked => {
      linkBox.hidden = true;
      linkBox.innerHTML = '';
      void load(linked);
    });
  };

  /**
   * (Re)load the queue. `linked` is the session the link form just produced;
   * otherwise the one already in use, else the stored one. Never re-read
   * after a link, since storage may be refusing writes.
   */
  const load = async (linked?: WebSession): Promise<void> => {
    session = linked ?? session ?? loadSession();
    setError('');
    if (!session) {
      askToLink();
      return;
    }
    status.hidden = false;
    status.textContent = 'Loading the queue…';
    try {
      routes = sortAdminQueue(await adminListCommunityRoutes(session));
    } catch (err) {
      status.hidden = true;
      if (err instanceof ApiError && err.status === 401) {
        clearSession();
        session = null;
        askToLink();
      } else if (err instanceof ApiError && err.status === 403) {
        setError('This account is not an admin.');
        toolbar.hidden = false;
        $('admin-identity').textContent = `Linked as ${session.displayName || 'this account'}.`;
      } else if (err instanceof NetworkError) {
        setError('Could not reach the server. Check your connection and reload.');
      } else {
        setError(`Could not load the queue: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    status.hidden = true;
    toolbar.hidden = false;
    $('admin-identity').textContent = `Linked as ${session.displayName || 'this account'} · ${routes.length} route${
      routes.length === 1 ? '' : 's'
    }`;
    list.innerHTML = routes.length > 0 ? routes.map(rowHtml).join('') : '<p class="import-note">The queue is empty.</p>';
  };

  list.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
    if (!target || !session) return;
    const id = target.dataset.id!;
    const action = target.dataset.action!;
    const route = routes.find(r => r.id === id);
    const noteInput = list.querySelector<HTMLInputElement>(`input[data-note="${CSS.escape(id)}"]`);
    const rowError = list.querySelector<HTMLElement>(`[data-error="${CSS.escape(id)}"]`);
    const note = noteInput?.value.trim() || null;
    const current = session;

    if (action === 'delete' && !window.confirm(`Delete "${route?.name ?? id}"? This cannot be undone.`)) return;

    const run = (): Promise<void> => {
      switch (action) {
        case 'verify':
          return adminSetCommunityStatus(current, id, 'verified', note);
        case 'unverify':
        case 'restore':
          return adminSetCommunityStatus(current, id, 'unverified', note);
        case 'hide':
          return adminSetCommunityStatus(current, id, 'hidden', note);
        case 'review':
          return adminRerunReview(current, id);
        case 'delete':
          return deleteCommunityRoute(current, id);
        default:
          return Promise.resolve();
      }
    };

    for (const b of list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`)) b.disabled = true;
    void run()
      .then(() => load())
      .catch((err: unknown) => {
        if (rowError) {
          rowError.textContent =
            err instanceof ApiError
              ? `Failed (${err.code}): ${err.message}`
              : `Failed: ${err instanceof Error ? err.message : String(err)}`;
          rowError.hidden = false;
        }
        for (const b of list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`)) b.disabled = false;
      });
  });

  $('admin-reload').addEventListener('click', () => void load());
  void load();
}

init();
