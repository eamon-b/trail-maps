/**
 * Boot script for `my-trail.html` — the trail page for a user-imported GPX.
 *
 * Same viewer as a bundled trail page; the only difference is where the trail
 * object comes from. Bundled pages let `initTrailViewer` fetch
 * `/data/generated/{id}.json`; here the record is read out of IndexedDB and
 * handed in, because an imported trail exists nowhere but this browser.
 */

import { clearDirectionPreference, initTrailViewer } from './trails/trail-viewer';
import { clearPlanState } from './trails/plan-state';
import { handoffFileName, serializeTrailHandoff } from '@lib/trail-handoff';
import type { ProcessedTrail } from '@lib/trail-types';
import { deleteTrail, getTrail, isIndexedDbAvailable, putTrail } from './imported-trails-db';
import { getQueryParam } from './web-utils';

function panel(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/**
 * Show exactly one of the three page states. `.panel` is `display:none` until
 * it also carries `.active`, so both the class and the `hidden` attribute have
 * to move together.
 */
function showPanel(id: 'loading-panel' | 'missing-panel' | 'trail-panel'): void {
  for (const candidate of ['loading-panel', 'missing-panel', 'trail-panel'] as const) {
    const node = panel(candidate);
    if (!node) continue;
    const active = candidate === id;
    node.classList.toggle('active', active);
    node.hidden = !active;
  }
}

/** Fill in the bits a bundled page gets from `{{…}}` template substitution. */
function applyTrailIdentity(name: string, trailId: string): void {
  document.title = `${name} - Trail Maps`;

  // textContent, not innerHTML: `name` is whatever the user typed on upload.
  const title = document.getElementById('trail-title');
  if (title) title.textContent = name;

  const crumb = document.getElementById('breadcrumb-name');
  if (crumb) crumb.textContent = name;

  const planLink = document.getElementById('plan-link') as HTMLAnchorElement | null;
  if (planLink) planLink.href = `./my-plan.html?id=${encodeURIComponent(trailId)}`;
}

/**
 * Wire the "Export for Tracknotes" button.
 *
 * An imported trail lives only in this browser's IndexedDB, so this download is
 * the entire bridge to the phone: the file it produces is what the mobile app's
 * share/open intent (or its document picker) reads back through
 * `parseHandoffJson`. The payload is the trail object verbatim — the phone does
 * no re-ingestion, so what you see here is exactly what you get there.
 */
function initTracknotesExport(trail: ProcessedTrail): void {
  const button = document.getElementById('export-tracknotes-btn') as HTMLButtonElement | null;
  if (!button) return;

  button.disabled = false;
  button.addEventListener('click', () => {
    // Built lazily: a full-resolution track serializes to megabytes, and most
    // visitors never press this.
    const blob = new Blob([serializeTrailHandoff(trail)], {
      type: 'application/json;charset=utf-8;',
    });
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

// === Waypoint category corrections ===
//
// Classification is a guess (a `<type>` we don't know, a name with no keyword in
// it), and this page is the only place a wrong guess can be fixed: the trail
// lives in this browser's IndexedDB and nowhere else. The viewer owns the
// control; everything below owns making the correction durable.

/**
 * Set `type` on every stored copy of one waypoint. Returns how many it touched.
 *
 * A single waypoint id legitimately appears in more than one of these lists. The
 * importer mints one id per *source* waypoint and then files it by geometry: on
 * the main route if it is close enough, in `offTrailWaypoints` if it is not, and
 * additionally under an alternate or side trip whose line runs past it. The map
 * marker, the datasheet row and the plan calculator each read a different one of
 * those lists — so updating only the first match would leave one place calling
 * a spot a water source while another still calls it a point of interest.
 */
function setWaypointType(trail: ProcessedTrail, waypointId: string, nextType: string): number {
  let matches = 0;

  for (const wp of trail.waypoints ?? []) {
    if (wp.id === waypointId) {
      wp.type = nextType;
      matches++;
    }
  }
  for (const wp of trail.offTrailWaypoints ?? []) {
    if (wp.id === waypointId) {
      wp.type = nextType;
      matches++;
    }
  }
  for (const variant of [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])]) {
    for (const wp of variant.waypoints ?? []) {
      if (wp.id === waypointId) {
        wp.type = nextType;
        matches++;
      }
    }
  }

  return matches;
}

/**
 * Read-modify-write the stored record.
 *
 * The record is re-read here rather than reusing the one this page booted from,
 * so a correction is applied to the freshest stored copy and can never carry a
 * stale sibling field back over a newer write. Nothing the viewer handed us is
 * mutated, and nothing is mutated at all unless `putTrail` resolves.
 */
async function saveWaypointType(
  trailId: string,
  waypointId: string,
  nextType: string,
): Promise<void> {
  if (!isIndexedDbAvailable()) {
    throw new Error("this browser can't store changes (IndexedDB is unavailable)");
  }

  const record = await getTrail(trailId);
  if (!record) {
    throw new Error('this trail is no longer in this browser’s storage');
  }
  if (setWaypointType(record.trail, waypointId, nextType) === 0) {
    throw new Error('that waypoint is not in the stored copy of this trail');
  }

  await putTrail(record);
}

/**
 * Serialised write queue.
 *
 * Two rows edited in quick succession are two independent read-modify-write
 * cycles over the *whole* trail record, so running them concurrently would let
 * the slower one write back a copy that predates the faster one's change —
 * silently undoing it. Chaining them means every write reads what the previous
 * one stored. A rejected write does not break the chain.
 */
let typeWriteQueue: Promise<void> = Promise.resolve();

function queueWaypointTypeWrite(
  trailId: string,
  waypointId: string,
  nextType: string,
): Promise<void> {
  const run = typeWriteQueue.then(() => saveWaypointType(trailId, waypointId, nextType));
  typeWriteQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function initDeleteButton(trailId: string, name: string): void {
  const button = document.getElementById('delete-trail-btn') as HTMLButtonElement | null;
  if (!button) return;

  button.addEventListener('click', () => {
    if (!window.confirm(`Delete "${name}"? This removes it from this browser for good.`)) {
      return;
    }
    button.disabled = true;
    button.textContent = 'Deleting…';
    void deleteTrail(trailId)
      .then(() => {
        // The IndexedDB record is only part of this trail; the plan and the
        // direction toggle live in localStorage under the same id. Because that
        // id is a content hash of the source GPX, re-importing the very same
        // file lands on it again — so anything left behind here would reappear
        // attached to what the user believes is a brand-new trail.
        clearPlanState(trailId);
        clearDirectionPreference(trailId);
        window.location.href = './';
      })
      .catch((err: unknown) => {
        button.disabled = false;
        button.textContent = 'Delete trail';
        window.alert(`Could not delete this trail: ${err instanceof Error ? err.message : String(err)}`);
      });
  });
}

async function init(): Promise<void> {
  const trailId = getQueryParam(window.location.search, 'id');

  if (!trailId || !isIndexedDbAvailable()) {
    showPanel('missing-panel');
    return;
  }

  let record;
  try {
    record = await getTrail(trailId);
  } catch {
    record = null;
  }

  if (!record) {
    showPanel('missing-panel');
    return;
  }

  // Captured out of the (nullable) `record` so the callback below closes over a
  // plain string rather than relying on narrowing that TypeScript drops inside
  // a closure.
  const storedId = record.id;
  const name = record.trail.config.name || record.name;
  applyTrailIdentity(name, record.id);
  initTracknotesExport(record.trail);
  initDeleteButton(record.id, name);

  // The panel must be laid out before the viewer runs: Leaflet and the
  // elevation canvas both size themselves from the live bounding box.
  showPanel('trail-panel');
  await initTrailViewer(record.id, record.trail, {
    // Only an imported trail gets this: a bundled trail's JSON is build output.
    onWaypointTypeChange: (waypointId, nextType) =>
      queueWaypointTypeWrite(storedId, waypointId, nextType),
  });
}

/**
 * A throw inside the viewer would otherwise leave the page stuck on a
 * half-drawn trail panel with an unhandled rejection in the console. The
 * "not found" panel is a worse trail page and a much better error message.
 */
function initSafely(): void {
  void init().catch((err: unknown) => {
    console.error('Could not open this trail', err);
    showPanel('missing-panel');
  });
}

initSafely();
