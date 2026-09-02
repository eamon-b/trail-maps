// Trail viewer module - extracted from inline script to fix Vite HTML proxy issues
// This module handles map, elevation profile, waypoints table, and direction reversal

import type * as Leaflet from 'leaflet';
import { findNearestByDistance } from '@lib/track-geometry';
import { createReversedTrail } from '@lib/trail-reverse';
import { getDirectionLabel as directionLabelFor } from '@lib/plan-direction';
import {
  isKnownWaypointType,
  isResupplyWaypoint,
  matchesWaypointFamily,
  waypointTypeLabel,
  WAYPOINT_TYPE_LABELS,
  WAYPOINT_TYPES,
  type WaypointFamily,
} from '@lib/waypoint-taxonomy';
// Shared with the upload/my-trail pages, and — unlike a `textContent` round
// trip through a detached div — it escapes quotes, so the same helper is safe
// in an attribute value as in a text node. That matters here: `autoLinkUrls`
// puts its result inside `href="…"`, and imported GPX supplies every waypoint
// name, type and description on this page.
import { escapeHtml } from '../web-utils';
import { onThemeChange, themeColor } from '../theme';
declare const L: typeof Leaflet;

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
}

interface Waypoint {
  /**
   * Stable waypoint id — from the committed registry for a bundled trail,
   * minted as `uw_…` by the importer. It is how the category editor addresses a
   * waypoint: the array index is a rendering detail that moves with the
   * direction toggle and the filter.
   */
  id?: string;
  name?: string;
  type?: string;
  lat: number;
  lon: number;
  elevation?: number;
  distance?: number;
  totalDistance?: number;
  ascent?: number;
  descent?: number;
  totalAscent?: number;
  totalDescent?: number;
  description?: string;
  trackIndex?: number;
}

interface VariantWaypoint {
  /** Stable id, shared with the same waypoint on the main route. */
  id?: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  elevation: number;
  /** Segment distance from previous variant waypoint (variant-relative) in km */
  distance: number;
  /** Absolute trail km: junction startDistance + distance walked along the variant */
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
  description?: string;
}

/**
 * A point on an alternate/side-trip polyline. Variant geometry is only ever
 * read for lat/lon here, and the shared `ProcessedTrail` type stores variant
 * points without a cumulative `dist`, so it stays optional — that is what makes
 * a `ProcessedTrail` (e.g. a runtime GPX import) assignable to `Trail`.
 */
interface VariantPoint {
  lat: number;
  lon: number;
  ele: number;
  dist?: number;
}

interface RouteVariant {
  name: string;
  type: 'alternate' | 'side-trip';
  distance?: number;
  startDistance?: number;
  endDistance?: number;
  elevation?: { ascent?: number; descent?: number };
  points?: VariantPoint[];
  waypoints?: VariantWaypoint[];
}

interface DirectionConfig {
  default: string;
  reversed: string;
}

interface OffTrailWaypoint {
  /** Stable id — see {@link Waypoint.id}. */
  id?: string;
  name: string;
  lat: number;
  lon: number;
  type?: string;
  description?: string;
  distanceFromTrail: number;  // meters
}

