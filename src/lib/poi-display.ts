/**
 * Platform-neutral presentation logic for OpenStreetMap points of interest.
 *
 * POIs (`ProcessedTrail.pois`) are *uncurated* OSM data: anybody can tag a
 * "spring" or a "supermarket", and the enrichment simply catalogs whatever sits
 * near the corridor. Every surface that shows them — the web trail page, the
 * Tracknotes map/list/profile — therefore renders them as a clearly separate
 * layer rather than folding them into the waypoint model: a waypoint is content
 * the trail data stands behind, a POI is a lead the walker checks.
 *
 * This module holds the half of that presentation logic which has no platform
 * in it: labels, tag summaries, the filter state, the interleave ordering, the
 * route key. Markup, `localStorage` and emoji glyphs stay in
 * `src/web/trails/trail-pois-ui.ts` (which re-exports everything here); React
 * Native components import it through `@lib`.
 *
 * **Every string in a POI is untrusted.** The web escapes them before they
 * reach markup; both platforms scheme-check URLs before they land in an `href`
 * or in `Linking.openURL` — an OSM `website` tag is free text and can just as
 * easily hold `javascript:`.
 *
 * Nothing here may import `./trail-reverse`: that module imports
 * `mirrorPoiDistances` from here.
 */

import type { TrailPOI, TrailPOICategory } from './trail-types';

/** The six families the enrichment produces, in the order the UI lists them. */
export const POI_CATEGORIES: readonly TrailPOICategory[] = [
  'water',
  'camping',
  'resupply',
  'restaurant',
  'transport',
  'emergency',
] as const;

export const POI_CATEGORY_LABELS: Record<TrailPOICategory, string> = {
  water: 'Water',
  camping: 'Camping',
  resupply: 'Resupply',
  restaurant: 'Food & drink',
  transport: 'Transport',
  emergency: 'Emergency',
};

/**
 * True for one of the six known categories. Guards against a hand-edited or
 * future-versioned trail JSON carrying something else.
 */
export function isPoiCategory(value: unknown): value is TrailPOICategory {
  return typeof value === 'string' && (POI_CATEGORIES as readonly string[]).includes(value);
}

