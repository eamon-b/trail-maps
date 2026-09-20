/**
 * Plan viewer — web trip planner for multi-day hiking.
 *
 * Three-panel layout: left (Days/Stops/Resupply tabs), center (map + elevation),
 * right (datasheet — the selected day, or the resupply plan while that tab is open).
 * Plans are persisted to localStorage.
 */

import type * as Leaflet from 'leaflet';
declare const L: typeof Leaflet;

import type { PlanTrackPoint, PlanWaypoint, StopData, ComputedDay, PlanState, Pace } from '@lib/plan-types';
import { PACE_KMH, isPace } from '@lib/plan-types';
import { computeDays } from '@lib/day-calculator';
import { findNearestByDistance } from '@lib/track-geometry';
import {
  routeBreakCrossings,
  routeBreakStarts,
  sliceAcrossRouteBreaks,
  splitAtRouteBreaks,
} from '@lib/route-breaks';
import type { RouteBreak } from '@lib/trail-types';
import {
  allResupplyOptionIds,
  computeResupplyLegs,
  listResupplyOptions,
  plannedResupplyIds,
  resolveResupplyStops,
  summariseResupplyLegs,
  type ResupplyLeg,
  type ResupplyOption,
  type ResupplyOptionGroup,
} from '@lib/resupply-plan';
import { accessSummary, firstSentence, resupplySummaryText } from '@lib/resupply-display';
import { analyzeWaterCarry } from '@lib/water-carry-calculator';
import { createReversedTrail } from '@lib/trail-reverse';
import { trailElevationIsUsable } from '@lib/elevation-backfill';
import { KM_EPSILON, getDirectionLabel, stopsToActive, toNoboKm, type PlanDirection } from '@lib/plan-direction';
import { baseWaypointType, waypointTypeLabel } from '@lib/waypoint-taxonomy';
import { loadPlanState, savePlanState } from './plan-state';
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
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * Starting positions of the two header inputs, used for a plan saved before they
 * existed. They are the initial value of a control the hiker can see and change,
 * not a figure the page holds on their behalf.
 */
const DEFAULT_PACE: Pace = 'average';
const DEFAULT_DAILY_HOURS = 8;
/** The range the number input offers; a hand-edited plan is clamped into it. */
const MIN_DAILY_HOURS = 1;
const MAX_DAILY_HOURS = 16;

let trail: Trail;
/** Lazily-built reversed copy of `trail`; only computed when SOBO is first viewed. */
let reversedTrail: Trail | null = null;
let planState: PlanState = { name: '', startDate: null, stops: [] };
let currentDays: ComputedDay[] = [];
let selectedDayIndex: number | null = null;
type PlanTab = 'days' | 'stops' | 'resupply';
let activeTab: PlanTab = 'days';
let stopsFilter = '';
let resupplyFilter = '';
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
// planState.stops[].km is ALWAYS stored NOBO-absolute (the trail as built).
// Everything at runtime — renderers, computeDays, marker clicks — works in
// "active" km, i.e. the currently viewed direction. The only conversions are:
//   storage -> active: activeStops() (used by renderAll and the renderers)
//   active -> storage: toNoboKm() in toggleStop()
// No renderer may branch on direction; they just read activeTrail()/activeStops().

function direction(): PlanDirection {
  return planState.direction ?? 'NOBO';
}

/**
 * The hiker's pace and hours per day. Both are inputs in the header; these
 * defaults are only the initial value of the control, for a plan saved before
 * the inputs existed — nothing on this page decides how far a day is.
 */
function pace(): Pace {
  return planState.pace ?? DEFAULT_PACE;
}

function baseKmh(): number {
  return PACE_KMH[pace()];
}

