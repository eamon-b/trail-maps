/**
 * The automatic checks a community route must pass before it is published.
 * Spec: `plans/community-routes.md` ("Automatic checks").
 *
 * Run twice: by the web and mobile clients before upload, so the hiker sees the
 * outcome while still on the share form, and again by the comments-api worker
 * on what was actually uploaded. The worker's run is the one that counts, so
 * this module never trusts its input: `sanitiseCommunityTrail` rebuilds the
 * `ProcessedTrail` from the `unknown` it is handed, and every check reads that
 * rebuilt copy. The rebuilt trail is returned as `trail`, which is what the
 * worker stores.
 *
 * What is taken from the client, validated (finite numbers, coordinates in
 * range, bounded arrays and strings) but otherwise as sent: the coordinates
 * and elevations of every point, the order of the points, each waypoint's
 * name, type, text, position and access fields, the variants' names and
 * types, and the config's id, name, region, description and `elevationSource`.
 *
 * A waypoint's `trackIndex` (which point of the line it is listed at; on a
 * variant, `variantTrackIndex`) is kept only when that point is within the
 * radius `buildTrail` matches waypoints at: 500 m on the main route, 200 m on
 * a variant. The index is not simply recomputed as the nearest point because
 * on a route that retraces itself an import lists one place at each pass, and
 * only one of those is the nearest. A waypoint whose point is further away
 * (a "water tank" listed at km 0.1 and placed 300 km off) is placed as an
 * import would place it: at its nearest point of the main route when that is
 * in range, otherwise in `offTrailWaypoints` (a variant's waypoint first tries
 * its own variant). Off-trail waypoints may lie any distance from the route,
 * as an import's do; only their `distanceFromTrail` is rebuilt.
 *
 * What is rebuilt from that geometry, the way `trail-ingest.ts`'s `buildTrail`
 * builds an import, with the client's figures ignored:
 * - every main-route point's `dist` (cumulative haversine km from 0),
 *   `track.totalDistance` and `config.lengthKm`;
 * - `track.displayPoints` (Douglas-Peucker at `buildTrail`'s adaptive
 *   tolerance, taken back by index so their `dist` ladder is the points');
 * - `track.totalAscent`/`totalDescent` (3 m hysteresis), and no point keeps a
 *   `cumAscent`/`cumDescent`, which `track-geometry` would otherwise prefer;
 * - each waypoint's km, leg, climb and elevation, from its (checked)
 *   `trackIndex`;
 * - each off-trail waypoint's `distanceFromTrail`;
 * - each variant's length, climb, junction km, track indices and `parent`.
 *   A variant must branch off the route (or off an alternate that does)
 *   within 500 m, or the shape check fails.
 *
 * Dropped outright: route breaks (an import never has any, and a declared one
 * exempted a jump from every check), OSM POIs (published unreviewed otherwise),
 * climate, timestamps, and the client's direction labels.
 *
 * The claimed km survive only long enough for `distance-consistency` to
 * compare them with the rebuilt ones: a file whose own km disagree with its
 * geometry has been edited, and fails.
 *
 * Platform-neutral (no DOM, Node or crypto). Everything is O(n) or O(n log n)
 * in the points on a real track; Douglas-Peucker, O(n²) on a pathological
 * line, is budgeted (`displayIndices`), and so the whole run fits a Worker's
 * CPU budget.
 *
 * Messages are shown to the person sharing the route, so they are plain
 * English and say what to do where there is something to do.
 */

import { haversineDistance } from './distance';
import { cumulativeElevationChange } from './gpx-optimizer';
import {
  calculateAdaptiveTolerance,
  DEFAULT_MAX_JUNCTION_DISTANCE_METERS,
  DEFAULT_TARGET_DISPLAY_POINTS,
  DEFAULT_WAYPOINT_MAX_DISTANCE_METERS,
  VARIANT_WAYPOINT_MAX_DISTANCE_METERS,
} from './trail-ingest';
import { ACCESS_MODES } from './types';
import type { AccessMode } from './types';
import type { CommunityCheck, CommunityCheckLevel } from './community-types';
import { COMMUNITY_LIMITS } from './community-types';
import type {
  DirectionConfig,
  EnrichedWaypoint,
  OffTrailWaypoint,
  ProcessedTrail,
  RouteVariant,
  TrackPoint,
  TrailConfig,
  VariantWaypoint,
} from './trail-types';

/** Thresholds of the checks table, in one place. */
export const COMMUNITY_CHECK_THRESHOLDS = {
  minLengthKm: 1,
  shortLengthKm: 3,
  maxLengthKm: 5000,
  minPoints: 20,
  coarseSpacingM: 500,
  distanceTolerance: 0.02,
  /** Below this length a 2 % disagreement is rounding, not a forged distance. */
  distanceToleranceMinKm: 0.05,
  driveSpeedKmh: 15,
  /** Fewer timed GPX points than this and the speed is not judged. */
  minTimedPoints: 10,
  noisyAscentPerKm: 250,
  /** The hysteresis band the recomputed climb uses: `gpx-import`'s ascent threshold. */
  ascentThresholdM: 3,
  gapKm: 2,
  /** Main-route, off-trail and variant waypoints together. */
  maxWaypoints: 2000,
  urlShareWarn: 0.5,
} as const;

/** Size bounds of the shape check: what a trail may hold at all. */
export const COMMUNITY_SHAPE_LIMITS = {
  trackPoints: 100_000,
  variants: 200,
  variantPoints: 100_000,
  totalVariantPoints: 300_000,
  /** The `waypoints` check fails above 2,000; the shape check only bounds memory. */
  waypoints: 10_000,
  offTrailWaypoints: 10_000,
  variantWaypoints: 2_000,
  mergedIds: 64,
  shortString: 300,
  idString: 128,
  typeString: 64,
  longString: 10_000,
  minElevation: -12_000,
  maxElevation: 12_000,
} as const;

/** The direction labels every import gets (`gpx-import.ts`); a client's are ignored. */
const COMMUNITY_DIRECTION: DirectionConfig = { default: 'Start → End', reversed: 'End → Start' };

export interface CommunityRouteStats {
  lengthKm: number;
  ascentM: number;
  hasElevation: boolean;
  /** Main-route, off-trail and variant waypoints together. */
  waypointCount: number;
  /** [minLon, minLat, maxLon, maxLat] of the main route. */
  bbox: [number, number, number, number];
  start: { lat: number; lon: number };
  end: { lat: number; lon: number };
}

export interface CommunityChecksResult {
  checks: CommunityCheck[];
  /** True when no check failed. */
  ok: boolean;
  /** The rebuilt, validated trail. Absent when the shape check failed. */
  trail?: ProcessedTrail;
  /** Absent when the shape check failed. */
  stats?: CommunityRouteStats;
}

export interface CommunityChecksMeta {
  name: string;
  description: string;
  /**
   * The raw GPX text the route was imported from, when the client still has
   * it (the web upload page does; the phone keeps no XML). Only the `speed`
   * check reads it — the processed points carry no timestamps.
   */
  gpxText?: string;
}

/**
 * What the client said about its own distances, kept from the sanitiser only
 * for `distance-consistency`. Never stored.
 */
export interface ClaimedDistances {
  /** The client's `track.totalDistance`. */
  totalDistance: number;
  /** The client's `dist` on the last main-route point. */
  lastPointDist: number;
  /** The first point whose claimed `dist` is below the one before, or null. */
  backwardsAt: number | null;
}

/** The `metadata` check on its own, for a form that re-checks text as it is typed. */
export function checkCommunityMetadata(meta: CommunityChecksMeta): CommunityCheck {
  return metadataCheck(meta);
}

