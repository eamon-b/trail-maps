/**
 * Upload page — turn a user's GPX file into a stored trail.
 *
 * The whole pipeline runs in the browser: read the file as text, hand it to the
 * shared `importGpx` orchestrator (the same ingestion the build script uses),
 * show the resulting {@link ImportReport}, then persist the built trail to
 * IndexedDB so `my-trail.html` / `my-plan.html` can open it. Nothing is
 * uploaded anywhere.
 */

import {
  applyElevation,
  backfillElevation,
  estimateElevationRequests,
} from '@lib/elevation-backfill';
import { importGpx, type ImportGpxResult } from '@lib/gpx-import';
import {
  isIndexedDbAvailable,
  putTrail,
  type ImportedTrailSummary,
} from './imported-trails-db';
import { escapeHtml, formatKm } from './web-utils';

/**
 * Point budget for the full-resolution web track.
 *
 * Web has no phone-sized memory ceiling, so this is far more generous than the
 * mobile 5,000 — but it still caps a pathological 100k-point recording at
 * something the Leaflet polyline and the elevation canvas can handle.
 */
const WEB_TARGET_POINTS = 20000;

/** Largest file we will even try to read, in bytes. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Warning `importGpx` pushes when the file carries no `<ele>`. Matched by prefix
 * so a backfill can drop it once it is no longer true — the wording may change,
 * but the opening words are the stable part.
 */
const NO_ELEVATION_WARNING_PREFIX = 'No elevation data';

/** Replacement note, so the report still says where the numbers came from. */
const BACKFILLED_ELEVATION_NOTE =
  'Elevation was filled in from Open-Elevation (terrain height under the track), ' +
  'not recorded on the walk — treat ascent totals as an estimate.';

interface Elements {
  dropZone: HTMLLabelElement;
  fileInput: HTMLInputElement;
  status: HTMLElement;
  error: HTMLElement;
  errorMessage: HTMLElement;
  noStorage: HTMLElement;
  report: HTMLElement;
  reportStats: HTMLElement;
  reportWarnings: HTMLElement;
  reportWarningList: HTMLElement;
  elevationBackfill: HTMLElement;
  fetchElevationBtn: HTMLButtonElement;
  elevationProgress: HTMLElement;
  elevationError: HTMLElement;
  trailName: HTMLInputElement;
  saveBtn: HTMLButtonElement;
  saveError: HTMLElement;
  saved: HTMLElement;
  savedName: HTMLElement;
  savedTrailLink: HTMLAnchorElement;
  savedPlanLink: HTMLAnchorElement;
}

/** The most recent successful import, waiting to be named and saved. */
let pending: ImportGpxResult | null = null;

/**
 * Row metadata of the pending import's last successful save, or null if it has
 * not been saved yet.
 *
 * Why keep it: elevation can be fetched *after* the trail is saved, and the
 * stored record would then still hold the flat version — the trail and plan
 * pages read IndexedDB, not this page's memory. When this is set, a backfill
 * re-`putTrail`s under the very same key and metadata, so the save is an
 * in-place update rather than a second row.
 */
let savedSummary: ImportedTrailSummary | null = null;

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`upload.html is missing #${id}`);
  return node as T;
}

function collectElements(): Elements {
  return {
    dropZone: el<HTMLLabelElement>('drop-zone'),
    fileInput: el<HTMLInputElement>('file-input'),
    status: el('status'),
    error: el('error'),
    errorMessage: el('error-message'),
    noStorage: el('no-storage'),
    report: el('report'),
    reportStats: el('report-stats'),
    reportWarnings: el('report-warnings'),
    reportWarningList: el('report-warning-list'),
    elevationBackfill: el('elevation-backfill'),
    fetchElevationBtn: el<HTMLButtonElement>('fetch-elevation-btn'),
    elevationProgress: el('elevation-progress'),
    elevationError: el('elevation-error'),
    trailName: el<HTMLInputElement>('trail-name'),
    saveBtn: el<HTMLButtonElement>('save-btn'),
    saveError: el('save-error'),
    saved: el('saved'),
    savedName: el('saved-name'),
    savedTrailLink: el<HTMLAnchorElement>('saved-trail-link'),
    savedPlanLink: el<HTMLAnchorElement>('saved-plan-link'),
  };
}

