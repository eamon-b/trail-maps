/**
 * Pure guide-trail helpers.
 *
 * Kept free of React so the direction logic can be unit-tested directly.
 */

import { createReversedTrail } from '@lib/trail-reverse';
import type { TrailJson } from '../../services/trail-loader';
import type { Direction } from '../../state/settings-store';

/**
 * Apply the chosen hiking direction to a trail. For 'reversed' this flips
 * track points, waypoint kilometres, and ascent/descent via the shared
 * `createReversedTrail`; 'default' returns the trail untouched.
 */
export function resolveGuideTrail(trail: TrailJson, direction: Direction): TrailJson {
  return direction === 'reversed' ? createReversedTrail(trail) : trail;
}

/** Waypoints ordered by cumulative distance for list rendering. */
export function orderedWaypoints(trail: TrailJson): TrailJson['waypoints'] {
  return [...trail.waypoints].sort(
    (a, b) => (a.totalDistance ?? 0) - (b.totalDistance ?? 0),
  );
}
