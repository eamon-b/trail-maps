/**
 * Thinning OpenStreetMap POIs where a trail walks through a city.
 *
 * A 2 km corridor through Auckland holds 1,940 POIs in ten kilometres, 1,357
 * of them cafés and restaurants. Nobody reads that list, it buries the
 * handful that matter, and it was 2 MB of the phone's Te Araroa asset. In a
 * city the walker has a street map and a phone signal; what the trail guide
 * owes them is where the services start and stop, and the few places a
 * walker (not a resident) is looking for.
 *
 * So inside a dense stretch this keeps:
 * - the first and last POI of each category (by trail km): the last water,
 *   food and shop on the way in, the first on the way out;
 * - "anchors" in between: supermarkets, convenience stores and outdoor shops
 *   (resupply), post offices (bounce boxes), campgrounds, holiday parks and huts, hospitals
 *   with an emergency department, rail stations and ferry terminals — thinned
 *   to one per ANCHOR_SPACING_KM of trail for each kind, preferring a branded
 *   store (a Woolworths over a spice shop OSM also tags `supermarket`), then
 *   the one nearest the trail;
 * - anything flagged `duplicateOf`: it carries OSM detail onto a curated
 *   waypoint and is never drawn as a POI anyway.
 *
 * Convenience stores are anchors because in Japan they *are* the resupply: a
 * Shikoku pilgrim crossing Tokushima eats, refills and finds a toilet at a
 * Lawson or a 7-Eleven, and dropping them left km 76-97 of the henro with 5 of
 * its 84. One per kind per 2 km keeps the nearest few without listing every
 * corner store in Auckland.
 *
 * Everything else in the stretch is dropped: cafés, takeaways, bars,
 * bakeries, pharmacies, clinics, drinking fountains, fuel,
 * picnic shelters. Outside dense stretches nothing is touched, so a small
 * town's café and the only tap for 40 km stay exactly as fetched.
 *
 * Like `@lib/poi-noise`, this runs at build and import time and never on
 * `pois.json` itself, so changing a threshold is a rebuild, not a re-fetch.
 */
import type { TrailPOI } from './trail-types.js';

/** Width of the sliding window density is measured over, km. */
export const DENSITY_WINDOW_KM = 5;
/**
 * POIs per km of trail, averaged over the window, above which a stretch counts
 * as a city.
 *
 * Measured on 2026-09-30 (after noise filtering), as the average over each
 * dense stretch: Auckland 72, Wellington 58, Hamilton 45, Albany at the end of
 * the Bibbulmun 46, Wānaka 26, Palmerston North 25, Invercargill 22, Whanganui
 * 20, Queenstown 18. A town with a main street — Kerikeri, Yass, the CDT's
 * trail towns — runs at 8-15 and is left alone: there the café and the
 * pharmacy are the services, not clutter around them.
 */
export const DENSE_POIS_PER_KM = 15;
/** A city stretch grows outwards while the density stays above this fraction of DENSE_POIS_PER_KM. */
export const SUBURB_FRACTION = 0.5;
/** Dense bins closer than this merge into one stretch, so a park doesn't split a city in two (Queenstown), km. */
export const MERGE_GAP_KM = 5;
/**
 * A stretch with fewer POIs than this is a busy corner, not a city: a service
 * station and its café can clear the density bar over a single km (a CDT trail
 * town, the Albury end of the Hume and Hovell).
 */
export const MIN_STRETCH_POIS = 40;
/** Keep at most one anchor of each kind per this much trail inside a city, km. */
export const ANCHOR_SPACING_KM = 2;

/**
 * The kind of anchor a POI is, or null if it is not one. Kinds are spaced
 * independently, so a station never crowds out a supermarket.
 */
export function anchorKind(poi: TrailPOI): string | null {
  const tags = poi.tags ?? {};
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'convenience') return 'convenience';
  if (tags.shop === 'outdoor') return 'outdoor';
  if (tags.amenity === 'post_office') return 'post-office';
  if (tags.tourism === 'camp_site' || tags.tourism === 'caravan_site') return 'campground';
  if (tags.tourism === 'wilderness_hut' || tags.tourism === 'alpine_hut') return 'hut';
  // Only `emergency=yes`: untagged "hospitals" are rest homes, hospices and
  // day-surgery clinics (50 of Te Araroa's 61), which a walker cannot use.
  if (tags.amenity === 'hospital' && tags.emergency === 'yes') return 'hospital';
  if (tags.railway === 'station') return 'station';
  if (tags.amenity === 'ferry_terminal') return 'ferry';
  return null;
}

/** A city stretch of the trail's km scale, inclusive. */
export interface DenseStretch {
  fromKm: number;
  toKm: number;
}

/**
 * The stretches of trail where POIs run denser than DENSE_POIS_PER_KM.
 *
 * Counts go into 1 km bins; a bin is dense when the window centred on it
 * averages over the threshold. Dense bins within MERGE_GAP_KM join up.
 */
