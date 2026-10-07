/**
 * Boot script for `community-route.html?id=c_…` — the public page of one
 * community route. Spec: `plans/community-routes.md`.
 *
 * The detail comes from the API, the track from its public, immutable
 * `trailUrl`, and both are drawn by the same trail viewer `my-trail.ts` uses
 * (handed the trail as `preloadedTrail`). Around it: the route's text and
 * status, Report (needs a linked browser), "Save to my trails" (an IndexedDB
 * copy under a `u_` id, so the planner treats it like an import and never
 * syncs it), "Export for Tracknotes", and for the owner Edit / Delete with the
 * checks and the AI review.
 */

import {
  COMMUNITY_LIMITS,
  COMMUNITY_REPORT_REASONS,
  isCommunityRouteId,
  type CommunityReportReason,
  type CommunityRouteDetail,
} from '@lib/community-types';
import { handoffFileName, serializeTrailHandoff } from '@lib/trail-handoff';
import type { ProcessedTrail } from '@lib/trail-types';
import { ApiError, NetworkError, getApiBase } from './api/client';
import {
  deleteCommunityRoute,
  fetchCommunityTrail,
  getCommunityRoute,
  patchCommunityRoute,
  reportCommunityRoute,
} from './api/community';
import { clearSession, loadSession, type WebSession } from './api/session';
import {
  UNVERIFIED_EXPLANATION,
  VERIFIED_EXPLANATION,
  checksListHtml,
  initRegionPicker,
  localCopyId,
  multilineHtml,
  regionLabel,
  reviewHtml,
  statusBadgeHtml,
} from './community-ui';
import { getTrail, isIndexedDbAvailable, putTrail } from './imported-trails-db';
import { renderLinkForm } from './link-browser';
import { initTrailViewer, setTrailName } from './trails/trail-viewer';
import { escapeHtml, getQueryParam } from './web-utils';

const REPORT_LABELS: Record<CommunityReportReason, string> = {
  spam: 'Spam or advertising',
  offensive: 'Offensive or abusive',
  inaccurate: 'Inaccurate or misleading',
  unsafe: 'Unsafe, closed or on private land',
  copyright: 'Copied without permission',
  other: 'Something else',
};

type PanelId = 'loading-panel' | 'missing-panel' | 'trail-panel';

/**
 * The route as this page knows it right now. One object, shared by every
 * control: an owner's edit replaces `detail`, and Save, the export and the
 * title read it when they are used rather than keeping the name they were
 * set up with. `session` is the linked browser in use (the one a link form
 * just produced, never re-read from a storage that may refuse writes).
 */