interface Trail {
  config: {
    id: string;
    name: string;
    region: string;
    direction?: DirectionConfig;
  };
  track: {
    points: TrackPoint[];
    displayPoints?: TrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints?: Waypoint[];
  offTrailWaypoints?: OffTrailWaypoint[];
  alternates?: RouteVariant[];
  sideTrips?: RouteVariant[];
}

/**
 * Optional capabilities the host page grants the viewer.
 *
 * The viewer is shared with the bundled trail pages, which are static build
 * output: their trail JSON is generated from committed data and nothing on the
 * page may edit it. So editing is opt-in — with no options passed the page
 * renders exactly as it always has.
 */
export interface TrailViewerOptions {
  /**
   * Persist a corrected waypoint category, addressed by waypoint id.
   *
   * Supplied by `my-trail.html` (an imported GPX, stored in this browser's
   * IndexedDB). Resolve once the change is durably stored — the viewer only
   * then updates its in-memory trail, the badge, the map marker and the filter.
   * Reject to have the `<select>` reverted and the reason shown inline.
   */
  onWaypointTypeChange?: (waypointId: string, nextType: string) => Promise<void> | void;
}

let viewerOptions: TrailViewerOptions = {};

// Map state
let map: L.Map | null = null;
let hoverMarker: L.Marker | null = null;
let mainRoutePolyline: L.Polyline | null = null;
let trackPoints: TrackPoint[] = [];
let displayPoints: TrackPoint[] = [];
let maxDistance = 0;
let waypointMarkers: Array<{ marker: L.Marker; waypoint: Waypoint; index: number }> = [];
let offTrailMarkers: L.Marker[] = [];
let expandedWaypointIndex: number | null = null;
let expandedVariantKey: string | null = null;
let expandedVariantWaypointIndex: number | null = null;
let chartPadding = { top: 20, right: 20, bottom: 30, left: 50 };

// Trail direction state management
const trailState = {
  isReversed: false,
  originalTrail: null as Trail | null,
  reversedTrail: null as Trail | null,
  get currentTrail(): Trail | null {
    return this.isReversed ? this.reversedTrail : this.originalTrail;
  }
};

// === Waypoints-table filter ===
//
// The datasheet answers two questions the unfiltered table cannot: "where can I
// get water?" and "how long is each resupply leg?". `all` is the table as it has
// always been; the two families come from @lib/waypoint-taxonomy so the web,
// the build and mobile agree on what counts as water or food.
//
// State is module-level rather than per-render so it survives a re-render — the
// direction toggle rebuilds the whole table via refreshDisplay().
type WaypointFilter = 'all' | WaypointFamily;

let waypointFilter: WaypointFilter = 'all';

/** Human label for a filter, used in button labels and CSV headers. */
const FILTER_LABELS: Record<WaypointFilter, string> = {
  all: 'all waypoints',
  water: 'water',
  resupply: 'food & resupply',
};

/** Noun for the things a family filter shows, for the summary line. */
const FILTER_NOUNS: Record<WaypointFamily, { one: string; many: string }> = {
  water: { one: 'water source', many: 'water sources' },
  resupply: { one: 'resupply point', many: 'resupply points' },
};

/**
 * CSS class that colours a type badge. Unknown types (an imported GPX can name
 * anything) deliberately get no class and fall back to the neutral chip.
 *
 * Module scope because the off-trail rows, the waypoint rows and the variant
 * sub-tables all need it.
 */
function getTypeClass(type?: string): string {
  const typeMap: Record<string, string> = {
    'town': 'type-town',
    'hut': 'type-hut',
    'campsite': 'type-campsite',
    'water': 'type-water',
    'water-tank': 'type-water-tank',
    'mountain': 'type-mountain',
    'side-trip': 'type-side-trip',
    'accommodation': 'type-accommodation',
    'caravan-park': 'type-caravan-park',
    'trailhead': 'type-trailhead',
    'food': 'type-food',
    'road-crossing': 'type-road-crossing',
    'inlet-crossing': 'type-inlet-crossing',
    'beach': 'type-beach',
    'poi': 'type-poi',
    'resupply': 'type-resupply',
    'endpoint': 'type-endpoint'
  };
  return typeMap[type || ''] || '';
}

/**
 * The type badge: a readable label, with the raw slug kept in `title` so the
 * underlying value stays discoverable (it is what the GPX/CSV carries).
 */
function renderTypeBadge(type?: string): string {
  const raw = type || 'waypoint';
  return `<td><span class="waypoint-type ${getTypeClass(type)}" title="${escapeHtml(raw)}">${escapeHtml(waypointTypeLabel(type))}</span></td>`;
}

/**
 * Row tint for a waypoint, driven by its type.
 *
 * Module scope because the category editor has to re-apply it after a change
 * without re-rendering the whole table.
 */
function getRowClass(wp: { type?: string }): string {
  if (wp.type === 'town') return 'highlight-town';
  if (isResupplyWaypoint(wp.type)) return 'highlight-resupply';
  return '';
}

const ROW_TYPE_CLASSES = ['highlight-town', 'highlight-resupply'] as const;

// === Editable waypoint category ===
//
// Automatic classification cannot win every time: an imported GPX may carry no
// `<type>` at all, or one from a vocabulary we do not know, so plenty of
// waypoints land as "Unclassified" or as something the plan calculators ignore.
// This control is the manual override, and it exists only where a correction can
// actually be saved (see TrailViewerOptions.onWaypointTypeChange).

/** True when this waypoint can be re-categorised on this page. */
function canEditType(wp: { id?: string }): boolean {
  return typeof viewerOptions.onWaypointTypeChange === 'function' && typeof wp.id === 'string' && wp.id !== '';
}

/**
 * The `<option>` list: the canonical vocabulary, preceded by the file's own type
 * when that is not one of ours.
 *
 * Keeping the foreign value is not politeness — dropping it would silently
 * rewrite data the user never touched. Someone opening the panel of a
 * `fire-trail` waypoint to read its coordinates must not lose that word.
 */
function typeOptionsHtml(current: string): string {
  const options: string[] = [];
  const currentIsCanonical = isKnownWaypointType(current);

  if (current && !currentIsCanonical) {
    options.push(
      `<option value="${escapeHtml(current)}" selected>${escapeHtml(waypointTypeLabel(current))} (from your file)</option>`,
    );
  }

  for (const type of WAYPOINT_TYPES) {
    const selected = currentIsCanonical && type === current ? ' selected' : '';
    options.push(`<option value="${type}"${selected}>${escapeHtml(WAYPOINT_TYPE_LABELS[type])}</option>`);
  }

  return options.join('');
}

/**
 * The category editor for one detail panel, or '' when editing is not offered.
 *
 * `domKey` only has to be unique within the page — it is what ties the `<label>`
 * to its `<select>` and to the status region beside it.
 */
function renderTypeEditor(domKey: string, wp: { id?: string; type?: string }): string {
  if (!canEditType(wp)) return '';
  const current = wp.type || 'waypoint';
  const selectId = `waypoint-type-select-${domKey}`;
  return `
    <div class="waypoint-type-edit">
      <label class="waypoint-type-edit-label" for="${escapeHtml(selectId)}">Category</label>
      <select id="${escapeHtml(selectId)}" class="waypoint-type-select"
              data-waypoint-id="${escapeHtml(wp.id!)}"
              data-previous-type="${escapeHtml(current)}">
        ${typeOptionsHtml(current)}
      </select>
      <span class="waypoint-type-edit-status" role="status" aria-live="polite"></span>
      <a class="waypoint-type-help" href="./how-import-works.html#fixing-a-category"
         target="_blank" rel="noopener">Waypoint types</a>
    </div>
  `;
}

/**
 * A live region outside the table, for announcing a saved change when the table
 * was re-rendered and the row the user was editing is no longer on screen —
 * which is exactly what happens when they retype a water source to something
 * else while the Water filter is on.
 *
 * Created lazily and only on a page that can edit, so bundled trail pages keep
 * their markup untouched.
 */
function typeAnnounceRegion(): HTMLElement | null {
  const existing = document.getElementById('waypoint-type-announce');
  if (existing) return existing;

  const container = document.getElementById('waypoints-container');
  if (!container?.parentNode) return null;

  const region = document.createElement('p');
  region.id = 'waypoint-type-announce';
  region.className = 'waypoint-type-announce';
  region.setAttribute('role', 'status');
  region.setAttribute('aria-live', 'polite');
  region.hidden = true;
  container.parentNode.insertBefore(region, container);
  return region;
}

function announceTypeChange(message: string): void {
  const region = typeAnnounceRegion();
  if (!region) return;
  region.textContent = message;
  region.hidden = false;
}

function setSelectStatus(select: HTMLSelectElement, message: string, kind: 'pending' | 'ok' | 'error'): void {
  const status = select.parentElement?.querySelector<HTMLElement>('.waypoint-type-edit-status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('is-error', kind === 'error');
  status.classList.toggle('is-ok', kind === 'ok');
  // An error is not a polite update — it is the answer to what the user just
  // did, and it must interrupt.
  status.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

/** Set `type` on every copy of this waypoint the viewer holds in memory. */
function applyWaypointTypeLocally(waypointId: string, nextType: string): void {
  // Both trails, because the reversed copy is built once and cached: leaving it
  // stale would resurrect the old category the next time the user reverses.
  for (const trail of [trailState.originalTrail, trailState.reversedTrail]) {
    if (!trail) continue;
    for (const wp of trail.waypoints ?? []) {
      if (wp.id === waypointId) wp.type = nextType;
    }
    for (const wp of trail.offTrailWaypoints ?? []) {
      if (wp.id === waypointId) wp.type = nextType;
    }
    for (const variant of [...(trail.alternates ?? []), ...(trail.sideTrips ?? [])]) {
      for (const wp of variant.waypoints ?? []) {
        if (wp.id === waypointId) wp.type = nextType;
      }
    }
  }
}

/** Repaint the badge and the row tint of one already-rendered row. */
function repaintRowType(row: HTMLElement, type: string, isMainWaypoint: boolean): void {
  const badge = row.querySelector<HTMLElement>('.waypoint-type');
  if (badge) {
    badge.className = `waypoint-type ${getTypeClass(type)}`.trim();
    badge.title = type;
    badge.textContent = waypointTypeLabel(type);
  }
  if (isMainWaypoint) {
    row.classList.remove(...ROW_TYPE_CLASSES);
    const rowClass = getRowClass({ type });
    if (rowClass) row.classList.add(rowClass);
  }
}

/** Push the new icon (and popup text) onto the map markers for this waypoint. */
function refreshMarkersForWaypoint(waypointId: string): void {
  if (!map) return;
  for (const { marker, waypoint, index } of waypointMarkers) {
    if (waypoint.id !== waypointId) continue;
    marker.setIcon(createWaypointIcon(waypoint.type));
    marker.setPopupContent(waypointPopupHtml(waypoint, index));
  }
  const trail = trailState.currentTrail;
  const offTrail = trail?.offTrailWaypoints ?? [];
  // Off-trail markers are not indexed, and there are only a handful; redrawing
  // them is cheaper to get right than tracking them individually.
  if (offTrail.some(wp => wp.id === waypointId)) {
    drawOffTrailWaypointMarkers(offTrail);
  }
}

/** Find the (possibly re-rendered) select for a waypoint id. */
function findTypeSelect(waypointId: string): HTMLSelectElement | null {
  for (const select of document.querySelectorAll<HTMLSelectElement>('select.waypoint-type-select')) {
    if (select.dataset.waypointId === waypointId) return select;
  }
  return null;
}

/**
 * Save one category correction, then make the page tell the truth about it.
 *
 * Order matters: nothing on screen and nothing in memory changes until the
 * host's write has resolved, so a failed save can never leave the user looking
 * at a value that was not stored.
 */
async function handleWaypointTypeChange(select: HTMLSelectElement): Promise<void> {
  const handler = viewerOptions.onWaypointTypeChange;
  const waypointId = select.dataset.waypointId;
  const previous = select.dataset.previousType ?? '';
  const nextType = select.value;

  if (!handler || !waypointId || nextType === previous) return;

  select.disabled = true;
  setSelectStatus(select, 'Saving…', 'pending');

  try {
    await handler(waypointId, nextType);
  } catch (err) {
    select.value = previous;
    select.disabled = false;
    setSelectStatus(
      select,
      `Not saved: ${err instanceof Error ? err.message : String(err)}`,
      'error',
    );
    return;
  }

  select.disabled = false;
  select.dataset.previousType = nextType;
  applyWaypointTypeLocally(waypointId, nextType);
  refreshMarkersForWaypoint(waypointId);

  const label = waypointTypeLabel(nextType);
  const detailRow = select.closest('tr');
  const row = detailRow?.previousElementSibling as HTMLElement | null;
  const isMainWaypoint = row?.hasAttribute('data-waypoint-index') ?? false;
  if (row) repaintRowType(row, nextType, isMainWaypoint);

  if (waypointFilter === 'all') {
    // Nothing about the visible set can have changed, so the panel stays open
    // and the user keeps their place — and their keyboard focus.
    setSelectStatus(select, `Saved as ${label}`, 'ok');
    return;
  }

  // Under a family filter the row may have just joined or left the table, and
  // every leg and the summary line are measured between visible rows — so the
  // table has to be rebuilt around the new type.
  const trail = trailState.currentTrail;
  if (!trail) return;
  renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips, trail.offTrailWaypoints);

  if (expandedWaypointIndex !== null) {
    const wp = trail.waypoints?.[expandedWaypointIndex];
    if (wp && document.getElementById(`waypoint-row-${expandedWaypointIndex}`)) {
      expandWaypointDetail(expandedWaypointIndex, wp);
    } else {
      expandedWaypointIndex = null;
    }
  }

  // Off-trail rows stay visible under a filter (a water source 200 m off-trail
  // is exactly what the water filter is for), so an edited one is very often
  // still on screen — re-expand it too, or findTypeSelect below finds nothing
  // and we wrongly tell the user their waypoint left the view.
  if (expandedOffTrailIndex !== null) {
    const wp = trail.offTrailWaypoints?.[expandedOffTrailIndex];
    if (wp && document.getElementById(`off-trail-row-${expandedOffTrailIndex}`)) {
      expandOffTrailDetail(expandedOffTrailIndex, wp);
    } else {
      expandedOffTrailIndex = null;
    }
  }

  const reopened = findTypeSelect(waypointId);
  if (reopened) {
    setSelectStatus(reopened, `Saved as ${label}`, 'ok');
    reopened.focus();
  } else {
    // The row is filtered out now. Say so where a screen reader will hear it,
    // since the control the user was operating no longer exists.
    announceTypeChange(`Saved as ${label}. That waypoint is no longer in the ${FILTER_LABELS[waypointFilter]} view.`);
  }
}

/** One visible waypoint row, with the leg values the current filter implies. */
interface WaypointLeg {
  wp: Waypoint;
  /** Index into the *unfiltered* waypoints array — the id every handler uses. */
  waypointIndex: number;
  /** km from the previous visible waypoint (from the trail start for the first). */
  legKm: number | null;
  legAscent: number | null;
  legDescent: number | null;
}

/** Difference between two cumulative figures, or null if either is missing. */
function cumulativeDelta(to: number | undefined, from: number | undefined): number | null {
  if (to == null || from == null) return null;
  return to - from;
}

/**
 * The waypoints the filter shows, in trail order, each with its leg back to the
 * previous *visible* waypoint.
 *
 * Unfiltered, the leg values are the stored per-waypoint ones, so the table is
 * byte-identical to what it has always rendered. Filtered, they are recomputed
 * as differences of the cumulative figures — which is exact, not an estimate:
 * `totalDistance`/`totalAscent`/`totalDescent` are measured along the whole
 * track, so B − A is the real distance and elevation between A and B including
 * everything skipped in between. A missing cumulative figure yields null (the
 * caller renders an em dash) rather than a stale number.
 */
function computeWaypointLegs(waypoints: Waypoint[], filter: WaypointFilter): WaypointLeg[] {
  const visible = waypoints
    .map((wp, waypointIndex) => ({ wp, waypointIndex }))
    .filter(({ wp }) => filter === 'all' || matchesWaypointFamily(wp.type, filter));

  if (filter === 'all') {
    return visible.map(({ wp, waypointIndex }) => ({
      wp,
      waypointIndex,
      legKm: wp.distance ?? null,
      legAscent: wp.ascent ?? null,
      legDescent: wp.descent ?? null,
    }));
  }

  // Sort by trail position before differencing so a leg can never come out
  // negative even if the source array is not in distance order.
  visible.sort((a, b) => (a.wp.totalDistance ?? 0) - (b.wp.totalDistance ?? 0));

  let prev: Waypoint | null = null;
  return visible.map(({ wp, waypointIndex }) => {
    const leg: WaypointLeg = {
      wp,
      waypointIndex,
      // The first visible row's leg is measured from the trail start (km 0),
      // which matches what the unfiltered column shows for waypoint 0 and is a
      // genuine carry — start to first resupply is a leg you walk.
      legKm: cumulativeDelta(wp.totalDistance, prev ? prev.totalDistance : 0),
      legAscent: cumulativeDelta(wp.totalAscent, prev ? prev.totalAscent : 0),
      legDescent: cumulativeDelta(wp.totalDescent, prev ? prev.totalDescent : 0),
    };
    prev = wp;
    return leg;
  });
}

/**
 * One compact line describing the legs between the visible waypoints — for the
 * resupply filter this is the actual deliverable ("how far between resupplies").
 *
 * The point-to-point legs are the gaps *between* two visible waypoints, so n
 * visible waypoints give n−1 legs, and those are what the leg count and the
 * average describe. The **longest** figure is deliberately wider than that: for
 * water it also considers the walk from the start to the first source and from
 * the last source to the end of the trail, because those are carries you make
 * too — reporting "longest dry stretch" while ignoring a 120 km tail after the
 * last tank would be actively misleading. `trailLengthKm` supplies the end
 * position; pass 0 or omit it when it is unknown and the bounding stretches are
 * simply left out.
 */
function summariseLegs(
  legs: WaypointLeg[],
  family: WaypointFamily,
  trailLengthKm = 0,
): string {
  const noun = FILTER_NOUNS[family];
  if (legs.length === 0) {
    return `No ${noun.many} on this trail.`;
  }
  // A single resupply point really has nothing to measure. A single water
  // source still does: the dry walk in to it and the dry walk out.
  if (legs.length === 1 && family === 'resupply') {
    return `Only one ${noun.one} on this trail — no legs to measure.`;
  }

  // Candidates for "longest": every point-to-point gap, plus (water only) the
  // unavoidable stretches at each end of the trail.
  const candidates: Array<{ km: number; from: string; to: string }> = [];
  const nameOf = (leg: WaypointLeg) => leg.wp.name || 'Unnamed';

  // legs[i] carries the gap from legs[i - 1], so the gaps are indices 1..n-1.
  let total = 0;
  let measured = 0;
  for (let i = 1; i < legs.length; i++) {
    const km = legs[i].legKm;
    if (km == null) continue;
    total += km;
    measured++;
    candidates.push({ km, from: nameOf(legs[i - 1]), to: nameOf(legs[i]) });
  }

  if (family === 'water') {
    const firstKm = legs[0].legKm;
    if (firstKm != null && firstKm > 0) {
      candidates.push({ km: firstKm, from: 'trail start', to: nameOf(legs[0]) });
    }
    const lastAt = legs[legs.length - 1].wp.totalDistance;
    if (trailLengthKm > 0 && lastAt != null && trailLengthKm > lastAt) {
      candidates.push({
        km: trailLengthKm - lastAt,
        from: nameOf(legs[legs.length - 1]),
        to: 'trail end',
      });
    }
  }

  const gapCount = legs.length - 1;
  const parts = [`${legs.length} ${legs.length === 1 ? noun.one : noun.many}`];
  if (gapCount > 0) {
    parts.push(`${gapCount} ${gapCount === 1 ? 'leg' : 'legs'}`);
  }

  const longest = candidates.reduce<(typeof candidates)[number] | null>(
    (best, c) => (best === null || c.km > best.km ? c : best),
    null,
  );
  if (longest) {
    const label = family === 'water' ? 'longest dry stretch' : 'longest leg';
    parts.push(`${label} ${longest.km.toFixed(1)} km (${longest.from} → ${longest.to})`);
  }
  if (measured > 0) {
    parts.push(`average ${(total / measured).toFixed(1)} km`);
  }

  return parts.join(' · ');
}

// Waypoint icon configuration
const WAYPOINT_ICONS: Record<string, { icon: string }> = {
  town: { icon: '\u{1F3D8}\u{FE0F}' },
  hut: { icon: '\u{1F6D6}' },
  campsite: { icon: '\u26FA' },
  water: { icon: '\u{1F4A7}' },
  'water-tank': { icon: '\u{1F6B0}' },
  mountain: { icon: '\u26F0\u{FE0F}' },
  'side-trip': { icon: '\u{1F97E}' },
  accommodation: { icon: '\u{1F3E8}' },
  'caravan-park': { icon: '\u{1F3D5}\u{FE0F}' },
  trailhead: { icon: '\u{1F697}' },
  food: { icon: '\u{1F374}' },
  'road-crossing': { icon: '\u{1F6E3}\u{FE0F}' },
  'inlet-crossing': { icon: '\u{1F30A}' },
  beach: { icon: '\u{1F3D6}\u{FE0F}' },
  poi: { icon: '\u{2B50}' },
  resupply: { icon: '\u{1F4E6}' },
  endpoint: { icon: '\u{1F6A9}' },
  waypoint: { icon: '\u{1F4CD}' }
};

// Safe min/max for large arrays (avoids stack overflow with spread operator)
function getMinMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0], max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

// Calculate nice round-number axis ticks for chart axes
function niceAxisTicks(min: number, max: number, maxTicks: number): number[] {
  const range = max - min;
  if (range <= 0) return [min];
  const roughStep = range / maxTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  let niceStep: number;
  if (normalized <= 1) niceStep = 1 * magnitude;
  else if (normalized <= 2) niceStep = 2 * magnitude;
  else if (normalized <= 5) niceStep = 5 * magnitude;
  else niceStep = 10 * magnitude;
  const start = Math.ceil(min / niceStep) * niceStep;
  const ticks: number[] = [];
  for (let v = start; v <= max; v += niceStep) {
    ticks.push(Math.round(v * 1e6) / 1e6); // avoid floating point drift
  }
  return ticks;
}

// Debounce helper for resize events
function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), ms);
  };
}


