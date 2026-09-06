/**
 * OpenStreetMap POI enrichment for the trail build pipeline — the pure,
 * testable half. `scripts/fetch-pois.ts` does the network and file I/O;
 * `scripts/build-trails.ts` applies the result as extra waypoints.
 *
 * Pipeline:
 *
 *   1. {@link buildCorridor} — simplify the built route (+ variants) into
 *      polyline chunks; {@link planQueryBoxes} turns those into a few padded
 *      bounding boxes per Overpass request.
 *   2. {@link buildOverpassQuery} — one bbox query per group, selecting only
 *      the tag combinations in {@link OSM_RULES}.
 *   3. {@link classifyOsmElement} — map an OSM element's tags to one of our
 *      waypoint types (or reject it), with a per-type corridor radius.
 *   4. {@link nearestOnTrack} — exact point-to-segment distance against the
 *      full-resolution track, so "how far off the trail" is honest.
 *   5. {@link mergeOsmCandidates} — drop anything the curated waypoints already
 *      cover (same family nearby, or same name), and OSM-vs-OSM duplicates.
 *   6. {@link poisFileToWaypoints} — turn a reviewed `pois.json` into
 *      `TrailWaypoint`s for the build, honouring its `rejected` list.
 *
 * Curated waypoints are never touched: OSM rows are appended after the GPX /
 * CalTopo / CSV sources have been resolved, and the merge only ever discards
 * OSM candidates. Every emitted waypoint carries `source: 'osm'` so a re-fetch
 * can tell curated rows from its own previous output, and so the UI can
 * attribute OpenStreetMap (ODbL) where it displays the data.
 */

import { haversineDistance as haversineMeters } from "../../src/lib/distance";
import { simplifyTrack } from "../../src/lib/track-simplify";
import {
  isResupplyWaypoint,
  isWaterWaypoint,
  type WaypointType,
} from "../../src/lib/waypoint-taxonomy";
import type { TrailWaypoint } from "../../src/lib/trail-types";

// ---------------------------------------------------------------------------
// OSM tag → waypoint type rules
// ---------------------------------------------------------------------------

export type OsmTags = Record<string, string>;

/** One row of {@link OSM_RULES}. First matching rule wins. */
export interface OsmRule {
  /** Short human label used in descriptions and as a fallback name. */
  kind: string;
  /** Waypoint type the element becomes. */
  type: WaypointType;
  /** Max distance from the track (metres) at which the element is kept. */
  radiusM: number;
  /**
   * Whether an unnamed element is dropped. Water points and huts are often
   * unnamed in OSM and still useful; an unnamed shop is almost always junk.
   */
  requireName: boolean;
  match(tags: OsmTags): boolean;
}

const has = (tags: OsmTags, key: string, ...values: string[]) =>
  values.length === 0 ? key in tags : values.includes(tags[key]);

/** Shelter subtypes that are somewhere a hiker would shelter. */
const HIKER_SHELTERS = new Set([
  "basic_hut",
  "lean_to",
  "weather_shelter",
  "rock_shelter",
]);

/** Shelter subtypes that are not somewhere a hiker would shelter overnight. */
const NON_HIKER_SHELTERS = new Set([
  "public_transport",
  "picnic_shelter",
  "sun_shelter",
  "gazebo",
  "changing_rooms",
  "field_shelter",
  "pavilion",
]);

/**
 * Tag rules, in priority order. Radii are deliberately tight for things that
 * only matter *on* the track (water, huts, lookouts) and loose for town
 * services a hiker will walk to anyway (supermarkets, hospitals).
 *
 * Tune here, then `npm run fetch:pois` — the build never re-classifies.
 */
