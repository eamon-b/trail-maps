/**
 * Presentation logic for OpenStreetMap points of interest on the trail page.
 *
 * POIs (`ProcessedTrail.pois`) are *uncurated* OSM data: anybody can tag a
 * "spring" or a "supermarket", and the enrichment simply catalogs whatever sits
 * near the corridor. They are therefore rendered as a clearly separate,
 * dismissable layer rather than folded into the waypoint model — a waypoint is
 * content the trail data stands behind, a POI is a lead the walker checks.
 *
 * Everything here is pure: labels, tag summaries, popup/row markup, the
 * interleave ordering and the persisted filter state. The DOM and Leaflet
 * wiring lives in `trail-viewer.ts`, which keeps this file unit-testable.
 *
 * **Every string in a POI is untrusted.** Names, tag keys and tag values all go
 * through `escapeHtml` before they reach markup, and URLs are scheme-checked
 * before they land in an `href` — an OSM `website` tag is free text and can
 * just as easily hold `javascript:`.
 *
 * POI data is © OpenStreetMap contributors (ODbL), hence `OSM_ATTRIBUTION` and
 * its appearance on every surface that shows a POI.
 */

import type { TrailPOI, TrailPOICategory } from '@lib/trail-types';
import { escapeHtml } from '../web-utils';

/** The five families the enrichment produces, in the order the UI lists them. */
export const POI_CATEGORIES: readonly TrailPOICategory[] = [
  'water',
  'camping',
  'resupply',
  'transport',
  'emergency',
] as const;

export const POI_CATEGORY_LABELS: Record<TrailPOICategory, string> = {
  water: 'Water',
  camping: 'Camping',
  resupply: 'Resupply',
  transport: 'Transport',
  emergency: 'Emergency',
};

/**
 * Marker glyphs. Deliberately a different set from `WAYPOINT_ICONS` in the
 * viewer — a POI marker must never be mistaken for a curated waypoint.
 */
export const POI_CATEGORY_ICONS: Record<TrailPOICategory, string> = {
  water: '\u{1F4A7}',
  camping: '⛺',
  resupply: '\u{1F6D2}',
  transport: '\u{1F68C}',
  emergency: '\u{1F3E5}',
};

/** The credit line, shown wherever POI data is. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/**
 * True for one of the five known categories. Guards against a hand-edited or
 * future-versioned trail JSON carrying something else.
 */
export function isPoiCategory(value: unknown): value is TrailPOICategory {
  return typeof value === 'string' && (POI_CATEGORIES as readonly string[]).includes(value);
}

/** Human label for a category, tolerating an unknown one. */
export function poiCategoryLabel(category: string): string {
  return isPoiCategory(category) ? POI_CATEGORY_LABELS[category] : 'Other';
}

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

/** What to call an unnamed POI: most OSM water points carry no `name` at all. */
export function poiDisplayName(poi: Pick<TrailPOI, 'name' | 'category'>): string {
  const name = poi.name?.trim();
  return name ? name : `Unnamed ${poiCategoryLabel(poi.category).toLowerCase()}`;
}

/** Canonical browse URL, so a walker can inspect — or fix — the element. */
export function poiOsmUrl(poi: Pick<TrailPOI, 'type' | 'id'>): string {
  const type = poi.type === 'way' || poi.type === 'relation' ? poi.type : 'node';
  return `https://www.openstreetmap.org/${type}/${encodeURIComponent(String(poi.id))}`;
}