// Convert plain-text URLs to clickable links (after HTML escaping)
function autoLinkUrls(text: string): string {
  const escaped = escapeHtml(text);
  // Match URLs, avoiding trailing punctuation that's likely not part of the URL
  return escaped.replace(
    /https?:\/\/[^\s<]+[^\s<.,;:!?)\]]/g,
    url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
  );
}

function initMap(trail: Trail): void {
  if (typeof L === 'undefined') {
    const mapContainer = document.getElementById('trail-map');
    if (mapContainer) {
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: var(--text-secondary);">Map unavailable. Please check your internet connection or try disabling ad blockers.</p>';
    }
    console.error('Leaflet library failed to load');
    return;
  }

  try {
    map = L.map('trail-map', {
      zoomControl: true,
      scrollWheelZoom: true
    });

    L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap'
    }).addTo(map);

    L.control.scale({ metric: true, imperial: false }).addTo(map);

    maxDistance = trail.track.totalDistance;

    drawMainRoute(trail);
    drawAlternates(trail.alternates || []);
    drawSideTrips(trail.sideTrips || []);
    drawWaypointMarkers(trail.waypoints || []);
    drawOffTrailWaypointMarkers(trail.offTrailWaypoints || []);

    hoverMarker = L.marker([0, 0], {
      icon: L.divIcon({
        className: 'elevation-hover-marker',
        iconSize: [12, 12],
        iconAnchor: [6, 6]
      })
    });

    fitMapToBounds(trail);
  } catch (error) {
    console.error('Failed to initialize map:', error);
    const mapContainer = document.getElementById('trail-map');
    if (mapContainer) {
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: var(--text-secondary);">Failed to load map. Please try refreshing the page.</p>';
    }
  }
}

function drawMainRoute(trail: Trail): void {
  displayPoints = trail.track.displayPoints || trail.track.points;
  if (!displayPoints || displayPoints.length === 0) return;

  const latLngs = displayPoints.map(p => [p.lat, p.lon] as [number, number]);

  mainRoutePolyline = L.polyline(latLngs, {
    color: '#2196F3',
    weight: 3,
    opacity: 0.9
  }).addTo(map!);

  trackPoints = trail.track.points;

  mainRoutePolyline.on('mousemove', handleMapHover);
  mainRoutePolyline.on('mouseout', hideElevationHover);
}

function drawAlternates(alternates: RouteVariant[]): void {
  alternates.forEach(alt => {
    if (!alt.points || alt.points.length === 0) return;

    const latLngs = alt.points.map(p => [p.lat, p.lon] as [number, number]);
    L.polyline(latLngs, {
      color: '#ff9800',
      weight: 3,
      opacity: 0.8
    }).addTo(map!).bindPopup(`<strong>${escapeHtml(alt.name)}</strong><br>${escapeHtml(alt.distance)} km`);
  });
}

function drawSideTrips(sideTrips: RouteVariant[]): void {
  sideTrips.forEach(trip => {
    if (!trip.points || trip.points.length === 0) return;

    const latLngs = trip.points.map(p => [p.lat, p.lon] as [number, number]);
    L.polyline(latLngs, {
      color: '#9c27b0',
      weight: 3,
      opacity: 0.8
    }).addTo(map!).bindPopup(`<strong>${escapeHtml(trip.name)}</strong><br>${escapeHtml(trip.distance)} km`);
  });
}

function createWaypointIcon(type?: string): L.DivIcon {
  const config = WAYPOINT_ICONS[type || 'waypoint'] || WAYPOINT_ICONS.waypoint;
  return L.divIcon({
    className: `waypoint-marker ${type || 'waypoint'}`,
    html: config.icon,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
    popupAnchor: [0, -12]
  });
}

/**
 * Marker popup body. Extracted so a category change can rewrite it in place
 * rather than by rebuilding every marker on the map.
 */
function waypointPopupHtml(wp: Waypoint, index: number): string {
  return `
      <strong>${escapeHtml(wp.name || 'Waypoint')}</strong><br>
      ${escapeHtml(wp.type || 'waypoint')}<br>
      ${(wp.totalDistance || 0).toFixed(1)} km along trail
      ${wp.elevation ? `<br>${Math.round(wp.elevation)}m elevation` : ''}
      <br><a href="#" class="popup-show-in-table" data-waypoint-index="${index}">Show in table</a>
    `;
}

function drawWaypointMarkers(waypoints: Waypoint[]): void {
  waypointMarkers = [];
  // Leaflet is a CDN script, and `initMap` already degrades to a "map
  // unavailable" panel when it doesn't arrive. Every other map mutation in
  // `refreshDisplay` is guarded on `map`; these two were not, so reversing
  // direction on a page whose Leaflet was blocked threw instead of just
  // updating the table and the profile.
  if (!map) return;
  if (!waypoints || waypoints.length === 0) return;

  waypoints.forEach((wp, index) => {
    const marker = L.marker([wp.lat, wp.lon], {
      icon: createWaypointIcon(wp.type)
    }).addTo(map!).bindPopup(waypointPopupHtml(wp, index));

    waypointMarkers.push({ marker, waypoint: wp, index });
  });
}

function drawOffTrailWaypointMarkers(waypoints: OffTrailWaypoint[]): void {
  offTrailMarkers.forEach(m => { if (map && map.hasLayer(m)) map.removeLayer(m); });
  offTrailMarkers = [];
  if (!map) return;
  if (!waypoints || waypoints.length === 0) return;

  waypoints.forEach(wp => {
    const marker = L.marker([wp.lat, wp.lon], {
      icon: createWaypointIcon(wp.type),
      opacity: 1
    }).addTo(map!).bindPopup(`
      <strong>${escapeHtml(wp.name || 'Waypoint')}</strong><br>
      ${escapeHtml(wp.type || 'waypoint')}<br>
      ${(wp.distanceFromTrail / 1000).toFixed(1)} km from trail
    `);

    offTrailMarkers.push(marker);
  });
}

function fitMapToBounds(trail: Trail): void {
  const bounds = L.latLngBounds([]);

  const pts = trail.track.displayPoints || trail.track.points;
  pts.forEach(p => bounds.extend([p.lat, p.lon]));

  (trail.alternates || []).forEach(alt => {
    (alt.points || []).forEach(p => bounds.extend([p.lat, p.lon]));
  });

  (trail.sideTrips || []).forEach(trip => {
    (trip.points || []).forEach(p => bounds.extend([p.lat, p.lon]));
  });

  (trail.offTrailWaypoints || []).forEach(wp => bounds.extend([wp.lat, wp.lon]));

  map!.fitBounds(bounds, { padding: [20, 20] });
}

function handleMapHover(e: L.LeafletMouseEvent): void {
  if (!displayPoints.length) return;

  const latlng = e.latlng;
  let nearestPoint: TrackPoint | null = null;
  let minDist = Infinity;

  for (const p of displayPoints) {
    const dist = Math.sqrt(
      Math.pow(p.lat - latlng.lat, 2) +
      Math.pow(p.lon - latlng.lng, 2)
    );
    if (dist < minDist) {
      minDist = dist;
      nearestPoint = p;
    }
  }

  if (nearestPoint) {
    showElevationHover(nearestPoint.dist, nearestPoint.ele);
  }
}