/** True when any check failed (a submission with one is rejected). */
export function hasFailures(checks: readonly CommunityCheck[]): boolean {
  return checks.some((c) => c.level === 'fail');
}

function check(id: string, level: CommunityCheckLevel, message: string): CommunityCheck {
  return { id, level, message };
}

/**
 * Run every automatic check on a processed trail and the text it will be
 * shared with. The `duplicate` check needs the server's list of routes and is
 * added by the worker.
 */
export function runCommunityChecks(trail: unknown, meta: CommunityChecksMeta): CommunityChecksResult {
  const metadata = metadataCheck(meta);
  const shaped = sanitiseCommunityTrail(trail);
  if ('error' in shaped) {
    const checks = [
      check('shape', 'fail', `The route data could not be read: ${shaped.error}. Try importing the GPX file again.`),
      metadata,
    ];
    return { checks, ok: false };
  }

  const clean = shaped.trail;
  const points = clean.track.points;
  const lengthKm = clean.track.totalDistance;

  const checks: CommunityCheck[] = [
    check('shape', 'pass', 'The route data is complete and readable.'),
    lengthCheck(lengthKm),
    pointsCheck(points),
    distanceConsistencyCheck(shaped.claimed, lengthKm),
    speedCheck(meta.gpxText),
    elevationCheck(clean, lengthKm),
    gapsCheck(points),
    metadata.level === 'pass' ? waypointTextCheck(clean) ?? metadata : metadata,
    waypointsCheck(clean),
  ];

  const stats = routeStats(clean, lengthKm);
  return { checks, ok: !hasFailures(checks), trail: clean, stats };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function formatKm(km: number): string {
  return km >= 100 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

function lengthCheck(lengthKm: number): CommunityCheck {
  const t = COMMUNITY_CHECK_THRESHOLDS;
  if (lengthKm < t.minLengthKm) {
    return check('length', 'fail', `The route is ${formatKm(lengthKm)} long; a shared route must be at least ${t.minLengthKm} km.`);
  }
  if (lengthKm > t.maxLengthKm) {
    return check('length', 'fail', `The route is ${formatKm(lengthKm)} long; a shared route can be at most ${t.maxLengthKm.toLocaleString('en')} km.`);
  }
  if (lengthKm < t.shortLengthKm) {
    return check('length', 'warn', `The route is only ${formatKm(lengthKm)} long. Check that the whole walk was recorded.`);
  }
  return check('length', 'pass', `The route is ${formatKm(lengthKm)} long.`);
}

function pointsCheck(points: TrackPoint[]): CommunityCheck {
  const t = COMMUNITY_CHECK_THRESHOLDS;
  if (points.length < t.minPoints) {
    return check('points', 'fail', `The route has only ${points.length} points; at least ${t.minPoints} are needed to draw it.`);
  }
  const spacings = new Float64Array(points.length - 1);
  for (let i = 1; i < points.length; i++) {
    spacings[i - 1] = (points[i].dist - points[i - 1].dist) * 1000;
  }
  const medianM = median(spacings);
  if (medianM > t.coarseSpacingM) {
    return check(
      'points',
      'warn',
      `Points are about ${Math.round(medianM)} m apart, so the line may be hand-drawn or coarse and cut corners on the ground.`
    );
  }
  return check('points', 'pass', `The route has ${points.length.toLocaleString('en')} points.`);
}

/**
 * The client's own km against the rebuilt ones. The stored trail carries the
 * rebuilt km whatever this says; a disagreement means the file was edited
 * after it was imported, so it is refused rather than silently corrected.
 */
function distanceConsistencyCheck(claimed: ClaimedDistances, lengthKm: number): CommunityCheck {
  const t = COMMUNITY_CHECK_THRESHOLDS;
  if (claimed.backwardsAt !== null) {
    return check(
      'distance-consistency',
      'fail',
      `The distances along the route go backwards at point ${claimed.backwardsAt}. Import the GPX file again.`
    );
  }
  const tolerance = Math.max(t.distanceToleranceMinKm, lengthKm * t.distanceTolerance);
  if (Math.abs(claimed.lastPointDist - lengthKm) > tolerance) {
    return check(
      'distance-consistency',
      'fail',
      `The route's distances (${formatKm(claimed.lastPointDist)}) do not match its points (${formatKm(lengthKm)}). Import the GPX file again.`
    );
  }
  if (Math.abs(claimed.totalDistance - lengthKm) > tolerance) {
    return check(
      'distance-consistency',
      'fail',
      `The route's total length (${formatKm(claimed.totalDistance)}) does not match its points (${formatKm(lengthKm)}). Import the GPX file again.`
    );
  }
  return check('distance-consistency', 'pass', 'The distances along the route match its points.');
}

function speedCheck(gpxText: string | undefined): CommunityCheck {
  if (typeof gpxText !== 'string' || gpxText.length === 0) {
    return check('speed', 'pass', 'No GPX file was supplied, so timing could not be checked.');
  }
  const speed = gpxMovingSpeedKmh(gpxText);
  if (!speed) {
    return check('speed', 'pass', 'The GPX file has too few timestamps to check walking speed.');
  }
  const kmh = speed.medianKmh;
  if (kmh > COMMUNITY_CHECK_THRESHOLDS.driveSpeedKmh) {
    return check(
      'speed',
      'warn',
      `The recording moved at about ${Math.round(kmh)} km/h, which looks like a drive or a ride rather than a walk.`
    );
  }
  return check('speed', 'pass', `The recording moved at a walking pace (about ${kmh.toFixed(1)} km/h).`);
}

/**
 * Median moving speed of a GPX recording, from its timed `<trkpt>`s: the
 * haversine km between consecutive timed points of one `<trkseg>` over the
 * time between them, ignoring steps slower than 0.5 km/h (standing still is
 * not moving speed). Null when fewer than
 * `COMMUNITY_CHECK_THRESHOLDS.minTimedPoints` points carry a time.
 *
 * A plain string scan rather than an XML parse: it runs on the phone, the web
 * and the worker without an XML adapter, it is only a warn-level heuristic, and
 * every `indexOf` starts past the last match, so it is O(length) on any input
 * (an unclosed `<trkpt` ends the scan rather than rescanning the rest).
 */
export function gpxMovingSpeedKmh(xml: string): { medianKmh: number; timedPoints: number } | null {
  const speeds: number[] = [];
  let timedPoints = 0;
  let prev: { lat: number; lon: number; t: number } | null = null;
  let segmentEnd = xml.indexOf('</trkseg');
  let pos = 0;
  for (;;) {
    const start = xml.indexOf('<trkpt', pos);
    if (start < 0) break;
    const after = xml.charCodeAt(start + 6);
    // `<trkpt` must be the whole tag name (not `<trkptx`).
    if (!(after === 0x20 || after === 0x09 || after === 0x0a || after === 0x0d || after === 0x3e || after === 0x2f)) {
      pos = start + 6;
      continue;
    }
    const tagEnd = xml.indexOf('>', start);
    if (tagEnd < 0) break;
    if (segmentEnd >= 0 && segmentEnd < start) {
      // A new segment: the time between two recordings is not moving time.
      prev = null;
      segmentEnd = xml.indexOf('</trkseg', start);
    }
    if (xml.charCodeAt(tagEnd - 1) === 0x2f) {
      // `<trkpt … />` has no time.
      prev = null;
      pos = tagEnd + 1;
      continue;
    }
    const close = xml.indexOf('</trkpt', tagEnd);
    if (close < 0) break;
    pos = close + 7;

    const open = xml.slice(start, tagEnd);
    const lat = attributeNumber(open, LAT_ATTR);
    const lon = attributeNumber(open, LON_ATTR);
    const t = timeIn(xml, tagEnd + 1, close);
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || t === null) {
      prev = null;
      continue;
    }
    timedPoints++;
    if (prev && t > prev.t) {
      const km = haversineDistance(prev.lat, prev.lon, lat, lon) / 1000;
      const kmh = km / ((t - prev.t) / 3_600_000);
      if (kmh >= 0.5) speeds.push(kmh);
    }
    prev = { lat, lon, t };
  }
  if (timedPoints < COMMUNITY_CHECK_THRESHOLDS.minTimedPoints) return null;
  return { medianKmh: speeds.length > 0 ? median(Float64Array.from(speeds)) : 0, timedPoints };
}

const LAT_ATTR = /\blat\s*=\s*["']([^"']*)["']/;
const LON_ATTR = /\blon\s*=\s*["']([^"']*)["']/;

function attributeNumber(tag: string, re: RegExp): number | null {
  const m = re.exec(tag);
  if (!m) return null;
  const n = Number(m[1].trim());
  return m[1].trim() !== '' && Number.isFinite(n) ? n : null;
}

/**
 * Epoch ms of the first `<time>` in one point's body, or null. Searched in a
 * slice of that body, never in `xml` itself: an `indexOf` on the whole file
 * from a point without a time would run on to the end of it, once per point.
 */
function timeIn(xml: string, from: number, to: number): number | null {
  const body = xml.slice(from, to);
  const open = body.indexOf('<time');
  if (open < 0) return null;
  const textStart = body.indexOf('>', open);
  if (textStart < 0) return null;
  const close = body.indexOf('</time', textStart);
  if (close < 0) return null;
  const ms = Date.parse(body.slice(textStart + 1, close).trim());
  return Number.isFinite(ms) ? ms : null;
}

function trailHasElevation(trail: ProcessedTrail): boolean {
  if (trail.config.elevationSource === 'none') return false;
  return trail.track.points.some((p) => p.ele !== 0);
}

function elevationCheck(trail: ProcessedTrail, lengthKm: number): CommunityCheck {
  if (!trailHasElevation(trail)) {
    return check(
      'elevation',
      'warn',
      'The route has no elevation, so its profile is flat and day estimates use distance only.'
    );
  }
  const perKm = lengthKm > 0 ? trail.track.totalAscent / lengthKm : 0;
  if (perKm > COMMUNITY_CHECK_THRESHOLDS.noisyAscentPerKm) {
    return check(
      'elevation',
      'warn',
      `The route climbs ${Math.round(perKm)} m per km on average, which suggests noisy elevation data.`
    );
  }
  return check('elevation', 'pass', `The route climbs ${Math.round(trail.track.totalAscent).toLocaleString('en')} m in total.`);
}

function gapsCheck(points: TrackPoint[]): CommunityCheck {
  let count = 0;
  let firstKm = 0;
  let longestKm = 0;
  for (let i = 1; i < points.length; i++) {
    const step = points[i].dist - points[i - 1].dist;
    if (step > COMMUNITY_CHECK_THRESHOLDS.gapKm) {
      if (count === 0) firstKm = points[i - 1].dist;
      count++;
      longestKm = Math.max(longestKm, step);
    }
  }
  if (count > 0) {
    return check(
      'gaps',
      'warn',
      `The route jumps more than ${COMMUNITY_CHECK_THRESHOLDS.gapKm} km between two points ${count === 1 ? 'once' : `${count} times`} ` +
        `(first at km ${firstKm.toFixed(1)}, longest ${formatKm(longestKm)}). The recording may have dropped out.`
    );
  }
  return check('gaps', 'pass', 'The route has no large jumps between points.');
}

const URL_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

function metadataCheck(meta: CommunityChecksMeta): CommunityCheck {
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  const L = COMMUNITY_LIMITS;
  if (name.length < L.nameMin || name.length > L.nameMax) {
    return check('metadata', 'fail', `The name must be ${L.nameMin} to ${L.nameMax} characters long (it is ${name.length}).`);
  }
  if (description.length < L.descriptionMin || description.length > L.descriptionMax) {
    return check(
      'metadata',
      'fail',
      `The description must be ${L.descriptionMin} to ${L.descriptionMax.toLocaleString('en')} characters long (it is ${description.length.toLocaleString('en')}).`
    );
  }
  if (mostlyLinks(description)) {
    return check(
      'metadata',
      'warn',
      'The description is mostly links. Describe the walk itself: where it goes, the terrain, water and camps.'
    );
  }
  return check('metadata', 'pass', 'The name and description are a good length.');
}

/** True when links make up more than `urlShareWarn` of the visible characters. */
function mostlyLinks(text: string): boolean {
  const visible = text.replace(/\s+/g, '').length;
  if (visible === 0) return false;
  let urlChars = 0;
  for (const match of text.matchAll(URL_RE)) urlChars += match[0].length;
  return urlChars / visible > COMMUNITY_CHECK_THRESHOLDS.urlShareWarn;
}

/**
 * The same "mostly links" test over every waypoint description (main route,
 * off-trail and variant waypoints) taken together: link spam hides there as
 * easily as in the route's own description. A `metadata` warning, or null when
 * the descriptions are fine.
 */
function waypointTextCheck(trail: ProcessedTrail): CommunityCheck | null {
  const texts: string[] = [];
  const add = (w: { description?: string }) => {
    if (w.description) texts.push(w.description);
  };
  trail.waypoints.forEach(add);
  trail.offTrailWaypoints.forEach(add);
  for (const v of [...trail.alternates, ...trail.sideTrips]) v.waypoints?.forEach(add);
  if (texts.length === 0 || !mostlyLinks(texts.join('\n'))) return null;
  return check(
    'metadata',
    'warn',
    'The waypoint descriptions are mostly links. Describe each place instead: what is there, water, shelter and access.'
  );
}

/** Main-route, off-trail and variant waypoints together. */
function countWaypoints(trail: {
  waypoints: unknown[];
  offTrailWaypoints: unknown[];
  alternates: { waypoints?: unknown[] }[];
  sideTrips: { waypoints?: unknown[] }[];
}): number {
  let count = trail.waypoints.length + trail.offTrailWaypoints.length;
  for (const v of trail.alternates) count += v.waypoints?.length ?? 0;
  for (const v of trail.sideTrips) count += v.waypoints?.length ?? 0;
  return count;
}

function waypointsCheck(trail: ProcessedTrail): CommunityCheck {
  const count = countWaypoints(trail);
  const max = COMMUNITY_CHECK_THRESHOLDS.maxWaypoints;
  if (count > max) {
    return check(
      'waypoints',
      'fail',
      `The route has ${count.toLocaleString('en')} waypoints (counting off-trail places, alternates and side trips); a shared route can have at most ${max.toLocaleString('en')}.`
    );
  }
  if (count === 0) {
    return check(
      'waypoints',
      'warn',
      'The route has no waypoints, so it will have no datasheet. Adding camps, water and towns to the GPX makes it far more useful.'
    );
  }
  return check('waypoints', 'pass', `The route has ${count.toLocaleString('en')} waypoint${count === 1 ? '' : 's'}.`);
}

function routeStats(trail: ProcessedTrail, lengthKm: number): CommunityRouteStats {
  const points = trail.track.points;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const first = points[0];
  const last = points[points.length - 1];
  return {
    lengthKm: Math.round(lengthKm * 10) / 10,
    ascentM: Math.round(trail.track.totalAscent),
    hasElevation: trailHasElevation(trail),
    waypointCount: countWaypoints(trail),
    bbox: [minLon, minLat, maxLon, maxLat],
    start: { lat: first.lat, lon: first.lon },
    end: { lat: last.lat, lon: last.lon },
  };
}

/** Median by quickselect: O(n) on average, and it reorders `values`. */
function median(values: Float64Array): number {
  if (values.length === 0) return 0;
  const k = Math.floor(values.length / 2);
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const tmp = values[i];
        values[i] = values[j];
        values[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

// ---------------------------------------------------------------------------
// Geometry helpers for the rebuild
// ---------------------------------------------------------------------------

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cumulative haversine km along `points`, from 0. */
function cumulativeKmOf(points: readonly { lat: number; lon: number }[]): Float64Array {
  const km = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    km[i] = km[i - 1] + haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000;
  }
  return km;
}

/**
 * Perpendicular distance in metres from `p` to the segment `a`-`b`: the same
 * equirectangular formula as `gpx-optimizer`'s (private) one, so
 * {@link displayIndices} keeps exactly the points `douglasPeuckerIndices` does.
 */
function perpendicularDistanceM(
  p: { lat: number; lon: number },
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad;
  const lat2 = b.lat * rad;
  const cos = Math.cos((lat1 + lat2) / 2);
  const x1 = a.lon * rad * cos * R;
  const y1 = lat1 * R;
  const x2 = b.lon * rad * cos * R;
  const y2 = lat2 * R;
  const xP = p.lon * rad * cos * R;
  const yP = p.lat * rad * R;
  const lengthSq = (x2 - x1) ** 2 + (y2 - y1) ** 2;
  if (lengthSq === 0) return Math.sqrt((xP - x1) ** 2 + (yP - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((xP - x1) * (x2 - x1) + (yP - y1) * (y2 - y1)) / lengthSq));
  return Math.sqrt((xP - (x1 + t * (x2 - x1))) ** 2 + (yP - (y1 + t * (y2 - y1))) ** 2);
}

/**
 * Perpendicular-distance evaluations Douglas-Peucker may spend before
 * {@link displayIndices} gives up on it. Its cost is the sum of the ranges it
 * splits: about n log n when splits are balanced, up to n × (points kept) when
 * they are not, which a long smooth line does (a 100,000-point line wiggling
 * every 25 m took 20 s). An import is simplified to ~5,000 points per track
 * (`IMPORT_TARGET_POINTS`), so 5,000 × 3,000 kept is the most an honest
 * single-track upload can need; this allows that with room to spare, and is
 * about half a second.
 */
const DOUGLAS_PEUCKER_BUDGET = 20_000_000;

/**
 * The indices of `points` the display copy keeps: `buildTrail`'s
 * simplification (adaptive tolerance capped at 25 m, Douglas-Peucker, kept
 * points taken back by index). Douglas-Peucker is O(n²) on a pathological
 * line, so past its budget the copy falls back to an even stride at the same
 * target — a coarser line for whoever built it, never a stalled worker.
 */
function displayIndices(points: readonly TrackPoint[], totalKm: number): number[] | null {
  const n = points.length;
  if (n <= DEFAULT_TARGET_DISPLAY_POINTS) return null;
  const tolerance = calculateAdaptiveTolerance(points as TrackPoint[], DEFAULT_TARGET_DISPLAY_POINTS, totalKm);
  let budget = DOUGLAS_PEUCKER_BUDGET;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: number[] = [0, n - 1];
  while (stack.length > 0) {
    const end = stack.pop()!;
    const start = stack.pop()!;
    budget -= end - start - 1;
    if (budget < 0) return strideIndices(n, DEFAULT_TARGET_DISPLAY_POINTS);
    let maxDist = 0;
    let maxIndex = start;
    for (let i = start + 1; i < end; i++) {
      const d = perpendicularDistanceM(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance) {
      keep[maxIndex] = 1;
      stack.push(start, maxIndex, maxIndex, end);
    }
  }
  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

function strideIndices(n: number, target: number): number[] {
  const step = (n - 1) / (target - 1);
  const out: number[] = [];
  for (let k = 0; k < target; k++) out.push(Math.round(k * step));
  return out;
}

/**
 * Exact nearest-point lookup over a fixed set of points: a k-d tree on unit
 * vectors, where straight-line (chord) distance orders points exactly as
 * great-circle distance does, so the answer is the point the importer's
 * brute-force haversine scan finds (ties go to the earliest index, as there).
 *
 * Not `@lib/point-index`: its grid ring-walk costs O(rows × rings) for a query
 * outside the track's bounding box, and an off-trail waypoint can be anywhere
 * (400 far-away waypoints against a 100,000-point north-south line did not
 * finish in two minutes). Here a build is O(n log n), and a query, pruned by
 * each subtree's bounding box, is about O(log n) near the track or far from
 * it; the worst case, a query equidistant from every point (the centre of a
 * circle), is O(n).
 */
class NearestPoints {
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly z: Float64Array;
  /** Point indices, arranged so every range's median splits it. */
  private readonly order: Uint32Array;
  /** Split axis (0, 1, 2) of the range whose median sits at each position. */
  private readonly axis: Uint8Array;
  /** That range's bounding box, [minX, maxX, minY, maxY, minZ, maxZ] per position. */
  private readonly box: Float64Array;
  private bestIndex = -1;
  private bestDistSq = Infinity;
  private qx = 0;
  private qy = 0;
  private qz = 0;

  constructor(points: readonly { lat: number; lon: number }[]) {
    const n = points.length;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.order = new Uint32Array(n);
    this.axis = new Uint8Array(n);
    this.box = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) {
      const [x, y, z] = unitVector(points[i].lat, points[i].lon);
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = z;
      this.order[i] = i;
    }
    this.build(0, n);
  }

  /** Index of the nearest point (the earliest on a tie); -1 when there are none. */
  nearest(lat: number, lon: number): number {
    [this.qx, this.qy, this.qz] = unitVector(lat, lon);
    this.bestIndex = -1;
    this.bestDistSq = Infinity;
    this.search(0, this.order.length);
    return this.bestIndex;
  }

  private coord(axis: number, i: number): number {
    return axis === 0 ? this.x[i] : axis === 1 ? this.y[i] : this.z[i];
  }

  private build(lo: number, hi: number): void {
    // An explicit stack: a 100,000-point track is only ~14 levels deep, but
    // there is no reason to spend the call stack on it.
    const stack = [lo, hi];
    while (stack.length > 0) {
      const h = stack.pop()!;
      const l = stack.pop()!;
      if (h - l <= KD_LEAF) continue;
      const mid = (l + h) >> 1;
      const axis = this.boundRange(l, h, mid);
      this.select(l, h - 1, mid, axis);
      this.axis[mid] = axis;
      stack.push(l, mid, mid + 1, h);
    }
  }

  /**
   * Record the bounding box of `order[lo..hi)` under `mid` and return its
   * widest axis, the one to split on.
   */
  private boundRange(lo: number, hi: number, mid: number): number {
    let best = 0;
    let bestSpread = -1;
    for (let axis = 0; axis < 3; axis++) {
      let min = Infinity;
      let max = -Infinity;
      for (let k = lo; k < hi; k++) {
        const c = this.coord(axis, this.order[k]);
        if (c < min) min = c;
        if (c > max) max = c;
      }
      this.box[mid * 6 + axis * 2] = min;
      this.box[mid * 6 + axis * 2 + 1] = max;
      if (max - min > bestSpread) {
        bestSpread = max - min;
        best = axis;
      }
    }
    return best;
  }

  /** Squared distance from the query to the box recorded under `mid`. */
  private boxDistSq(mid: number): number {
    let sum = 0;
    for (let axis = 0; axis < 3; axis++) {
      const q = axis === 0 ? this.qx : axis === 1 ? this.qy : this.qz;
      const min = this.box[mid * 6 + axis * 2];
      const max = this.box[mid * 6 + axis * 2 + 1];
      const d = q < min ? min - q : q > max ? q - max : 0;
      sum += d * d;
    }
    return sum;
  }

  /** Quickselect `order[lo..hi]` so position `k` holds its median on `axis`. */
  private select(lo: number, hi: number, k: number, axis: number): void {
    const order = this.order;
    while (lo < hi) {
      const pivot = this.coord(axis, order[(lo + hi) >> 1]);
      let i = lo;
      let j = hi;
      while (i <= j) {
        while (this.coord(axis, order[i]) < pivot) i++;
        while (this.coord(axis, order[j]) > pivot) j--;
        if (i <= j) {
          const tmp = order[i];
          order[i] = order[j];
          order[j] = tmp;
          i++;
          j--;
        }
      }
      if (k <= j) hi = j;
      else if (k >= i) lo = i;
      else return;
    }
  }

  private consider(i: number): void {
    const dx = this.x[i] - this.qx;
    const dy = this.y[i] - this.qy;
    const dz = this.z[i] - this.qz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < this.bestDistSq || (d === this.bestDistSq && i < this.bestIndex)) {
      this.bestDistSq = d;
      this.bestIndex = i;
    }
  }

  private search(lo: number, hi: number): void {
    if (hi - lo <= KD_LEAF) {
      for (let k = lo; k < hi; k++) this.consider(this.order[k]);
      return;
    }
    const mid = (lo + hi) >> 1;
    // `>`, not `>=`: an equally near point in the box may be an earlier one.
    // The box test is what keeps a query far outside the track cheap: there
    // every split plane is nearer than the best point, but whole boxes on the
    // track's far side are not.
    if (this.boxDistSq(mid) > this.bestDistSq) return;
    const axis = this.axis[mid];
    const point = this.order[mid];
    const q = axis === 0 ? this.qx : axis === 1 ? this.qy : this.qz;
    this.consider(point);
    if (q < this.coord(axis, point)) {
      this.search(lo, mid);
      this.search(mid + 1, hi);
    } else {
      this.search(mid + 1, hi);
      this.search(lo, mid);
    }
  }
}

/** Points per k-d tree leaf, scanned outright. */
const KD_LEAF = 8;

function unitVector(lat: number, lon: number): [number, number, number] {
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  const c = Math.cos(phi);
  return [c * Math.cos(lambda), c * Math.sin(lambda), Math.sin(phi)];
}

type Climb = { ascent: number[]; descent: number[] };

/**
 * Each row's leg from the row before it (sorted by `index`) and its running
 * totals, read off the rebuilt km and climb ladders — what `enrichWaypoints`
 * and `enrichVariantWaypoints` compute from `calculateSegmentStats`. `offsetKm`
 * is the variant's junction km (0 on the main route). Returns the rows sorted.
 */
function enrichRows<W extends EnrichedWaypoint | VariantWaypoint>(
  rows: W[],
  indexOf: (w: W) => number,
  points: readonly { ele: number }[],
  km: ArrayLike<number>,
  climb: Climb,
  offsetKm: number
): W[] {
  const sorted = rows
    .map((w, order) => ({ w, order, index: indexOf(w) }))
    .sort((a, b) => a.index - b.index || a.order - b.order);
  let prev = 0;
  return sorted.map(({ w, index }) => {
    w.elevation = Math.round(points[index].ele);
    w.distance = round2(km[index] - km[prev]);
    w.totalDistance = round2(offsetKm + km[index]);
    w.ascent = Math.round(climb.ascent[index] - climb.ascent[prev]);
    w.descent = Math.round(climb.descent[index] - climb.descent[prev]);
    w.totalAscent = Math.round(climb.ascent[index]);
    w.totalDescent = Math.round(climb.descent[index]);
    prev = index;
    return w;
  });
}

// ---------------------------------------------------------------------------
// The shape check: rebuild a ProcessedTrail from untrusted input
// ---------------------------------------------------------------------------

/** Thrown inside the sanitiser; caught by `sanitiseCommunityTrail`. */
class ShapeError extends Error {}

type Obj = Record<string, unknown>;

const S = COMMUNITY_SHAPE_LIMITS;

function fail(path: string, what: string): never {
  throw new ShapeError(`${path} ${what}`);
}

function obj(v: unknown, path: string): Obj {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'is not an object');
  return v as Obj;
}

function arr(v: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(v)) fail(path, 'is not a list');
  if (v.length > max) fail(path, `has more than ${max.toLocaleString('en')} entries`);
  return v;
}

