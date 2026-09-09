/**
 * OSM points of interest as elevation-profile ticks.
 *
 * A POI carries no elevation of its own — it is a place *near* the trail, not a
 * point on it — so its tick is hung off the track: the elevation of the nearest
 * track point to its `distanceAlongTrail`. That keeps the ring sitting on the
 * trace instead of on the plot floor, which is where a missing elevation lands
 * a marker.
 *
 * Pure and React-free: the pane memoises this per (visible POIs, track) and the
 * profile only ever sees `ProfileWaypoint`s, so nothing downstream has to learn
 * what a POI is beyond its `kind`.
 */

import { poiRouteKey } from '@lib/poi-display';
import { findNearestByDistance } from '@lib/track-geometry';
import type { TrailPOI } from '@lib/trail-types';
import type { ProfileWaypoint } from './ElevationProfile';
import type { DistEle } from './geometry';

/**
 * Widest visible window (km) that still gets POI ticks.
 *
 * Zoomed out to a whole trail, Bibbulmun's 435 visible POIs are a hedge of
 * overlapping rings that hides the trace they are drawn on; the ticks only earn
 * their place once a section is on screen.
 */
export const POI_PROFILE_MAX_WINDOW_KM = 60;

/** The POI a walker tapped, as the profile's marker id. */
type PoiSource = Pick<TrailPOI, 'type' | 'id' | 'category' | 'distanceAlongTrail'>;

/**
 * Profile markers for the visible POIs, elevation sampled from `points`.
 *
 * `points` must be the track sorted ascending by `dist` (the binary search in
 * `findNearestByDistance` assumes it) — `trail.track.displayPoints` is. With no
 * track to sample, the elevation is left undefined and the profile drops the
 * marker to its floor, which is the same thing it does for a waypoint without
 * one. Input order is irrelevant: markers come back in the order given, and the
 * profile places each from its own km.
 */
export function poiProfileMarkers(pois: PoiSource[], points: DistEle[]): ProfileWaypoint[] {
  return pois.map((poi) => ({
    id: poiRouteKey(poi),
    kind: 'poi' as const,
    type: poi.category,
    totalDistance: poi.distanceAlongTrail,
    elevation:
      points.length > 0 ? points[findNearestByDistance(points, poi.distanceAlongTrail)]?.ele : undefined,
  }));
}