function showElevationHover(distance: number, elevation: number): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const rect = canvas.getBoundingClientRect();
  const padding = chartPadding;
  const width = rect.width - padding.left - padding.right;

  const xPos = padding.left + (distance / maxDistance) * width;

  const hoverLine = document.querySelector('.elevation-profile .hover-line') as HTMLElement;
  const tooltip = document.querySelector('.elevation-profile .hover-tooltip') as HTMLElement;

  if (hoverLine) {
    hoverLine.style.left = `${xPos}px`;
    hoverLine.style.display = 'block';
  }

  if (tooltip) {
    tooltip.style.left = `${xPos + 10}px`;
    tooltip.textContent = `${distance.toFixed(1)} km, ${Math.round(elevation)}m`;
    tooltip.style.display = 'block';
  }
}

function hideElevationHover(): void {
  const hoverLine = document.querySelector('.elevation-profile .hover-line') as HTMLElement;
  const tooltip = document.querySelector('.elevation-profile .hover-tooltip') as HTMLElement;
  if (hoverLine) hoverLine.style.display = 'none';
  if (tooltip) tooltip.style.display = 'none';
}

function handleTableRowClick(waypointIndex: number): void {
  const markerInfo = waypointMarkers[waypointIndex];
  if (!markerInfo) return;

  document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const targetZoom = Math.max(map!.getZoom(), 13);
  map!.setView([markerInfo.waypoint.lat, markerInfo.waypoint.lon], targetZoom);

  markerInfo.marker.openPopup();

  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (row) {
    row.classList.add('highlight-selected');
    setTimeout(() => row.classList.remove('highlight-selected'), 2000);
  }
}

function scrollToTableRow(waypointIndex: number): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (!row) return;

  row.scrollIntoView({ behavior: 'smooth', block: 'center' });

  row.classList.add('highlight-selected');
  setTimeout(() => row.classList.remove('highlight-selected'), 2000);

  // Expand the row (collapse any other expanded row first, per accordion behavior)
  if (expandedWaypointIndex !== null && expandedWaypointIndex !== waypointIndex) {
    collapseWaypointDetail(expandedWaypointIndex);
  }
  if (expandedWaypointIndex !== waypointIndex) {
    const trail = trailState.currentTrail;
    const wp = trail?.waypoints?.[waypointIndex];
    if (wp) {
      expandWaypointDetail(waypointIndex, wp);
      expandedWaypointIndex = waypointIndex;
    }
  }
}

function toggleWaypointExpansion(waypointIndex: number): void {
  if (expandedWaypointIndex === waypointIndex) {
    collapseWaypointDetail(waypointIndex);
    expandedWaypointIndex = null;
  } else {
    // Collapse any expanded variant
    if (expandedVariantKey !== null) {
      collapseVariantDetail(expandedVariantKey);
      expandedVariantKey = null;
      expandedVariantWaypointIndex = null;
    }
    if (expandedWaypointIndex !== null) {
      collapseWaypointDetail(expandedWaypointIndex);
    }
    const trail = trailState.currentTrail;
    const wp = trail?.waypoints?.[waypointIndex];
    if (wp) {
      expandWaypointDetail(waypointIndex, wp);
      expandedWaypointIndex = waypointIndex;
    }
  }
}

function expandWaypointDetail(waypointIndex: number, wp: Waypoint): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (!row) return;

  // Add expanded styling to the row
  row.classList.add('waypoint-expanded');
  row.setAttribute('aria-expanded', 'true');
  const chevron = row.querySelector('.expand-chevron');
  if (chevron) chevron.classList.add('expanded');

  // Determine colspan dynamically
  const headerCells = document.querySelectorAll('.waypoints-table thead th');
  const colspan = headerCells.length || 9;

  // Build detail panel HTML
  const hasDesc = !!wp.description;
  const descHtml = hasDesc
    ? `<div class="waypoint-detail-description">${autoLinkUrls(wp.description!)}</div>`
    : '';
  const coordsHtml = `<span class="waypoint-detail-coords">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} · <a href="https://www.google.com/maps?q=${wp.lat},${wp.lon}" target="_blank" rel="noopener noreferrer">Google Maps</a></span>`;

  const detailHtml = `
    <tr class="waypoint-detail-row" id="waypoint-detail-${waypointIndex}">
      <td colspan="${colspan}">
        <div class="waypoint-detail-panel${hasDesc ? '' : ' no-description'}">
          ${descHtml}
          <div class="waypoint-detail-actions">
            <a href="#" class="waypoint-show-on-map" data-waypoint-index="${waypointIndex}">Show on map</a>
            ${coordsHtml}
          </div>
          ${renderTypeEditor(`wp-${waypointIndex}`, wp)}
        </div>
      </td>
    </tr>
  `;

  row.insertAdjacentHTML('afterend', detailHtml);
}

function collapseWaypointDetail(waypointIndex: number): void {
  const row = document.getElementById(`waypoint-row-${waypointIndex}`);
  if (row) {
    row.classList.remove('waypoint-expanded');
    row.setAttribute('aria-expanded', 'false');
    const chevron = row.querySelector('.expand-chevron');
    if (chevron) chevron.classList.remove('expanded');
  }
  const detailRow = document.getElementById(`waypoint-detail-${waypointIndex}`);
  if (detailRow) {
    detailRow.remove();
  }
}

// === Variant Expansion Functions ===

