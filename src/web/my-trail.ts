/**
 * Boot script for `my-trail.html` — the trail page for a user-imported GPX.
 *
 * Same viewer as a bundled trail page; the only difference is where the trail
 * object comes from. Bundled pages let `initTrailViewer` fetch
 * `/data/generated/{id}.json`; here the record is read out of IndexedDB and
 * handed in, because an imported trail exists nowhere but this browser.
 */

import { initTrailViewer } from './trails/trail-viewer';
import { handoffFileName, serializeTrailHandoff } from '@lib/trail-handoff';
import type { ProcessedTrail } from '@lib/trail-types';
import { deleteTrail, getTrail, isIndexedDbAvailable } from './imported-trails-db';
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

  const name = record.trail.config.name || record.name;
  applyTrailIdentity(name, record.id);
  initTracknotesExport(record.trail);
  initDeleteButton(record.id, name);

  // The panel must be laid out before the viewer runs: Leaflet and the
  // elevation canvas both size themselves from the live bounding box.
  showPanel('trail-panel');
  await initTrailViewer(record.id, record.trail);
}

void init();
