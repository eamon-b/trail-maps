/**
 * Web presentation of OpenStreetMap points of interest on the trail page.
 *
 * The platform-neutral half of this — labels, tag summaries, the interleave
 * ordering, the filter state, the route key — lives in `@lib/poi-display` so
 * the phone and the page cannot drift apart, and is re-exported below so this
 * module stays the one import the viewer needs. What is left here is what only
 * a browser has: emoji glyphs, HTML builders, `localStorage`.
 *
 * **Every string in a POI is untrusted.** Names, tag keys and tag values all go
 * through `escapeHtml` before they reach markup, and URLs are scheme-checked
 * (in `@lib/poi-display`) before they land in an `href` — an OSM `website` tag
 * is free text and can just as easily hold `javascript:`.
 *
 * POI data is © OpenStreetMap contributors (ODbL), hence `OSM_ATTRIBUTION` and
 * its appearance on every surface that shows a POI.
 */

import type { TrailPOI, TrailPOICategory } from '@lib/trail-types';
import {
  countPoisByCategory,
  defaultPoiFilterState,
  formatOffTrail,
  isPoiCategory,
  normalisePoiFilterState,
  poiCategoryLabel,
  poiDisplayName,
  poiOsmUrl,
  summarisePoiTags,
  visiblePois,
  OSM_ATTRIBUTION,
  POI_CATEGORIES,
  POI_CATEGORY_LABELS,
  type PoiFilterState,
  type PoiTagLine,
} from '@lib/poi-display';
import { escapeHtml } from '../web-utils';

// The shared half, re-exported so `trail-viewer.ts` and the imported-trail page
// keep importing POI behaviour from one place.
export {
  countPoisByCategory,
  defaultPoiFilterState,
  findPoiByRouteKey,
  formatOffTrail,
  interleavePoisByDistance,
  isPoiCategory,
  mirrorPoiDistances,
  normalisePoiFilterState,
  parsePoiRouteKey,
  poiCategoryLabel,
  poiDisplayName,
  poiOsmUrl,
  poiRouteKey,
  safeHttpUrl,
  safeTelUrl,
  slimPoi,
  summarisePoiTags,
  visiblePois,
  OSM_ATTRIBUTION,
  POI_CATEGORIES,
  POI_CATEGORY_LABELS,
  POI_DISPLAY_TAG_KEYS,
  PRIMARY_TAG_KEYS,
} from '@lib/poi-display';
export type { InterleavedEntry, PoiFilterState, PoiTagLine } from '@lib/poi-display';

/**
 * Marker glyphs. Deliberately a different set from `WAYPOINT_ICONS` in the
 * viewer — a POI marker must never be mistaken for a curated waypoint.
 */
export const POI_CATEGORY_ICONS: Record<TrailPOICategory, string> = {
  water: '\u{1F4A7}',
  camping: '⛺',
  resupply: '\u{1F6D2}',
  restaurant: '\u{1F37D}\uFE0F',
  transport: '\u{1F68C}',
  emergency: '\u{1F3E5}',
};

/** The credit line, shown wherever POI data is. */

/** Marker/badge glyph for a category, tolerating an unknown one. */
export function poiCategoryIcon(category: string): string {
  return isPoiCategory(category) ? POI_CATEGORY_ICONS[category] : '⭐';
}

/**
 * A stable per-POI key.
 *
 * OSM element ids are only unique *within* a type — a node and a way can both
 * be 12345 — so the key has to carry both.
 */
export function poiKey(poi: Pick<TrailPOI, 'type' | 'id'>): string {
  return `${poi.type}/${poi.id}`;
}

// === Markup ===

/** A category chip, used in popups and in the datasheet rows. */
export function poiCategoryBadgeHtml(category: string): string {
  const known = isPoiCategory(category) ? category : 'other';
  return (
    `<span class="poi-badge poi-cat-${escapeHtml(known)}">` +
    `<span class="poi-badge-icon" aria-hidden="true">${poiCategoryIcon(category)}</span>` +
    `${escapeHtml(poiCategoryLabel(category))}</span>`
  );
}

function tagLinesHtml(lines: PoiTagLine[]): string {
  if (lines.length === 0) return '';
  const items = lines
    .map(line => {
      const value = line.href
        ? `<a href="${escapeHtml(line.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(line.value)}</a>`
        : escapeHtml(line.value);
      return `<dt>${escapeHtml(line.label)}</dt><dd>${value}</dd>`;
    })
    .join('');
  return `<dl class="poi-tags">${items}</dl>`;
}

/** The Leaflet popup body for one POI. */
export function poiPopupHtml(poi: TrailPOI): string {
  return `
    <div class="poi-popup">
      <strong class="poi-popup-name">${escapeHtml(poiDisplayName(poi))}</strong>
      <div class="poi-popup-meta">${poiCategoryBadgeHtml(poi.category)}</div>
      <div class="poi-popup-dist">
        ${escapeHtml(poi.distanceAlongTrail.toFixed(1))} km along trail
        · ${escapeHtml(formatOffTrail(poi.distanceFromTrail))} off trail
      </div>
      ${tagLinesHtml(summarisePoiTags(poi.tags))}
      <a class="poi-osm-link" href="${escapeHtml(poiOsmUrl(poi))}" target="_blank" rel="noopener noreferrer">View on OpenStreetMap</a>
      <div class="poi-attribution">${escapeHtml(OSM_ATTRIBUTION)}</div>
    </div>
  `;
}