function findVariantByKey(key: string, trail: Trail): RouteVariant | null {
  for (const v of trail.alternates || []) {
    const vKey = `${v.type}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (vKey === key) return v;
  }
  for (const v of trail.sideTrips || []) {
    const vKey = `${v.type}-${v.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (vKey === key) return v;
  }
  return null;
}

function toggleVariantExpansion(variantKey: string): void {
  if (expandedVariantKey === variantKey) {
    collapseVariantDetail(variantKey);
    expandedVariantKey = null;
    expandedVariantWaypointIndex = null;
  } else {
    // Collapse any expanded waypoint
    if (expandedWaypointIndex !== null) {
      collapseWaypointDetail(expandedWaypointIndex);
      expandedWaypointIndex = null;
    }
    // Collapse any previously expanded variant
    if (expandedVariantKey !== null) {
      collapseVariantDetail(expandedVariantKey);
    }
    const trail = trailState.currentTrail;
    if (!trail) return;
    const variant = findVariantByKey(variantKey, trail);
    if (variant) {
      expandVariantDetail(variantKey, variant);
      expandedVariantKey = variantKey;
      expandedVariantWaypointIndex = null;
    }
  }
}

function expandVariantDetail(variantKey: string, variant: RouteVariant): void {
  const row = document.querySelector(`tr[data-variant-key="${variantKey}"]`) as HTMLElement;
  if (!row) return;

  row.classList.add('variant-expanded');
  row.setAttribute('aria-expanded', 'true');
  const chevron = row.querySelector('.expand-chevron');
  if (chevron) chevron.classList.add('expanded');

  const headerCells = document.querySelectorAll('.waypoints-table thead th');
  const colspan = headerCells.length || 9;

  const typeClass = variant.type === 'side-trip' ? 'type-side-trip' : '';
  const wps = variant.waypoints || [];

  // Stats line
  const branchLabel = variant.type === 'alternate' ? 'Branches' : 'Starts';
  let statsHtml = `<span class="variant-stat"><strong>Distance:</strong> ${variant.distance} km</span>`;
  statsHtml += `<span class="variant-stat"><strong>Elevation:</strong> +${variant.elevation?.ascent || 0}m / -${variant.elevation?.descent || 0}m</span>`;
  if (variant.startDistance != null) {
    statsHtml += `<span class="variant-stat"><strong>${branchLabel} at:</strong> ${variant.startDistance.toFixed(1)} km</span>`;
  }
  if (variant.type === 'alternate' && variant.endDistance != null) {
    statsHtml += `<span class="variant-stat"><strong>Rejoins:</strong> ${variant.endDistance.toFixed(1)} km</span>`;
  }

  // Waypoints table
  let waypointsHtml: string;
  if (wps.length > 0) {
    const wpRows = wps.map((wp, i) => {
      const descIndicator = wp.description
        ? ' <span class="has-description-indicator" title="Has additional info"></span>'
        : '';
      return `
        <tr class="variant-waypoint-row" data-variant-key="${escapeHtml(variantKey)}" data-variant-wp-index="${i}"
            tabindex="0" role="button" aria-expanded="false">
          <td><span class="expand-chevron">&#9654;</span> ${escapeHtml(wp.name)}${descIndicator}</td>
          ${renderTypeBadge(wp.type)}
          <td class="numeric">${wp.elevation}</td>
          <td class="numeric">${wp.distance.toFixed(1)}</td>
          <td class="numeric">${wp.totalDistance.toFixed(1)}</td>
          <td class="numeric">+${wp.ascent}</td>
          <td class="numeric">-${wp.descent}</td>
        </tr>
      `;
    }).join('');

    waypointsHtml = `
      <div class="variant-waypoints">
        <h4>Waypoints on this route (${wps.length})</h4>
        <table class="variant-waypoints-table">
          <thead>
            <tr>
              <th>Location</th>
              <th>Type</th>
              <th class="numeric">Elev (m)</th>
              <th class="numeric">Dist (km)</th>
              <th class="numeric">Total (km)</th>
              <th class="numeric">Gain</th>
              <th class="numeric">Loss</th>
            </tr>
          </thead>
          <tbody>${wpRows}</tbody>
        </table>
      </div>
    `;
  } else {
    waypointsHtml = '<p class="variant-no-waypoints">No waypoints on this route</p>';
  }

  // Show on map button
  const showOnMapHtml = `<a href="#" class="variant-show-on-map" data-variant-key="${escapeHtml(variantKey)}">Show on map</a>`;

  const detailHtml = `
    <tr class="variant-detail-row" id="variant-detail-${escapeHtml(variantKey)}">
      <td colspan="${colspan}">
        <div class="variant-detail-panel ${typeClass}">
          <div class="variant-header">
            <div class="variant-headline-stats">${statsHtml}</div>
            ${showOnMapHtml}
          </div>
          ${waypointsHtml}
        </div>
      </td>
    </tr>
  `;

  row.insertAdjacentHTML('afterend', detailHtml);
}

function collapseVariantDetail(variantKey: string): void {
  const row = document.querySelector(`tr[data-variant-key="${variantKey}"].variant-expandable`) as HTMLElement;
  if (row) {
    row.classList.remove('variant-expanded');
    row.setAttribute('aria-expanded', 'false');
    const chevron = row.querySelector('.expand-chevron');
    if (chevron) chevron.classList.remove('expanded');
  }
  const detailRow = document.getElementById(`variant-detail-${variantKey}`);
  if (detailRow) detailRow.remove();
}

function toggleVariantWaypointExpansion(variantKey: string, wpIndex: number): void {
  if (expandedVariantWaypointIndex === wpIndex) {
    collapseVariantWaypointDetail(variantKey, wpIndex);
    expandedVariantWaypointIndex = null;
  } else {
    if (expandedVariantWaypointIndex !== null) {
      collapseVariantWaypointDetail(variantKey, expandedVariantWaypointIndex);
    }
    const trail = trailState.currentTrail;
    if (!trail) return;
    const variant = findVariantByKey(variantKey, trail);
    const wp = variant?.waypoints?.[wpIndex];
    if (wp) {
      expandVariantWaypointDetail(variantKey, wpIndex, wp);
      expandedVariantWaypointIndex = wpIndex;
    }
  }
}

function expandVariantWaypointDetail(variantKey: string, wpIndex: number, wp: VariantWaypoint): void {
  const row = document.querySelector(
    `tr.variant-waypoint-row[data-variant-key="${variantKey}"][data-variant-wp-index="${wpIndex}"]`
  ) as HTMLElement;
  if (!row) return;

  row.classList.add('waypoint-expanded');
  row.setAttribute('aria-expanded', 'true');
  const chevron = row.querySelector('.expand-chevron');
  if (chevron) chevron.classList.add('expanded');

  const colspan = 7; // variant waypoints table has 7 columns
  const hasDesc = !!wp.description;
  const descHtml = hasDesc
    ? `<div class="waypoint-detail-description">${autoLinkUrls(wp.description!)}</div>`
    : '';
  const coordsHtml = `<span class="waypoint-detail-coords">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} · <a href="https://www.google.com/maps?q=${wp.lat},${wp.lon}" target="_blank" rel="noopener noreferrer">Google Maps</a></span>`;

  const detailHtml = `
    <tr class="variant-wp-detail-row" id="variant-wp-detail-${escapeHtml(variantKey)}-${wpIndex}">
      <td colspan="${colspan}">
        <div class="waypoint-detail-panel${hasDesc ? '' : ' no-description'}">
          ${descHtml}
          <div class="waypoint-detail-actions">
            <a href="#" class="variant-wp-show-on-map" data-variant-key="${escapeHtml(variantKey)}" data-variant-wp-index="${wpIndex}">Show on map</a>
            ${coordsHtml}
          </div>
        </div>
      </td>
    </tr>
  `;

  row.insertAdjacentHTML('afterend', detailHtml);
}

function collapseVariantWaypointDetail(variantKey: string, wpIndex: number): void {
  const row = document.querySelector(
    `tr.variant-waypoint-row[data-variant-key="${variantKey}"][data-variant-wp-index="${wpIndex}"]`
  ) as HTMLElement;
  if (row) {
    row.classList.remove('waypoint-expanded');
    row.setAttribute('aria-expanded', 'false');
    const chevron = row.querySelector('.expand-chevron');
    if (chevron) chevron.classList.remove('expanded');
  }
  const detailRow = document.getElementById(`variant-wp-detail-${variantKey}-${wpIndex}`);
  if (detailRow) detailRow.remove();
}

// === Off-Trail Waypoint Expansion Functions ===

let expandedOffTrailIndex: number | null = null;

function toggleOffTrailExpansion(index: number): void {
  if (expandedOffTrailIndex === index) {
    collapseOffTrailDetail(index);
    expandedOffTrailIndex = null;
  } else {
    // Collapse any expanded main waypoint or variant
    if (expandedWaypointIndex !== null) {
      collapseWaypointDetail(expandedWaypointIndex);
      expandedWaypointIndex = null;
    }
    if (expandedVariantKey !== null) {
      collapseVariantDetail(expandedVariantKey);
      expandedVariantKey = null;
      expandedVariantWaypointIndex = null;
    }
    if (expandedOffTrailIndex !== null) {
      collapseOffTrailDetail(expandedOffTrailIndex);
    }
    const trail = trailState.currentTrail;
    const wp = trail?.offTrailWaypoints?.[index];
    if (wp) {
      expandOffTrailDetail(index, wp);
      expandedOffTrailIndex = index;
    }
  }
}

function expandOffTrailDetail(index: number, wp: OffTrailWaypoint): void {
  const row = document.getElementById(`off-trail-row-${index}`);
  if (!row) return;

  row.classList.add('waypoint-expanded');
  row.setAttribute('aria-expanded', 'true');
  const chevron = row.querySelector('.expand-chevron');
  if (chevron) chevron.classList.add('expanded');

  const headerCells = document.querySelectorAll('.waypoints-table thead th');
  const colspan = headerCells.length || 9;

  const hasDesc = !!wp.description;
  const descHtml = hasDesc
    ? `<div class="waypoint-detail-description">${autoLinkUrls(wp.description!)}</div>`
    : '';
  const coordsHtml = `<span class="waypoint-detail-coords">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)} · <a href="https://www.google.com/maps?q=${wp.lat},${wp.lon}" target="_blank" rel="noopener noreferrer">Google Maps</a></span>`;

  const detailHtml = `
    <tr class="waypoint-detail-row" id="off-trail-detail-${index}">
      <td colspan="${colspan}">
        <div class="waypoint-detail-panel${hasDesc ? '' : ' no-description'}">
          ${descHtml}
          <div class="waypoint-detail-actions">
            <a href="#" class="off-trail-show-on-map" data-off-trail-index="${index}">Show on map</a>
            ${coordsHtml}
          </div>
          ${renderTypeEditor(`off-${index}`, wp)}
        </div>
      </td>
    </tr>
  `;

  row.insertAdjacentHTML('afterend', detailHtml);
}

function collapseOffTrailDetail(index: number): void {
  const row = document.getElementById(`off-trail-row-${index}`);
  if (row) {
    row.classList.remove('waypoint-expanded');
    row.setAttribute('aria-expanded', 'false');
    const chevron = row.querySelector('.expand-chevron');
    if (chevron) chevron.classList.remove('expanded');
  }
  const detailRow = document.getElementById(`off-trail-detail-${index}`);
  if (detailRow) detailRow.remove();
}

function handleOffTrailShowOnMap(index: number): void {
  if (!map) return;
  const trail = trailState.currentTrail;
  const wp = trail?.offTrailWaypoints?.[index];
  if (!wp) return;

  document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const targetZoom = Math.max(map.getZoom(), 14);
  map.setView([wp.lat, wp.lon], targetZoom);
}

function handleVariantShowOnMap(variantKey: string): void {
  if (!map) return;
  const trail = trailState.currentTrail;
  if (!trail) return;
  const variant = findVariantByKey(variantKey, trail);
  if (!variant?.points || variant.points.length === 0) return;

  document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const bounds = L.latLngBounds(variant.points.map(p => [p.lat, p.lon] as [number, number]));
  map.fitBounds(bounds, { padding: [40, 40] });
}

function handleVariantWaypointShowOnMap(variantKey: string, wpIndex: number): void {
  if (!map) return;
  const trail = trailState.currentTrail;
  if (!trail) return;
  const variant = findVariantByKey(variantKey, trail);
  const wp = variant?.waypoints?.[wpIndex];
  if (!wp) return;

  document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const targetZoom = Math.max(map.getZoom(), 14);
  map.setView([wp.lat, wp.lon], targetZoom);
}

function setupElevationHover(): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const profileDiv = document.querySelector('.elevation-profile') as HTMLElement;

  const hoverLine = document.createElement('div');
  hoverLine.className = 'hover-line';
  profileDiv.appendChild(hoverLine);

  const tooltip = document.createElement('div');
  tooltip.className = 'hover-tooltip';
  profileDiv.appendChild(tooltip);

  canvas.addEventListener('mousemove', (e) => {
    if (!trackPoints.length || !map) return;

    const rect = canvas.getBoundingClientRect();
    const padding = chartPadding;
    const width = rect.width - padding.left - padding.right;

    const x = e.clientX - rect.left - padding.left;
    if (x < 0 || x > width) {
      hideElevationHover();
      if (map.hasLayer(hoverMarker!)) map.removeLayer(hoverMarker!);
      return;
    }

    const distance = (x / width) * maxDistance;

    const nearestIndex = findNearestByDistance(trackPoints, distance);
    const nearestPoint = trackPoints[nearestIndex];

    if (nearestPoint) {
      hoverMarker!.setLatLng([nearestPoint.lat, nearestPoint.lon]);
      if (!map.hasLayer(hoverMarker!)) {
        hoverMarker!.addTo(map);
      }
      showElevationHover(nearestPoint.dist, nearestPoint.ele);
    }
  });

  canvas.addEventListener('mouseleave', () => {
    if (map && map.hasLayer(hoverMarker!)) {
      map.removeLayer(hoverMarker!);
    }
    hideElevationHover();
  });

  canvas.addEventListener('click', (e) => {
    if (!trackPoints.length || !map) return;

    const rect = canvas.getBoundingClientRect();
    const padding = chartPadding;
    const width = rect.width - padding.left - padding.right;

    const x = e.clientX - rect.left - padding.left;
    if (x < 0 || x > width) return;

    const distance = (x / width) * maxDistance;
    const nearestIndex = findNearestByDistance(trackPoints, distance);
    const nearestPoint = trackPoints[nearestIndex];

    if (nearestPoint) {
      hoverMarker!.setLatLng([nearestPoint.lat, nearestPoint.lon]);
      if (!map.hasLayer(hoverMarker!)) {
        hoverMarker!.addTo(map);
      }

      document.getElementById('trail-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const targetZoom = Math.max(map.getZoom(), 14);
      map.setView([nearestPoint.lat, nearestPoint.lon], targetZoom);
    }
  });

  canvas.style.cursor = 'pointer';
}

async function loadTrailData(trailId: string): Promise<Trail | null> {
  try {
    const response = await fetch(`/data/generated/${trailId}.json`);
    if (!response.ok) throw new Error('Trail data not found');
    return await response.json();
  } catch (error) {
    console.error('Failed to load trail data:', error);
    return null;
  }
}

function updateStats(trail: Trail): void {
  document.getElementById('distance')!.textContent = trail.track.totalDistance.toFixed(1);
  document.getElementById('ascent')!.textContent = Math.round(trail.track.totalAscent).toString();
  document.getElementById('descent')!.textContent = Math.round(trail.track.totalDescent).toString();
  document.getElementById('points')!.textContent = trail.track.points.length.toLocaleString();
}

function drawElevationProfile(points: TrackPoint[]): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const rect = canvas.getBoundingClientRect();

  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  if (points.length === 0) return;

  const elevations = points.map(p => p.ele);
  const distances = points.map(p => p.dist);
  const { min: minEle, max: maxEle } = getMinMax(elevations);
  const { max: maxDist } = getMinMax(distances);

  const eleTicks = niceAxisTicks(minEle, maxEle, 4);
  const distTicks = niceAxisTicks(0, maxDist, 5);

  // Measure the widest elevation label to size left padding
  ctx.font = '12px system-ui, sans-serif';
  let maxLabelWidth = 0;
  for (const tick of eleTicks) {
    const w = ctx.measureText(`${Math.round(tick)}m`).width;
    if (w > maxLabelWidth) maxLabelWidth = w;
  }

  chartPadding = { top: 20, right: 20, bottom: 30, left: maxLabelWidth + 15 };
  const padding = chartPadding;
  const width = rect.width - padding.left - padding.right;
  const height = rect.height - padding.top - padding.bottom;

  // Expand elevation range to encompass the tick boundaries
  const eleMin = eleTicks.length > 0 ? Math.min(minEle, eleTicks[0]) : minEle;
  const eleMax = eleTicks.length > 0 ? Math.max(maxEle, eleTicks[eleTicks.length - 1]) : maxEle;
  const eleRange = eleMax - eleMin || 1;

  const axisColor = themeColor('--chart-text', '#666');
  const gridColor = themeColor('--chart-grid', '#ddd');
  const gridSoftColor = themeColor('--chart-grid-soft', '#eee');

  // Draw elevation (Y) axis grid lines and labels
  ctx.fillStyle = axisColor;
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of eleTicks) {
    const y = padding.top + height - ((tick - eleMin) / eleRange) * height;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + width, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)}m`, padding.left - 5, y);
  }

  // Draw distance (X) axis grid lines and labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const tick of distTicks) {
    const x = padding.left + (tick / maxDist) * width;
    ctx.strokeStyle = gridSoftColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + height);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)} km`, x, padding.top + height + 5);
  }

  // Draw elevation profile line
  ctx.beginPath();
  ctx.strokeStyle = themeColor('--chart-line', '#2196F3');
  ctx.lineWidth = 2;

  points.forEach((point, i) => {
    const x = padding.left + (point.dist / maxDist) * width;
    const y = padding.top + height - ((point.ele - eleMin) / eleRange) * height;

    if (i === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });
  ctx.stroke();

  // Fill area under the curve
  ctx.lineTo(padding.left + width, padding.top + height);
  ctx.lineTo(padding.left, padding.top + height);
  ctx.closePath();
  ctx.fillStyle = themeColor('--chart-fill', 'rgba(33, 150, 243, 0.1)');
  ctx.fill();
}

