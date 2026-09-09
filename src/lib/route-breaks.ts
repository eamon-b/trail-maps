/**
 * Reading {@link RouteBreak}s back out of a built trail, for anything that
 * draws or measures the route.
 *
 * A break is a place the walking route stops and starts again somewhere else —
 * a ferry, a river with no crossing, a lake. `trail-ingest` records them and
 * leaves the points either side of one in the same flat array, because every
 * consumer of `track.points` (the elevation profile, waypoint projection, the
 * hover readout, the mobile budget) wants one ladder of cumulative distance.
 * Only the code that draws a line has to care, and this is what it uses.
 *
 * Platform-neutral: no Leaflet, no DOM.
 */

import type { RouteBreak } from './trail-types';

/** The least a point needs for splitting: nothing but its place in the array. */
export interface SplittablePoint {
  lat: number;
  lon: number;
}

/**
 * Cut a point list into the stretches between its breaks.
 *
 * Returns a single stretch when the trail has none, which is every trail whose
 * route is continuous — so a caller can use this unconditionally.
 *
 * `which` picks the index the breaks are expressed in: `displayPoints` for the
 * simplified map copy, `points` for the full-resolution one. Passing the wrong
 * array is the one way to get this wrong, so it is named rather than inferred.
 */
export function splitAtRouteBreaks<P extends SplittablePoint>(
  points: P[],
  breaks: RouteBreak[] | undefined,
  which: 'points' | 'displayPoints'
): P[][] {
  if (!breaks || breaks.length === 0) return [points];

  const cuts = breaks
    .map((b) => (which === 'points' ? b.index : b.displayIndex))
    .filter((i) => Number.isInteger(i) && i > 0 && i < points.length)
    .sort((a, b) => a - b);

  if (cuts.length === 0) return [points];

  const stretches: P[][] = [];
  let start = 0;
  for (const cut of cuts) {
    stretches.push(points.slice(start, cut));
    start = cut;
  }
  stretches.push(points.slice(start));
  return stretches.filter((stretch) => stretch.length > 0);
}

/** The two ends of a break: the last point walked, and the first one after it. */
export interface RouteBreakCrossing {
  from: SplittablePoint;
  to: SplittablePoint;
  /** Straight-line distance across, in km. */
  straightLineKm: number;
}

/**
 * The straight lines a break implies, for drawing them as what they are —
 * dashed, unwalked — rather than as trail or not at all.
 *
 * Deliberately unlabelled. The stretch names a break sits between read
 * 'Te Araroa (SOBO) 3/7: km 606.0-1739.0', which is no use in a popup, and the
 * trail data already puts a named 'Trail ends'/'Trail resumes' waypoint at each
 * end. All the line itself has to say is how wide it is.
 */
export function routeBreakCrossings<P extends SplittablePoint>(
  points: P[],
  breaks: RouteBreak[] | undefined,
  which: 'points' | 'displayPoints'
): RouteBreakCrossing[] {
  if (!breaks) return [];

  const crossings: RouteBreakCrossing[] = [];
  for (const routeBreak of breaks) {
    const index =
      which === 'points' ? routeBreak.index : routeBreak.displayIndex;
    if (!Number.isInteger(index) || index <= 0 || index >= points.length)
      continue;
    crossings.push({
      from: points[index - 1],
      to: points[index],
      straightLineKm: routeBreak.straightLineKm,
    });
  }
  return crossings;
}