interface RoutePage {
  detail: CommunityRouteDetail;
  session: WebSession | null;
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function showPanel(id: PanelId): void {
  for (const candidate of ['loading-panel', 'missing-panel', 'trail-panel'] as const) {
    const node = $(candidate);
    if (!node) continue;
    const active = candidate === id;
    node.classList.toggle('active', active);
    node.hidden = !active;
  }
}

function showMissing(title?: string, detail?: string): void {
  if (title) $('missing-title')!.textContent = title;
  if (detail) $('missing-detail')!.textContent = detail;
  showPanel('missing-panel');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function renderHeader(detail: CommunityRouteDetail): void {
  document.title = `${detail.name} - Community route - Trail Maps`;
  $('trail-title')!.textContent = detail.name;
  $('breadcrumb-name')!.textContent = detail.name;
  $('status-badge')!.innerHTML = statusBadgeHtml(detail.status);
  $('route-region')!.textContent = regionLabel(detail.country, detail.state);
  const when = formatDate(detail.createdAt);
  $('route-submitted')!.textContent = `Shared by ${detail.submittedBy || 'a hiker'}${when ? ` · ${when}` : ''}`;
  $('route-reviewed')!.hidden = !detail.reviewed;

  $('status-note')!.textContent =
    detail.status === 'verified'
      ? `${VERIFIED_EXPLANATION}${detail.verifiedAt ? ` (${formatDate(detail.verifiedAt)})` : ''}`
      : detail.status === 'unverified'
        ? UNVERIFIED_EXPLANATION
        : 'Hidden: this route is not listed publicly. Only its owner and the Tracknotes admins can see it.';

  $('route-description')!.innerHTML = multilineHtml(detail.description);
  $('route-licence')!.innerHTML =
    'Released into the public domain under ' +
    '<a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noopener">CC0</a>.' +
    (detail.credit ? ` Credit: ${escapeHtml(detail.credit)}` : '');

  const owner = detail.isOwner === true;
  $('edit-btn')!.hidden = !owner;
  $('delete-btn')!.hidden = !owner;
  $('owner-box')!.hidden = !owner;
  if (owner) {
    $('owner-checks')!.innerHTML = checksListHtml(detail.checks ?? []);
    $('owner-review')!.innerHTML = reviewHtml(detail.review);
  }
}

/** The pristine trail under the route's current name. */
function namedCopy(pristine: ProcessedTrail, name: string): ProcessedTrail {
  const copy: ProcessedTrail = structuredClone(pristine);
  copy.config = { ...copy.config, name, shortName: name };
  return copy;
}

/** Download the trail as the `.tracknotes.json` the app opens, under its current name. */
function initTracknotesExport(page: RoutePage, pristine: ProcessedTrail): void {
  const button = $('export-tracknotes-btn') as HTMLButtonElement | null;
  if (!button) return;
  button.disabled = false;
  button.addEventListener('click', () => {
    const trail = namedCopy(pristine, page.detail.name);
    const blob = new Blob([serializeTrailHandoff(trail)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = handoffFileName(trail);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
}

function initSave(page: RoutePage, pristine: ProcessedTrail): void {
  const button = $('save-btn') as HTMLButtonElement;
  const note = $('save-note')!;
  const localId = localCopyId(page.detail.id);
  const query = `?id=${encodeURIComponent(localId)}`;
  const savedHtml = (prefix: string): string =>
    `${escapeHtml(prefix)} <a href="./my-trail.html${query}">Open it</a> · <a href="./my-plan.html${query}">Plan it</a>`;

  if (!isIndexedDbAvailable()) {
    button.disabled = true;
    button.title = "This browser can't store trails (IndexedDB is unavailable)";
    return;
  }

  void getTrail(localId)
    .then(existing => {
      if (existing) {
        note.innerHTML = savedHtml('Saved in My trails on this browser.');
        note.hidden = false;
      }
    })
    .catch(() => undefined);

  button.addEventListener('click', () => {
    button.disabled = true;
    const name = page.detail.name;
    const lengthKm = Math.round(pristine.track.totalDistance * 10) / 10;
    const copy = namedCopy(pristine, name);
    copy.config = { ...copy.config, id: localId, lengthKm, source: 'community' };
    void putTrail({ id: localId, name, lengthKm, createdAt: Date.now(), trail: copy })
      .then(() => {
        note.innerHTML = savedHtml('Saved in My trails on this browser.');
      })
      .catch((err: unknown) => {
        note.textContent = `Could not save: ${messageOf(err)}`;
      })
      .finally(() => {
        note.hidden = false;
        button.disabled = false;
      });
  });
}

/**
 * Report: needs a linked browser, and is not offered to the owner (the
 * server refuses a report of one's own route). It needs no track, so it
 * stays when only the download failed.
 */
function initReport(page: RoutePage): void {
  const button = $('report-btn') as HTMLButtonElement;
  if (page.detail.isOwner === true) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  const box = $('report-box')!;
  const linkBox = $('report-link')!;
  const form = $('report-form') as HTMLFormElement;
  const reason = $('report-reason') as HTMLSelectElement;
  const noteInput = $('report-note') as HTMLTextAreaElement;
  const submit = $('report-submit') as HTMLButtonElement;
  const errorEl = $('report-error')!;
  const done = $('report-done')!;

  reason.innerHTML = COMMUNITY_REPORT_REASONS.map(
    r => `<option value="${escapeHtml(r)}">${escapeHtml(REPORT_LABELS[r] ?? r)}</option>`,
  ).join('');

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  const render = (): void => {
    setError('');
    if (!page.session) {
      form.hidden = true;
      linkBox.hidden = false;
      renderLinkForm(
        linkBox,
        'Reporting needs your Tracknotes app identity, so one person counts once. Link this browser to the app on your phone first.',
        linked => {
          page.session = linked;
          render();
        },
      );
    } else {
      linkBox.hidden = true;
      linkBox.innerHTML = '';
      form.hidden = false;
    }
  };

  button.addEventListener('click', () => {
    box.hidden = !box.hidden;
    done.hidden = true;
    if (!box.hidden) render();
  });
  $('report-cancel')!.addEventListener('click', () => {
    box.hidden = true;
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const session = page.session;
    if (!session) {
      render();
      return;
    }
    submit.disabled = true;
    setError('');
    // A repeat report from the same account is answered 200 by the worker
    // (it counts once), so there is no "already reported" case to word.
    void reportCommunityRoute(session, page.detail.id, reason.value as CommunityReportReason, noteInput.value)
      .then(() => {
        form.hidden = true;
        done.hidden = false;
        noteInput.value = '';
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          page.session = null;
          render();
        } else if (err instanceof ApiError && err.status === 429) {
          setError('Too many reports from this account today. Try again later.');
        } else if (err instanceof NetworkError) {
          setError('Could not reach the server. Check your connection and try again.');
        } else {
          setError(`Could not send the report: ${messageOf(err)}`);
        }
      })
      .finally(() => {
        submit.disabled = false;
      });
  });
}

function initOwnerTools(page: RoutePage): void {
  const session = page.session;
  if (!page.detail.isOwner || !session) return;
  const form = $('edit-form') as HTMLFormElement;
  const nameInput = $('edit-name') as HTMLInputElement;
  const descInput = $('edit-description') as HTMLTextAreaElement;
  const creditInput = $('edit-credit') as HTMLInputElement;
  const errorEl = $('edit-error')!;
  const submit = $('edit-submit') as HTMLButtonElement;
  nameInput.maxLength = COMMUNITY_LIMITS.nameMax;
  descInput.maxLength = COMMUNITY_LIMITS.descriptionMax;
  creditInput.maxLength = COMMUNITY_LIMITS.creditMax;

  const picker = initRegionPicker(
    $('edit-country') as HTMLSelectElement,
    $('edit-country-other') as HTMLInputElement,
    $('edit-state') as HTMLSelectElement,
    $('edit-state-field')!,
    $('edit-country-other-field')!,
  );

  const setError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = message === '';
  };

  $('edit-btn')!.addEventListener('click', () => {
    const detail = page.detail;
    nameInput.value = detail.name;
    descInput.value = detail.description;
    creditInput.value = detail.credit ?? '';
    picker.set(detail.country, detail.state);
    $('edit-verified-note')!.hidden = detail.status !== 'verified';
    setError('');
    form.hidden = false;
    $('owner-box')!.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('edit-cancel')!.addEventListener('click', () => {
    form.hidden = true;
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const description = descInput.value.trim();
    const country = picker.country();
    if (name.length < COMMUNITY_LIMITS.nameMin) {
      setError(`The name needs at least ${COMMUNITY_LIMITS.nameMin} characters.`);
      return;
    }
    if (description.length < COMMUNITY_LIMITS.descriptionMin) {
      setError(`The description needs at least ${COMMUNITY_LIMITS.descriptionMin} characters.`);
      return;
    }
    if (!country) {
      setError('Choose a country.');
      return;
    }
    submit.disabled = true;
    setError('');
    void patchCommunityRoute(session, page.detail.id, {
      name,
      description,
      credit: creditInput.value.trim() || null,
      country,
      state: picker.state(),
    })
      .then(updated => {
        // Keep owner-only fields if the PATCH reply leaves them out.
        page.detail = { ...page.detail, ...updated, isOwner: true };
        renderHeader(page.detail);
        setTrailName(page.detail.name);
        form.hidden = true;
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          clearSession();
          setError('This browser is no longer linked. Reload the page and link it again.');
        } else if (err instanceof NetworkError) {
          setError('Could not reach the server. Check your connection and try again.');
        } else if (err instanceof ApiError) {
          setError(`Could not save (${err.code}): ${err.message}`);
        } else {
          setError(`Could not save: ${messageOf(err)}`);
        }
      })
      .finally(() => {
        submit.disabled = false;
      });
  });

  const deleteBtn = $('delete-btn') as HTMLButtonElement;
  deleteBtn.addEventListener('click', () => {
    if (!window.confirm(`Delete "${page.detail.name}" from the community list? This cannot be undone.`)) return;
    deleteBtn.disabled = true;
    void deleteCommunityRoute(session, page.detail.id)
      .then(() => {
        window.location.href = './';
      })
      .catch((err: unknown) => {
        deleteBtn.disabled = false;
        window.alert(`Could not delete this route: ${messageOf(err)}`);
      });
  });
}

/** The detail, retried without the token when a stale one is refused. */
async function loadDetail(id: string, session: WebSession | null): Promise<RoutePage> {
  try {
    return { detail: await getCommunityRoute(id, session), session };
  } catch (err) {
    if (session && err instanceof ApiError && err.status === 401) {
      clearSession();
      return { detail: await getCommunityRoute(id, null), session: null };
    }
    throw err;
  }
}

/**
 * The text, status and owner tools without the map: a hidden route has no
 * public track (its owner and admins still see the details), and a download
 * can fail. Save, the exports and the direction toggle need the track, so
 * they go. Report does not: it stays for a live route whose download failed,
 * and goes for a hidden one (only its owner and admins can see it).
 */
function showWithoutTrack(page: RoutePage, note: string): void {
  renderHeader(page.detail);
  initOwnerTools(page);
  $('save-btn')!.hidden = true;
  $('direction-meta')!.hidden = true;
  if (page.detail.trailUrl && page.detail.status !== 'hidden') initReport(page);
  else $('report-btn')!.hidden = true;
  $('trail-body')!.hidden = true;
  const noteEl = $('no-track-note')!;
  noteEl.textContent = note;
  noteEl.hidden = false;
  showPanel('trail-panel');
}

async function init(): Promise<void> {
  const id = getQueryParam(window.location.search, 'id');
  if (!id || !isCommunityRouteId(id) || !getApiBase()) {
    showMissing();
    return;
  }

  let page: RoutePage;
  try {
    page = await loadDetail(id, loadSession());
  } catch (err) {
    if (err instanceof NetworkError) {
      showMissing('Could not load this route', 'The server could not be reached. Check your connection and reload.');
    } else if (err instanceof ApiError && err.status !== 404 && err.status !== 403) {
      showMissing('Could not load this route', `The server answered: ${err.message}`);
    } else {
      showMissing();
    }
    return;
  }
  const { detail } = page;
  if (detail.status === 'removed') {
    showMissing();
    return;
  }

  let trail: ProcessedTrail;
  try {
    trail = await fetchCommunityTrail(detail);
  } catch (err) {
    if (detail.trailUrl) console.error('Could not download the community route', err);
    showWithoutTrack(
      page,
      detail.trailUrl
        ? 'The route’s track could not be downloaded. Try reloading the page later.'
        : 'This route is hidden, so its track is not published. Its details are shown here; the map returns if it is restored.',
    );
    return;
  }
  trail.config = { ...trail.config, name: detail.name, shortName: detail.name };
  // A copy before the viewer takes it: the viewer normalises `config.id` and
  // owns the object from here on.
  const pristine = structuredClone(trail);

  renderHeader(detail);
  initSave(page, pristine);
  initReport(page);
  initOwnerTools(page);
  initTracknotesExport(page, pristine);

  showPanel('trail-panel');
  await initTrailViewer(detail.id, trail);
}

void init().catch((err: unknown) => {
  console.error('Could not open this route', err);
  showMissing('Could not load this route', 'Something went wrong drawing it. Try reloading the page.');
});
