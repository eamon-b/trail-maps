/**
 * Runtime GPX import: an arbitrary user file in, a full {@link ProcessedTrail}
 * out, plus a report of everything the UI should warn about.
 *
 * This is the same pipeline the build script runs (`buildTrail`), with three
 * differences that only make sense for untrusted input:
 * - elevation cleaning is ON (spike removal + smoothing + a noise threshold on
 *   the ascent total), because barometric tracks inflate ascent 2-3×;
 * - waypoint ids are minted locally with a `uw_` prefix, so an imported
 *   waypoint can never collide with a registry id or reach the comments API;
 * - the trail id is `u_` + a content hash, so re-importing the same file lands
 *   on the same trail instead of creating a duplicate.
 *
 * React-Native safe: no Node or browser globals at module scope, and no crypto
 * dependency (Hermes has neither `crypto.subtle` nor `crypto.getRandomValues`
 * without a native module). Callers on mobile pass the fast-xml-parser adapter
 * from `xml-adapter-fxp`; web callers can omit the adapter and get DOMParser.
 */

import { parseGpx, type GpxParseLimits } from './gpx-parser';
import { calculateElevationStats, removeElevationSpikes, smoothElevation } from './gpx-optimizer';
import { simplifyToTarget } from './track-simplify';
import {
  buildTrail,
  flattenGpx,
  type BuildTrailDiagnostics,
  type ParsedGpxResult,
} from './trail-ingest';
import type { SelfRetrace } from './track-spurs';
import type { CombineTracksWarning, GpxPoint } from './types';
import type { ProcessedTrail, TrailConfig, TrailWaypoint } from './trail-types';
import type { XmlAdapter } from './xml-adapter';

/** Point budget for the full-resolution track of an imported trail. */
export const IMPORT_TARGET_POINTS = 5000;

/** Spike threshold (m) used when cleaning imported elevation data. */
const IMPORT_SPIKE_THRESHOLD_METERS = 50;
/** Moving-average window (points) used when smoothing imported elevation. */
const IMPORT_SMOOTHING_WINDOW = 7;
/** Minimum climb (m) that counts towards an imported trail's ascent total. */
const IMPORT_ASCENT_THRESHOLD_METERS = 3;

export interface ImportGpxOptions {
  /** Override the trail name (defaults to `<metadata><name>`, then track name). */
  name?: string;
  /**
   * Simplify the source track to about this many points before building, so
   * indices, distances and the elevation profile all stay consistent. Pass 0
   * to keep full resolution. Defaults to {@link IMPORT_TARGET_POINTS}.
   */
  targetPoints?: number;
  /** Target size of the map-display copy (defaults to buildTrail's 3000). */
  targetDisplayPoints?: number;
  /** XML backend. Mobile must pass `fxpXmlAdapter`; web defaults to DOMParser. */
  adapter?: XmlAdapter;
  /** Force a trail id instead of deriving `u_<hash>` from the file contents. */
  id?: string;
  /** Match radius (m) between waypoints and the route (default 500). */
  waypointMaxDistance?: number;
  /** Parser size/point caps (defaults come from GPX_OPTIMIZER_DEFAULTS). */
  limits?: GpxParseLimits;
  /** Turn off spike removal / smoothing / thresholded ascent (default: on). */
  cleanElevation?: boolean;
}

/** Data-quality facts about an import, for the UI to surface. */
export interface ImportReport {
  /** Synthetic trail id (`u_` + content hash). */
  trailId: string;
  /** Resolved trail name. */
  name: string;
  /** False when the file has no usable `<ele>` data (flat profile ahead). */
  hasElevation: boolean;
  /** True when raw elevation looks like barometric noise (inflated ascent). */
  elevationLooksNoisy: boolean;
  /** Track/route points in the source file. */
  sourcePointCount: number;
  /** Points on the built main route (after any simplification). */
  pointCount: number;
  /** Waypoints matched to the route. */
  waypointCount: number;
  /** Waypoints too far from the route to be matched. */
  offTrailWaypointCount: number;
  /** `<trk>` (or fallback `<rte>`) tracks found in the file. */
  tracksFound: number;
  /** How many of them were chained together into the main route. */
  tracksCombined: number;
  alternateCount: number;
  sideTripCount: number;
  /** Gaps between chained tracks — the route may be discontinuous here. */
  gapWarnings: CombineTracksWarning[];
  /** Whether the source track was simplified to the point budget. */
  simplified: boolean;
  /** Human-readable warnings, ready to render. */
  warnings: string[];
}