function show(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

/** Let the browser paint the "Processing…" status before we block on parsing. */
function nextFrame(): Promise<void> {
  return new Promise(resolve => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function renderStats(ui: Elements, result: ImportGpxResult): void {
  const { trail, report } = result;
  const rows: Array<[string, string]> = [
    ['Distance', `${formatKm(trail.track.totalDistance)} km`],
    ['Ascent / descent', `${Math.round(trail.track.totalAscent)} m / ${Math.round(trail.track.totalDescent)} m`],
    ['Track points', `${report.pointCount.toLocaleString()}${report.simplified ? ` (simplified from ${report.sourcePointCount.toLocaleString()})` : ''}`],
    ['Waypoints', String(report.waypointCount)],
  ];

  if (report.offTrailWaypointCount > 0) {
    rows.push(['Off-trail waypoints', String(report.offTrailWaypointCount)]);
  }
  if (report.tracksFound > 1) {
    rows.push(['Tracks in file', `${report.tracksFound} (${report.tracksCombined} joined into the main route)`]);
  }
  if (report.alternateCount > 0) rows.push(['Alternates', String(report.alternateCount)]);
  if (report.sideTripCount > 0) rows.push(['Side trips', String(report.sideTripCount)]);
  // A backfilled profile is real data, but not *the walker's* data — say so here
  // rather than letting "present" imply the GPX carried it.
  rows.push([
    'Elevation data',
    trail.config.elevationSource === 'backfilled'
      ? 'filled in from Open-Elevation'
      : report.hasElevation
        ? 'present'
        : 'missing',
  ]);

  ui.reportStats.innerHTML = rows
    .map(([label, value]) => `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`)
    .join('');
}

function renderWarnings(ui: Elements, result: ImportGpxResult): void {
  const { warnings } = result.report;
  show(ui.reportWarnings, warnings.length > 0);
  ui.reportWarningList.innerHTML = warnings
    .map(warning => `<li>${escapeHtml(warning)}</li>`)
    .join('');
}

function resetOutput(ui: Elements): void {
  pending = null;
  savedSummary = null;
  show(ui.error, false);
  show(ui.report, false);
  show(ui.saved, false);
  show(ui.saveError, false);
  // The backfill affordance is per-import: a fresh file decides again whether it
  // is offered, and must never inherit the previous file's progress or error.
  show(ui.elevationBackfill, false);
  show(ui.elevationProgress, false);
  show(ui.elevationError, false);
  ui.fetchElevationBtn.disabled = false;
}

/**
 * Offer the backfill only when the import has no elevation of its own, labelled
 * with the request count so the user knows what they are committing to before a
 * long track starts a minute of round-trips.
 */
function renderElevationBackfill(ui: Elements, result: ImportGpxResult): void {
  const offer = !result.report.hasElevation;
  if (offer) {
    const requests = estimateElevationRequests(result.trail.track.points.length);
    ui.fetchElevationBtn.textContent = `Fetch elevation (Open-Elevation, ~${requests.toLocaleString()} requests)`;
  }
  show(ui.elevationBackfill, offer);
}

/**
 * Look the terrain height up for every track point and fold it into the pending
 * import.
 *
 * Everything is replaced at once on success — `backfillElevation` either returns
 * a complete elevation array or throws — so a failure leaves the preview exactly
 * as it was and the button available to try again.
 */
async function handleFetchElevation(ui: Elements): Promise<void> {
  if (!pending) return;

  show(ui.elevationError, false);
  ui.fetchElevationBtn.disabled = true;
  ui.elevationProgress.textContent = 'Fetching elevation…';
  show(ui.elevationProgress, true);

  let withElevation: ImportGpxResult['trail'];
  try {
    const elevations = await backfillElevation(pending.trail.track.points, {
      onProgress: (done, total) => {
        ui.elevationProgress.textContent =
          `Fetching elevation… ${done.toLocaleString()} / ${total.toLocaleString()} points`;
      },
    });
    withElevation = applyElevation(pending.trail, elevations);
  } catch (err) {
    ui.elevationError.textContent = `Could not fetch elevation: ${messageOf(err)}`;
    show(ui.elevationError, true);
    show(ui.elevationProgress, false);
    ui.fetchElevationBtn.disabled = false;
    return;
  }

  show(ui.elevationProgress, false);

  pending.trail = withElevation;
  pending.report.hasElevation = true;
  // The "no elevation data" warning is now false; replace it with a note saying
  // where the numbers actually came from.
  pending.report.warnings = pending.report.warnings.filter(
    warning => !warning.startsWith(NO_ELEVATION_WARNING_PREFIX)
  );
  pending.report.warnings.push(BACKFILLED_ELEVATION_NOTE);

  renderStats(ui, pending);
  renderWarnings(ui, pending);
  show(ui.elevationBackfill, false);

  await persistBackfillIfSaved(ui);
}

/**
 * Re-save an already-saved trail so IndexedDB doesn't keep the flat version.
 *
 * No-op when the user hasn't pressed Save yet — the normal Save flow reads
 * `pending.trail`, which is the backfilled one by then.
 */
async function persistBackfillIfSaved(ui: Elements): Promise<void> {
  if (!pending || !savedSummary) return;
  try {
    await putTrail({ ...savedSummary, trail: pending.trail });
  } catch (err) {
    ui.saveError.textContent = `Elevation was fetched, but re-saving the trail failed: ${messageOf(err)}. Press Save trail again.`;
    show(ui.saveError, true);
  }
}

function fail(ui: Elements, message: string): void {
  show(ui.status, false);
  ui.errorMessage.textContent = message;
  show(ui.error, true);
}

async function handleFile(ui: Elements, file: File): Promise<void> {
  resetOutput(ui);

  if (file.size > MAX_FILE_BYTES) {
    fail(ui, `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 50 MB.`);
    return;
  }

  ui.status.textContent = `Reading ${file.name}…`;
  show(ui.status, true);

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    fail(ui, `Could not read the file: ${messageOf(err)}`);
    return;
  }

  ui.status.textContent = 'Processing track…';
  await nextFrame();

  let result: ImportGpxResult;
  try {
    // The file name is a better default than "Imported trail" when the GPX
    // carries no <metadata><name>, but it must not beat a real name from the
    // file — so it is only used when importGpx falls back.
    result = importGpx(text, { targetPoints: WEB_TARGET_POINTS });
    if (result.report.name === 'Imported trail') {
      const stem = file.name.replace(/\.gpx$/i, '').trim();
      if (stem) {
        result.report.name = stem;
        result.trail.config.name = stem;
        result.trail.config.shortName = stem;
      }
    }
  } catch (err) {
    fail(ui, messageOf(err));
    return;
  }

  pending = result;
  show(ui.status, false);
  ui.trailName.value = result.report.name;
  renderStats(ui, result);
  renderWarnings(ui, result);
  renderElevationBackfill(ui, result);
  ui.saveBtn.disabled = !isIndexedDbAvailable();
  show(ui.report, true);
}

async function handleSave(ui: Elements): Promise<void> {
  if (!pending) return;
  show(ui.saveError, false);

  const name = ui.trailName.value.trim() || pending.report.name;
  const { trail } = pending;
  const lengthKm = Math.round(trail.track.totalDistance * 10) / 10;

  // The edited name is the trail's identity from here on: the viewers read
  // config.name/shortName, the landing page reads the record's name column.
  trail.config.name = name;
  trail.config.shortName = name;
  trail.config.lengthKm = lengthKm;

  const summary: ImportedTrailSummary = {
    id: trail.config.id,
    name,
    lengthKm,
    createdAt: Date.now(),
  };

  ui.saveBtn.disabled = true;
  ui.saveBtn.textContent = 'Saving…';
  try {
    await putTrail({ ...summary, trail });
  } catch (err) {
    ui.saveError.textContent = `Could not save this trail: ${messageOf(err)}`;
    show(ui.saveError, true);
    ui.saveBtn.disabled = false;
    ui.saveBtn.textContent = 'Save trail';
    return;
  }

  ui.saveBtn.disabled = false;
  ui.saveBtn.textContent = 'Save trail';
  // A later elevation backfill re-saves under exactly these fields.
  savedSummary = summary;

  const query = `?id=${encodeURIComponent(trail.config.id)}`;
  ui.savedName.textContent = name;
  ui.savedTrailLink.href = `./my-trail.html${query}`;
  ui.savedPlanLink.href = `./my-plan.html${query}`;
  show(ui.saved, true);
  ui.saved.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function initDragAndDrop(ui: Elements): void {
  const setDragging = (dragging: boolean): void => {
    ui.dropZone.classList.toggle('dragover', dragging);
  };

  for (const type of ['dragenter', 'dragover'] as const) {
    ui.dropZone.addEventListener(type, event => {
      event.preventDefault();
      setDragging(true);
    });
  }

  for (const type of ['dragleave', 'dragend'] as const) {
    ui.dropZone.addEventListener(type, () => setDragging(false));
  }

  ui.dropZone.addEventListener('drop', event => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(ui, file);
  });

  // Dropping outside the zone would otherwise make the browser navigate to the
  // file, silently losing whatever was on the page.
  for (const type of ['dragover', 'drop'] as const) {
    window.addEventListener(type, event => {
      if (!ui.dropZone.contains(event.target as Node)) event.preventDefault();
    });
  }
}

function init(): void {
  const ui = collectElements();

  if (!isIndexedDbAvailable()) {
    show(ui.noStorage, true);
    ui.saveBtn.disabled = true;
  }

  ui.fileInput.addEventListener('change', () => {
    const file = ui.fileInput.files?.[0];
    if (file) void handleFile(ui, file);
    // Allow re-picking the same file after a failed import.
    ui.fileInput.value = '';
  });

  ui.saveBtn.addEventListener('click', () => void handleSave(ui));
  ui.fetchElevationBtn.addEventListener('click', () => void handleFetchElevation(ui));
  initDragAndDrop(ui);
}

init();