function renderWaypoints(waypoints: Waypoint[] | undefined, alternates: RouteVariant[] | undefined, sideTrips: RouteVariant[] | undefined, offTrailWaypoints?: OffTrailWaypoint[]): void {
  const container = document.getElementById('waypoints-container')!;

  if ((!waypoints || waypoints.length === 0) && (!offTrailWaypoints || offTrailWaypoints.length === 0)) {
    container.innerHTML = '<p>No waypoints defined</p>';
    updateFilterChrome(0, 0, null);
    return;
  }

  const filter = waypointFilter;
  const isFiltered = filter !== 'all';

  // Row highlighting is type-driven, like the filter (see `getRowClass` at
  // module scope). It used to be a keyword scan of the name and description
  // ('grocer', 'iga', 'coles', …), which meant three different notions of
  // "resupply" in one file; the shared taxonomy is the single one.

  interface TableRow {
    rowType: 'waypoint' | 'variant-start' | 'variant-end';
    distance: number;
    data: Waypoint | RouteVariant;
    waypointIndex?: number;
    leg?: WaypointLeg;
  }

  const allVariants = [...(alternates || []), ...(sideTrips || [])];
  const tableRows: TableRow[] = [];

  // The legs are computed over the filtered set, so a filtered "Leg (km)" is the
  // gap from the previous *visible* row rather than from the previous waypoint
  // in the unfiltered list.
  const legs = computeWaypointLegs(waypoints || [], filter);
  for (const leg of legs) {
    tableRows.push({
      rowType: 'waypoint',
      distance: leg.wp.totalDistance ?? 0,
      data: leg.wp,
      waypointIndex: leg.waypointIndex,
      leg,
    });
  }

  // Route-variant markers are navigational furniture — "this alternate branches
  // here" — not places you can get water or food, so a family filter drops them
  // rather than leaving rows in the table that answer neither question and break
  // up the leg reading.
  if (!isFiltered) {
    for (const variant of allVariants) {
      if (variant.startDistance != null) {
        tableRows.push({
          rowType: 'variant-start',
          distance: variant.startDistance,
          data: variant
        });
      }
      if (variant.type === 'alternate' && variant.endDistance != null) {
        tableRows.push({
          rowType: 'variant-end',
          distance: variant.endDistance,
          data: variant
        });
      }
    }
  }

  tableRows.sort((a, b) => a.distance - b.distance);

  const numeric = (value: number | null | undefined, digits = 0): string =>
    value == null ? '—' : value.toFixed(digits);

  function renderWaypointRow(wp: Waypoint, waypointIndex: number, leg: WaypointLeg): string {
    const descIndicator = wp.description
      ? ' <span class="has-description-indicator" title="Has additional info"></span>'
      : '';
    return `
      <tr class="${getRowClass(wp)}"
          id="waypoint-row-${waypointIndex}"
          data-waypoint-index="${waypointIndex}"
          tabindex="0"
          role="button"
          aria-expanded="false"
          aria-controls="waypoint-detail-${waypointIndex}">
        <td><span class="expand-chevron">&#9654;</span> ${escapeHtml(wp.name || 'Unnamed')}${descIndicator}</td>
        ${renderTypeBadge(wp.type)}
        <td class="numeric">${wp.elevation ?? '-'}</td>
        <td class="numeric">${isFiltered ? numeric(leg.legKm, 1) : (wp.distance?.toFixed(1) ?? '-')}</td>
        <td class="numeric">${wp.totalDistance?.toFixed(1) ?? '-'}</td>
        <td class="numeric">${isFiltered ? numeric(leg.legAscent) : (wp.ascent ?? '-')}</td>
        <td class="numeric">${isFiltered ? numeric(leg.legDescent) : (wp.descent ?? '-')}</td>
        <td class="numeric">${wp.totalAscent ?? '-'}</td>
        <td class="numeric">${wp.totalDescent ?? '-'}</td>
      </tr>
    `;
  }

  function makeVariantKey(variant: RouteVariant): string {
    return `${variant.type}-${variant.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  function renderVariantRow(variant: RouteVariant, isStart: boolean): string {
    const typeClass = variant.type === 'alternate' ? 'type-alternate' : 'type-side-trip';
    const typeLabel = variant.type === 'alternate' ? 'Alternate' : 'Side Trip';
    const actionLabel = isStart
      ? (variant.type === 'alternate' ? 'branches' : 'starts')
      : 'rejoins';
    const distance = isStart ? variant.startDistance : variant.endDistance;

    const variantKey = makeVariantKey(variant);
    const hasWaypoints = (variant.waypoints?.length ?? 0) > 0;
    const isExpandable = isStart;
    const expandableAttrs = isExpandable
      ? `data-variant-key="${escapeHtml(variantKey)}" tabindex="0" role="button" aria-expanded="false"`
      : '';
    const expandableClass = isExpandable ? ' variant-expandable' : '';
    const chevronHtml = isExpandable ? '<span class="expand-chevron">&#9654;</span> ' : '';
    const waypointDot = isExpandable && hasWaypoints
      ? ` <span class="has-waypoints-indicator" title="Has waypoints"></span>`
      : '';

    return `
      <tr class="variant-row ${typeClass}${expandableClass}" ${expandableAttrs}>
        <td colspan="2">
          <span class="variant-marker ${typeClass}">
            ${chevronHtml}<span class="variant-icon">${isStart ? '\u2197' : '\u2198'}</span>
            <strong>${escapeHtml(variant.name)}</strong>${waypointDot}
            <span class="variant-action">${actionLabel} here</span>
          </span>
        </td>
        <td colspan="3" class="variant-stats-cell">
          <span class="variant-inline-stats">
            ${variant.distance} km \u00B7 +${variant.elevation?.ascent || 0}m / -${variant.elevation?.descent || 0}m
          </span>
        </td>
        <td class="numeric">${distance?.toFixed(1) ?? '-'}</td>
        <td colspan="3">
          <span class="variant-type-badge ${typeClass}">${typeLabel}</span>
        </td>
      </tr>
    `;
  }

  // Off-trail waypoints, unlike variant markers, are real places: a water source
  // 200 m off the trail is exactly what the water filter is for. So they stay,
  // filtered to the family. Their leg cells are already em dashes — an off-trail
  // point has no position along the track, so no honest leg can be derived.
  const allOffTrail = offTrailWaypoints || [];
  const offTrail = isFiltered
    ? allOffTrail
        .map((wp, index) => ({ wp, index }))
        .filter(({ wp }) => matchesWaypointFamily(wp.type, filter))
    : allOffTrail.map((wp, index) => ({ wp, index }));

  function renderOffTrailRow(wp: OffTrailWaypoint, index: number): string {
    const descIndicator = wp.description
      ? ' <span class="has-description-indicator" title="Has additional info"></span>'
      : '';
    const distLabel = wp.distanceFromTrail >= 1000
      ? `${(wp.distanceFromTrail / 1000).toFixed(1)} km`
      : `${wp.distanceFromTrail}m`;
    return `
      <tr class="off-trail-row"
          id="off-trail-row-${index}"
          data-off-trail-index="${index}"
          tabindex="0"
          role="button"
          aria-expanded="false">
        <td><span class="expand-chevron">&#9654;</span> ${escapeHtml(wp.name || 'Unnamed')}${descIndicator}</td>
        ${renderTypeBadge(wp.type)}
        <td class="numeric">-</td>
        <td class="numeric off-trail-distance">${distLabel} off-trail</td>
        <td class="numeric">-</td>
        <td class="numeric">-</td>
        <td class="numeric">-</td>
        <td class="numeric">-</td>
        <td class="numeric">-</td>
      </tr>
    `;
  }

  const offTrailSection = offTrail.length > 0 ? `
    <tr class="off-trail-header-row">
      <td colspan="9"><strong>Off-trail waypoints</strong> <span class="off-trail-count">(${offTrail.length})</span></td>
    </tr>
    ${offTrail.map(({ wp, index }) => renderOffTrailRow(wp, index)).join('')}
  ` : '';

  // Retitled under a filter so nobody reads a between-visible-rows gap as the
  // per-waypoint leg it is not.
  const legHeader = isFiltered ? 'Leg (km)' : 'Dist (km)';
  const gainHeader = isFiltered ? 'Leg Gain (m)' : 'Gain (m)';
  const lossHeader = isFiltered ? 'Leg Loss (m)' : 'Loss (m)';

  const emptyRow = tableRows.length === 0 && offTrail.length === 0
    ? `<tr class="waypoints-empty-row"><td colspan="9">No ${escapeHtml(FILTER_LABELS[filter])} waypoints on this trail.</td></tr>`
    : '';

  const tableHtml = `
    <table class="waypoints-table">
      <thead>
        <tr>
          <th>Location</th>
          <th>Type</th>
          <th>Elev (m)</th>
          <th>${legHeader}</th>
          <th>Total (km)</th>
          <th>${gainHeader}</th>
          <th>${lossHeader}</th>
          <th>Total Gain</th>
          <th>Total Loss</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows.map(row => {
          if (row.rowType === 'waypoint') {
            return renderWaypointRow(row.data as Waypoint, row.waypointIndex!, row.leg!);
          } else if (row.rowType === 'variant-start') {
            return renderVariantRow(row.data as RouteVariant, true);
          } else {
            return renderVariantRow(row.data as RouteVariant, false);
          }
        }).join('')}
        ${offTrailSection}
        ${emptyRow}
      </tbody>
    </table>
  `;

  container.innerHTML = tableHtml;

  updateFilterChrome(
    legs.length,
    (waypoints || []).length,
    // Read the length off the trail rather than the module's `maxDistance`,
    // which the chart sets later in the boot sequence and is still 0 on the
    // first render.
    isFiltered
      ? summariseLegs(legs, filter, trailState.currentTrail?.track.totalDistance ?? 0)
      : null,
  );
}

/**
 * Keep the filter bar's own chrome in step with the rendered table: pressed
 * state, the "23 of 187 waypoints" count, the leg summary and the CSV button
 * label. Called from `renderWaypoints` so the direction toggle refreshes it too.
 */
function updateFilterChrome(visible: number, total: number, summary: string | null): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#waypoint-filter [data-filter]')) {
    btn.setAttribute('aria-pressed', btn.dataset.filter === waypointFilter ? 'true' : 'false');
  }

  const count = document.getElementById('waypoint-filter-count');
  if (count) {
    count.textContent = waypointFilter === 'all'
      ? `${total} waypoint${total === 1 ? '' : 's'}`
      : `${visible} of ${total} waypoints`;
  }

  const summaryEl = document.getElementById('waypoint-filter-summary');
  if (summaryEl) {
    summaryEl.textContent = summary ?? '';
    summaryEl.hidden = summary == null;
  }

  const csvBtn = document.getElementById('export-csv-btn');
  if (csvBtn) {
    csvBtn.textContent = waypointFilter === 'all'
      ? 'Download CSV'
      : `Download CSV (${FILTER_LABELS[waypointFilter]})`;
  }
}

/** Switch the datasheet filter and re-render the table around it. */
function setWaypointFilter(next: WaypointFilter): void {
  if (next === waypointFilter) return;
  waypointFilter = next;

  // Any open detail row belongs to the old table; the re-render drops the
  // markup, so the "what is expanded" state has to be dropped with it.
  expandedWaypointIndex = null;
  expandedVariantKey = null;
  expandedVariantWaypointIndex = null;
  expandedOffTrailIndex = null;

  const trail = trailState.currentTrail;
  if (!trail) return;
  renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips, trail.offTrailWaypoints);
}

/**
 * Quote a value for one CSV field: wrap in double quotes and double any inner
 * quote (RFC 4180). Every free-text column must go through this — waypoint
 * `type` is an editable, arbitrary string on imported trails, so an unquoted
 * comma in it would shift every later column in the row.
 */
function csvQuote(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function exportDatasheet(trail: Trail): void {
  const { config, track, waypoints, alternates, sideTrips } = trail;

  // The CSV is what is on screen: same filter, same recomputed leg column.
  const filter = waypointFilter;
  const isFiltered = filter !== 'all';
  const legs = computeWaypointLegs(waypoints || [], filter);

  const lines: string[] = [];

  lines.push(`# ${config.name} - Trail Datasheet`);
  lines.push(`# Region: ${config.region}`);
  lines.push(`# Total Distance: ${track.totalDistance.toFixed(1)} km`);
  lines.push(`# Total Ascent: ${Math.round(track.totalAscent)} m`);
  lines.push(`# Total Descent: ${Math.round(track.totalDescent)} m`);
  lines.push(`# Generated: ${new Date().toISOString().split('T')[0]}`);
  if (isFiltered) {
    lines.push(`# View: ${FILTER_LABELS[filter]} only (${legs.length} of ${(waypoints || []).length} waypoints)`);
    lines.push(`# ${summariseLegs(legs, filter, track.totalDistance)}`);
    lines.push('# Leg columns are measured from the previous row in this file, not from the previous waypoint on the trail.');
  }
  lines.push('');

  lines.push(isFiltered
    ? 'Location,Type,Elevation (m),Leg (km),Total (km),Leg Gain (m),Leg Loss (m),Total Gain (m),Total Loss (m),Notes'
    : 'Location,Type,Elevation (m),Distance (km),Total (km),Gain (m),Loss (m),Total Gain (m),Total Loss (m),Notes');

  for (const leg of legs) {
    const wp = leg.wp;
    const row = [
      `"${(wp.name || 'Unnamed').replace(/"/g, '""')}"`,
      csvQuote(wp.type || 'waypoint'),
      wp.elevation ?? '',
      leg.legKm?.toFixed(1) ?? '',
      wp.totalDistance?.toFixed(1) ?? '',
      isFiltered ? (leg.legAscent?.toFixed(0) ?? '') : (wp.ascent ?? ''),
      isFiltered ? (leg.legDescent?.toFixed(0) ?? '') : (wp.descent ?? ''),
      wp.totalAscent ?? '',
      wp.totalDescent ?? '',
      `"${(wp.description || '').replace(/"/g, '""')}"`
    ];
    lines.push(row.join(','));
  }

  // Alternates and side trips are hidden from the table under a filter, so the
  // export leaves them out too — it exports the view, not the trail.
  if (!isFiltered && alternates && alternates.length > 0) {
    lines.push('');
    lines.push('# Alternate Routes');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km),End Distance (km)');
    for (const alt of alternates) {
      const row = [
        `"${(alt.name || 'Unnamed').replace(/"/g, '""')}"`,
        csvQuote(alt.type || 'alternate'),
        alt.distance ?? '',
        alt.elevation?.ascent ?? '',
        alt.elevation?.descent ?? '',
        alt.startDistance?.toFixed(1) ?? '',
        alt.endDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  if (!isFiltered && sideTrips && sideTrips.length > 0) {
    lines.push('');
    lines.push('# Side Trips');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km)');
    for (const trip of sideTrips) {
      const row = [
        `"${(trip.name || 'Unnamed').replace(/"/g, '""')}"`,
        csvQuote(trip.type || 'side-trip'),
        trip.distance ?? '',
        trip.elevation?.ascent ?? '',
        trip.elevation?.descent ?? '',
        trip.startDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  // Off-trail waypoints stay visible under a filter (a spring 200 m off-trail is
  // a real water source), so they stay in the export — filtered to the family.
  const offTrail = (trail.offTrailWaypoints || []).filter(
    wp => !isFiltered || matchesWaypointFamily(wp.type, filter),
  );
  if (offTrail.length > 0) {
    lines.push('');
    lines.push('# Off-Trail Waypoints');
    lines.push('Name,Type,Distance From Trail (m),Notes');
    for (const wp of offTrail) {
      const row = [
        `"${(wp.name || 'Unnamed').replace(/"/g, '""')}"`,
        csvQuote(wp.type || 'waypoint'),
        wp.distanceFromTrail,
        `"${(wp.description || '').replace(/"/g, '""')}"`
      ];
      lines.push(row.join(','));
    }
  }

  const csvContent = lines.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = isFiltered
    ? `${exportBaseName(config)}-datasheet-${filter}.csv`
    : `${exportBaseName(config)}-datasheet.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Filename stem for the CSV/GPX exports.
 *
 * Bundled trails keep their stable trail id (`heysen-datasheet.csv`). An
 * imported trail's id is an opaque content hash (`u_1a2b3c…`), which makes a
 * useless filename, so its user-visible name is slugified instead.
 */
function exportBaseName(config: { id: string; name?: string }): string {
  if (config.id && !config.id.startsWith('u_')) return config.id;
  const slug = String(config.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || config.id || 'trail';
}

function escapeXml(text: unknown): string {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function exportGpx(trail: Trail): void {
  const { config, track, waypoints } = trail;

  const gpxLines: string[] = [];
  gpxLines.push('<?xml version="1.0" encoding="UTF-8"?>');
  gpxLines.push('<gpx version="1.1" creator="GPX Tools" xmlns="http://www.topografix.com/GPX/1/1">');
  gpxLines.push(`  <metadata>`);
  gpxLines.push(`    <name>${escapeXml(config.name)}</name>`);
  gpxLines.push(`    <desc>${escapeXml(config.region)} - ${track.totalDistance.toFixed(1)} km</desc>`);
  gpxLines.push(`  </metadata>`);

  for (const wp of waypoints || []) {
    gpxLines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">`);
    if (wp.elevation != null) gpxLines.push(`    <ele>${wp.elevation}</ele>`);
    gpxLines.push(`    <name>${escapeXml(wp.name || 'Waypoint')}</name>`);
    if (wp.type) gpxLines.push(`    <type>${escapeXml(wp.type)}</type>`);
    if (wp.description) gpxLines.push(`    <desc>${escapeXml(wp.description)}</desc>`);
    gpxLines.push(`  </wpt>`);
  }

  for (const wp of trail.offTrailWaypoints || []) {
    gpxLines.push(`  <wpt lat="${wp.lat}" lon="${wp.lon}">`);
    gpxLines.push(`    <name>${escapeXml(wp.name || 'Waypoint')}</name>`);
    if (wp.type) gpxLines.push(`    <type>${escapeXml(wp.type)}</type>`);
    if (wp.description) gpxLines.push(`    <desc>${escapeXml(wp.description)}</desc>`);
    gpxLines.push(`  </wpt>`);
  }

  gpxLines.push(`  <trk>`);
  gpxLines.push(`    <name>${escapeXml(config.name)}</name>`);
  gpxLines.push(`    <trkseg>`);
  for (const pt of track.points || []) {
    gpxLines.push(`      <trkpt lat="${pt.lat}" lon="${pt.lon}">`);
    if (pt.ele != null) gpxLines.push(`        <ele>${pt.ele}</ele>`);
    gpxLines.push(`      </trkpt>`);
  }
  gpxLines.push(`    </trkseg>`);
  gpxLines.push(`  </trk>`);

  gpxLines.push('</gpx>');

  const gpxContent = gpxLines.join('\n');
  const blob = new Blob([gpxContent], { type: 'application/gpx+xml;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${exportBaseName(config)}.gpx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// === Direction Reversal ===
//
// Track/waypoint/variant reversal is shared with the plan viewer and the
// mobile app via @lib/trail-reverse (which reuses @lib/variant-reverse for
// the variant math). Unlike the old inline copy, the lib leaves
// displayPoints undefined when the source track has none; every consumer
// reads `displayPoints || points`, so the behaviour is identical.

function getReversedTrail(): Trail {
  if (!trailState.reversedTrail) {
    trailState.reversedTrail = createReversedTrail(trailState.originalTrail!);
  }
  return trailState.reversedTrail;
}

function refreshDisplay(trail: Trail): void {
  expandedWaypointIndex = null;
  expandedVariantKey = null;
  expandedVariantWaypointIndex = null;
  expandedOffTrailIndex = null;
  trackPoints = trail.track.points;
  displayPoints = trail.track.displayPoints || trail.track.points;
  maxDistance = trail.track.totalDistance;

  updateStats(trail);
  drawElevationProfile(trail.track.points);
  renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips, trail.offTrailWaypoints);

  // Update waypoint markers
  waypointMarkers.forEach(({ marker }) => {
    if (map && map.hasLayer(marker)) {
      map.removeLayer(marker);
    }
  });
  drawWaypointMarkers(trail.waypoints || []);
  drawOffTrailWaypointMarkers(trail.offTrailWaypoints || []);

  // Update main route polyline
  if (map && mainRoutePolyline) {
    const latLngs = displayPoints.map(p => [p.lat, p.lon] as [number, number]);
    mainRoutePolyline.setLatLngs(latLngs);
  }
}

function getDirectionLabel(isReversed: boolean): string {
  return directionLabelFor(
    trailState.originalTrail?.config.direction,
    isReversed ? 'SOBO' : 'NOBO',
    { default: 'Start → End', reversed: 'End → Start' },
  );
}

function saveDirectionPreference(trailId: string, isReversed: boolean): void {
  try {
    const prefs = JSON.parse(localStorage.getItem('trailDirectionPrefs') || '{}');
    prefs[trailId] = isReversed;
    localStorage.setItem('trailDirectionPrefs', JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Forget one trail's direction preference.
 *
 * Needed only for imported trails, and needed *because* their ids are a content
 * hash of the source file: delete a trail and re-import the same GPX and you
 * land on the same id, so a preference left behind here would silently come
 * back attached to what the user thinks is a fresh trail. Bundled trails keep
 * theirs forever, which is the intended behaviour for them.
 */
export function clearDirectionPreference(trailId: string): void {
  try {
    const prefs = JSON.parse(localStorage.getItem('trailDirectionPrefs') || '{}');
    delete prefs[trailId];
    localStorage.setItem('trailDirectionPrefs', JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable
  }
}

function loadDirectionPreference(trailId: string): boolean {
  try {
    const prefs = JSON.parse(localStorage.getItem('trailDirectionPrefs') || '{}');
    return prefs[trailId] === true;
  } catch {
    return false;
  }
}

function updateDirectionUI(isReversed: boolean): void {
  const btn = document.getElementById('reverse-direction-btn');
  const label = document.getElementById('direction-label');

  if (btn) btn.setAttribute('aria-pressed', isReversed ? 'true' : 'false');
  if (label) label.textContent = getDirectionLabel(isReversed);
}

function toggleDirection(): void {
  const loading = document.getElementById('direction-loading');
  const originalTrail = trailState.originalTrail;
  if (!originalTrail) return;

  // Show loading indicator if we need to compute reversed trail
  if (!trailState.reversedTrail && !trailState.isReversed && loading) {
    loading.hidden = false;
  }

  // Use requestAnimationFrame to ensure loading indicator renders before heavy computation
  requestAnimationFrame(() => {
    trailState.isReversed = !trailState.isReversed;

    const trail = trailState.isReversed ? getReversedTrail() : originalTrail;

    refreshDisplay(trail);
    updateDirectionUI(trailState.isReversed);
    saveDirectionPreference(originalTrail.config.id, trailState.isReversed);

    if (loading) loading.hidden = true;
  });
}

/**
 * Boot the trail page.
 *
 * @param trailId  The id everything persisted per-trail is keyed by (direction
 *   preference, plan state on the plan page).
 * @param preloadedTrail  An already-loaded trail — passed by the imported-trail
 *   page (`my-trail.html`), which reads from IndexedDB instead of
 *   `/data/generated/{id}.json`. When omitted the trail is fetched as before.
 * @param options  Opt-in capabilities. Omitted by every bundled trail page, so
 *   those pages render exactly as they always have.
 */
export async function initTrailViewer(
  trailId: string,
  preloadedTrail?: Trail,
  options?: TrailViewerOptions,
): Promise<void> {
  viewerOptions = options ?? {};
  const trail = preloadedTrail ?? await loadTrailData(trailId);
  if (!trail) {
    const panel = document.querySelector('.panel');
    if (panel) panel.innerHTML = '<p>Failed to load trail data.</p>';
    return;
  }

  // The direction preference is written under `config.id` but read under
  // `trailId`; normalise so the two can never diverge for a preloaded trail.
  if (trail.config.id !== trailId) {
    trail.config.id = trailId;
  }

  trailState.originalTrail = trail;

  // Load saved direction preference
  const savedReversed = loadDirectionPreference(trailId);
  if (savedReversed) {
    trailState.isReversed = true;
    const reversedTrail = getReversedTrail();
    updateStats(reversedTrail);
    initMap(reversedTrail);
    drawElevationProfile(reversedTrail.track.points);
    setupElevationHover();
    renderWaypoints(reversedTrail.waypoints, reversedTrail.alternates, reversedTrail.sideTrips, reversedTrail.offTrailWaypoints);
  } else {
    updateStats(trail);
    initMap(trail);
    drawElevationProfile(trail.track.points);
    setupElevationHover();
    renderWaypoints(trail.waypoints, trail.alternates, trail.sideTrips, trail.offTrailWaypoints);
  }

  // Set initial direction label from config
  updateDirectionUI(trailState.isReversed);

  // Delegate from the container, not the tbody.
  //
  // The table is re-rendered wholesale (`container.innerHTML = …`) by the
  // direction toggle and now by the filter, so a listener bound to the tbody is
  // thrown away with the first re-render and every row silently stops
  // expanding. `#waypoints-container` is in the page markup and outlives them.
  const waypointsContainer = document.getElementById('waypoints-container');

  waypointsContainer?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Handle "Show on map" link clicks in waypoint detail panels
    if (target.classList.contains('waypoint-show-on-map')) {
      e.preventDefault();
      handleTableRowClick(parseInt(target.dataset.waypointIndex!, 10));
      return;
    }

    // Handle off-trail waypoint "Show on map" link clicks
    if (target.classList.contains('off-trail-show-on-map')) {
      e.preventDefault();
      handleOffTrailShowOnMap(parseInt(target.dataset.offTrailIndex!, 10));
      return;
    }

    // Handle variant "Show on map" link clicks
    if (target.classList.contains('variant-show-on-map')) {
      e.preventDefault();
      handleVariantShowOnMap(target.dataset.variantKey!);
      return;
    }

    // Handle variant waypoint "Show on map" link clicks
    if (target.classList.contains('variant-wp-show-on-map')) {
      e.preventDefault();
      handleVariantWaypointShowOnMap(target.dataset.variantKey!, parseInt(target.dataset.variantWpIndex!, 10));
      return;
    }

    // Handle variant waypoint row clicks (nested inside variant detail)
    const variantWpRow = target.closest('tr.variant-waypoint-row') as HTMLElement;
    if (variantWpRow) {
      toggleVariantWaypointExpansion(variantWpRow.dataset.variantKey!, parseInt(variantWpRow.dataset.variantWpIndex!, 10));
      return;
    }

    // Handle variant row clicks for expand/collapse
    const variantRow = target.closest('tr.variant-expandable') as HTMLElement;
    if (variantRow) {
      toggleVariantExpansion(variantRow.dataset.variantKey!);
      return;
    }

    // Handle off-trail waypoint row clicks for expand/collapse
    const offTrailRow = target.closest('tr[data-off-trail-index]') as HTMLElement;
    if (offTrailRow) {
      toggleOffTrailExpansion(parseInt(offTrailRow.dataset.offTrailIndex!, 10));
      return;
    }

    // Handle waypoint row clicks for expand/collapse
    const row = target.closest('tr[data-waypoint-index]');
    if (row) {
      toggleWaypointExpansion(parseInt((row as HTMLElement).dataset.waypointIndex!, 10));
    }
  });

  // The category editor. Delegated like everything else in this table, because
  // the detail panel carrying the <select> is created and destroyed on every
  // expand/collapse and on every re-render.
  waypointsContainer?.addEventListener('change', (e) => {
    const select = (e.target as HTMLElement).closest<HTMLSelectElement>('select.waypoint-type-select');
    if (select) void handleWaypointTypeChange(select);
  });

  // Keyboard accessibility for waypoint and variant rows
  waypointsContainer?.addEventListener('keydown', (e: Event) => {
    const keyEvent = e as KeyboardEvent;
    if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
      const target = e.target as HTMLElement;

      // Variant waypoint rows
      const variantWpRow = target.closest('tr.variant-waypoint-row') as HTMLElement;
      if (variantWpRow) {
        e.preventDefault();
        toggleVariantWaypointExpansion(variantWpRow.dataset.variantKey!, parseInt(variantWpRow.dataset.variantWpIndex!, 10));
        return;
      }

      // Variant expandable rows
      const variantRow = target.closest('tr.variant-expandable') as HTMLElement;
      if (variantRow) {
        e.preventDefault();
        toggleVariantExpansion(variantRow.dataset.variantKey!);
        return;
      }

      // Off-trail waypoint rows
      const offTrailRow = target.closest('tr[data-off-trail-index]') as HTMLElement;
      if (offTrailRow) {
        e.preventDefault();
        toggleOffTrailExpansion(parseInt(offTrailRow.dataset.offTrailIndex!, 10));
        return;
      }

      // Main waypoint rows
      const row = target.closest('tr[data-waypoint-index]');
      if (row) {
        e.preventDefault();
        toggleWaypointExpansion(parseInt((row as HTMLElement).dataset.waypointIndex!, 10));
      }
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('popup-show-in-table')) {
      e.preventDefault();
      scrollToTableRow(parseInt(target.dataset.waypointIndex!, 10));
    }
  });

  document.getElementById('reverse-direction-btn')?.addEventListener('click', toggleDirection);

  // Datasheet filter. Delegated from the group so the three buttons need no
  // individual wiring, and keyboard use comes free — they are real <button>s.
  document.getElementById('waypoint-filter')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]');
    const next = btn?.dataset.filter;
    if (next === 'all' || next === 'water' || next === 'resupply') {
      setWaypointFilter(next);
    }
  });

  const exportCsvBtn = document.getElementById('export-csv-btn') as HTMLButtonElement;
  const exportGpxBtn = document.getElementById('export-gpx-btn') as HTMLButtonElement;
  if (exportCsvBtn) {
    exportCsvBtn.disabled = false;
    exportCsvBtn.addEventListener('click', () => {
      if (trailState.currentTrail) exportDatasheet(trailState.currentTrail);
    });
  }
  if (exportGpxBtn) {
    exportGpxBtn.disabled = false;
    exportGpxBtn.addEventListener('click', () => {
      if (trailState.currentTrail) exportGpx(trailState.currentTrail);
    });
  }

  window.addEventListener('resize', debounce(() => {
    if (trailState.currentTrail) {
      drawElevationProfile(trailState.currentTrail.track.points);
    }
    if (map) map.invalidateSize();
  }, 150));

  // The elevation profile is canvas-drawn, so it has to be repainted by hand
  // when the theme changes.
  onThemeChange(() => {
    if (trailState.currentTrail) {
      drawElevationProfile(trailState.currentTrail.track.points);
    }
  });
}