function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    fail(path, Number.isFinite(min) || Number.isFinite(max) ? `is not a number between ${min} and ${max}` : 'is not a number');
  }
  return v;
}

function int(v: unknown, path: string, min: number, max: number): number {
  const n = num(v, path, min, max);
  if (!Number.isInteger(n)) fail(path, 'is not a whole number');
  return n;
}

function str(v: unknown, path: string, max: number): string {
  if (typeof v !== 'string') fail(path, 'is not text');
  if (v.length > max) fail(path, `is longer than ${max.toLocaleString('en')} characters`);
  return v;
}

function optStr(v: unknown, path: string, max: number): string | undefined {
  return v === undefined || v === null ? undefined : str(v, path, max);
}

function optNum(v: unknown, path: string, min = -Infinity, max = Infinity): number | undefined {
  return v === undefined || v === null ? undefined : num(v, path, min, max);
}

function lat(v: unknown, path: string): number {
  return num(v, path, -90, 90);
}

function lon(v: unknown, path: string): number {
  return num(v, path, -180, 180);
}

function ele(v: unknown, path: string): number {
  // `ele` is optional on the wire for a point without elevation; 0 is how the
  // pipeline writes "none".
  if (v === undefined || v === null) return 0;
  return num(v, path, S.minElevation, S.maxElevation);
}