export const OSM_RULES: readonly OsmRule[] = [
  // --- water -------------------------------------------------------------
  {
    kind: "Drinking water",
    type: "water",
    radiusM: 300,
    requireName: false,
    match: (t) =>
      has(t, "amenity", "drinking_water") && t.drinking_water !== "no",
  },
  {
    kind: "Water tap",
    type: "water",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "man_made", "water_tap") && t.drinking_water !== "no",
  },
  {
    kind: "Water tank",
    type: "water-tank",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "man_made", "water_tank") && t.drinking_water !== "no",
  },
  {
    kind: "Well",
    type: "water",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "man_made", "water_well") && t.drinking_water !== "no",
  },
  {
    kind: "Spring",
    type: "water",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "natural", "spring") && t.drinking_water !== "no",
  },
  // --- shelter -----------------------------------------------------------
  {
    kind: "Hut",
    type: "hut",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "tourism", "wilderness_hut", "alpine_hut"),
  },
  {
    kind: "Shelter",
    type: "hut",
    radiusM: 300,
    requireName: false,
    // Unnamed and untyped `amenity=shelter` is a bus or picnic shelter far
    // more often than a hut, so those need a name or an explicit hiker type.
    match: (t) =>
      has(t, "amenity", "shelter") &&
      !(t.shelter_type && NON_HIKER_SHELTERS.has(t.shelter_type)) &&
      Boolean(
        cleanName(t.name) ||
        (t.shelter_type && HIKER_SHELTERS.has(t.shelter_type))
      ),
  },
  {
    kind: "Campsite",
    type: "campsite",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "tourism", "camp_site"),
  },
  {
    kind: "Caravan park",
    type: "caravan-park",
    radiusM: 1000,
    requireName: true,
    match: (t) => has(t, "tourism", "caravan_site"),
  },
  {
    kind: "Accommodation",
    type: "accommodation",
    radiusM: 1000,
    requireName: true,
    // Not guest_house/chalet: in OSM those are overwhelmingly holiday rentals.
    match: (t) => has(t, "tourism", "hotel", "motel", "hostel"),
  },
  // --- resupply ----------------------------------------------------------
  {
    kind: "Supermarket",
    type: "resupply",
    radiusM: 2000,
    requireName: true,
    match: (t) => has(t, "shop", "supermarket"),
  },
  {
    kind: "Shop",
    type: "resupply",
    radiusM: 1500,
    requireName: true,
    match: (t) =>
      has(t, "shop", "convenience", "general", "grocery", "greengrocer"),
  },
  {
    kind: "Service station",
    type: "resupply",
    radiusM: 1000,
    requireName: true,
    match: (t) => has(t, "amenity", "fuel"),
  },
  {
    kind: "Post office",
    type: "resupply",
    radiusM: 1500,
    requireName: true,
    match: (t) => has(t, "amenity", "post_office"),
  },
  {
    kind: "Bakery",
    type: "food",
    radiusM: 500,
    requireName: true,
    match: (t) => has(t, "shop", "bakery"),
  },
  {
    kind: "Cafe",
    type: "food",
    radiusM: 500,
    requireName: true,
    match: (t) => has(t, "amenity", "cafe"),
  },
  {
    kind: "Restaurant",
    type: "food",
    radiusM: 500,
    requireName: true,
    match: (t) => has(t, "amenity", "restaurant", "fast_food"),
  },
  {
    kind: "Pub",
    type: "food",
    radiusM: 500,
    requireName: true,
    match: (t) => has(t, "amenity", "pub"),
  },
  {
    kind: "Town",
    type: "town",
    radiusM: 2500,
    requireName: true,
    match: (t) => has(t, "place", "town", "village"),
  },
  // --- trail features ----------------------------------------------------
  {
    kind: "Trailhead",
    type: "trailhead",
    radiusM: 300,
    requireName: false,
    match: (t) => has(t, "highway", "trailhead"),
  },
  {
    kind: "Lookout",
    type: "poi",
    radiusM: 150,
    // Unnamed viewpoints are a row per bend on a coastal track; named ones
    // are the ones a hiker will look for.
    requireName: true,
    match: (t) => has(t, "tourism", "viewpoint"),
  },
  {
    kind: "Picnic area",
    type: "poi",
    radiusM: 200,
    requireName: true,
    match: (t) => has(t, "tourism", "picnic_site"),
  },
  {
    kind: "Visitor centre",
    type: "poi",
    radiusM: 1500,
    requireName: true,
    match: (t) =>
      has(t, "tourism", "information") &&
      has(t, "information", "visitor_centre"),
  },
  // --- town services -----------------------------------------------------
  {
    kind: "Hospital",
    type: "poi",
    radiusM: 2000,
    requireName: true,
    match: (t) => has(t, "amenity", "hospital"),
  },
  {
    kind: "Pharmacy",
    type: "poi",
    radiusM: 1000,
    requireName: true,
    match: (t) => has(t, "amenity", "pharmacy"),
  },
  {
    kind: "Railway station",
    type: "poi",
    radiusM: 1000,
    requireName: true,
    match: (t) =>
      has(t, "railway", "station", "halt") && t.station !== "subway",
  },
  {
    kind: "Ferry terminal",
    type: "poi",
    radiusM: 1000,
    requireName: true,
    match: (t) => has(t, "amenity", "ferry_terminal"),
  },
];

/** Widest radius any rule uses — the corridor the Overpass query must cover. */
export const MAX_RULE_RADIUS_M = Math.max(...OSM_RULES.map((r) => r.radiusM));

/**
 * Overpass selectors that pull in every element {@link OSM_RULES} could match.
 * Kept as a handful of regex selectors rather than one per rule because each
 * selector repeats the corridor polyline in the query body.
 */