export interface ImportGpxResult {
  trail: ProcessedTrail;
  report: ImportReport;
}

/**
 * Parse and ingest a user-supplied GPX file.
 *
 * @throws when the XML is malformed, a coordinate is unparseable, the file
 * exceeds the size/point caps, or it contains no track/route points at all.
 */
export function importGpx(xmlText: string, options: ImportGpxOptions = {}): ImportGpxResult {
  const parsed = parseGpx(xmlText, options.adapter, options.limits);
  const gpx = flattenGpx(parsed);

  const sourcePointCount = gpx.tracks.reduce((sum, t) => sum + t.points.length, 0);
  if (sourcePointCount === 0) {
    throw new Error('GPX file contains no track or route points');
  }

  const trailId = options.id ?? `u_${hashString(xmlText)}`;
  const name = resolveTrailName(options.name, gpx);

  const hasElevation = gpx.tracks.some(track =>
    track.points.some(p => Number.isFinite(p.ele) && p.ele !== 0)
  );
  const cleanElevation = options.cleanElevation ?? true;
  const elevationLooksNoisy = hasElevation && cleanElevation && looksNoisy(longestTrackPoints(gpx));

  const targetPoints = options.targetPoints ?? IMPORT_TARGET_POINTS;
  let simplified = false;
  if (targetPoints > 0) {
    for (const track of gpx.tracks) {
      if (track.points.length > targetPoints) {
        track.points = simplifyToTarget(track.points, targetPoints);
        simplified = true;
      }
    }
  }

  const config: TrailConfig = {
    id: trailId,
    name,
    shortName: name,
    region: 'Imported',
    lengthKm: 0,
    gpxFile: '',
    waypointMaxDistance: options.waypointMaxDistance,
    direction: { default: 'Start → End', reversed: 'End → Start' },
    source: 'imported',
    // Recorded up front so every later consumer (plan labelling, the "fetch
    // elevation" offer) can ask the trail rather than having to keep the import
    // report around. `applyElevation` flips this to 'backfilled'.
    elevationSource: hasElevation ? 'gpx' : 'none',
  };

  const collected: BuildTrailDiagnostics[] = [];
  const warnings: string[] = [];

  const trail = buildTrail(gpx, {
    config,
    targetDisplayPoints: options.targetDisplayPoints,
    combineUnclassifiedTracks: true,
    duplicateWaypointIds: 'suffix',
    mintWaypointIds: mintImportedWaypointIds,
    elevation: cleanElevation
      ? {
          removeSpikes: true,
          spikeThreshold: IMPORT_SPIKE_THRESHOLD_METERS,
          smooth: true,
          smoothingWindow: IMPORT_SMOOTHING_WINDOW,
          ascentThreshold: IMPORT_ASCENT_THRESHOLD_METERS,
        }
      : undefined,
    // buildTrail's `warn` advice is written for trail.json authors; imports
    // word their own from the structured diagnostics below.
    onDiagnostics: d => collected.push(d),
  });

  // buildTrail always calls onDiagnostics before returning.
  const built = collected[0];
  if (!built) throw new Error('buildTrail reported no diagnostics');

  for (const gap of built.gapWarnings) {
    warnings.push(
      `${gap.gapMeters.toFixed(0)}m gap between "${gap.fromTrack}" and "${gap.toTrack}" — ` +
        'the route may be discontinuous here.'
    );
  }
  for (const retrace of built.selfRetraces) {
    warnings.push(describeSelfRetrace(retrace));
  }
  if (!hasElevation) {
    warnings.push('No elevation data in this file: the profile is flat and day estimates are distance-only.');
  } else if (elevationLooksNoisy) {
    warnings.push('Elevation looks noisy (barometric?); spikes were smoothed before totalling ascent.');
  }

  const report: ImportReport = {
    trailId,
    name,
    hasElevation,
    elevationLooksNoisy,
    sourcePointCount,
    pointCount: built.pointCount,
    waypointCount: built.waypointCount,
    offTrailWaypointCount: built.offTrailWaypointCount,
    tracksFound: built.tracksFound,
    tracksCombined: built.mainTracksCombined,
    alternateCount: built.alternateCount,
    sideTripCount: built.sideTripCount,
    gapWarnings: built.gapWarnings,
    simplified,
    warnings,
  };

  return { trail, report };
}

