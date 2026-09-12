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

import { mirrorPoiDistances } from './poi-display';
import {
  reverseAlternates,
  transformSideTrips,
  type ReversibleVariant,
} from './variant-reverse';

/** Minimal POI shape for reversal: only the along-trail km is direction-dependent. */
export interface ReversiblePoi {
  /** km along the trail from the current start */
  distanceAlongTrail: number;
}

/** Minimal track point shape for reversal. */
export interface ReversibleTrackPoint {
  /** Cumulative distance along the trail in km */
  dist: number;
  /** Cumulative ascent from the start of the route in m (thinned tracks only). */
  cumAscent?: number;
  /** Cumulative descent from the start of the route in m (thinned tracks only). */
  cumDescent?: number;
}

/** The fields of a route break that a change of direction moves. */
export interface ReversibleRouteBreak {
  index: number;
  displayIndex: number;
  km: number;
  fromTrack: string;
  toTrack: string;
}

/**
 * Mirror route breaks about the end of the trail.
 *
 * A break sits *between* points i-1 and i. Reversing an n-point array sends
 * index i to n-1-i, so the same seam ends up between n-i-1 and n-i and the
 * first point after it is n-i. Walked the other way the stretch that ended at
 * the break is the one that resumes, so the two names swap; the km is the same
 * distance from the other end.
 */
export function reverseRouteBreaks<B extends ReversibleRouteBreak>(
  breaks: B[],
  totalDistance: number,
  trackLength: number,
  displayLength: number,
): B[] {
  return [...breaks].reverse().map(b => ({
    ...b,
    index: trackLength - b.index,
    displayIndex: displayLength - b.displayIndex,
    km: totalDistance - b.km,
    fromTrack: b.toTrack,
    toTrack: b.fromTrack,
  }));
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
    breaks?: ReversibleRouteBreak[];
  };
  waypoints?: W[];
  alternates?: V[];
  sideTrips?: V[];
  /** OSM points of interest. Absent on a trail that was never enriched. */
  pois?: ReversiblePoi[];
}

/**
 * Reverse track points, flipping cumulative distances — and, when the points
 * carry them, the cumulative climb pair.
 *
 * A climb walked one way is a descent walked the other, so the ascent from the
 * new start down to a point is the descent the forward walk still had left at
 * that point: `cumAscent' = D - cumDescent`, `cumDescent' = A - cumAscent`,
 * where A and D are the last point's own totals. Taken from the array rather
 * than from `track.totalAscent` so the pair stays self-consistent: the reversed
 * first point lands on 0 and the last on the forward totals, whatever rounding
 * the asset applied. The step into a route break contributed nothing forward,
 * so it contributes nothing reversed either, and the breaks need no extra care.
 */
export function reverseTrackPoints<P extends ReversibleTrackPoint>(
  points: P[],
  totalDistance: number,
): P[] {
  const last = points[points.length - 1];
  const totalAscent = last?.cumAscent;
  const totalDescent = last?.cumDescent;
  const hasCumulative =
    typeof totalAscent === 'number' && typeof totalDescent === 'number';

  return [...points].reverse().map(p => {
    const dist = totalDistance - p.dist;
    if (
      hasCumulative &&
      typeof p.cumAscent === 'number' &&
      typeof p.cumDescent === 'number'
    ) {
      return {
        ...p,
        dist,
        cumAscent: totalDescent - p.cumDescent,
        cumDescent: totalAscent - p.cumAscent,
      };
    }
    return { ...p, dist };
  });
}

/**
 * Reverse waypoints, recalculating segment distances and swapping
 * ascent/descent (a climb walked one way is a descent walked the other).
 *
 * Per-waypoint ascent/descent follow the arriving-segment convention set by
 * build-trails enrichWaypoints ("segment ascent from previous waypoint"):
 * walking the trail backwards, the segment arriving at reversed[i] is the
 * segment that originally arrived at reversed[i - 1], with ascent/descent
 * swapped. The first reversed waypoint has no arriving segment (0/0), and
 * cumulative totals are recomputed from the per-segment values so the final
 * waypoint's totals equal the swapped trail totals.
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
    // The segment between reversed[i - 1] and reversed[i] carries the stats
    // stored on reversed[i - 1] (its arriving segment in the original walk).
    const prev = i > 0 ? reversed[i - 1] : undefined;
    const segmentAscent = prev ? (prev.descent ?? 0) : 0;
    const segmentDescent = prev ? (prev.ascent ?? 0) : 0;
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
 * junctions. POI km are mirrored too, so the web viewer and the mobile guide
 * both get a reversed trail whose POIs read from the new start rather than the
 * old one. Any extra fields on the trail object (config, climate, …) are passed
 * through unchanged.
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
      ...(trail.track.breaks
        ? {
            breaks: reverseRouteBreaks(
              trail.track.breaks,
              totalDist,
              trackLength,
              (reversedDisplay ?? reversedPoints).length,
            ),
          }
        : {}),
    },
    waypoints: reverseWaypoints(trail.waypoints ?? [], totalDist, trackLength),
    alternates: reverseAlternates(trail.alternates ?? [], totalDist),
    sideTrips: transformSideTrips(trail.sideTrips ?? [], totalDist),
    // Only when the trail has POIs: an absent `pois` means "never enriched",
    // which is not the same as "enriched and found nothing".
    ...(trail.pois ? { pois: mirrorPoiDistances(trail.pois, totalDist) } : {}),
  } as T;
}
