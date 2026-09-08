/**
 * Flagging OSM POIs that duplicate a curated waypoint.
 *
 * OSM maps the same campsites the curated GPX was built around, so a trail with
 * POIs fetched shows two markers a few metres apart and two datasheet rows for
 * one place. Measured on the 2026-09 fetch, 87 of 1155 POIs across four trails
 * duplicated a waypoint, and 84 of those 87 were `camping`.
 *
 * The duplicate is *flagged, not removed*. Three reasons:
 *   - Merging OSM tags into the waypoint would break the rule this feature is
 *     built on — POIs never become waypoints and never enter the waypoint-id
 *     registry (`data/waypoint-ids.json`).
 *   - The OSM record often carries what the curated waypoint lacks (`website`,
 *     `opening_hours`, `operator`, `fee`), so dropping it is lossy.
 *   - `rejected` in `pois.json` means "we never want this". A duplicate means
 *     "we already have this, from a better source". Keeping the two distinct is
 *     what lets a re-fetch carry review work forward without confusing them.
 *
 * The flag is *derived*, never stored in `data/trails/<dir>/pois.json`: that file
 * is the fetch record, while this depends on waypoint positions that a rebuild
 * can move. Recompute it at build time, and on import.
 *
 * See `plans/poi-waypoint-dedup.md` for the measurements and the rejected
 * alternatives.
 */

import { haversineDistance2D } from './distance';
import type { TrailPOI, TrailPOICategory } from './trail-types';

/** Two points further apart than this are never the same place. */
export const MAX_DUPLICATE_DISTANCE_M = 250;

/** Name similarity at or above this counts as the same name. */
export const MIN_NAME_SCORE = 0.9;

/**
 * Waypoint types each POI category may duplicate.
 *
 * `transport` is absent on purpose: no waypoint type corresponds to a bus stop,
 * and bus-stop names defeat the matcher anyway (see `nameScore`).
 *
 * `town` is absent from every row, and that is the single most important entry
 * in this table. A town waypoint marks an *area*, so every shop inside it
 * carries its name: without this, `BP Pemberton` matched the town `Pemberton`,
 * `Walpole IGA Pioneer Store` matched `Walpole`, and `Premier Hotel Albany`
 * matched `Albany`. Allowing `town` produced 16 false positives on the
 * Bibbulmun alone.
 */
export const DUPLICATE_COMPATIBLE_TYPES: Readonly<
  Partial<Record<TrailPOICategory, readonly string[]>>
> = {
  camping: ['campsite', 'caravan-park', 'hut', 'shelter', 'camp'],
  water: ['water', 'water-tank', 'tank', 'spring', 'water-source'],
  resupply: ['resupply', 'food', 'shop'],
  restaurant: ['food', 'resupply'],
  emergency: ['emergency', 'hospital'],
};

/**
 * Words that carry no identity, removed before names are compared.
 *
 * `Finke River Campground` and `Finke River` are the same place, but score only
 * 0.67 as raw strings. Dropping these lifts them to 1.00.
 */
const GENERIC_WORDS = new Set([
  'campsite',
  'campground',
  'camp',
  'site',
  'shelter',
  'hut',
  'caravan',
  'park',
  'holiday',
  'rest',
  'area',
  'reserve',
  'trackhead',
  'trailhead',
  'walk',
  'in',
  'group',
  'the',
  'kiosk',
  'closed',
  'np',
  'national',
]);

/** Curator prefixes used in the bundled GPX files (`R: Ormiston Gorge`). */
const CURATOR_PREFIX = /^(closed\s*c?\s*-?\s*|c\?\s*|r:\s*|kiosk:\s*)/i;

/** A trailing ` - Leeuwin-Naturaliste NP` style qualifier. */
const TRAILING_QUALIFIER = /\s*-\s*.*$/;

/** The subset of a waypoint this module reads. Structural, so both platforms fit. */
export interface DedupWaypointLike {
  id?: string;
  name?: string | null;
  type?: string;
  lat: number;
  lon: number;
}

/**
 * Reduce a place name to the tokens that actually identify it.
 *
 * Exported for tests, which is the only way to pin the behaviour that the
 * generic-word list drives.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  const cleaned = (name.toLowerCase().replace(CURATOR_PREFIX, '') as string)
    .replace(TRAILING_QUALIFIER, '')
    .replace(/[^a-z0-9 ]/g, ' ');
  return cleaned.split(/\s+/).filter(token => token.length > 0 && !GENERIC_WORDS.has(token));
}

/** Longest-common-subsequence ratio, the same measure `difflib` reports. */
function sequenceRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  const row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    row[0] = 0;
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = row[j];
  }
  return (2 * prev[b.length]) / (a.length + b.length);
}

