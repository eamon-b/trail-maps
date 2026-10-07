/**
 * The automatic checks a community route must pass before it is published.
 * Spec: `plans/community-routes.md` ("Automatic checks").
 *
 * Run twice: by the web and mobile clients before upload, so the hiker sees the
 * outcome while still on the share form, and again by the comments-api worker
 * on what was actually uploaded. The worker's run is the one that counts, so
 * this module never trusts its input: `runCommunityChecks` first rebuilds the
 * `ProcessedTrail` field by field from the `unknown` it is handed (finite
 * numbers, coordinates in range, bounded arrays and strings, nothing a client
 * invented), and every later check reads that rebuilt copy. The rebuilt trail
 * is returned as `trail`, which is what the worker stores.
 *
 * Platform-neutral and dependency-free apart from `distance.ts`; every check is
 * O(points), so the whole run fits a Worker's CPU budget.
 *
 * Messages are shown to the person sharing the route, so they are plain
 * English and say what to do where there is something to do.
 */

import { haversineDistance } from './distance';
import { ACCESS_MODES } from './types';
import type { AccessMode } from './types';
import type { CommunityCheck, CommunityCheckLevel } from './community-types';
import { COMMUNITY_LIMITS } from './community-types';
import type {
  DirectionConfig,
  EnrichedWaypoint,
  OffTrailWaypoint,
  ProcessedTrail,
  RouteBreak,
  RouteVariant,
  TrackPoint,
  TrailConfig,
  TrailPOI,
  TrailPOICategory,
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
  noisyAscentPerKm: 250,
  gapKm: 2,
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
  breaks: 1_000,
  pois: 20_000,
  poiTags: 64,
  mergedIds: 64,
  shortString: 300,
  idString: 128,
  typeString: 64,
  longString: 10_000,
  tagKey: 100,
  tagValue: 1_000,
  minElevation: -12_000,
  maxElevation: 12_000,
} as const;

export interface CommunityRouteStats {
  lengthKm: number;
  ascentM: number;
  hasElevation: boolean;
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
  const breakStarts = new Set((clean.track.breaks ?? []).map((b) => b.index));
  const lengthKm = points[points.length - 1].dist;

  const checks: CommunityCheck[] = [
    check('shape', 'pass', 'The route data is complete and readable.'),
    lengthCheck(lengthKm),
    pointsCheck(points, breakStarts),
    distanceConsistencyCheck(clean, breakStarts),
    speedCheck(shaped.times, points, breakStarts),
    elevationCheck(clean, lengthKm),
    gapsCheck(points, breakStarts),
    metadata,
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

function pointsCheck(points: TrackPoint[], breakStarts: Set<number>): CommunityCheck {
  const t = COMMUNITY_CHECK_THRESHOLDS;
  if (points.length < t.minPoints) {
    return check('points', 'fail', `The route has only ${points.length} points; at least ${t.minPoints} are needed to draw it.`);
  }
  const spacings = new Float64Array(points.length - 1);
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    if (breakStarts.has(i)) continue;
    spacings[n++] = (points[i].dist - points[i - 1].dist) * 1000;
  }
  const medianM = n > 0 ? median(spacings.subarray(0, n)) : 0;
  if (medianM > t.coarseSpacingM) {
    return check(
      'points',
      'warn',
      `Points are about ${Math.round(medianM)} m apart, so the line may be hand-drawn or coarse and cut corners on the ground.`
    );
  }
  return check('points', 'pass', `The route has ${points.length.toLocaleString('en')} points.`);
}

function distanceConsistencyCheck(trail: ProcessedTrail, breakStarts: Set<number>): CommunityCheck {
  const t = COMMUNITY_CHECK_THRESHOLDS;
  const points = trail.track.points;
  let recomputed = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].dist < points[i - 1].dist) {
      return check('distance-consistency', 'fail', `The distances along the route go backwards at point ${i}. Import the GPX file again.`);
    }
    if (breakStarts.has(i)) continue;
    const a = points[i - 1];
    const b = points[i];
    recomputed += haversineDistance(a.lat, a.lon, b.lat, b.lon) / 1000;
  }
  const claimed = points[points.length - 1].dist - points[0].dist;
  const tolerance = Math.max(t.distanceToleranceMinKm, recomputed * t.distanceTolerance);
  if (Math.abs(claimed - recomputed) > tolerance) {
    return check(
      'distance-consistency',
      'fail',
      `The route's distances (${formatKm(claimed)}) do not match its points (${formatKm(recomputed)}). Import the GPX file again.`
    );
  }
  const total = trail.track.totalDistance;
  if (Math.abs(total - points[points.length - 1].dist) > Math.max(t.distanceToleranceMinKm, total * t.distanceTolerance)) {
    return check(
      'distance-consistency',
      'fail',
      `The route's total length (${formatKm(total)}) does not match its points. Import the GPX file again.`
    );
  }
  return check('distance-consistency', 'pass', 'The distances along the route match its points.');
}

