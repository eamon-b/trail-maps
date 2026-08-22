// Trail viewer module - extracted from inline script to fix Vite HTML proxy issues
// This module handles map, elevation profile, waypoints table, and direction reversal

import type * as Leaflet from 'leaflet';
import { findNearestByDistance } from '@lib/track-geometry';
import { createReversedTrail } from '@lib/trail-reverse';
import { getDirectionLabel as directionLabelFor } from '@lib/plan-direction';
// Shared with the upload/my-trail pages, and — unlike a `textContent` round
// trip through a detached div — it escapes quotes, so the same helper is safe
// in an attribute value as in a text node. That matters here: `autoLinkUrls`
// puts its result inside `href="…"`, and imported GPX supplies every waypoint
// name, type and description on this page.
import { escapeHtml } from '../web-utils';
declare const L: typeof Leaflet;

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number;
  dist: number;
}

interface Waypoint {
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
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: #666;">Map unavailable. Please check your internet connection or try disabling ad blockers.</p>';
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
      mapContainer.innerHTML = '<p style="padding: 2rem; text-align: center; color: #666;">Failed to load map. Please try refreshing the page.</p>';
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
    }).addTo(map!).bindPopup(`
      <strong>${escapeHtml(wp.name || 'Waypoint')}</strong><br>
      ${escapeHtml(wp.type || 'waypoint')}<br>
      ${(wp.totalDistance || 0).toFixed(1)} km along trail
      ${wp.elevation ? `<br>${Math.round(wp.elevation)}m elevation` : ''}
      <br><a href="#" class="popup-show-in-table" data-waypoint-index="${index}">Show in table</a>
    `);

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
          <td><span class="waypoint-type">${escapeHtml(wp.type)}</span></td>
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

  // Draw elevation (Y) axis grid lines and labels
  ctx.fillStyle = '#666';
  ctx.font = '12px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of eleTicks) {
    const y = padding.top + height - ((tick - eleMin) / eleRange) * height;
    ctx.strokeStyle = '#ddd';
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
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + height);
    ctx.stroke();
    ctx.fillText(`${Math.round(tick)} km`, x, padding.top + height + 5);
  }

  // Draw elevation profile line
  ctx.beginPath();
  ctx.strokeStyle = '#2196F3';
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
  ctx.fillStyle = 'rgba(33, 150, 243, 0.1)';
  ctx.fill();
}