/** Human label for a category, tolerating an unknown one. */
/** The credit line, shown wherever POI data is. */
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export function poiCategoryLabel(category: string): string {
  return isPoiCategory(category) ? POI_CATEGORY_LABELS[category] : 'Other';
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
export const PRIMARY_TAG_KEYS = [
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

/**
 * Every tag key any surface reads, and therefore the whitelist `slimPoi` keeps.
 *
 * Derived from the two lists above rather than written out again, so the build
 * and the UI cannot disagree about what is worth carrying onto the phone.
 */
export const POI_DISPLAY_TAG_KEYS: readonly string[] = [
  ...PRIMARY_TAG_KEYS,
  ...TAG_SPECS.map(spec => spec.key),
];

export interface PoiTagLine {
  label: string;
  value: string;
  /** Present only when the value is safe to link. */
  href?: string;
}

/** `http:`/`https:` only. A bare `example.com` is assumed to be https. */
export function safeHttpUrl(value: string): string | undefined {
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
export function safeTelUrl(value: string): string | undefined {
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

// === Slimming ===

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The shipping form of a POI: everything the phone reads, nothing it doesn't.
 *
 * A raw OSM element arrives with every tag the mapper wrote — twenty of them is
 * ordinary — and full float precision, which across 1562 bundled POIs is ~200 KB
 * of payload nobody looks at. Keeping only `POI_DISPLAY_TAG_KEYS` and rounding
 * to the same precision `truncateWaypoint` uses roughly halves that.
 *
 * `duplicateDistanceM` goes too: it is a review aid for judging the dedup pass,
 * meaningless once the data is on a phone. `duplicateOf` stays — the app hides
 * flagged POIs and shows their OSM detail on the waypoint they duplicate.
 */
export function slimPoi(poi: TrailPOI): TrailPOI {
  const tags: Record<string, string> = {};
  for (const key of POI_DISPLAY_TAG_KEYS) {
    const value = poi.tags?.[key];
    if (typeof value === 'string' && value !== '') tags[key] = value;
  }

  const slim: TrailPOI = {
    id: poi.id,
    type: poi.type,
    category: poi.category,
    lat: round(poi.lat, 6),
    lon: round(poi.lon, 6),
    name: poi.name,
    tags,
    distanceAlongTrail: round(poi.distanceAlongTrail, 1),
    distanceFromTrail: round(poi.distanceFromTrail, 2),
  };
  if (poi.duplicateOf !== undefined) slim.duplicateOf = poi.duplicateOf;
  return slim;
}

// === Filter state ===

export interface PoiFilterState {
  /** The master switch: hides POIs on the map *and* in the datasheet. */
  enabled: boolean;
  categories: Record<TrailPOICategory, boolean>;
}

export function defaultPoiFilterState(): PoiFilterState {
  return {
    enabled: true,
    categories: {
      water: true,
      camping: true,
      resupply: true,
      restaurant: true,
      transport: true,
      emergency: true,
    },
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
 * POIs per category, excluding those flagged as duplicating a waypoint.
 *
 * These numbers label the filter checkboxes, so they have to agree with what
 * `visiblePois` will actually draw — "camping (13)" must mean 13 markers.
 */
export function countPoisByCategory(pois: readonly TrailPOI[]): Record<TrailPOICategory, number> {
  const counts: Record<TrailPOICategory, number> = {
    water: 0,
    camping: 0,
    resupply: 0,
    restaurant: 0,
    transport: 0,
    emergency: 0,
  };
  for (const poi of pois) {
    if (poi.duplicateOf) continue;
    if (isPoiCategory(poi.category)) counts[poi.category] += 1;
  }
  return counts;
}

/**
 * The POIs the current filter shows.
 *
 * An unknown category (not one of the six) is shown whenever the master switch
 * is on: no checkbox could turn it off, so hiding it by default would make it
 * unreachable.
 */
export function visiblePois(
  pois: readonly TrailPOI[] | undefined,
  state: PoiFilterState
): TrailPOI[] {
  if (!pois || !state.enabled) return [];
  return pois.filter(poi => {
    // A POI the curated waypoint data already covers is never drawn: the
    // waypoint is the one marker for that place, and showing both puts two
    // pins a few metres apart. The POI stays in the data for its OSM detail.
    if (poi.duplicateOf) return false;
    return isPoiCategory(poi.category) ? state.categories[poi.category] : true;
  });
}

/**
 * Mirror POI positions for a reversed trail.
 *
 * Without this a reversed trail would show every POI at its forward km — 3 km
 * from the start of a 130 km walk instead of 3 km from the end. Cross-track
 * distance is direction-independent and is left alone. `createReversedTrail`
 * calls this, so the web viewer and the mobile guide both get it for free; the
 * POI shape is structural for the same reason the rest of `trail-reverse` is.
 */
export function mirrorPoiDistances<P extends { distanceAlongTrail: number }>(
  pois: readonly P[] | undefined,
  totalDistance: number
): P[] | undefined {
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
 * Merge POIs into an already-distance-sorted list of rows.
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

// === Route keys ===
//
// `poiKey` (in `./trail-pois`) is the data key, `type/id`. A `/` in an Expo
// Router param is a path separator, so navigation needs a slash-free form.

const ROUTE_KEY_TYPES = new Set(['node', 'way', 'relation']);

/** The slash-free key a route param can carry: `node-12345`. */
export function poiRouteKey(poi: Pick<TrailPOI, 'type' | 'id'>): string {
  return `${poi.type}-${poi.id}`;
}

/**
 * Parse a route key back into an element reference, or null.
 *
 * Route params are user-reachable (a deep link, a stale saved URL), so this
 * validates rather than trusts: the type must be one of the three OSM element
 * types and the id a plain non-negative integer.
 */
export function parsePoiRouteKey(key: string): { type: string; id: number } | null {
  const match = /^([a-z]+)-(\d+)$/.exec(key);
  if (!match) return null;
  const [, type, digits] = match;
  if (!ROUTE_KEY_TYPES.has(type)) return null;
  const id = Number(digits);
  return Number.isSafeInteger(id) ? { type, id } : null;
}

/** Find the POI a route key names, or null when it is gone or malformed. */
export function findPoiByRouteKey(
  pois: readonly TrailPOI[] | undefined,
  key: string
): TrailPOI | null {
  const parsed = parsePoiRouteKey(key);
  if (!pois || !parsed) return null;
  return pois.find(poi => poi.type === parsed.type && poi.id === parsed.id) ?? null;
}