function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'is not true or false');
  return v;
}

/** Copy the optional WaypointAccess fields onto `out`. */
function copyAccess(w: Obj, path: string, out: { offTrailKm?: number; accessMode?: AccessMode; acceptsBoxes?: boolean; accessName?: string }): void {
  const offTrailKm = optNum(w.offTrailKm, `${path}.offTrailKm`, 0, 10_000);
  if (offTrailKm !== undefined) out.offTrailKm = offTrailKm;
  if (w.accessMode !== undefined && w.accessMode !== null) {
    if (typeof w.accessMode !== 'string' || !(ACCESS_MODES as readonly string[]).includes(w.accessMode)) {
      fail(`${path}.accessMode`, 'is not a known way of reaching a place');
    }
    out.accessMode = w.accessMode as AccessMode;
  }
  if (w.acceptsBoxes !== undefined && w.acceptsBoxes !== null) out.acceptsBoxes = bool(w.acceptsBoxes, `${path}.acceptsBoxes`);
  const accessName = optStr(w.accessName, `${path}.accessName`, S.shortString);
  if (accessName !== undefined) out.accessName = accessName;
}

function mergedIds(v: unknown, path: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  return arr(v, path, S.mergedIds).map((id, i) => str(id, `${path}[${i}]`, S.idString));
}

