/**
 * Boot script for `my-plan.html` — the trip planner for a user-imported GPX.
 *
 * Mirrors `my-trail.ts`: the plan viewer is unchanged, it just receives a trail
 * read from IndexedDB instead of fetching `/data/generated/{id}.json`. The plan
 * document is persisted to localStorage under the same import id, so a plan
 * survives page reloads exactly as it does for a bundled trail — including the
 * one-off migration of a plan saved before the day planner, whose stops resolve
 * against the import's own `uw_` waypoint ids (`loadOrMigratePlan`).
 *
 * The record's `pois` come along with the trail, so the Stops tab's services
 * strip works here too when the import was enriched; a GPX imported with no
 * enrichment has none, and the tab says so rather than claiming there is
 * nothing around.
 *
 * Plans for imported trails stay on this device: Phase 3c's sync arm is gated
 * off for `u_` ids, exactly as comments are.
 */

import { initPlanViewer } from './trails/plan-viewer';
import { getTrail, isIndexedDbAvailable } from './imported-trails-db';
import { getQueryParam } from './web-utils';

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** Swap the page into the "this trail isn't here any more" state. */
function showMissing(): void {
  const missing = byId('plan-missing');
  if (missing) missing.hidden = false;

  const shell = byId('plan-shell');
  if (shell) shell.hidden = true;

  // Otherwise the narrow-screen notice would show alongside the message.
  const smallScreen = byId('small-screen-msg');
  if (smallScreen) smallScreen.hidden = true;
}

/** Fill in the bits a bundled plan page gets from `{{…}}` substitution. */
function applyTrailIdentity(name: string, trailId: string): void {
  document.title = `Plan — ${name} - Trail Maps`;

  // textContent, not innerHTML: `name` is whatever the user typed on upload.
  const title = byId('trail-title');
  if (title) title.textContent = name;

  const href = `./my-trail.html?id=${encodeURIComponent(trailId)}`;
  for (const id of ['back-link', 'small-screen-back']) {
    const link = byId<HTMLAnchorElement>(id);
    if (link) link.href = href;
  }
}

async function init(): Promise<void> {
  const trailId = getQueryParam(window.location.search, 'id');

  if (!trailId || !isIndexedDbAvailable()) {
    showMissing();
    return;
  }

  let record;
  try {
    record = await getTrail(trailId);
  } catch {
    record = null;
  }

  if (!record) {
    showMissing();
    return;
  }

  applyTrailIdentity(record.trail.config.name || record.name, record.id);
  await initPlanViewer(record.id, record.trail);
}

// A throw inside the viewer would otherwise leave a half-drawn planner and an
// unhandled rejection in the console — no worse a trail than the "not found"
// state, and far harder for the user to interpret.
void init().catch((err: unknown) => {
  console.error('Could not open this plan', err);
  showMissing();
});
