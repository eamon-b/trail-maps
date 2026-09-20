/**
 * Plan viewer — web trip planner for multi-day hiking.
 *
 * Three-panel layout: left (Days/Stops/Resupply tabs), center (map + elevation),
 * right (datasheet — the selected day, or the resupply plan while that tab is open).
 * Plans are persisted to localStorage.
 */

import type * as Leaflet from 'leaflet';
declare const L: typeof Leaflet;

import type {
  PlanTrackPoint,
  PlanWaypoint,
  ComputedDay,
  PlanDocument,
  PlanStop,
} from '@lib/plan-types';
import {
  computePlanDays,
  overnightCandidates,
  servicesAtStop,
  setDirection as editDirection,
  setNights as editNights,
  setPlanName as editPlanName,
  setStartDate as editStartDate,
  setStopBooked as editStopBooked,
  setStopNote as editStopNote,
  toggleStop as editToggleStop,
  findStop,
  isStopSelected,
  type StopKey,
  type StopServices,
} from '@lib/plan-editor';
import { PLAN_LIMITS } from '@lib/plan-types';
import { findNearestByDistance } from '@lib/track-geometry';
import {
  routeBreakCrossings,
  routeBreakStarts,
  sliceAcrossRouteBreaks,
  splitAtRouteBreaks,
} from '@lib/route-breaks';
import type { RouteBreak, TrailPOI } from '@lib/trail-types';
import { OSM_ATTRIBUTION } from '@lib/poi-display';
import {
  computeResupplyLegs,
  listResupplyOptions,
  resolveResupplyStops,
  summariseResupplyLegs,
  DEFAULT_RESUPPLY_DAILY_HOURS,
  type ResupplyLeg,
  type ResupplyOption,
  type ResupplyOptionGroup,
  type ResupplySummary,
} from '@lib/resupply-plan';
import { analyzeWaterCarry } from '@lib/water-carry-calculator';
import { createReversedTrail } from '@lib/trail-reverse';
import { trailElevationIsUsable } from '@lib/elevation-backfill';
import { KM_EPSILON, getDirectionLabel, stopsToActive, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import { baseWaypointType, waypointTypeLabel } from '@lib/waypoint-taxonomy';
import {
  loadOrMigratePlan,
  loadPlanUiPrefs,
  savePlanDocument,
  savePlanUiPrefs,
} from './plan-state';
// Escapes quotes as well as angle brackets, unlike a `textContent` round trip
// through a detached div — this file interpolates waypoint names and types into
// `title="…"` and `class="…"`, and an imported GPX supplies both.
import { escapeHtml } from '../web-utils';
import { onThemeChange, themeColor } from '../theme';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Trail {
  config: {
    id: string;
    name: string;
    shortName?: string;
    region?: string;
    /** Display labels for the two hiking directions (e.g. Westbound/Eastbound). */
    direction?: { default: string; reversed: string };
    /** Where the track's elevations came from; absent on trails built before imports. */
    elevationSource?: 'gpx' | 'backfilled' | 'none';
  };
  track: {
    points: PlanTrackPoint[];
    displayPoints?: PlanTrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
    breaks?: RouteBreak[];
  };
  waypoints?: PlanWaypoint[];
  /**
   * OSM points of interest, on the same km scale as the waypoints. Absent when
   * the trail has never been fetched for them (CDT, Te Araroa) — which is not
   * the same as "nothing near this stop", and the Stops tab says so.
   */
  pois?: TrailPOI[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trail: Trail;
/** Lazily-built reversed copy of `trail`; only computed when SOBO is first viewed. */
let reversedTrail: Trail | null = null;
/**
 * The plan being edited. Replaced wholesale by every edit — `@lib/plan-editor`
 * never mutates, so this binding is the only thing that changes, and a render
 * always reads one consistent document.
 */
let plan: PlanDocument;
let currentDays: ComputedDay[] = [];
let selectedDayIndex: number | null = null;
type PlanTab = 'days' | 'stops' | 'resupply';
let activeTab: PlanTab = 'days';
let stopsFilter = '';
let resupplyFilter = '';
/** Stops tab: list every waypoint rather than only the overnight candidates. */
let showAllWaypoints = false;
let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Leaflet
let map: L.Map | null = null;
let basePolyline: L.Polyline | null = null;
let dayPolylines: L.Polyline[] = [];
let stopMarkers: L.LayerGroup | null = null;
let waypointMarkers: Array<{ marker: L.Marker; waypoint: PlanWaypoint }> = [];

// Elevation
const PAD = { top: 20, right: 20, bottom: 28, left: 50 };
let elevMaxDist = 1;

// ---------------------------------------------------------------------------
// Waypoint icons
// ---------------------------------------------------------------------------

const WAYPOINT_ICONS: Record<string, string> = {
  town: '\u{1F3D8}\u{FE0F}',
  hut: '\u{1F6D6}',
  campsite: '\u26FA',
  water: '\u{1F4A7}',
  'water-tank': '\u{1F6B0}',
  mountain: '\u26F0\u{FE0F}',
  'side-trip': '\u{1F97E}',
  accommodation: '\u{1F3E8}',
  'caravan-park': '\u{1F3D5}\u{FE0F}',
  trailhead: '\u{1F697}',
  food: '\u{1F374}',
  'road-crossing': '\u{1F6E3}\u{FE0F}',
  'inlet-crossing': '\u{1F30A}',
  beach: '\u{1F3D6}\u{FE0F}',
  poi: '\u{2B50}',
  resupply: '\u{1F4E6}',
  endpoint: '\u{1F6A9}',
  // Keep in step with the same table in trail-viewer.ts.
  junction: '\u{1F500}',
  milestone: '\u{1FAA7}',
  gap: '\u{1F6A7}',
  'ley-note': '\u{1F5D2}\u{FE0F}',
  'ley-waypoint': '\u{1F53A}',
  'camp-2018': '\u{1F525}',
  waypoint: '\u{1F4CD}',
};

function waypointIcon(type?: string): string {
  // A turn-off shows its served type's icon (`town-access` → the town glyph).
  return WAYPOINT_ICONS[type ?? ''] ?? WAYPOINT_ICONS[baseWaypointType(type)] ?? '\u{1F4CD}';
}

// ---------------------------------------------------------------------------
// Services at a stop
// ---------------------------------------------------------------------------

/** The flags of `StopServices`, in the order the strip shows them. */
type ServiceFlag = Exclude<keyof StopServices, 'pois'>;

const SERVICE_GLYPHS: ReadonlyArray<{ flag: ServiceFlag; glyph: string; label: string }> = [
  { flag: 'camping', glyph: '\u26FA', label: 'Camping' },
  { flag: 'lodging', glyph: '\u{1F6CF}\u{FE0F}', label: 'Lodging' },
  { flag: 'shop', glyph: '\u{1F6D2}', label: 'Shop' },
  { flag: 'food', glyph: '\u{1F37D}\u{FE0F}', label: 'Food' },
  { flag: 'water', glyph: '\u{1F4A7}', label: 'Water' },
  { flag: 'transport', glyph: '\u{1F68C}', label: 'Transport' },
];

/**
 * What is within a kilometre of this place, from the trail's OSM POIs.
 *
 * @param km active-direction km. `createReversedTrail` mirrors POI distances
 *   along with everything else, so the POIs of `activeTrail()` are already on
 *   the same scale as the waypoint km the rows show.
 */
function servicesAt(km: number): StopServices | undefined {
  return servicesAtStop({ km }, activeTrail().pois);
}

/**
 * Six glyphs, greyed where the service is absent. Empty when the trail has no
 * POI data at all: a strip of six grey glyphs would read as "nothing here",
 * which is a different and more dangerous claim than "we do not know" — the
 * tab footer says which it is.
 */
function servicesStripHtml(services: StopServices | undefined): string {
  if (!services) return '';
  const glyphs = SERVICE_GLYPHS.map(({ flag, glyph, label }) => {
    const present = services[flag];
    const title = present ? label : `No ${label.toLowerCase()} nearby`;
    return `<span class="stop-svc${present ? '' : ' is-off'}" title="${escapeHtml(title)}">${glyph}</span>`;
  }).join('');
  return `<div class="stop-services">${glyphs}</div>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------


function getMinMax(arr: number[]): { min: number; max: number } {
  if (arr.length === 0) return { min: 0, max: 0 };
  let min = arr[0], max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
  }
  return { min, max };
}

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
    ticks.push(Math.round(v * 1e6) / 1e6);
  }
  return ticks;
}

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): (...args: Parameters<T>) => void {
  let t: ReturnType<typeof setTimeout>;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/**
 * Naismith flat-ground speed for the day plan. The page has no pace input, so
 * this is the one place the figure lives (the resupply legs have their own,
 * deliberately, since they answer a different question).
 */
const PLAN_BASE_KMH = 4;

/** The first line of a note — all a day card or a datasheet row has room for. */
function firstLine(text: string): string {
  return text.split('\n')[0].trim();
}

/**
 * The "Booked" badge and the note, shown wherever a stop is reported: the day
 * card that ends there and that stop's row in the datasheet.
 */
function stopFooterHtml(stop: PlanStop | undefined): string {
  if (!stop) return '';
  const note = firstLine(stop.note ?? '');
  if (!stop.booked && !note) return '';
  return `<div class="stop-footer">
      ${stop.booked ? '<span class="booked-badge">Booked</span>' : ''}
      ${note ? `<span class="stop-note-text">${escapeHtml(note)}</span>` : ''}
    </div>`;
}

/** Day and month only — the resupply table has eight columns in a 220px panel. */
function formatShortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ---------------------------------------------------------------------------
// Direction (km-space contract)
// ---------------------------------------------------------------------------
//
// plan.stops[].km is ALWAYS stored NOBO-absolute (the trail as built).
// Everything at runtime — renderers, computePlanDays, marker clicks — works in
// "active" km, i.e. the currently viewed direction. The only conversions are:
//   storage -> active: activeStops() (used by renderAll and the renderers)
//   active -> storage: stopKeyFor() / toNoboKm() in toggleStop()
// No renderer may branch on direction; they just read activeTrail()/activeStops().

function direction(): PlanDirection {
  return plan.direction;
}

/** The trail oriented in the active direction. */
function activeTrail(): Trail {
  return direction() === 'SOBO' ? (reversedTrail ??= createReversedTrail(trail)) : trail;
}

/**
 * Cached result of `stopsToActive` for the current render pass. All stop and
 * direction mutations funnel through renderAll(), which refreshes the cache
 * before anything reads it; isStop(), the markers, and the elevation profile
 * then share one array instead of clone-and-sorting per waypoint.
 */
let cachedActiveStops: PlanStop[] = [];

function refreshActiveStops(): void {
  cachedActiveStops = stopsToActive(plan.stops, direction(), trail.track.totalDistance);
}

/** Stored stops mapped into active-direction km, sorted ascending. */
function activeStops(): PlanStop[] {
  return cachedActiveStops;
}

/**
 * The stop key for a place the user pointed at in the active direction: the
 * waypoint's id when it has one, and always its km converted back to storage
 * space. Every editor call on this page goes through it, so no call site does
 * the NOBO conversion by hand.
 */
function stopKeyFor(waypoint: { id?: string; km: number }): StopKey {
  return {
    ...(waypoint.id ? { waypointId: waypoint.id } : {}),
    km: toNoboKm(waypoint.km, direction(), trail.track.totalDistance),
  };
}

/** The stored stop for an active-km position, or undefined. */
function stopAtActiveKm(km: number): PlanStop | undefined {
  return activeStops().find(stop => Math.abs(stop.km - km) < KM_EPSILON);
}

/** Display label for a direction, from trail config with NOBO/SOBO fallback. */
function directionLabel(dir: PlanDirection): string {
  return getDirectionLabel(trail.config.direction, dir, { default: 'NOBO', reversed: 'SOBO' });
}

/** @param km active-direction km */
function isStop(km: number): boolean {
  return activeStops().some(s => Math.abs(s.km - km) < KM_EPSILON);
}

function getDayColors(count: number): string[] {
  const palette = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];
  const colors: string[] = [];
  for (let i = 0; i < count; i++) colors.push(palette[i % palette.length]);
  return colors;
}

// ---------------------------------------------------------------------------
// Resupply selection
// ---------------------------------------------------------------------------
//
// The page has no pace inputs, so the two figures the leg calculator needs are
// fixed here rather than being scattered through the renderers.

/** Naismith flat-ground speed used for every resupply leg on this page. */
const RESUPPLY_BASE_KMH = 4;

/** Options depend only on the trail, so they are rebuilt only on a direction flip. */
let cachedResupplyGroups: ResupplyOptionGroup[] = [];
let cachedResupplyGroupsKey: string | null = null;

/**
 * Legs are the expensive half: each one walks the full-resolution track for its
 * ascent, so they are recomputed only when the selection, the direction or the
 * day plan they report arrivals against actually changes — never once per
 * `renderAll()`.
 */
let cachedResupplyLegs: ResupplyLeg[] = [];
let cachedResupplyLegsKey: string | null = null;

function resetResupplyCaches(): void {
  cachedResupplyGroups = [];
  cachedResupplyGroupsKey = null;
  cachedResupplyLegs = [];
  cachedResupplyLegsKey = null;
}

function resupplyGroups(): ResupplyOptionGroup[] {
  const key = direction();
  if (key !== cachedResupplyGroupsKey) {
    cachedResupplyGroups = listResupplyOptions(activeTrail().waypoints);
    cachedResupplyGroupsKey = key;
  }
  return cachedResupplyGroups;
}

/** Every option id, in active-direction order — the "All" selection. */
function allResupplyOptionIds(): string[] {
  return resupplyGroups().flatMap(group => group.options.map(option => option.id));
}

/** The ticked ids. An absent `resupplyStops` means every option, as on a fresh plan. */
function selectedResupplyIds(): Set<string> {
  return new Set(plan.resupplyStops ?? allResupplyOptionIds());
}

function resupplyLegs(): ResupplyLeg[] {
  // Arrival days move when a camp stop moves, not only when one is added, so the
  // day boundaries themselves are part of the key.
  const key = [
    direction(),
    JSON.stringify(plan.resupplyStops ?? null),
    plan.startDate ?? '',
    currentDays.map(day => day.endKm).join(','),
  ].join('|');

  if (key !== cachedResupplyLegsKey) {
    const stops = resolveResupplyStops(resupplyGroups(), plan.resupplyStops);
    cachedResupplyLegs = computeResupplyLegs(activeTrail(), stops, {
      dailyHours: DEFAULT_RESUPPLY_DAILY_HOURS,
      baseKmh: RESUPPLY_BASE_KMH,
      days: currentDays,
    });
    cachedResupplyLegsKey = key;
  }
  return cachedResupplyLegs;
}

/** The one line the Resupply datasheet and the Days-tab collapsible both show. */
function resupplySummaryText(summary: ResupplySummary): string {
  const stops = `${summary.stops} stop${summary.stops === 1 ? '' : 's'}`;
  const days = `${summary.longestDays} day${summary.longestDays === 1 ? '' : 's'}`;
  return `${stops} · longest carry ${summary.longestKm.toFixed(1)} km / ${days} · ` +
    `${summary.totalFoodKg.toFixed(1)} kg food in total`;
}

/**
 * How far off the route the place is, and how you get there — metric, because
 * the web pages are (the phone is the one that formats by unit preference).
 */
function accessSummary(option: ResupplyOption): string {
  const hasKm = typeof option.offTrailKm === 'number' && option.offTrailKm > 0;
  const mode = option.accessMode;
  if (hasKm) return `${option.offTrailKm!.toFixed(1)} km ${mode && mode !== 'on-trail' ? mode : 'off trail'}`;
  if (mode === 'on-trail') return 'on trail';
  return mode ?? '';
}

/**
 * Dotted tokens that end no sentence: "U.S. 50", "Mt. Sonder", "approx. 3 km".
 * A single capital letter before the dot (the "S" of "U.S.") is handled by the
 * pattern itself; these are the multi-letter ones a trail description uses.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  'mt', 'mtn', 'st', 'hwy', 'rd', 'jct', 'approx', 'alt', 'elev', 'ft', 'km', 'mi', 'no', 'vs', 'etc', 'inc', 'co', 'ltd',
]);

/**
 * The lead sentence of a description, which is the part that says what is
 * there. The trail generators prefix their descriptions with `|`-separated
 * metadata ("mi 1947.3 (SOBO mi 1947.3) | off. mi 1955.8 | CO | Leave the CDT
 * here for Salida…"), so the prose is the last segment.
 *
 * A sentence ends at `.`, `!` or `?` followed by whitespace or the end of the
 * text — unless the dot closes an initial or an abbreviation ("U.S. 50",
 * "Mt. Sonder"), which would otherwise cut the sentence to "Store beside U.S."
 */
function firstSentence(text: string): string {
  const segments = text.split('|').map(part => part.trim()).filter(part => part !== '');
  const prose = segments.length > 0 ? segments[segments.length - 1] : '';

  const terminator = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = terminator.exec(prose)) !== null) {
    const end = match.index + 1;
    if (match[0] === '.' && isAbbreviationDot(prose, match.index)) continue;
    return prose.slice(0, end).trim();
  }
  return prose.trim();
}

/** Whether the dot at `index` closes an initial ("U.S.") or a listed abbreviation ("Mt."). */
function isAbbreviationDot(prose: string, index: number): boolean {
  const word = prose.slice(0, index).match(/(\S+)$/)?.[1] ?? '';
  // "U.S." — the dot after the S sits behind a single capital letter, itself
  // behind another dotted letter or the start of the word.
  if (/^(?:[A-Z]\.)*[A-Z]$/.test(word)) return true;
  return NON_TERMINAL_ABBREVIATIONS.has(word.replace(/^[^a-z]+/i, '').toLowerCase());
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadTrailData(trailId: string): Promise<Trail | null> {
  try {
    const response = await fetch(`/data/generated/${trailId}.json`);
    if (!response.ok) throw new Error('Trail data not found');
    return await response.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Map
// ---------------------------------------------------------------------------

function initMap(): void {
  if (typeof L === 'undefined') {
    const el = document.getElementById('plan-map');
    if (el) el.innerHTML = '<p style="padding:2rem;text-align:center;color:var(--text-secondary)">Map unavailable.</p>';
    return;
  }

  map = L.map('plan-map', { zoomControl: true, scrollWheelZoom: true });

  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
  }).addTo(map);

  L.control.scale({ metric: true, imperial: false }).addTo(map);

  stopMarkers = L.layerGroup().addTo(map);

  // Base trail polyline (always visible, muted). One line per walkable stretch,
  // so a route break is not drawn as trail; each crossing gets the trail page's
  // dashed grey line instead. The geometry is the same in both directions, so
  // this is drawn once.
  const { track } = activeTrail();
  const displayPoints = track.displayPoints ?? track.points;
  const which = track.displayPoints ? 'displayPoints' : 'points';
  const latLngs = splitAtRouteBreaks(displayPoints, track.breaks, which).map(stretch =>
    stretch.map(p => [p.lat, p.lon] as [number, number])
  );
  basePolyline = L.polyline(latLngs, { color: '#aaa', weight: 3, opacity: 0.55 }).addTo(map);
  for (const crossing of routeBreakCrossings(displayPoints, track.breaks, which)) {
    L.polyline(
      [
        [crossing.from.lat, crossing.from.lon],
        [crossing.to.lat, crossing.to.lon],
      ],
      { color: '#9e9e9e', weight: 2, opacity: 0.9, dashArray: '6 6' }
    )
      .addTo(map)
      .bindPopup(
        `<strong>Trail break</strong><br>${crossing.straightLineKm.toFixed(1)} km, not walked ` +
          'and not counted in the trail distance.'
      );
  }

  // Fit map
  if (displayPoints.length > 0) {
    map.fitBounds(basePolyline.getBounds(), { padding: [20, 20] });
  }

  // Waypoint markers (clickable to add/remove stop)
  drawWaypointMarkers();
}

function drawWaypointMarkers(): void {
  if (!map) return;
  // Remove existing
  waypointMarkers.forEach(({ marker }) => marker.remove());
  waypointMarkers = [];

  // On the Resupply tab the map answers the question that tab asks: which of the
  // resupply options am I taking? Ticked ones borrow the camp-stop emphasis and
  // the rest fade back. Every other tab redraws these markers plain.
  const showingResupply = activeTab === 'resupply';
  const optionIds = showingResupply ? new Set(allResupplyOptionIds()) : null;
  const pickedIds = showingResupply ? selectedResupplyIds() : null;

  const waypoints = activeTrail().waypoints ?? [];
  waypoints.forEach(wp => {
    const km = wp.totalDistance ?? 0; // active-direction km
    const type = wp.type ?? 'waypoint';
    const icon = waypointIcon(type);
    const isSelected = isStop(km);
    const isOption = optionIds !== null && wp.id !== undefined && optionIds.has(wp.id);
    const isPicked = isOption && pickedIds!.has(wp.id!);
    const className = `waypoint-marker ${type}${isSelected || isPicked ? ' is-stop' : ''}`;
    const divIcon = L.divIcon({
      className: '',
      html: `<div class="${escapeHtml(className)}" title="${escapeHtml(wp.name)}">${icon}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    const marker = L.marker([wp.lat ?? 0, wp.lon ?? 0], { icon: divIcon });
    if (isOption && !isPicked) marker.setOpacity(0.4);
    // A click means what the tab means: on the Resupply tab the highlighted
    // markers are the ticked options, so clicking one ticks or unticks it.
    // Everywhere else it opens the waypoint's popup — a stop is never toggled
    // by the click itself, because a mis-aimed click on a 22 px marker used to
    // silently rewrite the day plan.
    marker.on('click', () => {
      if (isOption) {
        toggleResupply(wp.id!);
        return;
      }
      marker.bindPopup(waypointPopupContent(wp, km), { className: 'plan-wp-popup' }).openPopup();
    });
    marker.addTo(map!);
    waypointMarkers.push({ marker, waypoint: wp });
  });
}

/**
 * The popup a waypoint marker opens: what the place is, and one button that
 * makes it a stop or stops it being one.
 *
 * Built as a detached element rather than an HTML string so the button's
 * handler is wired here, where `wp` and `km` are in hand. Leaflet takes an
 * element as popup content, and the content is rebuilt on every click, so the
 * button always reads the plan as it is now.
 *
 * @param km active-direction km.
 */
function waypointPopupContent(wp: PlanWaypoint, km: number): HTMLElement {
  const selected = isStopSelected(plan, stopKeyFor({ id: wp.id, km }));
  const el = document.createElement('div');
  el.className = 'wp-popup';
  el.innerHTML = `
    <div class="wp-popup-name">${escapeHtml(wp.name)}</div>
    <div class="wp-popup-sub">${escapeHtml(waypointTypeLabel(wp.type))} · ${km.toFixed(1)} km</div>
    ${servicesStripHtml(servicesAt(km))}
    <button type="button" class="wp-popup-btn${selected ? ' is-stop' : ''}">
      ${selected ? 'Remove stop' : 'Stop here'}
    </button>`;
  el.querySelector('.wp-popup-btn')?.addEventListener('click', () => {
    toggleStop(km, wp.name ?? 'Stop', wp.id);
    map?.closePopup();
  });
  return el;
}

function redrawMapLayers(): void {
  if (!map || !stopMarkers) return;

  // Remove old day polylines
  dayPolylines.forEach(p => p.remove());
  dayPolylines = [];

  const days = currentDays;
  const colors = getDayColors(days.length);

  const { points, breaks } = activeTrail().track;
  const breakStarts = routeBreakStarts(breaks, 'points');
  days.forEach((day, i) => {
    const startIdx = findNearestByDistance(points, day.startKm);
    const endIdx = findNearestByDistance(points, day.endKm);
    // A day that spans a route break (the Cook Strait ferry, say) is two lines.
    const latLngs = sliceAcrossRouteBreaks(points, startIdx, endIdx, breakStarts)
      .filter(piece => piece.length >= 2)
      .map(piece => piece.map(p => [p.lat, p.lon] as [number, number]));
    const isSelected = selectedDayIndex === i;
    const polyline = L.polyline(latLngs, {
      color: isSelected ? '#3b82f6' : colors[i],
      weight: isSelected ? 5 : 3,
      opacity: isSelected ? 0.9 : 0.6,
    });
    polyline.on('click', () => selectDay(i));
    polyline.addTo(map!);
    dayPolylines.push(polyline);
  });

  // Bring base to back
  basePolyline?.bringToBack();

  // Stop markers
  stopMarkers.clearLayers();
  activeStops().forEach(stop => {
    // Find waypoint position
    const wp = (activeTrail().waypoints ?? []).find(w => Math.abs((w.totalDistance ?? 0) - stop.km) < KM_EPSILON);
    if (!wp) return;
    const divIcon = L.divIcon({
      className: '',
      html: `<div class="stop-flag-icon" title="${escapeHtml(stop.name)}">⛺</div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    L.marker([wp.lat ?? 0, wp.lon ?? 0], { icon: divIcon }).addTo(stopMarkers!);
  });

  // Re-draw waypoint markers to update is-stop styling
  drawWaypointMarkers();
}

// ---------------------------------------------------------------------------
// Elevation profile
// ---------------------------------------------------------------------------

function drawElevationProfile(): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  canvas.width = rect.width * window.devicePixelRatio;
  canvas.height = rect.height * window.devicePixelRatio;
  ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

  const pts = activeTrail().track.points;
  if (pts.length === 0) return;

  const elevations = pts.map(p => p.ele);
  const { min: minEle, max: maxEle } = getMinMax(elevations);
  const maxDist = activeTrail().track.totalDistance;

  const eleTicks = niceAxisTicks(minEle, maxEle, 4);
  const distTicks = niceAxisTicks(0, maxDist, 5);

  ctx.font = '11px system-ui, sans-serif';
  let maxLabelWidth = 0;
  for (const tick of eleTicks) {
    const w = ctx.measureText(`${Math.round(tick)}m`).width;
    if (w > maxLabelWidth) maxLabelWidth = w;
  }
  PAD.left = maxLabelWidth + 12;

  const width = rect.width - PAD.left - PAD.right;
  const height = rect.height - PAD.top - PAD.bottom;

  const eleMin = eleTicks.length > 0 ? Math.min(minEle, eleTicks[0]) : minEle;
  const eleMax = eleTicks.length > 0 ? Math.max(maxEle, eleTicks[eleTicks.length - 1]) : maxEle;
  const eleRange = eleMax - eleMin || 1;

  // Cache max distance for hover calculation
  elevMaxDist = maxDist;

  const axisColor = themeColor('--chart-text', '#666');
  const gridColor = themeColor('--chart-grid', '#ddd');
  const gridSoftColor = themeColor('--chart-grid-soft', '#eee');
  const accentColor = themeColor('--chart-accent', '#3b82f6');

  // Elevation axis
  ctx.fillStyle = axisColor;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of eleTicks) {
    const y = PAD.top + height - ((tick - eleMin) / eleRange) * height;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + width, y);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)}m`, PAD.left - 4, y);
  }

  // Distance axis
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = axisColor;
  for (const tick of distTicks) {
    const x = PAD.left + (tick / maxDist) * width;
    ctx.strokeStyle = gridSoftColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + height);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)} km`, x, PAD.top + height + 4);
  }

  // Full trail — muted against the theme background
  ctx.beginPath();
  ctx.strokeStyle = themeColor('--chart-muted-line', '#ccc');
  ctx.lineWidth = 2;
  pts.forEach((p, i) => {
    const x = PAD.left + (p.dist / maxDist) * width;
    const y = PAD.top + height - ((p.ele - eleMin) / eleRange) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Selected day — blue overlay
  if (selectedDayIndex !== null) {
    const day = currentDays[selectedDayIndex];
    if (day) {
      const startIdx = findNearestByDistance(pts, day.startKm);
      const endIdx = findNearestByDistance(pts, day.endKm);
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const slice = pts.slice(lo, hi + 1);

      ctx.beginPath();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 3;
      slice.forEach((p, i) => {
        const x = PAD.left + (p.dist / maxDist) * width;
        const y = PAD.top + height - ((p.ele - eleMin) / eleRange) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  // Stop markers on elevation
  activeStops().forEach(stop => {
    const x = PAD.left + (stop.km / maxDist) * width;
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + height);
    ctx.stroke();
    ctx.setLineDash([]);
  });
}

function setupElevationHover(): void {
  const canvas = document.getElementById('elevation-canvas') as HTMLCanvasElement;
  const hoverLine = document.getElementById('elev-hover-line') as HTMLElement;
  const tooltip = document.getElementById('elev-hover-tooltip') as HTMLElement;
  if (!canvas || !hoverLine || !tooltip) return;

  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const width = rect.width - PAD.left - PAD.right;
    const x = e.clientX - rect.left - PAD.left;
    if (x < 0 || x > width) { hoverLine.style.display = 'none'; tooltip.style.display = 'none'; return; }

    const fracDist = Math.max(0, Math.min(1, x / width));
    const km = fracDist * elevMaxDist;
    const points = activeTrail().track.points;
    const ptIdx = findNearestByDistance(points, km);
    const pt = points[ptIdx];
    if (!pt) return;

    const xPx = PAD.left + (pt.dist / elevMaxDist) * width;
    hoverLine.style.display = 'block';
    hoverLine.style.left = `${rect.left + xPx - canvas.getBoundingClientRect().left}px`;
    tooltip.style.display = 'block';
    tooltip.textContent = `${pt.dist.toFixed(1)} km · ${Math.round(pt.ele)} m`;
    const tipLeft = xPx + 8;
    tooltip.style.left = (tipLeft + tooltip.offsetWidth > rect.width ? xPx - tooltip.offsetWidth - 4 : tipLeft) + 'px';
  });

  canvas.addEventListener('mouseleave', () => {
    hoverLine.style.display = 'none';
    tooltip.style.display = 'none';
  });
}

// ---------------------------------------------------------------------------
// Left panel — Days tab
// ---------------------------------------------------------------------------

function renderDayList(): void {
  const container = document.getElementById('days-list');
  if (!container) return;

  const days = currentDays;

  // Naismith needs ascent: with a flat profile the day times are distance-only
  // and read as optimistic, so say so wherever the estimates are shown.
  const elevationNote = trailElevationIsUsable(activeTrail())
    ? ''
    : `<p class="days-empty">Distance-only estimate — this trail has no elevation data, so climbing time isn't included.</p>`;

  if (days.length === 1 && plan.stops.length === 0) {
    container.innerHTML = `${elevationNote}<p class="days-empty">Add stops in the Stops tab to split the trail into days.</p>`;
    renderResupplySection();
    renderWaterCarrySection();
    return;
  }

  container.innerHTML = elevationNote + days.map((day, i) => {
    const dateStr = day.date ? `<span class="day-card-date">${formatDate(day.date)}</span>` : '';
    const waterStr = day.waterSources > 0
      ? `<span class="water-info">💧 ${day.waterSources} water</span>`
      : '<span>💧 0 water</span>';
    const selected = selectedDayIndex === i ? ' selected' : '';
    // A rest day is not a card of its own — it is nights at the stop this day
    // ends at, and the reason every later date has moved on.
    const rest = day.restDays ?? 0;
    const restLine = rest > 0
      ? `<div class="day-card-rest">+${rest} rest day${rest === 1 ? '' : 's'} at ${escapeHtml(day.endName)}</div>`
      : '';
    return `
      <div class="day-card${selected}" data-day-index="${i}">
        <div class="day-card-header">
          <span class="day-card-number">Day ${day.dayNumber}</span>
          ${dateStr}
        </div>
        <div class="day-card-route">${escapeHtml(day.startName)} → ${escapeHtml(day.endName)}</div>
        <div class="day-card-stats">
          <span>${day.distanceKm.toFixed(1)} km</span>
          <span>+${day.ascentM} m</span>
          <span>-${day.descentM} m</span>
          <span>~${day.estimatedHours}h</span>
          ${waterStr}
        </div>
        ${restLine}
        ${stopFooterHtml(stopAtActiveKm(day.endKm))}
      </div>`;
  }).join('');

  container.querySelectorAll('.day-card').forEach(card => {
    card.addEventListener('click', () => {
      const idx = Number((card as HTMLElement).dataset.dayIndex);
      selectDay(selectedDayIndex === idx ? null : idx);
    });
  });

  renderResupplySection();
  renderWaterCarrySection();
}

/**
 * The Days-tab summary of the resupply plan.
 *
 * Deliberately only a summary: the legs themselves live in the Resupply tab's
 * datasheet, and both read the same cached legs so the two can never disagree.
 */
function renderResupplySection(): void {
  const section = document.getElementById('resupply-section');
  const body = document.getElementById('resupply-body');
  if (!section || !body) return;

  if (resupplyGroups().length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const summary = summariseResupplyLegs(resupplyLegs());
  const line = summary.hasData ? resupplySummaryText(summary) : 'No resupply stops ticked.';
  body.innerHTML = `<div class="gap-item">
      <span class="gap-ok">🍎</span>
      <span>${escapeHtml(line)}</span>
    </div>
    <button type="button" class="resupply-edit" id="resupply-edit-link">Edit in the Resupply tab</button>`;

  document.getElementById('resupply-edit-link')?.addEventListener('click', () => switchTab('resupply'));
}

function renderWaterCarrySection(): void {
  const section = document.getElementById('water-section');
  const body = document.getElementById('water-body');
  if (!section || !body) return;

  const waypoints = activeTrail().waypoints ?? [];
  const analysis = analyzeWaterCarry(waypoints, activeTrail().track.totalDistance);

  if (!analysis.hasWaterData) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  body.innerHTML = analysis.gaps.map(g => {
    const cls = g.isDryStretch ? ' gap-warn' : ' gap-ok';
    const badge = g.isDryStretch ? ' 🔴 DRY' : '';
    return `<div class="gap-item">
      <span class="${cls}">💧${badge}</span>
      <span>${escapeHtml(g.fromName)} → ${escapeHtml(g.toName)}: ${g.distanceKm} km</span>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Left panel — Stops tab
// ---------------------------------------------------------------------------

/**
 * The places the Stops tab offers.
 *
 * `overnightCandidates` by default — camps, huts, shelters and towns, the
 * places you can actually sleep — because a list of every road crossing and
 * creek on a 3,000 km trail is not a list you pick a night's stop from. The
 * "Show all waypoints" switch restores the old behaviour for the hiker who
 * wants to camp at a river junction.
 */
function stopCandidates(): PlanWaypoint[] {
  const waypoints = activeTrail().waypoints ?? [];
  return showAllWaypoints ? waypoints.slice() : overnightCandidates(waypoints);
}

/** The nights / note / booked controls that open under a ticked row. */
function stopEditorHtml(stop: PlanStop): string {
  const note = stop.note ?? '';
  return `<div class="stop-editor">
      <div class="stop-editor-line">
        <span class="stop-editor-label">Nights</span>
        <button type="button" class="nights-btn" data-nights-delta="-1"
          aria-label="One night fewer"${stop.nights <= 1 ? ' disabled' : ''}>\u2212</button>
        <span class="nights-value">${stop.nights}</span>
        <button type="button" class="nights-btn" data-nights-delta="1"
          aria-label="One night more"${stop.nights >= PLAN_LIMITS.nightsMax ? ' disabled' : ''}>+</button>
        <span class="nights-hint">2 nights = 1 rest day</span>
      </div>
      <input type="text" class="stop-note" placeholder="Note\u2026"
        maxlength="${PLAN_LIMITS.noteMax}" value="${escapeHtml(note)}" />
      <label class="stop-booked">
        <input type="checkbox" class="stop-booked-check"${stop.booked ? ' checked' : ''} />
        Booked
      </label>
    </div>`;
}

function renderStopList(): void {
  const container = document.getElementById('stops-list');
  if (!container) return;

  renderStopsFooter();

  const candidates = stopCandidates();
  const needle = stopsFilter.trim().toLowerCase();
  const waypoints = needle
    ? candidates.filter(wp => (wp.name ?? '').toLowerCase().includes(needle))
    : candidates;

  if (waypoints.length === 0) {
    container.innerHTML = candidates.length === 0
      ? '<p class="days-empty">This trail names nowhere to spend a night. Tick \u201CShow all waypoints\u201D to pick from every point on the route.</p>'
      : '<p class="days-empty">No waypoints match.</p>';
    return;
  }

  container.innerHTML = waypoints.map((wp, i) => {
    const km = wp.totalDistance ?? 0;
    const stop = findStop(plan, stopKeyFor({ id: wp.id, km }));
    const selected = stop !== undefined;
    const checkmark = selected ? '\u2713' : '\u00A0';
    const icon = waypointIcon(wp.type ?? 'waypoint');
    // Gap from the previous row on screen, so a filtered or candidates-only
    // list reads as the distances you would actually walk between them.
    const prevKm = i > 0 ? (waypoints[i - 1].totalDistance ?? 0) : 0;
    const gap = i > 0 ? `+${(km - prevKm).toFixed(1)}` : '';
    const idAttr = wp.id ? ` data-id="${escapeHtml(wp.id)}"` : '';
    return `<div class="stop-item${selected ? ' is-stop' : ''}" data-km="${km}"${idAttr}>
      <div class="stop-row${selected ? ' is-stop' : ''}" data-km="${km}"${idAttr}>
        <div class="stop-line">
          <span class="stop-check">${checkmark}</span>
          <span class="stop-type-icon" title="${escapeHtml(waypointTypeLabel(wp.type))}">${icon}</span>
          <span class="stop-name">${escapeHtml(wp.name)}</span>
          <span class="stop-km">${km.toFixed(1)} km</span>
          ${gap ? `<span class="stop-gap">(${gap})</span>` : ''}
        </div>
        ${servicesStripHtml(servicesAt(km))}
      </div>
      ${stop ? stopEditorHtml(stop) : ''}
    </div>`;
  }).join('');
}

/**
 * The one line under the stop list: where the service glyphs come from, or
 * that this trail has no OSM data at all. Never "no services" — see
 * `servicesStripHtml`.
 */
function renderStopsFooter(): void {
  const footer = document.getElementById('stops-footer');
  if (!footer) return;
  const hasPois = activeTrail().pois !== undefined;
  footer.className = `stops-footer${hasPois ? '' : ' is-missing'}`;
  // textContent: both strings are ours, and this keeps the attribution
  // literally what `@lib/poi-display` says it is.
  footer.textContent = hasPois ? OSM_ATTRIBUTION : 'No OpenStreetMap data for this trail yet';
}

/**
 * The stop a row (or a control inside its editor) is about.
 *
 * Read off the `.stop-item` wrapper rather than passed in a closure: every
 * render replaces the rows, and the handlers are delegated from `#stops-list`,
 * which does not.
 */
function stopKeyFromRow(el: HTMLElement): { key: StopKey; km: number; name: string } | null {
  const item = el.closest<HTMLElement>('.stop-item');
  if (!item) return null;
  const km = parseFloat(item.dataset.km ?? '');
  if (!Number.isFinite(km)) return null;
  const id = item.dataset.id;
  const waypoint = (activeTrail().waypoints ?? []).find(wp =>
    id !== undefined ? wp.id === id : Math.abs((wp.totalDistance ?? 0) - km) < KM_EPSILON
  );
  return {
    key: stopKeyFor({ id, km }),
    km,
    name: waypoint?.name ?? 'Stop',
  };
}

// ---------------------------------------------------------------------------
// Left panel — Resupply tab
// ---------------------------------------------------------------------------

/** The groups the filter box leaves on screen. Filtering never changes a tick. */
function filteredResupplyGroups(): ResupplyOptionGroup[] {
  const needle = resupplyFilter.trim().toLowerCase();
  if (!needle) return resupplyGroups();

  const matches: ResupplyOptionGroup[] = [];
  for (const group of resupplyGroups()) {
    // A turn-off's name matching keeps everything reachable from it, which is
    // the point of searching for "Monarch Pass".
    if (group.label && group.label.toLowerCase().includes(needle)) {
      matches.push(group);
      continue;
    }
    const options = group.options.filter(option => option.name.toLowerCase().includes(needle));
    if (options.length > 0) matches.push({ ...group, options });
  }
  return matches;
}

function renderResupplyList(): void {
  const container = document.getElementById('resupply-list');
  const count = document.getElementById('resupply-count');
  if (!container) return;

  const groups = resupplyGroups();
  const picked = selectedResupplyIds();
  const total = groups.reduce((n, group) => n + group.options.length, 0);
  // Counted over the options the trail actually has, so ids left over from an
  // older build of it are never reported as ticked.
  const tickedCount = groups.reduce(
    (n, group) => n + group.options.filter(option => picked.has(option.id)).length,
    0
  );
  if (count) count.textContent = `${tickedCount} of ${total} selected`;

  if (total === 0) {
    container.innerHTML = '<p class="days-empty">This trail has no resupply points.</p>';
    return;
  }

  const visible = filteredResupplyGroups();
  if (visible.length === 0) {
    container.innerHTML = '<p class="days-empty">No resupply points match.</p>';
    return;
  }

  container.innerHTML = visible.map(group => {
    const header = group.label
      ? `<div class="resupply-group-header">⤴ ${escapeHtml(group.label)} · km ${group.km.toFixed(1)}</div>`
      : '';
    const rows = group.options.map(option => renderResupplyRow(option, picked)).join('');
    return `<div class="resupply-group">${header}${rows}</div>`;
  }).join('');
}

function renderResupplyRow(option: ResupplyOption, picked: ReadonlySet<string>): string {
  const checked = picked.has(option.id);
  const inputId = `resupply-opt-${option.id}`;
  const parts = [accessSummary(option)];
  if (option.description) parts.push(firstSentence(option.description));
  if (option.acceptsBoxes) parts.push('accepts boxes');
  const sub = parts.filter(part => part !== '').join(' · ');

  return `<div class="resupply-row${checked ? ' is-picked' : ''}" data-id="${escapeHtml(option.id)}">
    <div class="resupply-line">
      <input type="checkbox" class="resupply-check" id="${escapeHtml(inputId)}"
        data-option-id="${escapeHtml(option.id)}"${checked ? ' checked' : ''} />
      <label class="resupply-label" for="${escapeHtml(inputId)}">
        <span class="resupply-icon" title="${escapeHtml(waypointTypeLabel(option.type))}">${waypointIcon(baseWaypointType(option.type))}</span>
        <span class="resupply-name">${escapeHtml(option.name)}</span>
        <span class="resupply-km">${option.km.toFixed(1)} km</span>
      </label>
    </div>
    ${sub ? `<div class="resupply-sub">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------
// Right panel — Datasheet
// ---------------------------------------------------------------------------

function renderDayDatasheet(day: ComputedDay | null): void {
  const title = document.getElementById('datasheet-title');
  const subtitle = document.getElementById('datasheet-subtitle');
  const body = document.getElementById('datasheet-body');
  if (!title || !subtitle || !body) return;

  const waypoints = activeTrail().waypoints ?? [];

  if (!day) {
    title.textContent = 'All waypoints';
    subtitle.textContent = '';
    body.innerHTML = waypoints.map((wp, i) => {
      const km = wp.totalDistance ?? 0;
      const prevKm = i > 0 ? (waypoints[i - 1].totalDistance ?? 0) : null;
      const deltaStr = prevKm !== null ? `+${(km - prevKm).toFixed(1)} km` : 'start';
      return `<div class="ds-row">
        <span class="ds-type-icon" title="${escapeHtml(waypointTypeLabel(wp.type))}">${waypointIcon(wp.type)}</span>
        <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}</span>
        <span class="ds-km">${km.toFixed(1)}<br><small style="color:var(--text-secondary)">${deltaStr}</small></span>
      </div>`;
    }).join('');
    return;
  }

  title.textContent = `Day ${day.dayNumber}`;
  subtitle.textContent = `${day.distanceKm.toFixed(1)} km · +${day.ascentM} m · ~${day.estimatedHours}h`;

  const inDay = waypoints.filter(wp => {
    const km = wp.totalDistance ?? 0;
    return km >= day.startKm && km <= day.endKm;
  });

  const rows: string[] = [];

  // Start row
  rows.push(`<div class="ds-row ds-start">
    <span class="ds-type-icon">\u{1F6A9}</span>
    <span class="ds-name">${escapeHtml(day.startName)}</span>
    <span class="ds-km">${day.startKm.toFixed(1)} km</span>
  </div>`);

  // Intermediate waypoints
  let prevKm = day.startKm;
  inDay.forEach(wp => {
    const km = wp.totalDistance ?? 0;
    if (Math.abs(km - day.startKm) < 0.01 || Math.abs(km - day.endKm) < 0.01) return;
    const delta = (km - prevKm).toFixed(1);
    rows.push(`<div class="ds-row">
      <span class="ds-type-icon" title="${escapeHtml(waypointTypeLabel(wp.type))}">${waypointIcon(wp.type)}</span>
      <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}</span>
      <span class="ds-km">${km.toFixed(1)}<br><small style="color:var(--text-secondary)">+${delta}</small></span>
    </div>`);
    prevKm = km;
  });

  // End row — the day's stop, so it carries that stop's note and booked tick.
  const endStop = stopAtActiveKm(day.endKm);
  rows.push(`<div class="ds-row ds-end">
    <span class="ds-type-icon">\u26FA</span>
    <span class="ds-name">${escapeHtml(day.endName)}</span>
    <span class="ds-km">${day.endKm.toFixed(1)} km</span>
  </div>`);
  const endFooter = stopFooterHtml(endStop);
  if (endFooter) rows.push(`<div class="ds-stop-meta">${endFooter}</div>`);
  const endRest = day.restDays ?? 0;
  if (endRest > 0) {
    rows.push(
      `<div class="ds-stop-meta"><span class="ds-rest">+${endRest} rest day${endRest === 1 ? '' : 's'} here</span></div>`
    );
  }

  body.innerHTML = rows.join('');
}

/**
 * The resupply plan as a table of carries: one row per leg, trail start to first
 * stop, stop to stop, last stop to trail end.
 */
function renderResupplyDatasheet(): void {
  const title = document.getElementById('datasheet-title');
  const subtitle = document.getElementById('datasheet-subtitle');
  const body = document.getElementById('datasheet-body');
  if (!title || !subtitle || !body) return;

  title.textContent = 'Resupply plan';

  const legs = resupplyLegs();
  const summary = summariseResupplyLegs(legs);

  if (!summary.hasData) {
    subtitle.textContent = '';
    body.innerHTML = resupplyGroups().length === 0
      ? '<p class="days-empty">This trail has no resupply points.</p>'
      : '<p class="days-empty">No resupply stops ticked — tick the ones you plan to use.</p>';
    return;
  }

  subtitle.textContent = resupplySummaryText(summary);

  // The arrival day only means anything once the camp plan has stops and a date
  // to count them from; without both the column would be a row of dashes.
  const showArrive = activeStops().length > 0 && plan.startDate !== null;

  const header = ['#', 'From → To', 'Distance', 'Ascent', 'Descent', 'Est. days', 'Food']
    .concat(showArrive ? ['Arrive'] : [])
    .map(label => `<th>${escapeHtml(label)}</th>`)
    .join('');

  const rows = legs.map((leg, i) => {
    const arrive = leg.arrival
      ? `Day ${leg.arrival.day}${leg.arrival.date ? ` (${formatShortDate(leg.arrival.date)})` : ''}`
      : '—';
    return `<tr class="resupply-leg${leg.isLong ? ' is-long' : ''}">
      <td>${i + 1}</td>
      <td class="rs-route">${escapeHtml(leg.fromName)} → ${escapeHtml(leg.toName)}</td>
      <td>${leg.distanceKm.toFixed(1)} km</td>
      <td>+${leg.ascentM} m</td>
      <td>-${leg.descentM} m</td>
      <td class="${leg.isLong ? 'gap-warn' : ''}">${leg.estimatedDays}${leg.isLong ? ' ⚠️' : ''}</td>
      <td>${leg.food.weightKg.toFixed(1)} kg</td>
      ${showArrive ? `<td>${escapeHtml(arrive)}</td>` : ''}
    </tr>`;
  }).join('');

  body.innerHTML = `<div class="ds-table-wrap">
    <table class="resupply-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function selectDay(index: number | null): void {
  selectedDayIndex = index;
  renderAll();

  if (index !== null && map) {
    const day = currentDays[index];
    if (day) {
      const points = activeTrail().track.points;
      const startIdx = findNearestByDistance(points, day.startKm);
      const endIdx = findNearestByDistance(points, day.endKm);
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const slice = points.slice(lo, hi + 1);
      if (slice.length > 0) {
        const latLngs = slice.map(p => [p.lat, p.lon] as [number, number]);
        map.fitBounds(L.polyline(latLngs).getBounds(), { padding: [30, 30] });
      }
    }
  }
}

/**
 * Add or remove a stop.
 *
 * @param km active-direction km (as shown in the UI); stored NOBO-absolute
 * @param id the waypoint's registry id, when it has one — the editor keys a
 *   stop by it, so a stop survives a rebuild that nudges the waypoint's km.
 */
function toggleStop(km: number, name: string, id?: string): void {
  const noboKm = toNoboKm(km, direction(), trail.track.totalDistance);
  applyEdit(editToggleStop(plan, { ...(id ? { id } : {}), km: noboKm, name }));
}

/**
 * Take an edited document, unless the editor returned the same one.
 *
 * `@lib/plan-editor` returns the input document unchanged for a no-op — a
 * second waypoint at an occupied km, a note that did not change — and that is
 * exactly the signal not to mark the plan unsaved or repaint the page.
 */
function applyEdit(next: PlanDocument, options: { render?: boolean } = {}): void {
  if (next === plan) return;
  plan = next;
  scheduleSave();
  if (options.render !== false) renderAll();
}

/** Nights at a stop, by the row's − / + buttons. Clamped by the editor. */
function changeNights(key: StopKey, delta: number): void {
  const stop = findStop(plan, key);
  if (!stop) return;
  applyEdit(editNights(plan, key, stop.nights + delta));
}

/**
 * Tick or untick one resupply option.
 *
 * The stored value is always an explicit list, so the first tick of a fresh
 * plan starts from "everything" (what the page is currently showing) rather
 * than from nothing. Ids the trail no longer has drop out here, which is the
 * only place a stale selection is ever pruned.
 */
function toggleResupply(id: string): void {
  const picked = selectedResupplyIds();
  if (picked.has(id)) picked.delete(id);
  else picked.add(id);
  setResupplyStops(allResupplyOptionIds().filter(optionId => picked.has(optionId)));
}

function setAllResupply(all: boolean): void {
  setResupplyStops(all ? allResupplyOptionIds() : []);
}

/**
 * Write the resupply selection into the document.
 *
 * `resupplyStops` is a field of `PlanDocument` that `@lib/plan-editor` has no
 * setter for — it predates the day planner and no other platform edits it — so
 * this follows the editors' contract by hand: a new document, never a mutation,
 * with `updatedAt` restamped so a later sync sees the change.
 */
function setResupplyStops(ids: string[]): void {
  applyEdit({ ...plan, resupplyStops: ids, updatedAt: new Date().toISOString() });
}

/** Centre the map on a resupply option, so the list and the map stay in step. */
function panToResupply(id: string): void {
  if (!map) return;
  const wp = (activeTrail().waypoints ?? []).find(w => w.id === id);
  if (!wp) return;
  map.panTo([wp.lat ?? 0, wp.lon ?? 0]);
}

function setDirection(dir: PlanDirection): void {
  if (direction() === dir) return;
  selectedDayIndex = null;
  // renderAll() recomputes days from the reoriented trail and rebuilds day
  // polylines, stop markers, waypoint markers, and the elevation profile.
  applyEdit(editDirection(plan, dir));
  // After the edit: the button's label is read back out of the document.
  updateDirectionButton();
}

function setStartDate(date: string): void {
  // The editor throws on anything that is not a real calendar day; an empty
  // input (the date field cleared) is a null start date, not a bad one.
  try {
    applyEdit(editStartDate(plan, date || null));
  } catch {
    setSaveStatus('error');
  }
}

function setPlanName(name: string): void {
  // No re-render: the name appears nowhere but the input the user is typing in.
  applyEdit(editPlanName(plan, name), { render: false });
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Mark the plan dirty and write it 800 ms after the last edit.
 *
 * Every edit funnels through here, so this is the one place a later sync arm
 * has to reach: `commitSave` is where the document is known-good and settled.
 */
function scheduleSave(): void {
  setSaveStatus('unsaved');
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(commitSave, 800);
}

/**
 * Write the document to `localStorage`.
 *
 * Phase 3c hooks in here: a linked browser also PUTs the document to the
 * comments API from this point, after the local write has succeeded — local
 * first, so a plan is never lost to a flaky network.
 */
function commitSave(): void {
  const ok = savePlanDocument(trail.config.id, plan);
  setSaveStatus(ok ? 'saved' : 'error');
}

function setSaveStatus(status: 'saved' | 'unsaved' | 'error'): void {
  const el = document.getElementById('save-status');
  if (!el) return;
  if (status === 'error') {
    el.textContent = 'Save failed';
    el.className = 'unsaved';
  } else {
    el.textContent = status === 'saved' ? 'Saved' : 'Unsaved…';
    el.className = status === 'saved' ? '' : 'unsaved';
  }
}

// ---------------------------------------------------------------------------
// Collapsible sections
// ---------------------------------------------------------------------------

function initCollapsibles(): void {
  document.querySelectorAll('[data-collapse]').forEach(header => {
    header.addEventListener('click', () => {
      const key = (header as HTMLElement).dataset.collapse!;
      const body = document.getElementById(`${key}-body`);
      const chevron = header.querySelector('.collapse-chevron');
      if (!body) return;
      const open = body.classList.toggle('open');
      if (chevron) chevron.classList.toggle('open', open);
    });
  });
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

/**
 * Switch the left panel, and re-render everything.
 *
 * `renderAll()` rather than just the new tab's list: the right-hand datasheet
 * and the map markers both depend on which tab is showing, so a partial render
 * would leave the resupply table and the day table disagreeing about what is on
 * screen. `selectedDayIndex` is untouched, so Days comes back as it was left.
 */
function switchTab(tab: PlanTab): void {
  activeTab = tab;
  document.querySelectorAll('.tab-btn').forEach(b =>
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab)
  );
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  renderAll();
}

function initTabs(): void {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab((btn as HTMLElement).dataset.tab as PlanTab));
  });
}

// ---------------------------------------------------------------------------
// Render all
// ---------------------------------------------------------------------------

function renderAll(): void {
  refreshActiveStops();
  // computePlanDays, not computeDays: it converts the document's NOBO stops
  // into the active km of the trail it is handed and pushes each day's date
  // along by the rest days taken before it.
  currentDays = computePlanDays(activeTrail(), plan, { baseKmh: PLAN_BASE_KMH });
  // Clamp selectedDayIndex in case stops were removed
  if (selectedDayIndex !== null && selectedDayIndex >= currentDays.length) {
    selectedDayIndex = null;
  }
  renderDayList();
  if (activeTab === 'stops') renderStopList();
  if (activeTab === 'resupply') renderResupplyList();

  if (activeTab === 'resupply') {
    renderResupplyDatasheet();
  } else {
    const selectedDay = selectedDayIndex !== null ? currentDays[selectedDayIndex] ?? null : null;
    renderDayDatasheet(selectedDay);
  }

  redrawMapLayers();
  drawElevationProfile();
}

// ---------------------------------------------------------------------------
// Header bindings
// ---------------------------------------------------------------------------

function updateDirectionButton(): void {
  const label = document.getElementById('direction-label');
  const btn = document.getElementById('direction-toggle') as HTMLButtonElement | null;
  if (label) label.textContent = directionLabel(direction());
  if (btn) btn.title = `Switch to ${directionLabel(direction() === 'NOBO' ? 'SOBO' : 'NOBO')}`;
}

function initHeader(): void {
  const nameInput = document.getElementById('plan-name-input') as HTMLInputElement;
  const dateInput = document.getElementById('plan-start-date') as HTMLInputElement;
  const directionBtn = document.getElementById('direction-toggle') as HTMLButtonElement;

  if (nameInput) {
    nameInput.value = plan.name;
    nameInput.addEventListener('input', () => setPlanName(nameInput.value));
  }

  if (dateInput) {
    dateInput.value = plan.startDate ?? '';
    dateInput.addEventListener('change', () => setStartDate(dateInput.value));
  }

  if (directionBtn) {
    updateDirectionButton();
    directionBtn.addEventListener('click', () => {
      setDirection(direction() === 'NOBO' ? 'SOBO' : 'NOBO');
    });
  }
}

// ---------------------------------------------------------------------------
// Stops tab controls
// ---------------------------------------------------------------------------

/**
 * The filter box, the "Show all waypoints" switch, and the row and per-stop
 * controls.
 *
 * All of the row handlers are delegated from `#stops-list`, which survives
 * every re-render — the rows and the open editor inside it do not.
 */
function initStopsControls(): void {
  const input = document.getElementById('stops-filter') as HTMLInputElement | null;
  input?.addEventListener('input', () => {
    stopsFilter = input.value;
    renderStopList();
  });

  const showAll = document.getElementById('stops-show-all') as HTMLInputElement | null;
  if (showAll) {
    showAll.checked = showAllWaypoints;
    showAll.addEventListener('change', () => {
      showAllWaypoints = showAll.checked;
      savePlanUiPrefs(trail.config.id, { showAllWaypoints });
      renderStopList();
    });
  }

  const list = document.getElementById('stops-list');
  if (!list) return;

  list.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const nights = target.closest<HTMLElement>('.nights-btn');
    if (nights) {
      const found = stopKeyFromRow(nights);
      if (found) changeNights(found.key, Number(nights.dataset.nightsDelta ?? '0'));
      return;
    }

    // Inside the open editor, a click belongs to the control it landed on —
    // the note field and the Booked tick must not toggle the stop off.
    if (target.closest('.stop-editor')) return;

    const row = target.closest<HTMLElement>('.stop-row');
    if (!row) return;
    const found = stopKeyFromRow(row);
    if (found) toggleStop(found.km, found.name, row.dataset.id);
  });

  // Typing does not re-render: the list would be rebuilt under the cursor and
  // take the focus with it. The edit is saved on every keystroke (debounced)
  // and the day cards catch up when the field is left.
  list.addEventListener('input', event => {
    const note = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.stop-note');
    if (!note) return;
    const found = stopKeyFromRow(note);
    if (found) applyEdit(editStopNote(plan, found.key, note.value), { render: false });
  });

  list.addEventListener('change', event => {
    const target = event.target as HTMLElement | null;
    const booked = target?.closest<HTMLInputElement>('.stop-booked-check');
    if (booked) {
      const found = stopKeyFromRow(booked);
      if (found) applyEdit(editStopBooked(plan, found.key, booked.checked));
      return;
    }
    // The note's own `change` fires when the field is left; nothing has to be
    // stored again, the day cards and the datasheet just need the new text.
    if (target?.closest('.stop-note')) renderAll();
  });
}

// ---------------------------------------------------------------------------
// Resupply tab controls
// ---------------------------------------------------------------------------

/**
 * Delegated from `#resupply-list`, which survives every re-render — the rows
 * inside it do not.
 */
function initResupplyControls(): void {
  const list = document.getElementById('resupply-list');
  if (list) {
    list.addEventListener('change', event => {
      const input = (event.target as HTMLElement | null)?.closest?.('input.resupply-check');
      const id = (input as HTMLInputElement | null)?.dataset.optionId;
      if (id) toggleResupply(id);
    });
    // A click anywhere on the row brings the place onto the map, so ticking an
    // option also shows you where it is.
    list.addEventListener('click', event => {
      const row = (event.target as HTMLElement | null)?.closest?.('.resupply-row');
      const id = (row as HTMLElement | null)?.dataset.id;
      if (id) panToResupply(id);
    });
  }

  document.getElementById('resupply-all')?.addEventListener('click', () => setAllResupply(true));
  document.getElementById('resupply-none')?.addEventListener('click', () => setAllResupply(false));

  const filter = document.getElementById('resupply-filter') as HTMLInputElement | null;
  filter?.addEventListener('input', () => {
    resupplyFilter = filter.value;
    renderResupplyList();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

/**
 * Boot the plan page.
 *
 * @param trailId  The key plan state is persisted under.
 * @param preloadedTrail  An already-loaded trail — passed by the imported-trail
 *   plan page (`my-plan.html`), which reads from IndexedDB instead of
 *   `/data/generated/{id}.json`. When omitted the trail is fetched as before.
 */
export async function initPlanViewer(trailId: string, preloadedTrail?: Trail): Promise<void> {
  const data = preloadedTrail ?? await loadTrailData(trailId);
  if (!data) {
    document.body.innerHTML = `<div style="padding:2rem;text-align:center">
      <h2>Trail data not found</h2>
      <p><a href="index.html">← Back to trail</a></p>
    </div>`;
    return;
  }

  // `scheduleSave` writes plan state under `trail.config.id` while it is read
  // below under `trailId`. Normalise so a preloaded trail whose stored config
  // drifted from its record key can never save to a different slot than it
  // loads from.
  if (data.config.id !== trailId) {
    data.config.id = trailId;
  }

  trail = data;

  // The stored document, a one-off migration of the pre-day-planner
  // `trail-plan-<id>` save, or a fresh empty plan. A server copy, when Phase 3c
  // lands, is applied over whatever this returns before the first render.
  plan = loadOrMigratePlan(trailId, trail).plan;
  showAllWaypoints = loadPlanUiPrefs(trailId).showAllWaypoints;

  // Module state outlives a boot (`my-plan.html` can reboot with another trail),
  // so the per-trail caches are cleared here rather than only on a direction flip.
  reversedTrail = null;
  resetResupplyCaches();
  activeTab = 'days';
  resupplyFilter = '';
  stopsFilter = '';
  selectedDayIndex = null;

  refreshActiveStops();
  initMap();
  initHeader();
  initTabs();
  initStopsControls();
  initResupplyControls();
  initCollapsibles();
  setupElevationHover();

  renderAll();

  // Redraw elevation on resize
  window.addEventListener('resize', debounce(() => {
    drawElevationProfile();
    map?.invalidateSize();
  }, 150));

  // The elevation profile is canvas-drawn, so it has to be repainted by hand
  // when the theme changes.
  onThemeChange(() => drawElevationProfile());
}