/** The text and identity fields every kind of waypoint carries. */
function copyWaypointText(w: Obj, path: string, out: { id?: string; description?: string; mergedIds?: string[] }): void {
  const id = optStr(w.id, `${path}.id`, S.idString);
  if (id !== undefined) out.id = id;
  const description = optStr(w.description, `${path}.description`, S.longString);
  if (description !== undefined) out.description = description;
  const merged = mergedIds(w.mergedIds, `${path}.mergedIds`);
  if (merged !== undefined) out.mergedIds = merged;
}

/**
 * The main route's points with `dist` rebuilt from their coordinates. The
 * claimed `dist` is still required and range-checked (it is what
 * `distance-consistency` compares), then dropped; `cumAscent`/`cumDescent`,
 * `time` and anything else on a point are never read.
 */
function mainPoints(v: unknown, path: string): { points: TrackPoint[]; lastPointDist: number; backwardsAt: number | null } {
  const raw = arr(v, path, S.trackPoints);
  if (raw.length < 2) fail(path, 'has fewer than 2 points');
  const points: TrackPoint[] = new Array(raw.length);
  let backwardsAt: number | null = null;
  let claimedPrev = 0;
  let km = 0;
  for (let i = 0; i < raw.length; i++) {
    const p = obj(raw[i], `${path}[${i}]`);
    const point: TrackPoint = {
      lat: lat(p.lat, `${path}[${i}].lat`),
      lon: lon(p.lon, `${path}[${i}].lon`),
      ele: ele(p.ele, `${path}[${i}].ele`),
      dist: 0,
    };
    const claimed = num(p.dist, `${path}[${i}].dist`, 0, 100_000);
    if (i > 0) {
      if (backwardsAt === null && claimed < claimedPrev) backwardsAt = i;
      const before = points[i - 1];
      km += haversineDistance(before.lat, before.lon, point.lat, point.lon) / 1000;
      point.dist = km;
    }
    claimedPrev = claimed;
    points[i] = point;
  }
  return { points, lastPointDist: claimedPrev, backwardsAt };
}