function speedCheck(
  times: (number | null)[] | null,
  points: TrackPoint[],
  breakStarts: Set<number>
): CommunityCheck {
  if (!times) {
    return check('speed', 'pass', 'The route has no timestamps, so walking speed was not checked.');
  }
  const speeds = new Float64Array(points.length);
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    if (breakStarts.has(i)) continue;
    const t0 = times[i - 1];
    const t1 = times[i];
    if (t0 === null || t1 === null || t1 <= t0) continue;
    const km = points[i].dist - points[i - 1].dist;
    const hours = (t1 - t0) / 3_600_000;
    const kmh = km / hours;
    // Standing still (a lunch stop) is not moving speed.
    if (kmh >= 0.5) speeds[n++] = kmh;
  }
  if (n < 2) {
    return check('speed', 'pass', 'The route has too few timestamps to check walking speed.');
  }
  const kmh = median(speeds.subarray(0, n));
  if (kmh > COMMUNITY_CHECK_THRESHOLDS.driveSpeedKmh) {
    return check(
      'speed',
      'warn',
      `The recording moved at about ${Math.round(kmh)} km/h, which looks like a drive or a ride rather than a walk.`
    );
  }
  return check('speed', 'pass', `The recording moved at a walking pace (about ${kmh.toFixed(1)} km/h).`);
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

