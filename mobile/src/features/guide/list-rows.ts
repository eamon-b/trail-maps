/**
 * The datasheet's row model: curated waypoints and OpenStreetMap points of
 * interest, ordered together by distance along the trail.
 *
 * Kept out of the pane (and free of React) because three of the list's subtler
 * behaviours — the FlatList key, scroll-to-me, and the focus hand-off between
 * panes — all read off a row rather than a waypoint now, and a mixed list is
 * exactly where an off-by-one hides.
 *
 * Two rules the ordering enforces:
 *
 *  - a waypoint wins a tie, so a POI sitting at the same kilometre as the
 *    waypoint it sits beside reads as an addendum to it (`interleavePoisByDistance`
 *    emits POIs strictly before the next item);
 *  - keys are assigned over the *unfiltered* waypoint order, so a legacy
 *    waypoint without a stable id keeps the same key — and therefore the same
 *    favourite — whichever chip is active.
 */

import { interleavePoisByDistance, poiRouteKey } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import type { TrailJson } from '../../services/trail-loader';

type Waypoint = TrailJson['waypoints'][number];

/** A curated waypoint row — everything the datasheet showed before POIs. */
export interface WaypointListRow {
  kind: 'waypoint';
  key: string;
  /** Cumulative distance along the trail, km. */
  km: number;
  waypoint: Waypoint;
}

/** An OpenStreetMap row: never favouritable, never commentable, always badged. */
export interface PoiListRow {
  kind: 'poi';
  key: string;
  km: number;
  poi: TrailPOI;
}

export type ListRow = WaypointListRow | PoiListRow;

/** Stable identity for a waypoint: its bundled id, or name plus position. */
export function waypointKey(waypoint: Waypoint, index: number): string {
  return waypoint.id ?? `${waypoint.name}-${index}`;
}

/** Row distance — the `kmOf` the focus helpers and scroll-to-me are given. */
export function rowKm(row: ListRow): number {
  return row.km;
}

/** Wrap ordered waypoints as rows, keying them by their place in that order. */
export function toWaypointRows(waypoints: readonly Waypoint[]): WaypointListRow[] {
  return waypoints.map((waypoint, index) => ({
    kind: 'waypoint',
    key: waypointKey(waypoint, index),
    km: waypoint.totalDistance ?? 0,
    waypoint,
  }));
}

/**
 * Merge POI rows into the waypoint rows by distance. The waypoint rows must
 * already be ordered (the pane's `orderedWaypoints` are); the POIs need not be.
 */
export function interleaveListRows(
  waypointRows: readonly WaypointListRow[],
  pois: readonly TrailPOI[],
): ListRow[] {
  return interleavePoisByDistance(waypointRows, pois, (row) => row.km).map((entry) =>
    entry.kind === 'item'
      ? entry.item
      : {
          kind: 'poi' as const,
          key: `poi:${poiRouteKey(entry.poi)}`,
          km: entry.poi.distanceAlongTrail,
          poi: entry.poi,
        },
  );
}