/**
 * How alike two place names are, 0..1.
 *
 * Containment scores 1: `Buddong Hut Camp Site` reduces to `buddong` and
 * `Buddong hut` to `buddong`, but `Mount Clare hut` reduces to `mount clare`
 * against a waypoint `Mount Clare`, and one set containing the other is the
 * signal that matters. Otherwise the better of token overlap and string
 * similarity, so spelling drift (`Hewett's` / `Hewitt's`) still matches.
 *
 * Note this is deliberately order-insensitive, which is safe here only because
 * `transport` is excluded: bus-stop names encode direction by word order, so
 * `Canning Rd After Recreation Rd` and `Recreation Rd After Canning Rd` are two
 * different stops that any set-based measure would call identical.
 */
export function nameScore(a: string | null | undefined, b: string | null | undefined): number {
  const setA = new Set(nameTokens(a));
  const setB = new Set(nameTokens(b));
  if (setA.size === 0 || setB.size === 0) return 0;

  const contained =
    [...setA].every(token => setB.has(token)) || [...setB].every(token => setA.has(token));
  if (contained) return 1;

  let shared = 0;
  for (const token of setA) if (setB.has(token)) shared += 1;
  const jaccard = shared / (setA.size + setB.size - shared);

  const ratio = sequenceRatio([...setA].sort().join(' '), [...setB].sort().join(' '));
  return Math.max(jaccard, ratio);
}

/** Whether a POI category may duplicate a waypoint of this type. */
export function isCompatibleType(category: string, waypointType: string | undefined): boolean {
  if (!waypointType) return false;
  const allowed = DUPLICATE_COMPATIBLE_TYPES[category as TrailPOICategory];
  return allowed ? allowed.includes(waypointType) : false;
}

/**
 * Flag every POI that duplicates a curated waypoint.
 *
 * Returns a new array; input is not mutated. POIs that match nothing come back
 * without the duplicate fields at all, so a trail whose POIs are all distinct
 * serialises exactly as before.
 *
 * An unnamed POI is never a duplicate. Cape to Cape has nameless water taps
 * 23–80 m from campsite waypoints: those are *complementary* — the waypoint does
 * not record that there is a tap — and requiring a name is what protects them.
 */
export function markDuplicatePois(
  pois: readonly TrailPOI[] | undefined,
  waypoints: readonly DedupWaypointLike[] | undefined
): TrailPOI[] | undefined {
  if (!pois) return undefined;
  if (!waypoints || waypoints.length === 0) return pois.map(poi => ({ ...poi }));

  return pois.map(poi => {
    const next: TrailPOI = { ...poi };
    delete next.duplicateOf;
    delete next.duplicateDistanceM;

    if (nameTokens(poi.name).length === 0) return next;

    let best: { waypoint: DedupWaypointLike; metres: number; score: number } | null = null;
    for (const waypoint of waypoints) {
      if (!waypoint.id) continue;
      if (!isCompatibleType(poi.category, waypoint.type)) continue;
      if (nameTokens(waypoint.name).length === 0) continue;

      const metres = haversineDistance2D(poi.lat, poi.lon, waypoint.lat, waypoint.lon);
      if (metres > MAX_DUPLICATE_DISTANCE_M) continue;

      const score = nameScore(poi.name, waypoint.name);
      if (score < MIN_NAME_SCORE) continue;

      // Prefer the better name match, then the closer one.
      if (!best || score > best.score || (score === best.score && metres < best.metres)) {
        best = { waypoint, metres, score };
      }
    }

    if (best && best.waypoint.id) {
      next.duplicateOf = best.waypoint.id;
      next.duplicateDistanceM = Math.round(best.metres);
    }
    return next;
  });
}

/** POIs that are not flagged as duplicating a waypoint. */
export function nonDuplicatePois(pois: readonly TrailPOI[] | undefined): TrailPOI[] {
  if (!pois) return [];
  return pois.filter(poi => !poi.duplicateOf);
}

/** How many of these POIs were flagged as duplicates. For build output. */
export function countDuplicatePois(pois: readonly TrailPOI[] | undefined): number {
  if (!pois) return 0;
  return pois.reduce((total, poi) => (poi.duplicateOf ? total + 1 : total), 0);
}