function gapsCheck(points: TrackPoint[], breakStarts: Set<number>): CommunityCheck {
  let count = 0;
  let firstKm = 0;
  let longestKm = 0;
  for (let i = 1; i < points.length; i++) {
    if (breakStarts.has(i)) continue;
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
  const visible = description.replace(/\s+/g, '').length;
  let urlChars = 0;
  for (const match of description.matchAll(URL_RE)) urlChars += match[0].length;
  if (visible > 0 && urlChars / visible > COMMUNITY_CHECK_THRESHOLDS.urlShareWarn) {
    return check(
      'metadata',
      'warn',
      'The description is mostly links. Describe the walk itself: where it goes, the terrain, water and camps.'
    );
  }
  return check('metadata', 'pass', 'The name and description are a good length.');
}

function waypointsCheck(trail: ProcessedTrail): CommunityCheck {
  const count = trail.waypoints.length;
  const max = COMMUNITY_CHECK_THRESHOLDS.maxWaypoints;
  if (count > max) {
    return check('waypoints', 'fail', `The route has ${count.toLocaleString('en')} waypoints; a shared route can have at most ${max.toLocaleString('en')}.`);
  }
  const variantCount = [...trail.alternates, ...trail.sideTrips].reduce((s, v) => s + (v.waypoints?.length ?? 0), 0);
  if (count + trail.offTrailWaypoints.length + variantCount === 0) {
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
    waypointCount: trail.waypoints.length,
    bbox: [minLon, minLat, maxLon, maxLat],
    start: { lat: first.lat, lon: first.lon },
    end: { lat: last.lat, lon: last.lon },
  };
}

/** Median by quickselect: O(n) on average, and it reorders `values`. */
function median(values: Float64Array): number {
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
// The shape check: rebuild a ProcessedTrail from untrusted input
// ---------------------------------------------------------------------------

/** Thrown inside the sanitiser; caught by `sanitiseCommunityTrail`. */
class ShapeError extends Error {}

type Obj = Record<string, unknown>;

const S = COMMUNITY_SHAPE_LIMITS;

const POI_CATEGORIES: readonly TrailPOICategory[] = [
  'water',
  'camping',
  'resupply',
  'restaurant',
  'transport',
  'emergency',
];

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

interface SanitisedPoints {
  points: TrackPoint[];
  /** Epoch ms per point, or null when the input carried no timestamps. */
  times: (number | null)[] | null;
}

function trackPoints(v: unknown, path: string, min: number): SanitisedPoints {
  const raw = arr(v, path, S.trackPoints);
  if (raw.length < min) fail(path, `has fewer than ${min} points`);
  const points: TrackPoint[] = new Array(raw.length);
  let times: (number | null)[] | null = null;
  for (let i = 0; i < raw.length; i++) {
    const p = obj(raw[i], `${path}[${i}]`);
    const point: TrackPoint = {
      lat: lat(p.lat, `${path}[${i}].lat`),
      lon: lon(p.lon, `${path}[${i}].lon`),
      ele: ele(p.ele, `${path}[${i}].ele`),
      dist: num(p.dist, `${path}[${i}].dist`, 0, 100_000),
    };
    const cumAscent = optNum(p.cumAscent, `${path}[${i}].cumAscent`, 0, 1e7);
    const cumDescent = optNum(p.cumDescent, `${path}[${i}].cumDescent`, 0, 1e7);
    if (cumAscent !== undefined && cumDescent !== undefined) {
      point.cumAscent = cumAscent;
      point.cumDescent = cumDescent;
    }
    // Timestamps are read for the speed check and then dropped: when someone
    // walked is nobody else's business, and TrackPoint has no field for it.
    if (p.time !== undefined && p.time !== null) {
      const ms = typeof p.time === 'string' ? Date.parse(p.time) : NaN;
      if (!times) times = new Array(raw.length).fill(null);
      times[i] = Number.isFinite(ms) ? ms : null;
    }
    points[i] = point;
  }
  return { points, times };
}

function routeBreaks(v: unknown, path: string, pointCount: number, displayCount: number): RouteBreak[] | undefined {
  if (v === undefined || v === null) return undefined;
  return arr(v, path, S.breaks).map((raw, i) => {
    const b = obj(raw, `${path}[${i}]`);
    const p = `${path}[${i}]`;
    return {
      index: int(b.index, `${p}.index`, 1, pointCount - 1),
      displayIndex: int(b.displayIndex, `${p}.displayIndex`, 1, displayCount - 1),
      km: num(b.km, `${p}.km`, 0, 100_000),
      straightLineKm: num(b.straightLineKm, `${p}.straightLineKm`, 0, 100_000),
      fromTrack: str(b.fromTrack, `${p}.fromTrack`, S.shortString),
      toTrack: str(b.toTrack, `${p}.toTrack`, S.shortString),
    };
  });
}

function enrichedWaypoint(raw: unknown, path: string, pointCount: number): EnrichedWaypoint {
  const w = obj(raw, path);
  const out: EnrichedWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    type: str(w.type, `${path}.type`, S.typeString),
    elevation: ele(w.elevation, `${path}.elevation`),
    distance: num(w.distance, `${path}.distance`, -100_000, 100_000),
    totalDistance: num(w.totalDistance, `${path}.totalDistance`, -100_000, 100_000),
    ascent: num(w.ascent, `${path}.ascent`, 0, 1e7),
    descent: num(w.descent, `${path}.descent`, 0, 1e7),
    totalAscent: num(w.totalAscent, `${path}.totalAscent`, 0, 1e7),
    totalDescent: num(w.totalDescent, `${path}.totalDescent`, 0, 1e7),
    trackIndex: int(w.trackIndex, `${path}.trackIndex`, 0, pointCount - 1),
  };
  const id = optStr(w.id, `${path}.id`, S.idString);
  if (id !== undefined) out.id = id;
  const description = optStr(w.description, `${path}.description`, S.longString);
  if (description !== undefined) out.description = description;
  const merged = mergedIds(w.mergedIds, `${path}.mergedIds`);
  if (merged !== undefined) out.mergedIds = merged;
  copyAccess(w, path, out);
  return out;
}

function offTrailWaypoint(raw: unknown, path: string): OffTrailWaypoint {
  const w = obj(raw, path);
  const out: OffTrailWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    type: str(w.type, `${path}.type`, S.typeString),
    distanceFromTrail: num(w.distanceFromTrail, `${path}.distanceFromTrail`, 0, 1e8),
  };
  const id = optStr(w.id, `${path}.id`, S.idString);
  if (id !== undefined) out.id = id;
  const description = optStr(w.description, `${path}.description`, S.longString);
  if (description !== undefined) out.description = description;
  const merged = mergedIds(w.mergedIds, `${path}.mergedIds`);
  if (merged !== undefined) out.mergedIds = merged;
  copyAccess(w, path, out);
  return out;
}