/** Metres below 1 km, kilometres above — matching the off-trail waypoint rows. */
export function formatOffTrail(km: number): string {
  if (!Number.isFinite(km)) return '—';
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// === Tag summary ===
//
// OSM elements carry arbitrary tags and dumping all of them is noise. This is
// the subset that answers "can I actually use this?", plus the primary feature
// tag — the single most useful field for judging whether the enrichment
// classified the element sensibly, which is what this whole UI is for.

interface TagSpec {
  key: string;
  label: string;
  /** How the value becomes a link, if at all. */
  link?: 'url' | 'tel';
}

/** The primary feature tags, tried in order. Shown first, as "OSM tag". */
const PRIMARY_TAG_KEYS = [
  'amenity',
  'shop',
  'tourism',
  'natural',
  'man_made',
  'emergency',
  'highway',
  'healthcare',
  'leisure',
] as const;

const TAG_SPECS: TagSpec[] = [
  { key: 'description', label: 'Description' },
  { key: 'opening_hours', label: 'Opening hours' },
  { key: 'drinking_water', label: 'Drinking water' },
  { key: 'water_source', label: 'Water source' },
  { key: 'fee', label: 'Fee' },
  { key: 'access', label: 'Access' },
  { key: 'capacity', label: 'Capacity' },
  { key: 'operator', label: 'Operator' },
  { key: 'ele', label: 'Elevation (m)' },
  { key: 'phone', label: 'Phone', link: 'tel' },
  { key: 'contact:phone', label: 'Phone', link: 'tel' },
  { key: 'website', label: 'Website', link: 'url' },
  { key: 'contact:website', label: 'Website', link: 'url' },
  { key: 'url', label: 'Website', link: 'url' },
];

export interface PoiTagLine {
  label: string;
  value: string;
  /** Present only when the value is safe to link. */
  href?: string;
}

/** `http:`/`https:` only. A bare `example.com` is assumed to be https. */
function safeHttpUrl(value: string): string | undefined {
  const trimmed = value.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Phone numbers keep digits and the punctuation `tel:` tolerates. */
function safeTelUrl(value: string): string | undefined {
  const cleaned = value.replace(/[^\d+\-().\s]/g, '').trim();
  return /\d/.test(cleaned) ? `tel:${cleaned.replace(/\s+/g, '')}` : undefined;
}

/**
 * The tags worth showing, in a fixed order, de-duplicated by label so `phone`
 * and `contact:phone` never both appear.
 */
export function summarisePoiTags(tags: Record<string, string> | undefined): PoiTagLine[] {
  if (!tags) return [];
  const lines: PoiTagLine[] = [];

  for (const key of PRIMARY_TAG_KEYS) {
    const value = tags[key];
    if (typeof value === 'string' && value.trim() !== '') {
      lines.push({ label: 'OSM tag', value: `${key}=${value.trim()}` });
      break;
    }
  }

  const seenLabels = new Set(lines.map(line => line.label));
  for (const spec of TAG_SPECS) {
    if (seenLabels.has(spec.label)) continue;
    const raw = tags[spec.key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value === '') continue;

    const href =
      spec.link === 'url'
        ? safeHttpUrl(value)
        : spec.link === 'tel'
          ? safeTelUrl(value)
          : undefined;

    lines.push(href ? { label: spec.label, value, href } : { label: spec.label, value });
    seenLabels.add(spec.label);
  }

  return lines;
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

// === Filter state ===

export interface PoiFilterState {
  /** The master switch: hides POIs on the map *and* in the datasheet. */
  enabled: boolean;
  categories: Record<TrailPOICategory, boolean>;
}

export const POI_FILTER_STORAGE_KEY = 'trail-maps-poi-filter';

export function defaultPoiFilterState(): PoiFilterState {
  return {
    enabled: true,
    categories: { water: true, camping: true, resupply: true, transport: true, emergency: true },
  };
}

/** Coerce whatever came back out of storage into a usable state. */
export function normalisePoiFilterState(raw: unknown): PoiFilterState {
  const state = defaultPoiFilterState();
  if (!raw || typeof raw !== 'object') return state;
  const source = raw as { enabled?: unknown; categories?: unknown };
  if (typeof source.enabled === 'boolean') state.enabled = source.enabled;
  if (source.categories && typeof source.categories === 'object') {
    const cats = source.categories as Record<string, unknown>;
    for (const category of POI_CATEGORIES) {
      const value = cats[category];
      if (typeof value === 'boolean') state.categories[category] = value;
    }
  }
  return state;
}

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

/** How many POIs there are per category, for the checkbox labels. */
export function countPoisByCategory(pois: readonly TrailPOI[]): Record<TrailPOICategory, number> {
  const counts: Record<TrailPOICategory, number> = {
    water: 0,
    camping: 0,
    resupply: 0,
    transport: 0,
    emergency: 0,
  };
  for (const poi of pois) {
    if (isPoiCategory(poi.category)) counts[poi.category] += 1;
  }
  return counts;
}

/**
 * The POIs the current filter shows.
 *
 * An unknown category (not one of the five) is shown whenever the master switch
 * is on: no checkbox could turn it off, so hiding it by default would make it
 * unreachable.
 */
export function visiblePois(
  pois: readonly TrailPOI[] | undefined,
  state: PoiFilterState
): TrailPOI[] {
  if (!pois || !state.enabled) return [];
  return pois.filter(poi => (isPoiCategory(poi.category) ? state.categories[poi.category] : true));
}

/**
 * Mirror POI positions for a reversed trail.
 *
 * `createReversedTrail` (@lib/trail-reverse) passes unknown fields through
 * untouched, so without this a reversed trail would show every POI at its
 * forward km — 3 km from the start of a 130 km walk instead of 3 km from the
 * end. Cross-track distance is direction-independent and is left alone.
 */
export function mirrorPoiDistances(
  pois: readonly TrailPOI[] | undefined,
  totalDistance: number
): TrailPOI[] | undefined {
  if (!pois) return undefined;
  return pois
    .map(poi => ({
      ...poi,
      distanceAlongTrail: Math.max(0, totalDistance - poi.distanceAlongTrail),
    }))
    .sort((a, b) => a.distanceAlongTrail - b.distanceAlongTrail);
}

// === Interleaving ===

export type InterleavedEntry<T> = { kind: 'item'; item: T } | { kind: 'poi'; poi: TrailPOI };

/**
 * Merge POIs into an already-distance-sorted list of table rows.
 *
 * Ties put the existing row first: a curated waypoint at km 12.0 should read
 * above the OSM tap that happens to sit at the same kilometre. The input list's
 * own order is otherwise preserved, so the caller's sort — which also decides
 * where variant markers land — stays the single ordering authority.
 */
export function interleavePoisByDistance<T>(
  items: readonly T[],
  pois: readonly TrailPOI[],
  distanceOf: (item: T) => number
): InterleavedEntry<T>[] {
  const sorted = [...pois].sort((a, b) => a.distanceAlongTrail - b.distanceAlongTrail);
  const out: InterleavedEntry<T>[] = [];
  let next = 0;

  for (const item of items) {
    const at = distanceOf(item);
    while (next < sorted.length && sorted[next].distanceAlongTrail < at) {
      out.push({ kind: 'poi', poi: sorted[next++] });
    }
    out.push({ kind: 'item', item });
  }
  while (next < sorted.length) {
    out.push({ kind: 'poi', poi: sorted[next++] });
  }

  return out;
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
