/**
 * The web → mobile trail handoff format.
 *
 * A trail imported in the browser lives only in that browser's IndexedDB. This
 * module is how it gets out: `wrapTrailForHandoff` produces the envelope the
 * web page downloads as `<slug>.tracknotes.json`, and `parseHandoffJson` is the
 * mobile (or web) side reading one back.
 *
 * The payload is a {@link ProcessedTrail} verbatim — the same object the build
 * pipeline writes to `public/data/generated/{id}.json` and the same object the
 * mobile guide renders — so no conversion happens at either end. Only the
 * envelope (`format` + `version`) is new, and it exists so that a file which is
 * *not* one of ours, or is one of ours from a future release, fails with a
 * sentence the user can act on rather than a `TypeError` three layers deep.
 *
 * Everything here is validation, not repair. A handoff file is untrusted input
 * that arrives from a share sheet or a file manager, so every field a consumer
 * later assumes is numeric is checked to actually be numeric here — silently
 * defaulting `dist` to 0, say, would produce a trail whose every km reading is
 * wrong instead of a file that refuses to import.
 *
 * Platform-neutral: no Node, DOM or React Native imports.
 */

import { hashString, type ImportReport } from './gpx-import';
import type {
  ClimateLocationConfig,
  DirectionConfig,
  EnrichedWaypoint,
  OffTrailWaypoint,
  ProcessedTrail,
  RouteVariant,
  TrackPoint,
  TrailConfig,
} from './trail-types';

/** Envelope discriminator. Present so a stray `.json` fails loudly. */
export const HANDOFF_FORMAT = 'tracknotes-trail';

/** Envelope version this build writes, and the highest it can read. */
export const HANDOFF_VERSION = 1;

/** Double extension used for downloaded handoff files. */
export const HANDOFF_EXTENSION = '.tracknotes.json';

/** The name `@lib/gpx-import` falls back to when a file names nothing. */
const GENERIC_NAME = 'Imported trail';

export interface TrailHandoff {
  format: typeof HANDOFF_FORMAT;
  version: number;
  trail: ProcessedTrail;
}

/** Wrap a built trail in the handoff envelope. */
export function wrapTrailForHandoff(trail: ProcessedTrail): TrailHandoff {
  return { format: HANDOFF_FORMAT, version: HANDOFF_VERSION, trail };
}

/** The exact bytes a handoff download should contain. */
export function serializeTrailHandoff(trail: ProcessedTrail): string {
  return JSON.stringify(wrapTrailForHandoff(trail));
}

/**
 * File-name slug for a trail, matching the trail viewer's export naming: the
 * trail id for bundled trails (stable and already slug-shaped), a slug of the
 * user-chosen name for imports (whose ids are opaque hashes).
 */
