/**
 * Direction reversal for a whole trail (track points, waypoints, variants).
 *
 * Shared by the web plan viewer and the mobile app (via Metro `@lib`).
 *
 * Parameter types are structural, in the style of `variant-reverse.ts` and
 * `track-geometry.ts`: track points only need `{ dist }`, waypoints only the
 * optional km/statistics fields below (guarded with `?? 0`), so the mobile
 * `TrackPoint`/`TrailWaypoint` shapes and the web `PlanTrackPoint`/
 * `PlanWaypoint` shapes both work without conversion. All other fields on the
 * input objects (ids, names, coordinates, …) are preserved untouched.
 *
 * Variant reversal math lives in `variant-reverse.ts` and is reused here.
 */

import {
  reverseAlternates,
  transformSideTrips,
  type ReversibleVariant,
} from './variant-reverse';

/** Minimal track point shape for reversal. */
export interface ReversibleTrackPoint {
  /** Cumulative distance along the trail in km */
  dist: number;
}

/** The km/statistics fields the reversal math needs on a main-route waypoint. */
export interface ReversibleWaypoint {
  /** Distance from previous waypoint in km */
  distance?: number;
  /** Cumulative distance along trail in km */
  totalDistance?: number;
  /** Ascent within this waypoint's segment in m */
  ascent?: number;
  /** Descent within this waypoint's segment in m */
  descent?: number;
  /** Cumulative ascent from trail start in m */
  totalAscent?: number;
  /** Cumulative descent from trail start in m */
  totalDescent?: number;
  /** Index into the track points array */
  trackIndex?: number;
}

/** Structural trail shape both web and mobile Trail types satisfy. */
export interface ReversibleTrail<
  P extends ReversibleTrackPoint = ReversibleTrackPoint,
  W extends ReversibleWaypoint = ReversibleWaypoint,
  V extends ReversibleVariant = ReversibleVariant,
> {
  track: {
    points: P[];
    displayPoints?: P[];
    totalDistance: number;
    totalAscent: number;
    totalDescent: number;
  };
  waypoints?: W[];
  alternates?: V[];
  sideTrips?: V[];
}

/** Reverse track points, flipping cumulative distances. */
export function reverseTrackPoints<P extends ReversibleTrackPoint>(
  points: P[],
  totalDistance: number,
): P[] {
  return [...points].reverse().map(p => ({
    ...p,
    dist: totalDistance - p.dist,
  }));
}

/**
 * Reverse waypoints, recalculating segment distances and swapping
 * ascent/descent (a climb walked one way is a descent walked the other).
 */
export function reverseWaypoints<W extends ReversibleWaypoint>(
  waypoints: W[],
  totalDistance: number,
  trackLength: number,
): Array<W & Required<ReversibleWaypoint>> {
  const reversed = [...waypoints].reverse();
  const newTotals = reversed.map(wp => totalDistance - (wp.totalDistance ?? 0));

  let runningAscent = 0;
  let runningDescent = 0;

  return reversed.map((wp, i) => {
    const segmentAscent = wp.descent ?? 0;
    const segmentDescent = wp.ascent ?? 0;
    runningAscent += segmentAscent;
    runningDescent += segmentDescent;

    const segmentDist = i === 0 ? 0 : newTotals[i] - newTotals[i - 1];

    return {
      ...wp,
      distance: Math.abs(segmentDist),
      totalDistance: newTotals[i],
      ascent: segmentAscent,
      descent: segmentDescent,
      totalAscent: runningAscent,
      totalDescent: runningDescent,
      trackIndex: trackLength - 1 - (wp.trackIndex ?? 0),
    };
  });
}

/**
 * Create a fully reversed copy of a trail (swap start/end direction).
 *
 * Total ascent/descent swap, track and waypoint km are mirrored about the
 * trail total, and attached variants are re-anchored to their mirrored
 * junctions. Any extra fields on the trail object (config, climate, …) are
 * passed through unchanged.
 */
export function createReversedTrail<T extends ReversibleTrail>(trail: T): T {
  const totalDist = trail.track.totalDistance;
  const trackLength = trail.track.points.length;

  const reversedPoints = reverseTrackPoints(trail.track.points, totalDist);
  const reversedDisplay = trail.track.displayPoints
    ? reverseTrackPoints(trail.track.displayPoints, totalDist)
    : undefined;

  return {
    ...trail,
    track: {
      ...trail.track,
      points: reversedPoints,
      displayPoints: reversedDisplay,
      totalDistance: totalDist,
      totalAscent: trail.track.totalDescent,
      totalDescent: trail.track.totalAscent,
    },
    waypoints: reverseWaypoints(trail.waypoints ?? [], totalDist, trackLength),
    alternates: reverseAlternates(trail.alternates ?? [], totalDist),
    sideTrips: transformSideTrips(trail.sideTrips ?? [], totalDist),
  } as T;
}