/**
 * A main-route waypoint. Only what places it is read; every figure
 * (`elevation`, `distance`, `totalDistance`, climb) is filled in by
 * {@link enrichRows} from `trackIndex`.
 */
function enrichedWaypoint(raw: unknown, path: string, pointCount: number): EnrichedWaypoint {
  const w = obj(raw, path);
  const out: EnrichedWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    type: str(w.type, `${path}.type`, S.typeString),
    elevation: 0,
    distance: 0,
    totalDistance: 0,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    trackIndex: int(w.trackIndex, `${path}.trackIndex`, 0, pointCount - 1),
  };
  copyWaypointText(w, path, out);
  copyAccess(w, path, out);
  return out;
}

/** An off-trail waypoint; `distanceFromTrail` is rebuilt by the caller. */
function offTrailWaypoint(raw: unknown, path: string): OffTrailWaypoint {
  const w = obj(raw, path);
  const out: OffTrailWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    type: str(w.type, `${path}.type`, S.typeString),
    distanceFromTrail: num(w.distanceFromTrail, `${path}.distanceFromTrail`, 0, 1e8),
  };
  copyWaypointText(w, path, out);
  copyAccess(w, path, out);
  return out;
}

/** A variant's waypoint; its figures are filled in by {@link enrichRows}. */
function variantWaypoint(raw: unknown, path: string, pointCount: number): VariantWaypoint {
  const w = obj(raw, path);
  const out: VariantWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    type: str(w.type, `${path}.type`, S.typeString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    elevation: 0,
    distance: 0,
    totalDistance: 0,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    variantTrackIndex: int(w.variantTrackIndex, `${path}.variantTrackIndex`, 0, pointCount - 1),
  };
  copyWaypointText(w, path, out);
  copyAccess(w, path, out);
  return out;
}

/**
 * How far a listed waypoint may sit from the point it is listed at: the radius
 * `buildTrail` matches it within, plus a few metres for an export that
 * rounded coordinates (`truncatePoint` keeps 6 decimals, ~0.1 m).
 */
const WAYPOINT_SLACK_M = 5;
const MAIN_WAYPOINT_M = DEFAULT_WAYPOINT_MAX_DISTANCE_METERS + WAYPOINT_SLACK_M;
const VARIANT_WAYPOINT_M = VARIANT_WAYPOINT_MAX_DISTANCE_METERS + WAYPOINT_SLACK_M;

/**
 * Keep each row whose listed point is within `maxM` of it; move one whose
 * point is not to its nearest point of the line when that is in range, and
 * hand the rest to `misplaced`. Returns the rows kept.
 */
function placeOnLine<W extends { lat: number; lon: number }>(
  rows: W[],
  line: readonly { lat: number; lon: number }[],
  index: { get: (w: W) => number; set: (w: W, i: number) => void },
  nearest: () => NearestPoints,
  maxM: number,
  misplaced: (w: W) => void
): W[] {
  const kept: W[] = [];
  for (const w of rows) {
    const at = line[index.get(w)];
    if (at && haversineDistance(w.lat, w.lon, at.lat, at.lon) <= maxM) {
      kept.push(w);
      continue;
    }
    const i = nearest().nearest(w.lat, w.lon);
    if (i >= 0 && haversineDistance(w.lat, w.lon, line[i].lat, line[i].lon) <= maxM) {
      index.set(w, i);
      kept.push(w);
    } else {
      misplaced(w);
    }
  }
  return kept;
}

/** A waypoint as an off-trail row; `distanceFromTrail` is rebuilt by the caller. */
function asOffTrail(w: EnrichedWaypoint | VariantWaypoint): OffTrailWaypoint {
  const out: OffTrailWaypoint = { name: w.name, lat: w.lat, lon: w.lon, type: w.type, distanceFromTrail: 0 };
  if (w.id !== undefined) out.id = w.id;
  if (w.description !== undefined) out.description = w.description;
  if (w.mergedIds !== undefined) out.mergedIds = w.mergedIds;
  copyAccessFields(w, out);
  return out;
}

/** A variant's waypoint as a main-route row with no usable `trackIndex` yet. */
function asMainRoute(w: VariantWaypoint): EnrichedWaypoint {
  const out: EnrichedWaypoint = {
    name: w.name,
    lat: w.lat,
    lon: w.lon,
    type: w.type,
    elevation: 0,
    distance: 0,
    totalDistance: 0,
    ascent: 0,
    descent: 0,
    totalAscent: 0,
    totalDescent: 0,
    trackIndex: -1,
  };
  if (w.id !== undefined) out.id = w.id;
  if (w.description !== undefined) out.description = w.description;
  if (w.mergedIds !== undefined) out.mergedIds = w.mergedIds;
  copyAccessFields(w, out);
  return out;
}

type AccessFields = { offTrailKm?: number; accessMode?: AccessMode; acceptsBoxes?: boolean; accessName?: string };

function copyAccessFields(from: AccessFields, to: AccessFields): void {
  if (from.offTrailKm !== undefined) to.offTrailKm = from.offTrailKm;
  if (from.accessMode !== undefined) to.accessMode = from.accessMode;
  if (from.acceptsBoxes !== undefined) to.acceptsBoxes = from.acceptsBoxes;
  if (from.accessName !== undefined) to.accessName = from.accessName;
}

const VARIANT_TYPES: readonly RouteVariant['type'][] = ['alternate', 'side-trip', 'terminus'];

/** A variant as read, before its junctions and figures are rebuilt. */
interface DraftVariant {
  path: string;
  name: string;
  type: RouteVariant['type'];
  points: { lat: number; lon: number; ele: number }[];
  waypoints?: VariantWaypoint[];
  start?: Junction;
  end?: Junction;
  /** Cumulative km along `points`; set once the variant's orientation is final. */
  km?: Float64Array;
  nearest?: NearestPoints;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}

interface Junction {
  km: number;
  /** Main-route point, when the junction is on the main route. */
  trackIndex?: number;
  /** Index into `alternates`, when it is on an alternate. */
  parent?: number;
}