export const OVERPASS_SELECTORS: readonly string[] = [
  '["amenity"~"^(drinking_water|shelter|fuel|post_office|cafe|restaurant|fast_food|pub|hospital|pharmacy|ferry_terminal)$"]',
  '["man_made"~"^(water_tap|water_tank|water_well)$"]',
  '["natural"="spring"]',
  '["tourism"~"^(wilderness_hut|alpine_hut|camp_site|caravan_site|hotel|motel|hostel|viewpoint|picnic_site|information)$"]',
  '["shop"~"^(supermarket|convenience|general|grocery|greengrocer|bakery)$"]',
  '["place"~"^(town|village)$"]',
  '["highway"="trailhead"]',
  '["railway"~"^(station|halt)$"]',
];

/** Result of classifying one element. */
export interface OsmClassification {
  rule: OsmRule;
  /** Display name: the OSM `name`, else the rule's kind. */
  name: string;
}

/**
 * Map an element's tags to a rule, or `null` when it is nothing we want.
 * `null` also covers a rule that requires a name when the element has none.
 */
export function classifyOsmElement(tags: OsmTags): OsmClassification | null {
  const rule = OSM_RULES.find((r) => r.match(tags));
  if (!rule) return null;
  const name = cleanName(tags.name);
  if (!name && rule.requireName) return null;
  return { rule, name: name || rule.kind };
}

function cleanName(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Corridor geometry
// ---------------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

/** Default Douglas-Peucker tolerance for the query corridor, in metres. */
export const CORRIDOR_SIMPLIFY_TOLERANCE_M = 250;
/** Max vertices per Overpass `around:` polyline. */
export const CORRIDOR_CHUNK_POINTS = 120;

/**
 * Simplify each polyline and split it into overlapping chunks of at most
 * `chunkPoints` vertices. Consecutive chunks share one vertex so no gap opens
 * at the seam. Degenerate inputs (0–1 points) are dropped.
 */
export function buildCorridor(
  polylines: LatLon[][],
  toleranceM: number = CORRIDOR_SIMPLIFY_TOLERANCE_M,
  chunkPoints: number = CORRIDOR_CHUNK_POINTS
): LatLon[][] {
  if (chunkPoints < 2) throw new Error("chunkPoints must be at least 2");
  const chunks: LatLon[][] = [];
  for (const line of polylines) {
    if (line.length < 2) continue;
    const simplified = simplifyTrack(line, toleranceM).map((p) => ({
      lat: p.lat,
      lon: p.lon,
    }));
    for (
      let start = 0;
      start < simplified.length - 1;
      start += chunkPoints - 1
    ) {
      chunks.push(simplified.slice(start, start + chunkPoints));
    }
  }
  return chunks;
}

/** A lat/lon bounding box (Overpass order: south, west, north, east). */
export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/**
 * Bounding box of a chunk padded by `padM` metres. Overpass answers bbox
 * queries from its index in seconds, whereas `around:` polyline queries over
 * a long corridor regularly time out on the public server ("too busy"), so
 * the fetch queries boxes and applies the exact per-rule radius client-side.
 */
export function chunkBounds(
  chunk: LatLon[],
  padM: number = MAX_RULE_RADIUS_M
): Bounds {
  if (chunk.length < 1) throw new Error("corridor chunk is empty");
  let south = Infinity;
  let north = -Infinity;
  let west = Infinity;
  let east = -Infinity;
  for (const p of chunk) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
  }
  const midLat = (south + north) / 2;
  const padLat = padM / 111_320;
  const padLon = padM / (111_320 * Math.cos((midLat * Math.PI) / 180));
  return {
    south: south - padLat,
    north: north + padLat,
    west: west - padLon,
    east: east + padLon,
  };
}

function area(b: Bounds): number {
  return (b.north - b.south) * (b.east - b.west);
}

function union(a: Bounds, b: Bounds): Bounds {
  return {
    south: Math.min(a.south, b.south),
    north: Math.max(a.north, b.north),
    west: Math.min(a.west, b.west),
    east: Math.max(a.east, b.east),
  };
}

/** Max bounding boxes per Overpass query (each repeats every selector). */
export const BOXES_PER_QUERY = 4;

/**
 * A box is folded into an existing one when doing so grows that box's area
 * by at most this fraction — side trips and alternates hug the main route,
 * so their boxes mostly overlap one of its chunks already.
 */
export const BOX_MERGE_MAX_GROWTH = 0.3;

/**
 * Turn corridor chunks into the boxes worth querying: one padded bbox per
 * chunk, folded into a bigger box wherever that costs little extra area,
 * then grouped `perQuery` at a time so a trail with forty tiny side trips
 * does not cost forty round trips.
 */