/**
 * Word a self-retrace for someone who can edit their GPX but not a trail.json.
 * Most retraces are the real route (a walk-in to town and back), so this is
 * advice, not an error: the fix, if one is wanted, is to move the out-and-back
 * into its own `<trk>` named as a side trip so classification lifts it off the
 * main route (see docs/gpx-import.md).
 */
function describeSelfRetrace(retrace: SelfRetrace): string {
  const where = retrace.terminal
    ? `at the ${retrace.startKm <= 1 ? 'start' : 'end'} of the route`
    : `around km ${retrace.turnaroundKm.toFixed(1)}`;
  return (
    `The route doubles back on itself for ${retrace.retraceLengthKm.toFixed(1)} km ${where}, ` +
    `so those kilometres count twice. If that section is a side trip rather than part of the ` +
    `walk, put it in its own <trk> named "Side trip: …" and re-import.`
  );
}

/**
 * Deterministic, namespaced waypoint ids for imported trails.
 *
 * `uw_` can never collide with the build registry's `w_` ids, which is what
 * keeps imported waypoints out of the comments API and out of
 * `data/waypoint-ids.json`.
 */
export function mintImportedWaypointIds(
  waypoints: TrailWaypoint[],
  config: TrailConfig
): string[] {
  return waypoints.map(
    (wp, i) => `uw_${hashString(`${config.id}|${i}|${wp.name}|${wp.lat}|${wp.lon}`)}`
  );
}

/**
 * Short, stable, lowercase-alphanumeric hash of a string.
 *
 * Two FNV-1a-style 32-bit lanes, base36-encoded — same alphabet as
 * `generateRouteId` in the mobile app. Not cryptographic: it only needs to make
 * accidental collisions between distinct files unlikely, and `Math.imul` keeps
 * it exact under Hermes' 32-bit integer semantics.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  const a = (h1 >>> 0).toString(36).padStart(7, '0');
  const b = (h2 >>> 0).toString(36).padStart(7, '0');
  return `${a}${b}`.slice(0, 12);
}

function resolveTrailName(explicit: string | undefined, gpx: ParsedGpxResult): string {
  const candidates = [explicit, gpx.name, gpx.tracks[0]?.name];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed && trimmed !== 'Unnamed') return trimmed;
  }
  return 'Imported trail';
}

function longestTrackPoints(gpx: ParsedGpxResult): GpxPoint[] {
  let longest: GpxPoint[] = [];
  for (const track of gpx.tracks) {
    if (track.points.length > longest.length) longest = track.points;
  }
  return longest;
}

/**
 * Heuristic: raw sample-to-sample ascent far exceeding the cleaned, thresholded
 * ascent means the elevation channel is dominated by noise rather than terrain.
 */
function looksNoisy(points: GpxPoint[]): boolean {
  if (points.length < 3) return false;
  const raw = calculateElevationStats(points, 0).gain;
  const cleaned = calculateElevationStats(
    smoothElevation(removeElevationSpikes(points, IMPORT_SPIKE_THRESHOLD_METERS), IMPORT_SMOOTHING_WINDOW),
    IMPORT_ASCENT_THRESHOLD_METERS
  ).gain;
  return raw > cleaned * 1.5 && raw - cleaned > 100;
}
