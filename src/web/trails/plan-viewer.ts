/**
 * Plan viewer — web trip planner for multi-day hiking.
 *
 * Three-panel layout: left (Days/Stops tabs), center (map + elevation), right (datasheet).
 * Plans are persisted to localStorage.
 */

import type * as Leaflet from 'leaflet';
declare const L: typeof Leaflet;

import type { PlanTrackPoint, PlanWaypoint, StopData, ComputedDay, PlanState } from '@lib/plan-types';
import { computeDays } from '@lib/day-calculator';
import { analyzeResupply } from '@lib/resupply-calculator';
import { analyzeWaterCarry } from '@lib/water-carry-calculator';
import { loadPlanState, savePlanState } from './plan-state';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Trail {
  config: {
    id: string;
    name: string;
    shortName?: string;
    region?: string;
  };
  track: {
    points: PlanTrackPoint[];
    displayPoints?: PlanTrackPoint[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints?: PlanWaypoint[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let trail: Trail;
let planState: PlanState = { name: '', startDate: null, stops: [] };
let currentDays: ComputedDay[] = [];
let selectedDayIndex: number | null = null;
let activeTab: 'days' | 'stops' = 'days';
let stopsFilter = '';
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
  waypoint: '\u{1F4CD}',
};

function waypointIcon(type?: string): string {
  return WAYPOINT_ICONS[type ?? ''] ?? '\u{1F4CD}';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: unknown): string {
  if (text == null) return '';
  const d = document.createElement('div');
  d.textContent = String(text);
  return d.innerHTML;
}

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

function isStop(km: number): boolean {
  return planState.stops.some(s => Math.abs(s.km - km) < 0.01);
}

function getDayColors(count: number): string[] {
  const palette = ['#ef4444','#f97316','#eab308','#22c55e','#06b6d4','#3b82f6','#8b5cf6','#ec4899'];
  const colors: string[] = [];
  for (let i = 0; i < count; i++) colors.push(palette[i % palette.length]);
  return colors;
}

function findNearestByDistance(points: PlanTrackPoint[], targetKm: number): number {
  if (points.length === 0) return 0;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < targetKm) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(points[lo - 1].dist - targetKm) < Math.abs(points[lo].dist - targetKm)) return lo - 1;
  return lo;
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
    if (el) el.innerHTML = '<p style="padding:2rem;text-align:center;color:#666">Map unavailable.</p>';
    return;
  }

  map = L.map('plan-map', { zoomControl: true, scrollWheelZoom: true });

  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: 'Map data: &copy; OpenStreetMap contributors, SRTM | Map style: &copy; OpenTopoMap',
  }).addTo(map);

  L.control.scale({ metric: true, imperial: false }).addTo(map);

  stopMarkers = L.layerGroup().addTo(map);

  // Base trail polyline (always visible, muted)
  const displayPoints = trail.track.displayPoints ?? trail.track.points;
  const latLngs = displayPoints.map(p => [p.lat, p.lon] as [number, number]);
  basePolyline = L.polyline(latLngs, { color: '#aaa', weight: 3, opacity: 0.55 }).addTo(map);

  // Fit map
  if (latLngs.length > 0) {
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

  const waypoints = trail.waypoints ?? [];
  waypoints.forEach(wp => {
    const km = wp.totalDistance ?? 0;
    const type = wp.type ?? 'waypoint';
    const icon = waypointIcon(type);
    const isSelected = isStop(km);
    const className = `waypoint-marker ${type}${isSelected ? ' is-stop' : ''}`;
    const divIcon = L.divIcon({
      className: '',
      html: `<div class="${escapeHtml(className)}" title="${escapeHtml(wp.name)}">${icon}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    });
    const marker = L.marker([wp.lat ?? 0, wp.lon ?? 0], { icon: divIcon });
    marker.on('click', () => toggleStop(km, wp.name ?? 'Stop'));
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

  days.forEach((day, i) => {
    const startIdx = findNearestByDistance(trail.track.points, day.startKm);
    const endIdx = findNearestByDistance(trail.track.points, day.endKm);
    const slice = trail.track.points.slice(
      Math.min(startIdx, endIdx),
      Math.max(startIdx, endIdx) + 1
    );
    const latLngs = slice.map(p => [p.lat, p.lon] as [number, number]);
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
  planState.stops.forEach(stop => {
    // Find waypoint position
    const wp = (trail.waypoints ?? []).find(w => Math.abs((w.totalDistance ?? 0) - stop.km) < 0.01);
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

  const pts = trail.track.points;
  if (pts.length === 0) return;

  const elevations = pts.map(p => p.ele);
  const { min: minEle, max: maxEle } = getMinMax(elevations);
  const maxDist = trail.track.totalDistance;

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

  // Elevation axis
  ctx.fillStyle = '#666';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of eleTicks) {
    const y = PAD.top + height - ((tick - eleMin) / eleRange) * height;
    ctx.strokeStyle = '#ddd';
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
  ctx.fillStyle = '#666';
  for (const tick of distTicks) {
    const x = PAD.left + (tick / maxDist) * width;
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, PAD.top);
    ctx.lineTo(x, PAD.top + height);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)} km`, x, PAD.top + height + 4);
  }

  // Full trail — light grey
  ctx.beginPath();
  ctx.strokeStyle = '#ccc';
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
      ctx.strokeStyle = '#3b82f6';
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
  planState.stops.forEach(stop => {
    const x = PAD.left + (stop.km / maxDist) * width;
    ctx.strokeStyle = '#3b82f6';
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
    const ptIdx = findNearestByDistance(trail.track.points, km);
    const pt = trail.track.points[ptIdx];
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

  if (days.length === 1 && planState.stops.length === 0) {
    container.innerHTML = `<p class="days-empty">Add stops in the Stops tab to split the trail into days.</p>`;
    renderResupplySection();
    renderWaterCarrySection();
    return;
  }

  container.innerHTML = days.map((day, i) => {
    const dateStr = day.date ? `<span class="day-card-date">${formatDate(day.date)}</span>` : '';
    const waterStr = day.waterSources > 0
      ? `<span class="water-info">💧 ${day.waterSources} water</span>`
      : '<span>💧 0 water</span>';
    const selected = selectedDayIndex === i ? ' selected' : '';
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

function renderResupplySection(): void {
  const section = document.getElementById('resupply-section');
  const body = document.getElementById('resupply-body');
  if (!section || !body) return;

  const waypoints = trail.waypoints ?? [];
  const analysis = analyzeResupply(waypoints, trail.track.totalDistance);

  if (!analysis.hasResupplyData) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  body.innerHTML = analysis.gaps.map(g => {
    const warn = g.isLong ? ' gap-warn' : ' gap-ok';
    const badge = g.isLong ? ' ⚠️ LONG' : '';
    return `<div class="gap-item">
      <span class="${warn}">🍎${badge}</span>
      <span>${escapeHtml(g.fromName)} → ${escapeHtml(g.toName)}: ${g.distanceKm} km (~${g.estimatedDays}d)</span>
    </div>`;
  }).join('');
}

function renderWaterCarrySection(): void {
  const section = document.getElementById('water-section');
  const body = document.getElementById('water-body');
  if (!section || !body) return;

  const waypoints = trail.waypoints ?? [];
  const analysis = analyzeWaterCarry(waypoints, trail.track.totalDistance);

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

  const waypoints = (trail.waypoints ?? []).filter(wp =>
    !stopsFilter || (wp.name ?? '').toLowerCase().includes(stopsFilter.toLowerCase())
  );

  if (waypoints.length === 0) {
    container.innerHTML = '<p style="padding:1rem;font-size:0.85rem;color:#888;">No waypoints match.</p>';
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
    return `<div class="stop-row${selected ? ' is-stop' : ''}" data-km="${km}">
      <span class="stop-check">${checkmark}</span>
      <span class="stop-type-icon">${icon}</span>
      <span class="stop-name">${escapeHtml(wp.name)}</span>
      <span class="stop-km">${km.toFixed(1)} km</span>
      ${gap ? `<span class="stop-gap">(${gap})</span>` : ''}
    </div>`;
  }).join('');

  container.querySelectorAll('.stop-row').forEach(row => {
    row.addEventListener('click', () => {
      const km = parseFloat((row as HTMLElement).dataset.km ?? '0');
      const found = (trail.waypoints ?? []).find(w => Math.abs((w.totalDistance ?? 0) - km) < 0.01);
      const name = found?.name ?? 'Stop';
      toggleStop(km, name);
    });
  });
}

// ---------------------------------------------------------------------------
// Right panel — Datasheet
// ---------------------------------------------------------------------------

function renderDayDatasheet(day: ComputedDay | null): void {
  const title = document.getElementById('datasheet-title');
  const subtitle = document.getElementById('datasheet-subtitle');
  const body = document.getElementById('datasheet-body');
  if (!title || !subtitle || !body) return;

  const waypoints = trail.waypoints ?? [];

  if (!day) {
    title.textContent = 'All waypoints';
    subtitle.textContent = '';
    body.innerHTML = waypoints.map((wp, i) => {
      const km = wp.totalDistance ?? 0;
      const prevKm = i > 0 ? (waypoints[i - 1].totalDistance ?? 0) : null;
      const deltaStr = prevKm !== null ? `+${(km - prevKm).toFixed(1)} km` : 'start';
      return `<div class="ds-row">
        <span class="ds-type-icon">${waypointIcon(wp.type)}</span>
        <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}</span>
        <span class="ds-km">${km.toFixed(1)}<br><small style="color:#aaa">${deltaStr}</small></span>
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
      <span class="ds-type-icon">${waypointIcon(wp.type)}</span>
      <span class="ds-name" title="${escapeHtml(wp.name)}">${escapeHtml(wp.name)}</span>
      <span class="ds-km">${km.toFixed(1)}<br><small style="color:#aaa">+${delta}</small></span>
    </div>`);
    prevKm = km;
  });

  // End row
  rows.push(`<div class="ds-row ds-end">
    <span class="ds-type-icon">\u26FA</span>
    <span class="ds-name">${escapeHtml(day.endName)}</span>
    <span class="ds-km">${day.endKm.toFixed(1)} km</span>
  </div>`);

  body.innerHTML = rows.join('');
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
      const startIdx = findNearestByDistance(trail.track.points, day.startKm);
      const endIdx = findNearestByDistance(trail.track.points, day.endKm);
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const slice = trail.track.points.slice(lo, hi + 1);
      if (slice.length > 0) {
        const latLngs = slice.map(p => [p.lat, p.lon] as [number, number]);
        map.fitBounds(L.polyline(latLngs).getBounds(), { padding: [30, 30] });
      }
    }
  }
}

function toggleStop(km: number, name: string): void {
  const existingIdx = planState.stops.findIndex(s => Math.abs(s.km - km) < 0.01);
  if (existingIdx >= 0) {
    planState.stops = planState.stops.filter((_, i) => i !== existingIdx);
  } else {
    const stop: StopData = { km, waypointName: name };
    const insertIdx = planState.stops.findIndex(s => s.km > km);
    if (insertIdx === -1) planState.stops.push(stop);
    else planState.stops.splice(insertIdx, 0, stop);
  }

  scheduleSave();
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

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function scheduleSave(): void {
  setSaveStatus('unsaved');
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    savePlanState(trail.config.id, planState);
    setSaveStatus('saved');
  }, 800);
}

function setSaveStatus(status: 'saved' | 'unsaved'): void {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = status === 'saved' ? 'Saved' : 'Unsaved…';
  el.className = status === 'saved' ? '' : 'unsaved';
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

function initTabs(): void {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = (btn as HTMLElement).dataset.tab as 'days' | 'stops';
      activeTab = tab;
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${tab}`)?.classList.add('active');
      if (tab === 'stops') renderStopList();
    });
  });
}

// ---------------------------------------------------------------------------
// Render all
// ---------------------------------------------------------------------------

function renderAll(): void {
  currentDays = computeDays(trail, planState.stops, planState.startDate);
  // Clamp selectedDayIndex in case stops were removed
  if (selectedDayIndex !== null && selectedDayIndex >= currentDays.length) {
    selectedDayIndex = null;
  }
  renderDayList();
  if (activeTab === 'stops') renderStopList();

  const selectedDay = selectedDayIndex !== null ? currentDays[selectedDayIndex] ?? null : null;
  renderDayDatasheet(selectedDay);

  redrawMapLayers();
  drawElevationProfile();
}

// ---------------------------------------------------------------------------
// Header bindings
// ---------------------------------------------------------------------------

function initHeader(): void {
  const nameInput = document.getElementById('plan-name-input') as HTMLInputElement;
  const dateInput = document.getElementById('plan-start-date') as HTMLInputElement;

  if (nameInput) {
    nameInput.value = planState.name;
    nameInput.addEventListener('input', () => setPlanName(nameInput.value));
  }

  if (dateInput) {
    dateInput.value = planState.startDate ?? '';
    dateInput.addEventListener('change', () => setStartDate(dateInput.value));
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
// Init
// ---------------------------------------------------------------------------

export async function initPlanViewer(trailId: string): Promise<void> {
  const data = await loadTrailData(trailId);
  if (!data) {
    document.body.innerHTML = `<div style="padding:2rem;text-align:center">
      <h2>Trail data not found</h2>
      <p><a href="index.html">← Back to trail</a></p>
    </div>`;
    return;
  }

  trail = data;

  // Load or create plan
  const saved = loadPlanState(trailId);
  if (saved) {
    planState = saved;
  } else {
    planState = { name: `My ${trail.config.shortName ?? trail.config.name} plan`, startDate: null, stops: [] };
  }

  initMap();
  initHeader();
  initTabs();
  initStopsFilter();
  initCollapsibles();
  setupElevationHover();

  renderAll();

  // Redraw elevation on resize
  window.addEventListener('resize', debounce(() => {
    drawElevationProfile();
    map?.invalidateSize();
  }, 150));
}