/**
 * Read a variant: its name, type, points and waypoints. Everything numeric the
 * client says about it (length, climb, junction km and indices, offsets,
 * `parent`) is ignored and rebuilt by {@link attachVariants}.
 */
function draftVariant(raw: unknown, path: string, budget: { points: number }): DraftVariant {
  const v = obj(raw, path);
  if (typeof v.type !== 'string' || !(VARIANT_TYPES as readonly string[]).includes(v.type)) {
    fail(`${path}.type`, "is not 'alternate', 'side-trip' or 'terminus'");
  }
  const rawPoints = arr(v.points, `${path}.points`, S.variantPoints);
  if (rawPoints.length < 2) fail(`${path}.points`, 'has fewer than 2 points');
  budget.points += rawPoints.length;
  if (budget.points > S.totalVariantPoints) fail(path, 'takes the alternates and side trips over their point limit');
  const bbox = { minLat: Infinity, maxLat: -Infinity, minLon: Infinity, maxLon: -Infinity };
  const points = rawPoints.map((r, i) => {
    const p = obj(r, `${path}.points[${i}]`);
    const point = {
      lat: lat(p.lat, `${path}.points[${i}].lat`),
      lon: lon(p.lon, `${path}.points[${i}].lon`),
      ele: ele(p.ele, `${path}.points[${i}].ele`),
    };
    if (point.lat < bbox.minLat) bbox.minLat = point.lat;
    if (point.lat > bbox.maxLat) bbox.maxLat = point.lat;
    if (point.lon < bbox.minLon) bbox.minLon = point.lon;
    if (point.lon > bbox.maxLon) bbox.maxLon = point.lon;
    return point;
  });
  const out: DraftVariant = {
    path,
    name: str(v.name, `${path}.name`, S.shortString),
    type: v.type as RouteVariant['type'],
    points,
    bbox,
  };
  if (v.waypoints !== undefined && v.waypoints !== null) {
    out.waypoints = arr(v.waypoints, `${path}.waypoints`, S.variantWaypoints).map((w, i) =>
      variantWaypoint(w, `${path}.waypoints[${i}]`, points.length)
    );
  }
  return out;
}

const JUNCTION_M = DEFAULT_MAX_JUNCTION_DISTANCE_METERS;
const METERS_PER_DEGREE_LAT = 111_320;

/**
 * Rebuild every variant's junctions the way `findVariantJunctions` and
 * `attachVariantsToParents` do for an import:
 * - each end is attached to the nearest main-route point within 500 m (a
 *   terminus only at `points[0]`; a side trip's far end only when it rejoins
 *   10 or more points from where it left, i.e. a loop);
 * - a variant whose ends are both on the main route but read backwards is
 *   turned round, so `points[0]` is always the branch point;
 * - an end still loose is attached to the nearest point of an alternate that
 *   is already attached, at that alternate's junction km plus the walk along
 *   it, repeating until nothing more attaches (a child of a child), and
 *   `parent` names that alternate.
 *
 * `points[0]` must end up attached: the importer turns a variant round so its
 * branch point comes first, so a variant whose first point is nowhere near the
 * route (or an alternate) is not one an import produced, and fails the shape
 * check. A loose far end is allowed, as it is in an import.
 *
 * Unlike an import, a variant turned round by a parent attachment is not turned
 * here: an honest upload is already the right way round, so only the first,
 * main-route pass orients.
 */
function attachVariants(drafts: DraftVariant[], alternateCount: number, main: TrackPoint[], mainIndex: NearestPoints): void {
  const onMain = (p: { lat: number; lon: number }): { trackIndex: number; meters: number } => {
    const i = mainIndex.nearest(p.lat, p.lon);
    return { trackIndex: i, meters: haversineDistance(p.lat, p.lon, main[i].lat, main[i].lon) };
  };

  for (const v of drafts) {
    const first = onMain(v.points[0]);
    if (first.meters <= JUNCTION_M) {
      v.start = { km: round2(main[first.trackIndex].dist), trackIndex: first.trackIndex };
    }
    if (v.type !== 'terminus') {
      const last = onMain(v.points[v.points.length - 1]);
      if (last.meters <= JUNCTION_M && (v.type === 'alternate' || Math.abs(last.trackIndex - first.trackIndex) >= 10)) {
        v.end = { km: round2(main[last.trackIndex].dist), trackIndex: last.trackIndex };
      }
    }
    if (v.start && v.end && v.start.km > v.end.km) {
      [v.start, v.end] = [v.end, v.start];
      const n = v.points.length;
      v.points = [...v.points].reverse();
      for (const w of v.waypoints ?? []) w.variantTrackIndex = n - 1 - w.variantTrackIndex;
    }
    v.km = cumulativeKmOf(v.points);
  }

  // The alternates attached so far, in the order they attached. A loose end
  // only needs testing against those attached since its last test (`seen`
  // records how many there were): every earlier one was already more than
  // 500 m away and has not moved. Without this, a chain of 200 alternates
  // each hanging off the next tested every loose end against every attached
  // alternate once per round, for up to 400 rounds.
  const attached: number[] = [];
  for (let a = 0; a < alternateCount; a++) if (drafts[a].start) attached.push(a);
  const seenStart = new Uint32Array(drafts.length);
  const seenEnd = new Uint32Array(drafts.length);

  const latMargin = JUNCTION_M / METERS_PER_DEGREE_LAT;
  const onParent = (p: { lat: number; lon: number }, self: number, from: number): Junction | null => {
    let best: { parent: number; point: number; meters: number } | null = null;
    const lonMargin = latMargin / Math.max(Math.cos((p.lat * Math.PI) / 180), 0.1);
    for (let k = from; k < attached.length; k++) {
      const a = attached[k];
      const parent = drafts[a];
      if (a === self) continue;
      const box = parent.bbox;
      if (
        p.lat < box.minLat - latMargin ||
        p.lat > box.maxLat + latMargin ||
        p.lon < box.minLon - lonMargin ||
        p.lon > box.maxLon + lonMargin
      ) {
        continue;
      }
      parent.nearest ??= new NearestPoints(parent.points);
      const i = parent.nearest.nearest(p.lat, p.lon);
      const meters = haversineDistance(p.lat, p.lon, parent.points[i].lat, parent.points[i].lon);
      // Ties go to the lower index, whatever order the two attached in.
      if (meters <= JUNCTION_M && (best === null || meters < best.meters || (meters === best.meters && a < best.parent))) {
        best = { parent: a, point: i, meters };
      }
    }
    if (!best) return null;
    const parent = drafts[best.parent];
    return { km: round2(parent.start!.km + parent.km![best.point]), parent: best.parent };
  };

  // Each round attaches at least one end or stops, and there are at most two
  // loose ends per variant, so this ends after at most 2 × variants rounds.
  for (let progress = true; progress; ) {
    progress = false;
    for (let i = 0; i < drafts.length; i++) {
      const v = drafts[i];
      if (!v.start && seenStart[i] < attached.length) {
        const from = seenStart[i];
        seenStart[i] = attached.length;
        const start = onParent(v.points[0], i, from);
        if (start) {
          v.start = start;
          if (i < alternateCount) attached.push(i);
          progress = true;
        }
      }
      if (!v.end && v.start && i < alternateCount && seenEnd[i] < attached.length) {
        const from = seenEnd[i];
        seenEnd[i] = attached.length;
        const end = onParent(v.points[v.points.length - 1], i, from);
        if (end) {
          v.end = end;
          progress = true;
        }
      }
    }
  }

  for (const v of drafts) {
    if (!v.start) {
      const meters = onMain(v.points[0]).meters;
      fail(
        v.path,
        `does not branch off the route: its first point is ${formatKm(meters / 1000)} from it, ` +
          `and an alternate or side trip must start within ${JUNCTION_M} m of the route or of an alternate`
      );
    }
  }
}