export function planQueryBoxes(
  chunks: LatLon[][],
  padM: number = MAX_RULE_RADIUS_M,
  perQuery: number = BOXES_PER_QUERY
): Bounds[][] {
  if (perQuery < 1) throw new Error("perQuery must be at least 1");
  const kept: Bounds[] = [];
  // Largest first, so small boxes fold into big ones rather than the reverse.
  const byArea = chunks
    .map((c) => chunkBounds(c, padM))
    .sort((a, b) => area(b) - area(a));
  for (const box of byArea) {
    let bestIndex = -1;
    let bestGrowth = Infinity;
    for (let i = 0; i < kept.length; i++) {
      const merged = union(kept[i], box);
      const growth = (area(merged) - area(kept[i])) / area(kept[i]);
      if (growth < bestGrowth) {
        bestGrowth = growth;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0 && bestGrowth <= BOX_MERGE_MAX_GROWTH) {
      kept[bestIndex] = union(kept[bestIndex], box);
    } else {
      kept.push(box);
    }
  }
  const groups: Bounds[][] = [];
  for (let i = 0; i < kept.length; i += perQuery) {
    groups.push(kept.slice(i, i + perQuery));
  }
  return groups;
}

/**
 * One Overpass QL query: every selector in every box. `out center` gives
 * ways/relations a representative point.
 */
export function buildOverpassQuery(
  boxes: Bounds[],
  timeoutS: number = 120
): string {
  if (boxes.length < 1) throw new Error("no boxes to query");
  const statements: string[] = [];
  for (const b of boxes) {
    const bbox = `(${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)})`;
    for (const sel of OVERPASS_SELECTORS)
      statements.push(`  nwr${sel}${bbox};`);
  }
  return `[out:json][timeout:${timeoutS}];\n(\n${statements.join("\n")}\n);\nout center tags;\n`;
}

/** A point on the track with its cumulative km (the built route shape). */
export interface TrackKmPoint extends LatLon {
  dist: number;
}

/** Nearest point on a polyline to a query point. */
export interface NearestOnTrack {
  /** Metres from the query point to the nearest point on the polyline. */
  distanceM: number;
  /** Cumulative km at that nearest point (interpolated along the segment). */
  km: number;
  /** Index of the segment's first vertex. */
  segmentIndex: number;
}

/**
 * Exact nearest point on a polyline, projecting onto segments (not just
 * vertices) in a local equirectangular frame. Segments whose bounding box is
 * further than the best distance so far are skipped, which keeps a 60k-point
 * track cheap for a few thousand candidates.
 */
export function nearestOnTrack(
  point: LatLon,
  track: TrackKmPoint[]
): NearestOnTrack | null {
  if (track.length === 0) return null;
  const R = 6371000;
  const cosLat = Math.cos((point.lat * Math.PI) / 180);
  const mPerDegLat = (Math.PI / 180) * R;
  const mPerDegLon = mPerDegLat * cosLat;
  const px = point.lon * mPerDegLon;
  const py = point.lat * mPerDegLat;

  let best: NearestOnTrack = {
    distanceM: haversineMeters(
      point.lat,
      point.lon,
      track[0].lat,
      track[0].lon
    ),
    km: track[0].dist,
    segmentIndex: 0,
  };
  if (track.length === 1) return best;

  for (let i = 0; i < track.length - 1; i++) {
    const a = track[i];
    const b = track[i + 1];
    // Cheap reject: the segment's bbox is already further than the best hit.
    const minLat = Math.min(a.lat, b.lat);
    const maxLat = Math.max(a.lat, b.lat);
    const minLon = Math.min(a.lon, b.lon);
    const maxLon = Math.max(a.lon, b.lon);
    const dLat =
      point.lat < minLat
        ? minLat - point.lat
        : point.lat > maxLat
          ? point.lat - maxLat
          : 0;
    const dLon =
      point.lon < minLon
        ? minLon - point.lon
        : point.lon > maxLon
          ? point.lon - maxLon
          : 0;
    if (Math.hypot(dLat * mPerDegLat, dLon * mPerDegLon) >= best.distanceM)
      continue;

    const ax = a.lon * mPerDegLon;
    const ay = a.lat * mPerDegLat;
    const bx = b.lon * mPerDegLon;
    const by = b.lat * mPerDegLat;
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    const t =
      len2 === 0
        ? 0
        : Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2));
    const qx = ax + t * vx;
    const qy = ay + t * vy;
    const d = Math.hypot(px - qx, py - qy);
    if (d < best.distanceM) {
      best = {
        distanceM: d,
        km: a.dist + t * (b.dist - a.dist),
        segmentIndex: i,
      };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Candidates and merging
// ---------------------------------------------------------------------------

/** A classified OSM element that sits inside its rule's corridor. */
export interface OsmCandidate {
  /** `node/123`, `way/456`, `relation/789`. */
  osmId: string;
  name: string;
  type: WaypointType;
  kind: string;
  lat: number;
  lon: number;
  /** Metres from the nearest track (main route or variant). */
  distanceFromTrackM: number;
  /** Km along the main route at the nearest point (for ordering / review). */
  trailKm: number;
  tags: OsmTags;
}

/** Minimal curated-waypoint shape the merge needs. */
export interface CuratedWaypointLike {
  name: string;
  type: string;
  lat: number;
  lon: number;
  source?: string;
}

type Family =
  "water" | "shelter" | "lodging" | "town" | "food" | "resupply" | "other";

/** `food`-family aliases from other people's GPX (the taxonomy lumps these into resupply). */
const FOOD_TYPES = new Set([
  "food",
  "cafe",
  "restaurant",
  "pub",
  "kiosk",
  "roadhouse",
]);

/**
 * Group types into families so an OSM `water` near a curated `water-tank`
 * counts as covered. Uses the taxonomy predicates so GPX aliases (`spring`,
 * `supermarket`) group correctly too.
 */
export function waypointFamily(type: string): Family {
  const key = type.trim().toLowerCase();
  if (isWaterWaypoint(key)) return "water";
  if (
    key === "campsite" ||
    key === "hut" ||
    key === "shelter" ||
    key === "camp"
  )
    return "shelter";
  if (key === "accommodation" || key === "caravan-park") return "lodging";
  if (key === "town" || key === "village" || key === "settlement")
    return "town";
  if (FOOD_TYPES.has(key)) return "food";
  if (isResupplyWaypoint(key)) return "resupply";
  return "other";
}

/**
 * How close (metres) a curated waypoint of the same family must be for an
 * OSM candidate to count as "already covered". Every value is ≥ the id
 * registry's 100 m match radius on purpose: a surviving OSM row can then
 * never resolve to a curated waypoint's registry entry.
 */
export const FAMILY_DUPLICATE_RADIUS_M: Record<Family, number> = {
  water: 250,
  // Curated campsite markers often sit on the track at the turn-off while
  // OSM maps the shelter itself, a few hundred metres up the spur.
  shelter: 600,
  lodging: 300,
  town: 3000,
  food: 150,
  resupply: 150,
  other: 200,
};

/** Same-name matches within this distance are duplicates regardless of type. */
export const NAME_DUPLICATE_RADIUS_M = 1500;

/** OSM-vs-OSM: same family + same name within this distance → one survivor. */
export const OSM_SELF_DUPLICATE_RADIUS_M = 300;
/** OSM-vs-OSM for towns: a place node and its boundary relation sit further apart. */
export const OSM_SELF_TOWN_DUPLICATE_RADIUS_M = 3000;
/** OSM-vs-OSM: unnamed same-type elements within this distance → one survivor. */
export const OSM_SELF_UNNAMED_RADIUS_M = 60;

/**
 * Per-family cap on OSM rows within {@link CLUSTER_RADIUS_M} of each other.
 * A trail town has thirty cafes; a hiker wants to know there is food, where
 * the supermarket is and a couple of places to sleep. Rows are admitted in
 * priority order (supermarkets first, then nearest to the track), so the cap
 * keeps the most useful ones. Water, shelter and towns are never capped.
 */
export const CLUSTER_CAPS: Partial<Record<Family, number>> = {
  food: 3,
  lodging: 3,
  resupply: 4,
  other: 3,
};
export const CLUSTER_RADIUS_M = 1000;

/** Admission order within a family: lower first. */
function kindPriority(kind: string): number {
  switch (kind) {
    case "Supermarket":
      return 0;
    case "Shop":
      return 1;
    case "Hospital":
      return 0;
    case "Pharmacy":
      return 1;
    default:
      return 2;
  }
}

/** Normalise a name for equality: case, punctuation and whitespace-insensitive. */
export function normaliseName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words that a name can gain or lose between a GPX and OSM without naming a
 * different place: "Long Point" vs "Long Point Campsite", "Mt Cooke Group
 * Campsite" vs "Mount Cooke". Stripped before {@link sameName} compares.
 */
const GENERIC_NAME_WORDS = new Set([
  "campsite",
  "camp",
  "site",
  "campground",
  "camping",
  "area",
  "ground",
  "hut",
  "shelter",
  "group",
  "the",
  "track",
  "trail",
  "lookout",
  "picnic",
  "reserve",
  "park",
]);

const NAME_WORD_ALIASES: Record<string, string> = {
  mt: "mount",
  mnt: "mount",
  st: "saint",
};

/** The distinctive part of a name: normalised, aliases expanded, generic words dropped. */
export function coreName(name: string): string {
  return normaliseName(name)
    .split(" ")
    .map((w) => NAME_WORD_ALIASES[w] ?? w)
    .filter((w) => w && !GENERIC_NAME_WORDS.has(w))
    .join(" ");
}

/** True when two names denote the same place for duplicate purposes. */
export function sameName(a: string, b: string): boolean {
  const na = normaliseName(a);
  const nb = normaliseName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ca = coreName(a);
  const cb = coreName(b);
  return ca.length >= 3 && ca === cb;
}

export interface MergeRejection {
  candidate: OsmCandidate;
  reason: string;
}

export interface MergeResult {
  kept: OsmCandidate[];
  rejected: MergeRejection[];
}

/**
 * Drop OSM candidates the curated set already covers, then collapse OSM
 * duplicates of each other. Curated rows (anything without `source: 'osm'`)
 * are read-only inputs here.
 *
 * Coverage rules, any of which rejects a candidate:
 *  - a curated waypoint of the same family within {@link FAMILY_DUPLICATE_RADIUS_M}
 *    (`other` requires the same exact type — a curated lookout does not cover
 *    an OSM hospital);
 *  - a curated waypoint with the same normalised name within
 *    {@link NAME_DUPLICATE_RADIUS_M}, whatever its type.
 *
 * Shops and cafes near a curated *town* waypoint are deliberately kept: the
 * town marker says "there is a town"; the shop says where the food is.
 */
export function mergeOsmCandidates(
  candidates: OsmCandidate[],
  curated: CuratedWaypointLike[]
): MergeResult {
  const curatedRows = curated
    .filter((w) => w.source !== "osm")
    .map((w) => ({
      ...w,
      family: waypointFamily(w.type),
      norm: normaliseName(w.name),
    }));

  const kept: OsmCandidate[] = [];
  const rejected: MergeRejection[] = [];

  // Deterministic order: most useful kind first, then closest to the track,
  // so when two OSM rows duplicate each other (or a cluster is full) the
  // supermarket / the one nearer the trail survives.
  const ordered = [...candidates].sort(
    (a, b) =>
      kindPriority(a.kind) - kindPriority(b.kind) ||
      a.distanceFromTrackM - b.distanceFromTrackM ||
      a.osmId.localeCompare(b.osmId)
  );

  for (const c of ordered) {
    const family = waypointFamily(c.type);
    const norm = normaliseName(c.name);
    const unnamed = normaliseName(c.name) === normaliseName(c.kind);
    let reason: string | null = null;

    for (const w of curatedRows) {
      const d = haversineMeters(c.lat, c.lon, w.lat, w.lon);
      const sameFamily =
        family === "other" ? w.type === c.type : w.family === family;
      if (sameFamily && d <= FAMILY_DUPLICATE_RADIUS_M[family]) {
        reason = `covered by curated ${w.type} "${w.name}" ${Math.round(d)} m away`;
        break;
      }
      if (norm && d <= NAME_DUPLICATE_RADIUS_M && sameName(c.name, w.name)) {
        reason = `same name as curated ${w.type} "${w.name}" ${Math.round(d)} m away`;
        break;
      }
    }

    if (!reason) {
      // The hut mapped 5 m from a campsite that a curated waypoint covers is
      // covered by the same waypoint.
      for (const r of rejected) {
        if (
          !r.reason.startsWith("covered by curated") &&
          !r.reason.startsWith("same name as")
        )
          continue;
        if (waypointFamily(r.candidate.type) !== family) continue;
        if (family === "other" && r.candidate.kind !== c.kind) continue;
        const d = haversineMeters(
          c.lat,
          c.lon,
          r.candidate.lat,
          r.candidate.lon
        );
        if (d <= OSM_SELF_UNNAMED_RADIUS_M) {
          reason = `co-located with OSM ${r.candidate.osmId} (${r.reason})`;
          break;
        }
      }
    }

    if (!reason) {
      for (const k of kept) {
        if (waypointFamily(k.type) !== family) continue;
        const d = haversineMeters(c.lat, c.lon, k.lat, k.lon);
        const kUnnamed = normaliseName(k.name) === normaliseName(k.kind);
        if (
          unnamed &&
          kUnnamed &&
          k.type === c.type &&
          d <= OSM_SELF_UNNAMED_RADIUS_M
        ) {
          reason = `duplicate of OSM ${k.osmId} (${k.kind}) ${Math.round(d)} m away`;
          break;
        }
        const selfRadius =
          family === "town"
            ? OSM_SELF_TOWN_DUPLICATE_RADIUS_M
            : OSM_SELF_DUPLICATE_RADIUS_M;
        if (!unnamed && d <= selfRadius && sameName(k.name, c.name)) {
          reason = `duplicate of OSM ${k.osmId} "${k.name}" ${Math.round(d)} m away`;
          break;
        }
      }
    }

    if (!reason) {
      const cap = CLUSTER_CAPS[family];
      if (cap !== undefined) {
        // `other` is capped per kind (three lookouts and three pharmacies,
        // not three of either); the rest per family.
        const peers = kept.filter(
          (k) =>
            waypointFamily(k.type) === family &&
            (family !== "other" || k.kind === c.kind) &&
            haversineMeters(c.lat, c.lon, k.lat, k.lon) <= CLUSTER_RADIUS_M
        );
        if (peers.length >= cap) {
          reason = `cluster cap: already ${cap} ${family === "other" ? c.kind.toLowerCase() : family} rows within ${CLUSTER_RADIUS_M} m`;
        }
      }
    }

    if (reason) rejected.push({ candidate: c, reason });
    else kept.push(c);
  }

  kept.sort((a, b) => a.trailKm - b.trailKm || a.name.localeCompare(b.name));
  return { kept, rejected };
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

/** Tags worth keeping in `pois.json` (review aid) and in descriptions. */
export const KEPT_TAG_KEYS: readonly string[] = [
  "name",
  "amenity",
  "shop",
  "tourism",
  "natural",
  "man_made",
  "place",
  "highway",
  "railway",
  "information",
  "shelter_type",
  "drinking_water",
  "seasonal",
  "opening_hours",
  "phone",
  "website",
  "fee",
  "capacity",
  "operator",
  "brand",
  "cuisine",
  "access",
  "description",
];

export function pickTags(tags: OsmTags): OsmTags {
  const out: OsmTags = {};
  for (const key of KEPT_TAG_KEYS) {
    if (tags[key] !== undefined) out[key] = tags[key];
  }
  return out;
}

const MAX_OSM_DESCRIPTION_CHARS = 300;

export function osmUrl(osmId: string): string {
  return `https://www.openstreetmap.org/${osmId}`;
}

/**
 * A short factual description from the tags, ending with the ODbL
 * attribution and the element URL (so a reviewer can jump straight to it).
 */
export function describeOsmCandidate(
  c: Pick<OsmCandidate, "kind" | "tags" | "osmId">
): string {
  const t = c.tags;
  const parts: string[] = [c.kind];
  if (t.description) {
    const text = t.description.replace(/\s+/g, " ").trim();
    parts.push(
      text.length > MAX_OSM_DESCRIPTION_CHARS
        ? `${text.slice(0, MAX_OSM_DESCRIPTION_CHARS - 1)}…`
        : text
    );
  }
  if (t.drinking_water === "yes") parts.push("Drinking water: yes");
  if (t.drinking_water === "treated") parts.push("Drinking water: treated");
  if (t.drinking_water === "conditional")
    parts.push("Drinking water: conditional");
  if (t.drinking_water === "untreated")
    parts.push("Drinking water: untreated (treat before drinking)");
  if (t.seasonal && t.seasonal !== "no") parts.push(`Seasonal: ${t.seasonal}`);
  if (t.shelter_type)
    parts.push(`Shelter type: ${t.shelter_type.replace(/_/g, " ")}`);
  if (t.capacity) parts.push(`Capacity: ${t.capacity}`);
  if (t.fee === "yes") parts.push("Fee applies");
  if (t.access && t.access !== "yes" && t.access !== "public")
    parts.push(`Access: ${t.access}`);
  if (t.operator) parts.push(`Operator: ${t.operator}`);
  if (t.opening_hours) parts.push(`Hours: ${t.opening_hours}`);
  if (t.phone) parts.push(`Phone: ${t.phone}`);
  if (t.website) parts.push(t.website);
  parts.push(`Source: OpenStreetMap contributors (ODbL), ${osmUrl(c.osmId)}`);
  return parts.join(". ").replace(/\.\./g, ".");
}

// ---------------------------------------------------------------------------
// pois.json
// ---------------------------------------------------------------------------

export const POIS_FILENAME = "pois.json";

/** One reviewed entry in `data/trails/<trail>/pois.json`. */
export interface PoiEntry {
  osmId: string;
  name: string;
  type: WaypointType;
  kind: string;
  lat: number;
  lon: number;
  distanceFromTrackM: number;
  trailKm: number;
  tags: OsmTags;
}

export interface PoisFile {
  trailId: string;
  note?: string;
  source: string;
  fetchedAt: string;
  /** OSM ids (`node/123`) a reviewer has struck out. Preserved across re-fetches. */
  rejected: string[];
  pois: PoiEntry[];
}

export const POIS_FILE_NOTE =
  "Generated by `npm run fetch:pois` from OpenStreetMap; do not hand-edit entries. " +
  "To keep an entry out of the build, add its osmId to `rejected` — a re-fetch preserves that list.";

export const POIS_FILE_SOURCE =
  "© OpenStreetMap contributors, ODbL 1.0 — fetched via the Overpass API";

export function candidateToPoiEntry(c: OsmCandidate): PoiEntry {
  return {
    osmId: c.osmId,
    name: c.name,
    type: c.type,
    kind: c.kind,
    lat: Number(c.lat.toFixed(6)),
    lon: Number(c.lon.toFixed(6)),
    distanceFromTrackM: Math.round(c.distanceFromTrackM),
    trailKm: Number(c.trailKm.toFixed(1)),
    tags: pickTags(c.tags),
  };
}

const OSM_ID_PATTERN = /^(node|way|relation)\/\d+$/;

/** Validate a parsed `pois.json`; throws with a path-aware message. */
export function parsePoisFile(raw: unknown, sourcePath: string): PoisFile {
  const fail = (msg: string): never => {
    throw new Error(`${sourcePath}: ${msg}`);
  };
  if (!raw || typeof raw !== "object") return fail("expected an object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.trailId !== "string") return fail("missing trailId");
  if (!Array.isArray(obj.pois)) return fail("missing pois array");
  const rejected = obj.rejected ?? [];
  if (
    !Array.isArray(rejected) ||
    !rejected.every((r) => typeof r === "string" && OSM_ID_PATTERN.test(r))
  ) {
    return fail('rejected must be an array of osm ids like "node/123"');
  }
  const pois = obj.pois.map((p, i) => {
    const e = p as Record<string, unknown>;
    if (typeof e.osmId !== "string" || !OSM_ID_PATTERN.test(e.osmId))
      fail(`pois[${i}]: bad osmId`);
    if (typeof e.name !== "string" || !e.name.trim())
      fail(`pois[${i}]: missing name`);
    if (typeof e.type !== "string") fail(`pois[${i}]: missing type`);
    if (
      typeof e.lat !== "number" ||
      typeof e.lon !== "number" ||
      !isFinite(e.lat) ||
      !isFinite(e.lon)
    ) {
      fail(`pois[${i}]: bad lat/lon`);
    }
    return {
      osmId: e.osmId as string,
      name: e.name as string,
      type: e.type as WaypointType,
      kind: typeof e.kind === "string" ? e.kind : (e.type as string),
      lat: e.lat as number,
      lon: e.lon as number,
      distanceFromTrackM:
        typeof e.distanceFromTrackM === "number" ? e.distanceFromTrackM : 0,
      trailKm: typeof e.trailKm === "number" ? e.trailKm : 0,
      tags: (e.tags && typeof e.tags === "object" ? e.tags : {}) as OsmTags,
    };
  });
  return {
    trailId: obj.trailId,
    note: typeof obj.note === "string" ? obj.note : undefined,
    source: typeof obj.source === "string" ? obj.source : POIS_FILE_SOURCE,
    fetchedAt: typeof obj.fetchedAt === "string" ? obj.fetchedAt : "",
    rejected: rejected as string[],
    pois,
  };
}

/** Waypoint the build appends for one POI. */
export interface OsmWaypoint extends TrailWaypoint {
  source: "osm";
}

export interface PoisToWaypointsResult {
  waypoints: OsmWaypoint[];
  /** Entries left out, with why — logged by the build. */
  skipped: { osmId: string; name: string; reason: string }[];
}

/**
 * Convert a reviewed file into waypoints for the build. The merge against the
 * curated set is re-run here (it is cheap and idempotent) so a curated
 * waypoint added *after* the last fetch still wins over its OSM twin.
 */
export function poisFileToWaypoints(
  file: PoisFile,
  curated: CuratedWaypointLike[]
): PoisToWaypointsResult {
  const rejectedIds = new Set(file.rejected);
  const skipped: PoisToWaypointsResult["skipped"] = [];
  const candidates: OsmCandidate[] = [];
  for (const p of file.pois) {
    if (rejectedIds.has(p.osmId)) {
      skipped.push({
        osmId: p.osmId,
        name: p.name,
        reason: "in rejected list",
      });
      continue;
    }
    candidates.push({ ...p });
  }
  const merged = mergeOsmCandidates(candidates, curated);
  for (const r of merged.rejected) {
    skipped.push({
      osmId: r.candidate.osmId,
      name: r.candidate.name,
      reason: r.reason,
    });
  }
  const waypoints: OsmWaypoint[] = merged.kept.map((c) => ({
    name: c.name,
    lat: c.lat,
    lon: c.lon,
    type: c.type,
    description: describeOsmCandidate(c),
    source: "osm",
  }));
  return { waypoints, skipped };
}