function variantWaypoint(raw: unknown, path: string, pointCount: number): VariantWaypoint {
  const w = obj(raw, path);
  const out: VariantWaypoint = {
    name: str(w.name, `${path}.name`, S.shortString),
    type: str(w.type, `${path}.type`, S.typeString),
    lat: lat(w.lat, `${path}.lat`),
    lon: lon(w.lon, `${path}.lon`),
    elevation: ele(w.elevation, `${path}.elevation`),
    distance: num(w.distance, `${path}.distance`, -100_000, 100_000),
    totalDistance: num(w.totalDistance, `${path}.totalDistance`, -100_000, 100_000),
    ascent: num(w.ascent, `${path}.ascent`, 0, 1e7),
    descent: num(w.descent, `${path}.descent`, 0, 1e7),
    totalAscent: num(w.totalAscent, `${path}.totalAscent`, 0, 1e7),
    totalDescent: num(w.totalDescent, `${path}.totalDescent`, 0, 1e7),
    variantTrackIndex: int(w.variantTrackIndex, `${path}.variantTrackIndex`, 0, pointCount - 1),
  };
  const id = optStr(w.id, `${path}.id`, S.idString);
  if (id !== undefined) out.id = id;
  const description = optStr(w.description, `${path}.description`, S.longString);
  if (description !== undefined) out.description = description;
  const merged = mergedIds(w.mergedIds, `${path}.mergedIds`);
  if (merged !== undefined) out.mergedIds = merged;
  copyAccess(w, path, out);
  return out;
}

const VARIANT_TYPES: readonly RouteVariant['type'][] = ['alternate', 'side-trip', 'terminus'];

function variant(raw: unknown, path: string, mainCount: number, budget: { points: number }): RouteVariant {
  const v = obj(raw, path);
  if (typeof v.type !== 'string' || !(VARIANT_TYPES as readonly string[]).includes(v.type)) {
    fail(`${path}.type`, "is not 'alternate', 'side-trip' or 'terminus'");
  }
  const rawPoints = arr(v.points, `${path}.points`, S.variantPoints);
  if (rawPoints.length < 2) fail(`${path}.points`, 'has fewer than 2 points');
  budget.points += rawPoints.length;
  if (budget.points > S.totalVariantPoints) fail(path, 'takes the alternates and side trips over their point limit');
  const points = rawPoints.map((r, i) => {
    const p = obj(r, `${path}.points[${i}]`);
    return {
      lat: lat(p.lat, `${path}.points[${i}].lat`),
      lon: lon(p.lon, `${path}.points[${i}].lon`),
      ele: ele(p.ele, `${path}.points[${i}].ele`),
    };
  });
  const elevation = obj(v.elevation, `${path}.elevation`);
  const out: RouteVariant = {
    name: str(v.name, `${path}.name`, S.shortString),
    type: v.type as RouteVariant['type'],
    points,
    distance: num(v.distance, `${path}.distance`, 0, 100_000),
    elevation: {
      ascent: num(elevation.ascent, `${path}.elevation.ascent`, 0, 1e7),
      descent: num(elevation.descent, `${path}.elevation.descent`, 0, 1e7),
    },
  };
  const startDistance = optNum(v.startDistance, `${path}.startDistance`, 0, 100_000);
  if (startDistance !== undefined) out.startDistance = startDistance;
  const endDistance = optNum(v.endDistance, `${path}.endDistance`, 0, 100_000);
  if (endDistance !== undefined) out.endDistance = endDistance;
  if (v.startTrackIndex !== undefined && v.startTrackIndex !== null) {
    out.startTrackIndex = int(v.startTrackIndex, `${path}.startTrackIndex`, 0, mainCount - 1);
  }
  if (v.endTrackIndex !== undefined && v.endTrackIndex !== null) {
    out.endTrackIndex = int(v.endTrackIndex, `${path}.endTrackIndex`, 0, mainCount - 1);
  }
  const startOffsetMeters = optNum(v.startOffsetMeters, `${path}.startOffsetMeters`, 0, 1e8);
  if (startOffsetMeters !== undefined) out.startOffsetMeters = startOffsetMeters;
  const endOffsetMeters = optNum(v.endOffsetMeters, `${path}.endOffsetMeters`, 0, 1e8);
  if (endOffsetMeters !== undefined) out.endOffsetMeters = endOffsetMeters;
  if (v.parent !== undefined && v.parent !== null) {
    const parent = obj(v.parent, `${path}.parent`);
    out.parent = {
      name: str(parent.name, `${path}.parent.name`, S.shortString),
      index: int(parent.index, `${path}.parent.index`, 0, S.variants - 1),
    };
  }
  if (v.waypoints !== undefined && v.waypoints !== null) {
    out.waypoints = arr(v.waypoints, `${path}.waypoints`, S.variantWaypoints).map((w, i) =>
      variantWaypoint(w, `${path}.waypoints[${i}]`, points.length)
    );
  }
  return out;
}