export function findDenseStretches(pois: readonly TrailPOI[]): DenseStretch[] {
  const counts = new Map<number, number>();
  for (const poi of pois) {
    if (!Number.isFinite(poi.distanceAlongTrail)) continue;
    const bin = Math.floor(poi.distanceAlongTrail);
    counts.set(bin, (counts.get(bin) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const half = Math.floor(DENSITY_WINDOW_KM / 2);
  const bins = [...counts.keys()].sort((a, b) => a - b);
  const first = bins[0];
  const last = bins[bins.length - 1];
  const density = (bin: number): number => {
    let total = 0;
    for (let k = bin - half; k <= bin + half; k++) total += counts.get(k) ?? 0;
    return total / DENSITY_WINDOW_KM;
  };

  // Seed on the full threshold, then grow each seed outwards while the density
  // stays above SUBURB_FRACTION of it: a city thins out into suburbs rather
  // than stopping at a line, and a hard cut left Torbay's twenty takeaways
  // standing just outside Auckland.
  const dense = new Set<number>();
  for (let bin = first; bin <= last; bin++) {
    if (dense.has(bin) || density(bin) < DENSE_POIS_PER_KM) continue;
    let lo = bin;
    while (lo - 1 >= first && density(lo - 1) >= DENSE_POIS_PER_KM * SUBURB_FRACTION) lo--;
    let hi = bin;
    while (hi + 1 <= last && density(hi + 1) >= DENSE_POIS_PER_KM * SUBURB_FRACTION) hi++;
    for (let k = lo; k <= hi; k++) if ((counts.get(k) ?? 0) > 0) dense.add(k);
  }

  const stretches: DenseStretch[] = [];
  for (const bin of [...dense].sort((x, y) => x - y)) {
    const last = stretches[stretches.length - 1];
    if (last && bin - last.toKm <= MERGE_GAP_KM) {
      last.toKm = bin + 1;
    } else {
      stretches.push({ fromKm: bin, toKm: bin + 1 });
    }
  }
  return stretches.filter(
    stretch =>
      pois.filter(poi => poi.distanceAlongTrail >= stretch.fromKm && poi.distanceAlongTrail < stretch.toKm).length >=
      MIN_STRETCH_POIS
  );
}

function poiKeyOf(poi: TrailPOI): string {
  return `${poi.type}/${poi.id}`;
}

/** Branded first, then nearer the trail, then the lower km, then the key: a total order. */
function preferred(a: TrailPOI, b: TrailPOI): number {
  return (
    Number(!a.tags?.brand) - Number(!b.tags?.brand) ||
    a.distanceFromTrail - b.distanceFromTrail ||
    a.distanceAlongTrail - b.distanceAlongTrail ||
    poiKeyOf(a).localeCompare(poiKeyOf(b))
  );
}

/** The keys of the POIs to keep inside one dense stretch. */
function keepInStretch(stretch: DenseStretch, inside: TrailPOI[]): Set<string> {
  const keep = new Set<string>();

  const byCategory = new Map<string, TrailPOI[]>();
  for (const poi of inside) {
    if (poi.duplicateOf) keep.add(poiKeyOf(poi));
    const list = byCategory.get(poi.category) ?? [];
    list.push(poi);
    byCategory.set(poi.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.distanceAlongTrail - b.distanceAlongTrail || preferred(a, b));
    keep.add(poiKeyOf(list[0]));
    keep.add(poiKeyOf(list[list.length - 1]));
  }

  const best = new Map<string, TrailPOI>();
  for (const poi of inside) {
    const kind = anchorKind(poi);
    if (kind === null) continue;
    const slot = `${kind}@${Math.floor((poi.distanceAlongTrail - stretch.fromKm) / ANCHOR_SPACING_KM)}`;
    const current = best.get(slot);
    if (!current || preferred(poi, current) < 0) best.set(slot, poi);
  }
  for (const poi of best.values()) keep.add(poiKeyOf(poi));

  return keep;
}

/** Drop the city clutter described above. Returns a new array; `undefined` passes through. */
export function thinUrbanPois(pois: readonly TrailPOI[] | undefined): TrailPOI[] | undefined {
  if (!pois) return undefined;
  const stretches = findDenseStretches(pois);
  if (stretches.length === 0) return [...pois];

  const drop = new Set<string>();
  for (const stretch of stretches) {
    const inside = pois.filter(
      poi => poi.distanceAlongTrail >= stretch.fromKm && poi.distanceAlongTrail < stretch.toKm
    );
    const keep = keepInStretch(stretch, inside);
    for (const poi of inside) {
      if (!keep.has(poiKeyOf(poi))) drop.add(poiKeyOf(poi));
    }
  }
  return pois.filter(poi => !drop.has(poiKeyOf(poi)));
}
