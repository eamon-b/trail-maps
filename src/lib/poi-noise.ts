/**
 * Category-wide noise filters for OpenStreetMap POIs.
 *
 * `data/trails/<dir>/pois.json` records what Overpass actually returned, noise
 * and all — it is the raw fetch, and re-fetching one is slow and unreliable
 * enough (see `scripts/fetch-pois.ts`) that we never want a filter change to
 * require one. So these rules run at build and import time, on the way into the
 * shipped trail JSON, exactly like the hand-edited `rejected` list. Change a
 * rule, rebuild; the source data is untouched.
 *
 * That is also why this drops rather than annotates, where `@lib/poi-dedup`
 * annotates: a duplicate POI still carries OSM detail worth showing on the
 * waypoint it doubles, but a bus stop named "Railway Rd After Noel Rd" carries
 * nothing, and 500 of them across six trails is payload every reader pays for.
 *
 * Each rule below was measured against the six fetched trails on 2026-09-09,
 * and each keeps the cases that look like noise but aren't.
 */
import type { TrailPOI } from './trail-types.js';

export type NoiseReason =
  | 'bus-stop'
  | 'minor-shelter'
  | 'no-emergency-department'
  | 'road-emergency-phone';

/**
 * `shelter_type` values that describe a roof over a bench rather than somewhere
 * a walker could shelter or sleep.
 *
 * `weather_shelter` is deliberately absent: on the Bibbulmun and Larapinta those
 * are real trail infrastructure. So are `basic_hut` and `lean_to`.
 */
const MINOR_SHELTER_TYPES = new Set(['picnic_shelter', 'gazebo', 'pavilion', 'sun_shelter', 'pergola']);

/**
 * Name fragments that override `MINOR_SHELTER_TYPES`.
 *
 * OSM mis-tags some genuine campgrounds as picnic shelters, and the tags carry
 * no other signal — "Ponderosa Campground" and "YHA Campground" on the Heysen
 * are `shelter_type=picnic_shelter` with nothing else to distinguish them from
 * an actual picnic roof. The name is the only evidence, so it gets a veto.
 * "Centenary Gazebo" is not spared: its name agrees it is a gazebo.
 */
const SHELTER_KEEP_WORDS = ['camp', 'hut', 'shelter', 'hostel', 'yha', 'cabin', 'bunk'];

/**
 * A name that says "picnic" agrees with the tag, and beats the keep-words: the
 * Kep Track has four roofs literally named "picnic shelter", which the word
 * `shelter` would otherwise spare.
 */
const PICNIC_NAME = /\bpicnic\b/;

/**
 * A bus stop whose name says it serves walkers. The Cradle Mountain shuttle
 * ("Ronny Creek - Cradle Shuttle Bus") and the Three Capes pickup are how a
 * walker reaches or leaves the track, and are the bus stops worth keeping.
 */
const WALKER_SHUTTLE_NAME = /\b(shuttle|pick-?up)\b/i;

/** Car-park and airport shuttles share the word, and serve nobody on foot. */
const NOT_A_WALKER_SHUTTLE = /\b(parking|car ?park|airport)\b/i;

/**
 * An `emergency=phone` on a road no walker is on. The Great North Walk runs
 * beside the Pacific Motorway and over Sydney's tunnels, and shipped 41
 * motorway help phones as emergency POIs.
 */
const ROAD_PHONE_STREET = /\b(motorway|freeway|expressway|tunnel|distributor|off-?ramp|on-?ramp)\b/i;

/**
 * Why this POI should not ship, or null to keep it.
 *
 * Reads `tags` rather than `category` so a rule cannot be silently bypassed by a
 * re-categorisation upstream in gpx-tools.
 */
export function noiseReason(poi: TrailPOI): NoiseReason | null {
  const tags = poi.tags ?? {};

  // 420 of the 433 transport POIs, named things like "Peoples Av Before Hill
  // St". The 13 that remain — rail stations and the Cape Jervis ferry — are
  // among the most useful POIs we have, so the category itself stays. A
  // walkers' shuttle stop is kept for the same reason (`WALKER_SHUTTLE_NAME`).
  if (tags.highway === 'bus_stop' && !isWalkerShuttle(poi.name ?? '')) {
    return 'bus-stop';
  }

  // Keyed on shelter_type alone: three wilderness huts carry it without
  // `amenity=shelter`, and they must be judged by the same rule.
  if (tags.shelter_type && MINOR_SHELTER_TYPES.has(tags.shelter_type)) {
    const name = (poi.name ?? '').toLowerCase();
    if (PICNIC_NAME.test(name) || !SHELTER_KEEP_WORDS.some(word => name.includes(word))) {
      return 'minor-shelter';
    }
  }

  // A hospital OSM records as having no emergency department, filed under a
  // category called "emergency". Only three, but this is the one rule here
  // fixing something actively misleading rather than merely cluttered.
  if (tags.emergency === 'no') {
    return 'no-emergency-department';
  }

  if (tags.emergency === 'phone' && ROAD_PHONE_STREET.test(tags['addr:street'] ?? '')) {
    return 'road-emergency-phone';
  }

  return null;
}

function isWalkerShuttle(name: string): boolean {
  return WALKER_SHUTTLE_NAME.test(name) && !NOT_A_WALKER_SHUTTLE.test(name);
}

/** Drop every POI a rule rejects. Returns a new array; `undefined` passes through. */
export function dropNoisePois(pois: readonly TrailPOI[] | undefined): TrailPOI[] | undefined {
  if (!pois) return undefined;
  return pois.filter(poi => noiseReason(poi) === null);
}

/** How many POIs each rule would drop. Build-log and review aid. */
export function countNoiseByReason(
  pois: readonly TrailPOI[] | undefined
): Record<NoiseReason, number> {
  const counts: Record<NoiseReason, number> = {
    'bus-stop': 0,
    'minor-shelter': 0,
    'no-emergency-department': 0,
    'road-emergency-phone': 0,
  };
  for (const poi of pois ?? []) {
    const reason = noiseReason(poi);
    if (reason) counts[reason]++;
  }
  return counts;
}