function renderWaypoints(waypoints: Waypoint[] | undefined, alternates: RouteVariant[] | undefined, sideTrips: RouteVariant[] | undefined, offTrailWaypoints?: OffTrailWaypoint[]): void {
  const container = document.getElementById('waypoints-container')!;

  if ((!waypoints || waypoints.length === 0) && (!offTrailWaypoints || offTrailWaypoints.length === 0)) {
    container.innerHTML = '<p>No waypoints defined</p>';
    return;
  }

  const resupplyKeywords = ['grocer', 'market', 'foodland', 'iga', 'wool', 'coles', 'general', 'servo'];

  function isResupply(wp: Waypoint): boolean {
    const text = ((wp.name || '') + ' ' + (wp.description || '')).toLowerCase();
    return resupplyKeywords.some(kw => text.includes(kw));
  }

  function getRowClass(wp: Waypoint): string {
    if (wp.type === 'town') return 'highlight-town';
    if (isResupply(wp)) return 'highlight-resupply';
    return '';
  }

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

  interface TableRow {
    rowType: 'waypoint' | 'variant-start' | 'variant-end';
    distance: number;
    data: Waypoint | RouteVariant;
    waypointIndex?: number;
  }

  const allVariants = [...(alternates || []), ...(sideTrips || [])];
  const tableRows: TableRow[] = [];

  (waypoints || []).forEach((wp, waypointIndex) => {
    tableRows.push({
      rowType: 'waypoint',
      distance: wp.totalDistance ?? 0,
      data: wp,
      waypointIndex
    });
  });

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

  tableRows.sort((a, b) => a.distance - b.distance);

  function renderWaypointRow(wp: Waypoint, waypointIndex: number): string {
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
        <td><span class="waypoint-type ${getTypeClass(wp.type)}">${escapeHtml(wp.type || 'waypoint')}</span></td>
        <td class="numeric">${wp.elevation ?? '-'}</td>
        <td class="numeric">${wp.distance?.toFixed(1) ?? '-'}</td>
        <td class="numeric">${wp.totalDistance?.toFixed(1) ?? '-'}</td>
        <td class="numeric">${wp.ascent ?? '-'}</td>
        <td class="numeric">${wp.descent ?? '-'}</td>
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

  // Render off-trail waypoint rows
  const offTrail = offTrailWaypoints || [];
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
        <td><span class="waypoint-type ${getTypeClass(wp.type)}">${escapeHtml(wp.type || 'waypoint')}</span></td>
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
    ${offTrail.map((wp, i) => renderOffTrailRow(wp, i)).join('')}
  ` : '';

  const tableHtml = `
    <table class="waypoints-table">
      <thead>
        <tr>
          <th>Location</th>
          <th>Type</th>
          <th>Elev (m)</th>
          <th>Dist (km)</th>
          <th>Total (km)</th>
          <th>Gain (m)</th>
          <th>Loss (m)</th>
          <th>Total Gain</th>
          <th>Total Loss</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows.map(row => {
          if (row.rowType === 'waypoint') {
            return renderWaypointRow(row.data as Waypoint, row.waypointIndex!);
          } else if (row.rowType === 'variant-start') {
            return renderVariantRow(row.data as RouteVariant, true);
          } else {
            return renderVariantRow(row.data as RouteVariant, false);
          }
        }).join('')}
        ${offTrailSection}
      </tbody>
    </table>
  `;

  container.innerHTML = tableHtml;
}

function exportDatasheet(trail: Trail): void {
  const { config, track, waypoints, alternates, sideTrips } = trail;

  const lines: string[] = [];

  lines.push(`# ${config.name} - Trail Datasheet`);
  lines.push(`# Region: ${config.region}`);
  lines.push(`# Total Distance: ${track.totalDistance.toFixed(1)} km`);
  lines.push(`# Total Ascent: ${Math.round(track.totalAscent)} m`);
  lines.push(`# Total Descent: ${Math.round(track.totalDescent)} m`);
  lines.push(`# Generated: ${new Date().toISOString().split('T')[0]}`);
  lines.push('');

  lines.push('Location,Type,Elevation (m),Distance (km),Total (km),Gain (m),Loss (m),Total Gain (m),Total Loss (m),Notes');

  for (const wp of waypoints || []) {
    const row = [
      `"${(wp.name || 'Unnamed').replace(/"/g, '""')}"`,
      wp.type || 'waypoint',
      wp.elevation ?? '',
      wp.distance?.toFixed(1) ?? '',
      wp.totalDistance?.toFixed(1) ?? '',
      wp.ascent ?? '',
      wp.descent ?? '',
      wp.totalAscent ?? '',
      wp.totalDescent ?? '',
      `"${(wp.description || '').replace(/"/g, '""')}"`
    ];
    lines.push(row.join(','));
  }

  if (alternates && alternates.length > 0) {
    lines.push('');
    lines.push('# Alternate Routes');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km),End Distance (km)');
    for (const alt of alternates) {
      const row = [
        `"${(alt.name || 'Unnamed').replace(/"/g, '""')}"`,
        alt.type || 'alternate',
        alt.distance ?? '',
        alt.elevation?.ascent ?? '',
        alt.elevation?.descent ?? '',
        alt.startDistance?.toFixed(1) ?? '',
        alt.endDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  if (sideTrips && sideTrips.length > 0) {
    lines.push('');
    lines.push('# Side Trips');
    lines.push('Name,Type,Distance (km),Ascent (m),Descent (m),Start Distance (km)');
    for (const trip of sideTrips) {
      const row = [
        `"${(trip.name || 'Unnamed').replace(/"/g, '""')}"`,
        trip.type || 'side-trip',
        trip.distance ?? '',
        trip.elevation?.ascent ?? '',
        trip.elevation?.descent ?? '',
        trip.startDistance?.toFixed(1) ?? ''
      ];
      lines.push(row.join(','));
    }
  }

  const offTrail = trail.offTrailWaypoints;
  if (offTrail && offTrail.length > 0) {
    lines.push('');
    lines.push('# Off-Trail Waypoints');
    lines.push('Name,Type,Distance From Trail (m),Notes');
    for (const wp of offTrail) {
      const row = [
        `"${(wp.name || 'Unnamed').replace(/"/g, '""')}"`,
        wp.type || 'waypoint',
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
  link.download = `${exportBaseName(config)}-datasheet.csv`;
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
 */
export async function initTrailViewer(trailId: string, preloadedTrail?: Trail): Promise<void> {
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

  document.querySelector('.waypoints-table tbody')?.addEventListener('click', (e) => {
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

  // Keyboard accessibility for waypoint and variant rows
  document.querySelector('.waypoints-table tbody')?.addEventListener('keydown', (e: Event) => {
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
}