/** A drafted, attached variant as the `RouteVariant` the trail stores. */
function finishVariant(v: DraftVariant, drafts: DraftVariant[]): RouteVariant {
  const km = v.km!;
  const climb = cumulativeElevationChange(v.points, COMMUNITY_CHECK_THRESHOLDS.ascentThresholdM);
  const last = v.points.length - 1;
  const out: RouteVariant = {
    name: v.name,
    type: v.type,
    points: v.points,
    distance: Math.round(km[last] * 10) / 10,
    elevation: { ascent: Math.round(climb.ascent[last]), descent: Math.round(climb.descent[last]) },
  };
  const start = v.start!;
  out.startDistance = start.km;
  if (start.trackIndex !== undefined) out.startTrackIndex = start.trackIndex;
  if (v.end) {
    out.endDistance = v.end.km;
    if (v.end.trackIndex !== undefined) out.endTrackIndex = v.end.trackIndex;
  }
  const parentIndex = start.parent ?? v.end?.parent;
  if (parentIndex !== undefined) out.parent = { name: drafts[parentIndex].name, index: parentIndex };
  if (v.waypoints) {
    out.waypoints = enrichRows(v.waypoints, (w) => w.variantTrackIndex, v.points, km, climb, start.km);
  }
  return out;
}

const ELEVATION_SOURCES: readonly NonNullable<TrailConfig['elevationSource']>[] = ['gpx', 'backfilled', 'none'];

function config(v: unknown, lengthKm: number): TrailConfig {
  const c = obj(v, 'config');
  const name = str(c.name, 'config.name', S.shortString);
  const out: TrailConfig = {
    id: str(c.id, 'config.id', S.idString),
    name,
    shortName: optStr(c.shortName, 'config.shortName', S.shortString) ?? name,
    region: optStr(c.region, 'config.region', S.shortString) ?? '',
    // The built route's own length, never a figure the file claims.
    lengthKm: Math.round(lengthKm * 10) / 10,
    gpxFile: '',
    direction: { ...COMMUNITY_DIRECTION },
  };
  if (c.elevationSource !== undefined && c.elevationSource !== null) {
    if (typeof c.elevationSource !== 'string' || !(ELEVATION_SOURCES as readonly string[]).includes(c.elevationSource)) {
      fail('config.elevationSource', "is not 'gpx', 'backfilled' or 'none'");
    }
    out.elevationSource = c.elevationSource as TrailConfig['elevationSource'];
  }
  const description = optStr(c.description, 'config.description', S.longString);
  if (description !== undefined) out.description = description;
  if (c.source === 'imported' || c.source === 'community') out.source = c.source;
  return out;
}

/**
 * Rebuild a `ProcessedTrail` from untrusted input (see the header for what is
 * kept, rebuilt and dropped). Returns the rebuilt trail and the client's own
 * distance claims, or a reader-facing error on the first problem.
 */
export function sanitiseCommunityTrail(
  raw: unknown
): { trail: ProcessedTrail; claimed: ClaimedDistances } | { error: string } {
  try {
    const t = obj(raw, 'the trail');
    const track = obj(t.track, 'track');
    const main = mainPoints(track.points, 'track.points');
    const points = main.points;
    const claimedTotal = num(track.totalDistance, 'track.totalDistance', 0, 100_000);
    const totalDistance = points[points.length - 1].dist;

    const alternates = arr(t.alternates ?? [], 'alternates', S.variants);
    const sideTrips = arr(t.sideTrips ?? [], 'sideTrips', S.variants);
    if (alternates.length + sideTrips.length > S.variants) {
      fail('alternates and sideTrips', `have more than ${S.variants} routes between them`);
    }
    let waypoints = arr(t.waypoints ?? [], 'waypoints', S.waypoints).map((w, i) =>
      enrichedWaypoint(w, `waypoints[${i}]`, points.length)
    );
    const offTrailWaypoints = arr(t.offTrailWaypoints ?? [], 'offTrailWaypoints', S.offTrailWaypoints).map((w, i) =>
      offTrailWaypoint(w, `offTrailWaypoints[${i}]`)
    );
    const variantBudget = { points: 0 };
    const drafts = [
      ...alternates.map((v, i) => draftVariant(v, `alternates[${i}]`, variantBudget)),
      ...sideTrips.map((v, i) => draftVariant(v, `sideTrips[${i}]`, variantBudget)),
    ];

    const climb = cumulativeElevationChange(points, COMMUNITY_CHECK_THRESHOLDS.ascentThresholdM);
    const kept = displayIndices(points, totalDistance);
    const mainIndex = new NearestPoints(points);
    attachVariants(drafts, alternates.length, points, mainIndex);

    // A nearest-point search is the one per-waypoint cost that is not O(1)
    // (and O(n) at worst, see NearestPoints), so a file over the waypoint
    // limit, which fails `waypoints` and is never stored, keeps the client's
    // validated placement and figures rather than paying for up to 10,000 of
    // them.
    const total = waypoints.length + offTrailWaypoints.length + drafts.reduce((s, v) => s + (v.waypoints?.length ?? 0), 0);
    if (total <= COMMUNITY_CHECK_THRESHOLDS.maxWaypoints) {
      // Variants first: a waypoint that is not on its variant joins the main
      // route's rows, to be placed there or moved off-trail below.
      for (const v of drafts) {
        if (!v.waypoints) continue;
        v.waypoints = placeOnLine(
          v.waypoints,
          v.points,
          { get: (w) => w.variantTrackIndex, set: (w, i) => (w.variantTrackIndex = i) },
          () => (v.nearest ??= new NearestPoints(v.points)),
          VARIANT_WAYPOINT_M,
          (w) => waypoints.push(asMainRoute(w))
        );
      }
      waypoints = placeOnLine(
        waypoints,
        points,
        { get: (w) => w.trackIndex, set: (w, i) => (w.trackIndex = i) },
        () => mainIndex,
        MAIN_WAYPOINT_M,
        (w) => offTrailWaypoints.push(asOffTrail(w))
      );
      for (const w of offTrailWaypoints) {
        const near = points[mainIndex.nearest(w.lat, w.lon)];
        w.distanceFromTrail = Math.round(haversineDistance(w.lat, w.lon, near.lat, near.lon));
      }
    }

    const km = new Float64Array(points.length);
    for (let i = 0; i < points.length; i++) km[i] = points[i].dist;
    const variants = drafts.map((v) => finishVariant(v, drafts));

    const cfg = config(t.config, totalDistance);
    const trail: ProcessedTrail = {
      config: cfg,
      track: {
        points,
        displayPoints: kept ? kept.map((i) => points[i]) : points,
        totalDistance,
        totalAscent: climb.ascent[points.length - 1],
        totalDescent: climb.descent[points.length - 1],
      },
      waypoints: enrichRows(waypoints, (w) => w.trackIndex, points, km, climb, 0),
      offTrailWaypoints,
      alternates: variants.slice(0, alternates.length),
      sideTrips: variants.slice(alternates.length),
      climate: null,
      climateLocations: null,
      direction: { ...COMMUNITY_DIRECTION },
    };
    return {
      trail,
      claimed: { totalDistance: claimedTotal, lastPointDist: main.lastPointDist, backwardsAt: main.backwardsAt },
    };
  } catch (err) {
    if (err instanceof ShapeError) return { error: err.message };
    throw err;
  }
}