function poi(raw: unknown, path: string): TrailPOI {
  const p = obj(raw, path);
  if (typeof p.category !== 'string' || !(POI_CATEGORIES as readonly string[]).includes(p.category)) {
    fail(`${path}.category`, 'is not a known point-of-interest category');
  }
  const rawTags = obj(p.tags, `${path}.tags`);
  const tagKeys = Object.keys(rawTags);
  if (tagKeys.length > S.poiTags) fail(`${path}.tags`, `has more than ${S.poiTags} entries`);
  const tags: Record<string, string> = {};
  for (const key of tagKeys) {
    str(key, `${path}.tags key`, S.tagKey);
    tags[key] = str(rawTags[key], `${path}.tags.${key.slice(0, 40)}`, S.tagValue);
  }
  const out: TrailPOI = {
    id: int(p.id, `${path}.id`, 0, Number.MAX_SAFE_INTEGER),
    type: str(p.type, `${path}.type`, S.typeString),
    category: p.category as TrailPOICategory,
    lat: lat(p.lat, `${path}.lat`),
    lon: lon(p.lon, `${path}.lon`),
    name: p.name === null || p.name === undefined ? null : str(p.name, `${path}.name`, S.shortString),
    tags,
    distanceAlongTrail: num(p.distanceAlongTrail, `${path}.distanceAlongTrail`, -100_000, 100_000),
    distanceFromTrail: num(p.distanceFromTrail, `${path}.distanceFromTrail`, 0, 100_000),
  };
  const duplicateOf = optStr(p.duplicateOf, `${path}.duplicateOf`, S.idString);
  if (duplicateOf !== undefined) out.duplicateOf = duplicateOf;
  return out;
}

function direction(v: unknown, path: string): DirectionConfig | null {
  if (v === undefined || v === null) return null;
  const d = obj(v, path);
  return {
    default: str(d.default, `${path}.default`, S.shortString),
    reversed: str(d.reversed, `${path}.reversed`, S.shortString),
  };
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
  };
  const dir = direction(c.direction, 'config.direction');
  if (dir) out.direction = dir;
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
 * Rebuild a `ProcessedTrail` from untrusted input, keeping only the fields the
 * type defines. Climate data is dropped (a community route has none that the
 * server vouches for). Returns a reader-facing error on the first problem.
 */
export function sanitiseCommunityTrail(
  raw: unknown
): { trail: ProcessedTrail; times: (number | null)[] | null } | { error: string } {
  try {
    const t = obj(raw, 'the trail');
    const track = obj(t.track, 'track');
    const main = trackPoints(track.points, 'track.points', 2);
    const display = trackPoints(track.displayPoints, 'track.displayPoints', 2);
    const breaks = routeBreaks(track.breaks, 'track.breaks', main.points.length, display.points.length);
    const totalDistance = num(track.totalDistance, 'track.totalDistance', 0, 100_000);
    const variantBudget = { points: 0 };
    const alternates = arr(t.alternates ?? [], 'alternates', S.variants);
    const sideTrips = arr(t.sideTrips ?? [], 'sideTrips', S.variants);
    if (alternates.length + sideTrips.length > S.variants) {
      fail('alternates and sideTrips', `have more than ${S.variants} routes between them`);
    }
    const mainCount = main.points.length;
    const trail: ProcessedTrail = {
      config: config(t.config, main.points[mainCount - 1].dist),
      track: {
        points: main.points,
        displayPoints: display.points,
        totalDistance,
        totalAscent: num(track.totalAscent, 'track.totalAscent', 0, 1e7),
        totalDescent: num(track.totalDescent, 'track.totalDescent', 0, 1e7),
      },
      waypoints: arr(t.waypoints ?? [], 'waypoints', S.waypoints).map((w, i) =>
        enrichedWaypoint(w, `waypoints[${i}]`, mainCount)
      ),
      offTrailWaypoints: arr(t.offTrailWaypoints ?? [], 'offTrailWaypoints', S.offTrailWaypoints).map((w, i) =>
        offTrailWaypoint(w, `offTrailWaypoints[${i}]`)
      ),
      alternates: alternates.map((v, i) => variant(v, `alternates[${i}]`, mainCount, variantBudget)),
      sideTrips: sideTrips.map((v, i) => variant(v, `sideTrips[${i}]`, mainCount, variantBudget)),
      climate: null,
      climateLocations: null,
      direction: direction(t.direction, 'direction'),
    };
    if (breaks && breaks.length > 0) trail.track.breaks = breaks;
    if (t.pois !== undefined && t.pois !== null) {
      trail.pois = arr(t.pois, 'pois', S.pois).map((p, i) => poi(p, `pois[${i}]`));
    }
    return { trail, times: main.times };
  } catch (err) {
    if (err instanceof ShapeError) return { error: err.message };
    throw err;
  }
}