/**
 * One datasheet row for a POI.
 *
 * Deliberately carries **no** `data-waypoint-index`, `data-off-trail-index` or
 * `variant-expandable` hook: the delegated handler on `#waypoints-container`
 * matches on exactly those, so a POI row falls through every branch and can
 * never be mistaken for an expandable waypoint. Its only interactive parts are
 * the two explicit links.
 *
 * Column order mirrors the waypoints table (Location, Type, Elev, Leg/Dist,
 * Total, Gain, Loss, Total Gain, Total Loss). A POI has no place in the leg
 * arithmetic, so the leg column carries its off-trail distance — exactly what
 * the off-trail waypoint rows do — and the gain/loss columns are em dashes.
 */
export function poiRowHtml(poi: TrailPOI): string {
  const key = poiKey(poi);
  const ele = poi.tags?.ele;
  const eleNum = ele != null ? Number.parseFloat(ele) : NaN;
  return `
      <tr class="poi-row" data-poi-key="${escapeHtml(key)}">
        <td>
          <a class="poi-source-badge" href="${escapeHtml(poiOsmUrl(poi))}" target="_blank"
             rel="noopener noreferrer" title="Uncurated OpenStreetMap data — open the element">OSM</a>
          ${escapeHtml(poiDisplayName(poi))}
          <a href="#" class="poi-show-on-map" data-poi-key="${escapeHtml(key)}">show on map</a>
        </td>
        <td>${poiCategoryBadgeHtml(poi.category)}</td>
        <td class="numeric">${Number.isFinite(eleNum) ? escapeHtml(Math.round(eleNum)) : '—'}</td>
        <td class="numeric poi-off-trail">${escapeHtml(formatOffTrail(poi.distanceFromTrail))} off trail</td>
        <td class="numeric">${escapeHtml(poi.distanceAlongTrail.toFixed(1))}</td>
        <td class="numeric">—</td>
        <td class="numeric">—</td>
        <td class="numeric">—</td>
        <td class="numeric">—</td>
      </tr>
    `;
}

// === Persisted filter state ===

export const POI_FILTER_STORAGE_KEY = 'trail-maps-poi-filter';

/**
 * Read the persisted choice. Storage may be unavailable (private mode, blocked
 * site data) — the page still works, it just forgets.
 */
export function loadPoiFilterState(): PoiFilterState {
  try {
    const raw = localStorage.getItem(POI_FILTER_STORAGE_KEY);
    return raw ? normalisePoiFilterState(JSON.parse(raw)) : defaultPoiFilterState();
  } catch {
    return defaultPoiFilterState();
  }
}

export function savePoiFilterState(state: PoiFilterState): void {
  try {
    localStorage.setItem(POI_FILTER_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage is best-effort.
  }
}

// === The control ===

/**
 * The "Points of interest (OpenStreetMap)" control markup.
 *
 * Returns the empty string when there is nothing to show — a trail with no
 * `pois` renders no control at all, rather than an empty one implying the
 * enrichment ran and found nothing.
 */
export function poiControlHtml(
  pois: readonly TrailPOI[] | undefined,
  state: PoiFilterState
): string {
  if (!pois || pois.length === 0) return '';
  const counts = countPoisByCategory(pois);
  const shown = visiblePois(pois, state).length;

  const boxes = POI_CATEGORIES.map(category => {
    const count = counts[category];
    const empty = count === 0;
    return `
        <label class="poi-cat-toggle poi-cat-${category}${empty ? ' is-empty' : ''}">
          <input type="checkbox" data-poi-category="${category}"${state.categories[category] ? ' checked' : ''}${empty ? ' disabled' : ''}>
          <span class="poi-badge-icon" aria-hidden="true">${POI_CATEGORY_ICONS[category]}</span>
          <span class="poi-cat-name">${escapeHtml(POI_CATEGORY_LABELS[category])}</span>
          <span class="poi-cat-count">${count}</span>
        </label>`;
  }).join('');

  return `
    <div class="poi-control-head">
      <label class="poi-master">
        <input type="checkbox" id="poi-enabled"${state.enabled ? ' checked' : ''}>
        <span class="poi-master-label">Points of interest (OpenStreetMap)</span>
      </label>
      <span class="poi-control-count" aria-live="polite">${shown} of ${pois.length} shown</span>
    </div>
    <div class="poi-cat-toggles"${state.enabled ? '' : ' hidden'}>${boxes}</div>
    <p class="poi-control-note">
      Uncurated OpenStreetMap data, shown alongside the trail's own waypoints so you can judge it.
      <span class="poi-attribution">${escapeHtml(OSM_ATTRIBUTION)}</span>
    </p>
  `;
}
