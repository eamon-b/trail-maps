/**
 * Boot script for `my-trail.html` — the trail page for a user-imported GPX.
 *
 * Same viewer as a bundled trail page; the only difference is where the trail
 * object comes from. Bundled pages let `initTrailViewer` fetch
 * `/data/generated/{id}.json`; here the record is read out of IndexedDB and
 * handed in, because an imported trail exists nowhere but this browser.
 */

import { initTrailViewer } from './trails/trail-viewer';
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
  initDeleteButton(record.id, name);

  // The panel must be laid out before the viewer runs: Leaflet and the
  // elevation canvas both size themselves from the live bounding box.
  showPanel('trail-panel');
  await initTrailViewer(record.id, record.trail);
}

void init();