export function trailSlug(config: { id?: string; name?: string }): string {
  const id = config.id ?? '';
  if (id && !id.startsWith('u_')) return id;
  const slug = String(config.name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || id || 'trail';
}

/** Download file name for a trail: `<slug>.tracknotes.json`. */
export function handoffFileName(trail: ProcessedTrail): string {
  return `${trailSlug(trail.config)}${HANDOFF_EXTENSION}`;
}

/**
 * Cheap "is this JSON rather than GPX?" sniff, for callers that have the text
 * but no trustworthy file name (an opaque Android `content://` URI names
 * nothing).
 *
 * Deliberately shallow — it only has to pick a branch. `parseHandoffJson` is
 * what decides whether the file is actually usable.
 */
export function looksLikeHandoffJson(text: string): boolean {
  return text.trimStart().startsWith('{');
}

/**
 * Read a handoff file back into a trail.
 *
 * The returned trail is always import-shaped: its id is `u_`-prefixed and
 * `config.source` is `'imported'`, so it can never be mistaken for a bundled
 * trail or reach the comments API. A file whose `config.id` is not already a
 * `u_` id (a bundled trail someone re-exported, or a hand-written file) gets a
 * fresh id minted from the content hash, which keeps re-importing the same file
 * idempotent.
 *
 * @throws {Error} with a user-facing sentence for every rejection.
 */
export function parseHandoffJson(text: string): ProcessedTrail {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err: unknown) {
    fail(`This file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!isRecord(parsed)) {
    fail('This is not a Tracknotes trail file: expected a JSON object at the top level.');
  }
  if (parsed.format !== HANDOFF_FORMAT) {
    fail(
      'This is not a Tracknotes trail file ' +
        `(format ${describe(parsed.format)}, expected "${HANDOFF_FORMAT}").`
    );
  }

  const version = parsed.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    fail(`This Tracknotes trail file has an invalid version (${describe(version)}).`);
  }
  if (version > HANDOFF_VERSION) {
    fail(
      `This trail was exported by a newer version of Tracknotes (file version ${version}, ` +
        `this app reads up to ${HANDOFF_VERSION}). Update the app and try again.`
    );
  }

  const trail = parsed.trail;
  if (!isRecord(trail)) fail('This Tracknotes trail file is missing its "trail" object.');

  const config = trail.config;
  if (!isRecord(config)) fail('This Tracknotes trail file is missing "trail.config".');

  const track = trail.track;
  if (!isRecord(track)) fail('This Tracknotes trail file is missing "trail.track".');

  const rawPoints = track.points;
  if (!Array.isArray(rawPoints) || rawPoints.length === 0) {
    fail('This Tracknotes trail file has no track points.');
  }
  const points = rawPoints.map((p, i) => readTrackPoint(p, `track.points[${i}]`));

  if (!Array.isArray(trail.waypoints)) {
    fail('This Tracknotes trail file is missing its "waypoints" array.');
  }

  // displayPoints is the map-rendering copy; regenerating it is out of scope
  // here, so a file without one simply draws the full-resolution track.
  const rawDisplay = track.displayPoints;
  const displayPoints =
    Array.isArray(rawDisplay) && rawDisplay.length > 0
      ? rawDisplay.map((p, i) => readTrackPoint(p, `track.displayPoints[${i}]`))
      : points;

  const name = readName(config.name) ?? readName(config.shortName) ?? GENERIC_NAME;
  const totalDistance = finiteOr(track.totalDistance, points[points.length - 1].dist);

  const resolvedConfig: TrailConfig = {
    ...(config as Partial<TrailConfig>),
    id: isImportedId(config.id) ? config.id : `u_${hashString(text)}`,
    name,
    shortName: readName(config.shortName) ?? name,
    region: typeof config.region === 'string' ? config.region : 'Imported',
    lengthKm: finiteOr(config.lengthKm, totalDistance),
    gpxFile: typeof config.gpxFile === 'string' ? config.gpxFile : '',
    source: 'imported',
  };

  return {
    config: resolvedConfig,
    track: {
      points,
      displayPoints,
      totalDistance,
      totalAscent: finiteOr(track.totalAscent, 0),
      totalDescent: finiteOr(track.totalDescent, 0),
    },
    waypoints: trail.waypoints as EnrichedWaypoint[],
    offTrailWaypoints: arrayOrEmpty<OffTrailWaypoint>(trail.offTrailWaypoints),
    alternates: arrayOrEmpty<RouteVariant>(trail.alternates),
    sideTrips: arrayOrEmpty<RouteVariant>(trail.sideTrips),
    climate: isRecord(trail.climate) ? (trail.climate as Record<string, unknown>) : null,
    climateLocations: Array.isArray(trail.climateLocations)
      ? (trail.climateLocations as ClimateLocationConfig[])
      : null,
    direction: isRecord(trail.direction) ? (trail.direction as unknown as DirectionConfig) : null,
  };
}

/**
 * An {@link ImportReport} for a trail that arrived already built.
 *
 * The import review screen renders a report regardless of where the trail came
 * from, so a handoff has to produce one too. The fields that describe *parsing*
 * (tracks found/combined, simplification, gap warnings) are reported as
 * already-settled: that work happened on the other device, and re-litigating it
 * here would invent numbers. `hasElevation` is the one thing still worth
 * checking, because it changes how the plan calculator's day estimates read.
 */
export function handoffImportReport(trail: ProcessedTrail): ImportReport {
  const pointCount = trail.track.points.length;
  return {
    trailId: trail.config.id,
    name: trail.config.name,
    hasElevation: trail.track.points.some(p => Number.isFinite(p.ele) && p.ele !== 0),
    elevationLooksNoisy: false,
    sourcePointCount: pointCount,
    pointCount,
    waypointCount: trail.waypoints.length,
    offTrailWaypointCount: trail.offTrailWaypoints.length,
    tracksFound: 1,
    tracksCombined: 1,
    alternateCount: trail.alternates.length,
    sideTripCount: trail.sideTrips.length,
    gapWarnings: [],
    simplified: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isImportedId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('u_') && value.length > 2;
}

function readName(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function arrayOrEmpty<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Render an unexpected value for an error message without dumping a blob. */
function describe(value: unknown): string {
  if (value === undefined) return 'missing';
  if (typeof value === 'string') return JSON.stringify(value.slice(0, 40));
  if (value === null || typeof value !== 'object') return String(value);
  return Array.isArray(value) ? 'an array' : 'an object';
}

/**
 * Every track point must carry four real numbers. `ele` and `dist` are not
 * defaulted on purpose: a zeroed `dist` silently breaks every distance, day
 * split and waypoint position downstream, which is far worse than refusing the
 * file.
 */
function readTrackPoint(value: unknown, where: string): TrackPoint {
  if (!isRecord(value)) fail(`This Tracknotes trail file has a malformed ${where}.`);
  const lat = requireFinite(value.lat, `${where}.lat`);
  const lon = requireFinite(value.lon, `${where}.lon`);
  const ele = requireFinite(value.ele, `${where}.ele`);
  const dist = requireFinite(value.dist, `${where}.dist`);
  if (lat < -90 || lat > 90) fail(`This Tracknotes trail file has an out-of-range ${where}.lat (${lat}).`);
  if (lon < -180 || lon > 180) fail(`This Tracknotes trail file has an out-of-range ${where}.lon (${lon}).`);
  return { lat, lon, ele, dist };
}

function requireFinite(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`This Tracknotes trail file has a non-numeric ${where} (${describe(value)}).`);
  }
  return value;
}