function dailyHours(): number {
  return planState.dailyHours ?? DEFAULT_DAILY_HOURS;
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
let cachedActiveStops: StopData[] = [];

function refreshActiveStops(): void {
  cachedActiveStops = stopsToActive(planState.stops, direction(), trail.track.totalDistance);
}

/** Stored stops mapped into active-direction km, sorted ascending. */
function activeStops(): StopData[] {
  return cachedActiveStops;
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
  // Markers are drawn once by initMap() before the first renderAll(), so the
  // planned set has to start empty rather than carry another trail's plan into
  // a reboot (my-plan.html boots this module again per imported trail).
  cachedPlannedIds = null;
  cachedPlannedStops = [];
}

function resupplyGroups(): ResupplyOptionGroup[] {
  const key = direction();
  if (key !== cachedResupplyGroupsKey) {
    cachedResupplyGroups = listResupplyOptions(activeTrail().waypoints);
    cachedResupplyGroupsKey = key;
  }
  return cachedResupplyGroups;
}

// The web pages are metric; the shared display helpers take the formatter so the
// phone can follow the hiker's unit setting with the same words.
const formatKm = (km: number): string => `${km.toFixed(1)} km`;
const formatFoodKg = (kg: number): string => `${kg.toFixed(1)} kg`;

/** The ticked ids. An absent `resupplyStops` means every option, as on a fresh plan. */
function selectedResupplyIds(): Set<string> {
  return new Set(planState.resupplyStops ?? allResupplyOptionIds(resupplyGroups()));
}

/**
 * The waypoints the hiker's selection marks as *planned* resupply stops.
 *
 * Same contract as the phone's `usePlannedResupplyIds`: `null` — nothing chosen
 * yet — highlights nothing. The every-option default feeds the legs, but
 * painting every town as planned before anyone planned anything would be noise.
 *
 * Refreshed once per `renderAll()` rather than read per row: the km list behind
 * it is a scan of the trail's waypoints, and the Days tab alone asks about every
 * one of them.
 */
let cachedPlannedIds: ReadonlySet<string> | null = null;
/**
 * The planned waypoints themselves, in active-direction km — a handful even on
 * the CDT, so the day cards and the profile ask this list rather than scanning
 * the trail's waypoints once per day.
 */
let cachedPlannedStops: Array<{ km: number; name: string }> = [];

function refreshPlannedResupply(): void {
  const selected = planState.resupplyStops ? new Set(planState.resupplyStops) : null;
  cachedPlannedIds = plannedResupplyIds(resupplyGroups(), selected);
  const planned = cachedPlannedIds;
  cachedPlannedStops = planned
    ? (activeTrail().waypoints ?? [])
        .filter(wp => wp.id !== undefined && planned.has(wp.id))
        .map(wp => ({ km: wp.totalDistance ?? 0, name: wp.name ?? 'Resupply' }))
    : [];
}

/**
 * True once the hiker has planned at least one stop. An explicit empty
 * selection is a real choice, but it badges nothing, so the surfaces that only
 * exist to explain the badge (the legend, the profile's ticks) stay away.
 */
function hasResupplyPlan(): boolean {
  return cachedPlannedStops.length > 0;
}

function isPlannedResupply(wp: { id?: string }): boolean {
  return cachedPlannedIds !== null && wp.id !== undefined && cachedPlannedIds.has(wp.id);
}

/**
 * The same question for a row named only by km — a day boundary in the
 * datasheet, whose start/end names come from the day plan, not a waypoint.
 */
function isPlannedResupplyKm(km: number): boolean {
  return cachedPlannedStops.some(stop => Math.abs(stop.km - km) < KM_EPSILON);
}

/** The planned stops inside a km range, named — the day card's tooltip. */
function plannedNamesBetween(startKm: number, endKm: number): string[] {
  return cachedPlannedStops
    .filter(stop => stop.km >= startKm - KM_EPSILON && stop.km <= endKm + KM_EPSILON)
    .map(stop => stop.name);
}

/**
 * The one marking of a planned stop, so every surface says the same thing.
 * `names` spells out which places it is, where the row is a day rather than a
 * waypoint; `title` is what makes the badge self-explanatory without a legend.
 */
function plannedBadge(names: readonly string[] = []): string {
  const title = names.length > 0
    ? `Planned resupply: ${names.join(', ')}`
    : 'Planned resupply — ticked in the Resupply tab';
  return `<span class="planned-badge" title="${escapeHtml(title)}">Planned resupply</span>`;
}

function resupplyLegs(): ResupplyLeg[] {
  // Arrival days move when a camp stop moves, not only when one is added, so the
  // day boundaries themselves are part of the key.
  const key = [
    direction(),
    JSON.stringify(planState.resupplyStops ?? null),
    planState.startDate ?? '',
    pace(),
    dailyHours(),
    currentDays.map(day => day.endKm).join(','),
  ].join('|');

  if (key !== cachedResupplyLegsKey) {
    const stops = resolveResupplyStops(resupplyGroups(), planState.resupplyStops);
    cachedResupplyLegs = computeResupplyLegs(activeTrail(), stops, {
      dailyHours: dailyHours(),
      baseKmh: baseKmh(),
      days: currentDays,
    });
    cachedResupplyLegsKey = key;
  }
  return cachedResupplyLegs;
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
  const optionIds = showingResupply ? new Set(allResupplyOptionIds(resupplyGroups())) : null;
  const pickedIds = showingResupply ? selectedResupplyIds() : null;

  const waypoints = activeTrail().waypoints ?? [];
  waypoints.forEach(wp => {
    const km = wp.totalDistance ?? 0; // active-direction km
    const type = wp.type ?? 'waypoint';
    const icon = waypointIcon(type);
    const isSelected = isStop(km);
    const isOption = optionIds !== null && wp.id !== undefined && optionIds.has(wp.id);
    const isPicked = isOption && pickedIds!.has(wp.id!);
    // A planned stop keeps its ring on every tab, and the ring wins over the
    // camp-stop border where a marker is both. The ring is the whole marking —
    // the title stays the plain name, which is what the map's tooltip is for.
    const isPlanned = isPlannedResupply(wp);
    const className = `waypoint-marker ${type}${isSelected || isPicked ? ' is-stop' : ''}` +
      `${isPlanned ? ' planned-resupply' : ''}`;
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
    // Every other marker, and every marker on the other tabs, is a camp stop.
    marker.on('click', () => {
      if (isOption) toggleResupply(wp.id!);
      else toggleStop(km, wp.name ?? 'Stop');
    });
    marker.addTo(map!);
    waypointMarkers.push({ marker, waypoint: wp });
  });
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
      html: `<div class="stop-flag-icon" title="${escapeHtml(stop.waypointName)}">⛺</div>`,
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

  // Planned resupply stops — a short tick off the baseline, in the planned
  // colour, so the profile agrees with the lists about where the food runs out.
  if (hasResupplyPlan()) {
    const plannedColor = themeColor('--resupply-planned', '#c2410c');
    for (const stop of cachedPlannedStops) {
      const x = PAD.left + (stop.km / maxDist) * width;
      ctx.strokeStyle = plannedColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, PAD.top + height);
      ctx.lineTo(x, PAD.top + height - 10);
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

  if (days.length === 1 && planState.stops.length === 0) {
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
    // A day is "planned resupply" when one of the ticked stops falls inside it,
    // its own ends included: the day you walk into town is the day it matters.
    const plannedNames = plannedNamesBetween(day.startKm, day.endKm);
    const planned = plannedNames.length > 0;
    return `
      <div class="day-card${selected}${planned ? ' planned-resupply' : ''}" data-day-index="${i}">
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
          ${planned ? plannedBadge(plannedNames) : ''}
        </div>
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
  const line = summary.hasData ? resupplySummaryText(summary, formatKm, formatFoodKg) : 'No resupply stops ticked.';
  // Says what the badge on a day card, a stops row or a map marker means. Only
  // shown once there is a plan, because until then nothing is badged.
  const legend = hasResupplyPlan()
    ? `<div class="planned-legend">${plannedBadge()} marks a stop you ticked, wherever it appears.</div>`
    : '';
  body.innerHTML = `<div class="gap-item">
      <span class="gap-ok">🍎</span>
      <span>${escapeHtml(line)}</span>
    </div>
    ${legend}
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

function renderStopList(): void {
  const container = document.getElementById('stops-list');
  if (!container) return;

  const waypoints = (activeTrail().waypoints ?? []).filter(wp =>
    !stopsFilter || (wp.name ?? '').toLowerCase().includes(stopsFilter.toLowerCase())
  );

  if (waypoints.length === 0) {
    container.innerHTML = '<p style="padding:1rem;font-size:0.85rem;color:var(--text-secondary);">No waypoints match.</p>';
    return;
  }

  container.innerHTML = waypoints.map((wp, i) => {
    const km = wp.totalDistance ?? 0;
    const selected = isStop(km);
    const checkmark = selected ? '✓' : '\u00A0';
    const type = wp.type ?? 'waypoint';
    const icon = waypointIcon(type);
    // Gap from previous waypoint in filtered list
    const prevKm = i > 0 ? (waypoints[i - 1].totalDistance ?? 0) : 0;
    const gap = i > 0 ? `+${(km - prevKm).toFixed(1)}` : '';
    const planned = isPlannedResupply(wp);
    return `<div class="stop-row${selected ? ' is-stop' : ''}${planned ? ' planned-resupply' : ''}" data-km="${km}">
      <span class="stop-check">${checkmark}</span>
      <span class="stop-type-icon">${icon}</span>
      <span class="stop-name">${escapeHtml(wp.name)}</span>
      ${planned ? plannedBadge() : ''}
      <span class="stop-km">${km.toFixed(1)} km</span>
      ${gap ? `<span class="stop-gap">(${gap})</span>` : ''}
    </div>`;
  }).join('');

  container.querySelectorAll('.stop-row').forEach(row => {
    row.addEventListener('click', () => {
      const km = parseFloat((row as HTMLElement).dataset.km ?? '0');
      const found = (activeTrail().waypoints ?? []).find(w => Math.abs((w.totalDistance ?? 0) - km) < KM_EPSILON);
      const name = found?.name ?? 'Stop';
      toggleStop(km, name);
    });
  });
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
  const parts = [accessSummary(option, formatKm)];
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
      const planned = isPlannedResupply(wp);
      return `<div class="ds-row${planned ? ' planned-resupply' : ''}">
        <span class="ds-type-icon" title="${escapeHtml(waypointTypeLabel(wp.type))}">${waypointIcon(wp.type)}</span>
        <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}${planned ? plannedBadge() : ''}</span>
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

  // Start and end rows are named by the day plan, not by a waypoint record, so
  // they are matched on km — a day that begins or ends in a planned town is
  // badged like any other row.
  const startPlanned = isPlannedResupplyKm(day.startKm);
  rows.push(`<div class="ds-row ds-start${startPlanned ? ' planned-resupply' : ''}">
    <span class="ds-type-icon">\u{1F6A9}</span>
    <span class="ds-name">${escapeHtml(day.startName)}${startPlanned ? plannedBadge() : ''}</span>
    <span class="ds-km">${day.startKm.toFixed(1)} km</span>
  </div>`);

  // Intermediate waypoints
  let prevKm = day.startKm;
  inDay.forEach(wp => {
    const km = wp.totalDistance ?? 0;
    if (Math.abs(km - day.startKm) < 0.01 || Math.abs(km - day.endKm) < 0.01) return;
    const delta = (km - prevKm).toFixed(1);
    const planned = isPlannedResupply(wp);
    rows.push(`<div class="ds-row${planned ? ' planned-resupply' : ''}">
      <span class="ds-type-icon" title="${escapeHtml(waypointTypeLabel(wp.type))}">${waypointIcon(wp.type)}</span>
      <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}${planned ? plannedBadge() : ''}</span>
      <span class="ds-km">${km.toFixed(1)}<br><small style="color:var(--text-secondary)">+${delta}</small></span>
    </div>`);
    prevKm = km;
  });

  // End row
  const endPlanned = isPlannedResupplyKm(day.endKm);
  rows.push(`<div class="ds-row ds-end${endPlanned ? ' planned-resupply' : ''}">
    <span class="ds-type-icon">\u26FA</span>
    <span class="ds-name">${escapeHtml(day.endName)}${endPlanned ? plannedBadge() : ''}</span>
    <span class="ds-km">${day.endKm.toFixed(1)} km</span>
  </div>`);

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

  subtitle.textContent = resupplySummaryText(summary, formatKm, formatFoodKg);

  // The arrival day only means anything once the camp plan has stops and a date
  // to count them from; without both the column would be a row of dashes.
  const showArrive = activeStops().length > 0 && planState.startDate !== null;

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

/** @param km active-direction km (as shown in the UI); stored NOBO-absolute */
function toggleStop(km: number, name: string): void {
  const noboKm = toNoboKm(km, direction(), trail.track.totalDistance);
  const existingIdx = planState.stops.findIndex(s => Math.abs(s.km - noboKm) < KM_EPSILON);
  if (existingIdx >= 0) {
    planState.stops = planState.stops.filter((_, i) => i !== existingIdx);
  } else {
    const stop: StopData = { km: noboKm, waypointName: name };
    const insertIdx = planState.stops.findIndex(s => s.km > noboKm);
    if (insertIdx === -1) planState.stops.push(stop);
    else planState.stops.splice(insertIdx, 0, stop);
  }

  scheduleSave();
  renderAll();
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
  planState.resupplyStops = allResupplyOptionIds(resupplyGroups()).filter(optionId => picked.has(optionId));

  scheduleSave();
  renderAll();
}

function setAllResupply(all: boolean): void {
  planState.resupplyStops = all ? allResupplyOptionIds(resupplyGroups()) : [];
  scheduleSave();
  renderAll();
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
  planState.direction = dir;
  selectedDayIndex = null;
  scheduleSave();
  updateDirectionButton();
  // renderAll() recomputes days from the reoriented trail and rebuilds day
  // polylines, stop markers, waypoint markers, and the elevation profile.
  renderAll();
}

function setStartDate(date: string): void {
  planState.startDate = date || null;
  scheduleSave();
  renderAll();
}

function setPlanName(name: string): void {
  planState.name = name;
  scheduleSave();
}

/** Pace feeds both the day plan's hours and every resupply leg's days. */
function setPace(value: Pace): void {
  if (pace() === value) return;
  planState.pace = value;
  scheduleSave();
  renderAll();
}

/** Ignores a blank or non-numeric entry and clamps the rest to the input's range. */
function setDailyHours(raw: string): void {
  // `Number('')` is 0, which would clamp to the minimum rather than be ignored.
  if (raw.trim() === '') return;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return;
  const clamped = Math.min(MAX_DAILY_HOURS, Math.max(MIN_DAILY_HOURS, Math.round(parsed)));
  if (dailyHours() === clamped) return;
  planState.dailyHours = clamped;
  scheduleSave();
  renderAll();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scheduleSave(): void {
  setSaveStatus('unsaved');
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    const ok = savePlanState(trail.config.id, planState);
    setSaveStatus(ok ? 'saved' : 'error');
  }, 800);
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
  // Before any renderer asks: every tab, the datasheet, the markers and the
  // profile read the same set, so ticking a stop in the Resupply tab shows up
  // everywhere on the next render rather than on the next tab switch.
  refreshPlannedResupply();
  currentDays = computeDays(activeTrail(), activeStops(), planState.startDate, undefined, baseKmh());
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
  const paceSelect = document.getElementById('plan-pace') as HTMLSelectElement | null;
  const hoursInput = document.getElementById('plan-daily-hours') as HTMLInputElement | null;

  if (nameInput) {
    nameInput.value = planState.name;
    nameInput.addEventListener('input', () => setPlanName(nameInput.value));
  }

  if (dateInput) {
    dateInput.value = planState.startDate ?? '';
    dateInput.addEventListener('change', () => setStartDate(dateInput.value));
  }

  if (paceSelect) {
    // Built from PACE_KMH rather than the markup, so the label and the speed the
    // calculators walk at cannot drift apart.
    paceSelect.innerHTML = '';
    for (const [value, kmh] of Object.entries(PACE_KMH)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = `${value[0].toUpperCase()}${value.slice(1)} (${kmh} km/h)`;
      paceSelect.appendChild(option);
    }
    paceSelect.value = pace();
    paceSelect.addEventListener('change', () => {
      if (isPace(paceSelect.value)) setPace(paceSelect.value);
    });
  }

  if (hoursInput) {
    hoursInput.min = String(MIN_DAILY_HOURS);
    hoursInput.max = String(MAX_DAILY_HOURS);
    hoursInput.value = String(dailyHours());
    hoursInput.addEventListener('change', () => {
      setDailyHours(hoursInput.value);
      // A blank or out-of-range entry is rejected, so the box shows what is in force.
      hoursInput.value = String(dailyHours());
    });
  }

  if (directionBtn) {
    updateDirectionButton();
    directionBtn.addEventListener('click', () => {
      setDirection(direction() === 'NOBO' ? 'SOBO' : 'NOBO');
    });
  }
}

// ---------------------------------------------------------------------------
// Stops filter
// ---------------------------------------------------------------------------

function initStopsFilter(): void {
  const input = document.getElementById('stops-filter') as HTMLInputElement;
  if (!input) return;
  input.addEventListener('input', () => {
    stopsFilter = input.value;
    renderStopList();
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

  // Load or create plan
  const saved = loadPlanState(trailId);
  if (saved) {
    planState = saved;
  } else {
    planState = { name: `My ${trail.config.shortName ?? trail.config.name} plan`, startDate: null, stops: [] };
  }

  // Module state outlives a boot (`my-plan.html` can reboot with another trail),
  // so the per-trail caches are cleared here rather than only on a direction flip.
  reversedTrail = null;
  resetResupplyCaches();
  activeTab = 'days';
  resupplyFilter = '';

  refreshActiveStops();
  initMap();
  initHeader();
  initTabs();
  initStopsFilter();
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
