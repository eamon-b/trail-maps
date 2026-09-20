/**
 * Boot script for `shared-plan.html` — somebody else's plan, read-only.
 *
 * The share id in `?s=` is the whole credential: `GET /v1/shared/plans/:id` is
 * public and needs no token, so this page works for a reader who has never
 * linked a browser. It fetches the plan, fetches the trail the plan names from
 * this site's own generated JSON, and boots the ordinary planner with
 * `readOnly: true` — the same map, elevation profile, day cards and datasheet,
 * with nothing that edits or stores anything.
 *
 * Everything the server hands back is hostile input: the plan's name, its
 * stop notes and the owner's display name were all typed by a stranger, so
 * every one of them reaches the page through `textContent` or `escapeHtml`.
 *
 * Two actions sit in the header. "Open in Tracknotes" is the `tracknotes://`
 * deep link the phone app claims. "Copy to my plans" appears only for a
 * browser that is linked to an account, and writes the document into that
 * account as the reader's own plan for the trail.
 */

import { initPlanViewer } from './trails/plan-viewer';
import { savePlanDocument } from './trails/plan-state';
import { getQueryParam } from './web-utils';
import { ApiError, getApiBase } from './api/client';
import { loadSession } from './api/session';
import { fetchMyPlan, fetchSharedPlan, putPlan } from './api/plans';
import type { SharedPlanResponse } from '@lib/comments-api-types';
import type { PlanDocument } from '@lib/plan-types';

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Swap the page into the "there is nothing to show" state. */
function showMissing(title: string, detail: string): void {
  const missing = byId('plan-missing');
  if (missing) missing.hidden = false;
  const titleEl = byId('plan-missing-title');
  if (titleEl) titleEl.textContent = title;
  const detailEl = byId('plan-missing-detail');
  if (detailEl) detailEl.textContent = detail;

  const shell = byId('plan-shell');
  if (shell) shell.hidden = true;
  const smallScreen = byId('small-screen-msg');
  if (smallScreen) smallScreen.hidden = true;
}

/**
 * The header's own fills: the plan's name as the title, and whose plan it is.
 *
 * `textContent` throughout — `ownerDisplayName` and `document.name` are
 * strangers' text, and this page renders it beside a link the reader may act on.
 */
function applyIdentity(shared: SharedPlanResponse, shareId: string): void {
  const name = shared.document.name || 'Shared plan';
  document.title = `${name} - Trail Maps`;

  const title = byId('trail-title');
  if (title) title.textContent = name;

  const sharedBy = byId('shared-by');
  if (sharedBy) sharedBy.textContent = `Shared by ${shared.ownerDisplayName}`;

  const openInApp = byId<HTMLAnchorElement>('open-in-app');
  if (openInApp) {
    // The share id is url-safe base64 from the server, but it is still
    // somebody else's string: encode it rather than trusting its shape.
    openInApp.href = `tracknotes://plan/${encodeURIComponent(shareId)}`;
    openInApp.hidden = false;
  }
}

/** The trail this site carries under that id, or null when it carries none. */
async function loadTrail(trailId: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`/data/generated/${encodeURIComponent(trailId)}.json`);
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Copy the shared plan into the reader's own account.
 *
 * A new id, because the reader's copy is their document and not the owner's;
 * unless they already have a plan for this trail, in which case the copy takes
 * over that id after they confirm — the server allows exactly one live plan per
 * trail per user, so any other id would be refused as `plan_exists`.
 */
async function copyToMyPlans(shared: SharedPlanResponse): Promise<void> {
  const session = loadSession();
  if (!session) return;

  const button = byId<HTMLButtonElement>('copy-to-plans');
  if (button) button.disabled = true;
  try {
    const existing = await fetchMyPlan(session, shared.trailId);
    let id: string;
    if (existing.entry) {
      const confirmed = window.confirm(
        'You already have a plan for this trail. Replace it with this shared one?',
      );
      if (!confirmed) return;
      id = existing.entry.id;
    } else {
      id = crypto.randomUUID();
    }

    const copy: PlanDocument = {
      ...shared.document,
      id,
      trailId: shared.trailId,
      updatedAt: new Date().toISOString(),
    };
    const stored = await putPlan(session, copy);
    // Written locally too, so the trail's own plan page opens on it straight
    // away instead of waiting for its first sync.
    savePlanDocument(shared.trailId, stored.document);
    window.location.href = `./trails/${encodeURIComponent(shared.trailId)}/plan.html`;
  } catch (err) {
    if (button) button.disabled = false;
    const sharedBy = byId('shared-by');
    if (sharedBy) {
      sharedBy.textContent =
        err instanceof ApiError ? `Could not copy: ${err.code}` : 'Could not reach the server.';
    }
  }
}

async function init(): Promise<void> {
  const shareId = getQueryParam(window.location.search, 's');
  if (!shareId) {
    showMissing('No plan link', 'This page needs a share link — ask whoever sent it for a new one.');
    return;
  }
  if (!getApiBase()) {
    showMissing(
      'Shared plans are unavailable',
      'This copy of the site was built without a server to read shared plans from.',
    );
    return;
  }

  let shared: SharedPlanResponse;
  try {
    shared = await fetchSharedPlan(shareId);
  } catch (err) {
    showMissing(
      'Plan not found',
      err instanceof ApiError && err.status === 404
        ? 'This link is no longer shared, or it was never valid.'
        : 'Could not reach the server. Try again in a moment.',
    );
    return;
  }

  const trail = await loadTrail(shared.trailId);
  if (!trail) {
    showMissing(
      'Trail not on this site',
      'This plan is for a trail this site does not have.',
    );
    return;
  }

  applyIdentity(shared, shareId);

  const copyBtn = byId<HTMLButtonElement>('copy-to-plans');
  if (copyBtn && loadSession()) {
    copyBtn.hidden = false;
    copyBtn.addEventListener('click', () => void copyToMyPlans(shared));
  }

  await initPlanViewer(shared.trailId, trail as never, {
    readOnly: true,
    preloadedPlan: shared.document,
  });
}

// A throw inside the viewer would otherwise leave a half-drawn planner and an
// unhandled rejection in the console.
void init().catch((err: unknown) => {
  console.error('Could not open this shared plan', err);
  showMissing('Plan not found', 'Something went wrong opening this plan.');
});
