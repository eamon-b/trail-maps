/**
 * Direction reversal for route variants (alternates and side trips).
 *
 * Shared by the web trail viewer and the mobile app (via Metro `@lib`).
 *
 * Variant waypoint `totalDistance` semantics (set by build-trails
 * enrichVariantWaypoints): when the variant has a junction with the main
 * track (`startDistance` set), it is ABSOLUTE trail km — junction km plus the
 * distance walked along the variant. When the variant never attaches to the
 * main track (`startDistance` undefined), it falls back to variant-relative
 * km. The reversal functions below only transform attached variants; an
 * unattached variant's relative km have no junction to mirror, so it is
 * returned untouched rather than corrupted.
 *
 * A variant attached to a parent alternate rather than to the main route
 * (`parent` set by the ingest pass) needs nothing special here: its junction km
 * are absolute trail km like any other, so they mirror the same way, and the
 * parent reference names an alternate whose own position flips with it.
 *
 * A variant with a single junction - a terminus, a dead-end side trip, an
 * alternate that never rejoins (the Bibbulmun's hitch into Denmark) - leaves
 * the trail and does not come back, so which way the trail is walked does not
 * change which end of it is the junction. It keeps the one shape every reader
 * expects of it, `startDistance` only with `points[0]` at the junction, and
 * only the junction km mirrors. One attached at its last point only (written by
 * an ingest from before such variants were turned round) comes out in that
 * same shape: its junction mirrored, its points and waypoints turned round.
 */

/** The km/statistics fields the reversal math needs on a variant waypoint. */
export interface VariantWaypointKmFields {
  /** Segment distance from previous variant waypoint (variant-relative) in km */
  distance: number;
  /** Absolute trail km (attached variants) or variant-relative km (unattached) */
  totalDistance: number;
  ascent: number;
  descent: number;
  totalAscent: number;
  totalDescent: number;
  variantTrackIndex: number;
}

/** Structural shape both web and mobile RouteVariant types satisfy. */
export interface ReversibleVariant {
  /** Distance along main trail where variant starts (km) */
  startDistance?: number;
  /** Distance along main trail where variant ends (km, alternates only) */
  endDistance?: number;
  /** Total length of the variant in km */
  distance?: number;
  /** How far the branch end sits from what it attached to (m), when recorded */
  startOffsetMeters?: number;
  /** The same residual for the rejoin end */
  endOffsetMeters?: number;
  points?: unknown[];
  waypoints?: VariantWaypointKmFields[];
}

function roundKm(km: number): number {
  return Math.round(km * 100) / 100;
}

/**
 * Turn a variant round about its far end: the waypoints' along-variant km run
 * from the other end, their order and per-segment climb flip, and `points`
 * reverses. `oldStart` is the km the waypoints are currently counted from,
 * `newStart` the km they will be counted from.
 */
function turnRound<V extends ReversibleVariant>(variant: V, oldStart: number, newStart: number): V {
  const variantLen = variant.distance ?? 0;
  const pointCount = variant.points?.length ?? 0;

  let waypoints = variant.waypoints;
  if (waypoints && waypoints.length > 0) {
    const reordered = [...waypoints].reverse().map(wp => {
      const alongVariant = Math.max(0, wp.totalDistance - oldStart);
      const newAlongVariant = Math.max(0, variantLen - alongVariant);
      return {
        ...wp,
        totalDistance: roundKm(newStart + newAlongVariant),
        ascent: wp.descent,
        descent: wp.ascent,
        variantTrackIndex: pointCount > 0 ? pointCount - 1 - wp.variantTrackIndex : 0,
      };
    });

    let runningAscent = 0;
    let runningDescent = 0;
    let prevAbs = newStart;
    waypoints = reordered.map(wp => {
      const distance = roundKm(Math.max(0, wp.totalDistance - prevAbs));
      prevAbs = wp.totalDistance;
      runningAscent += wp.ascent;
      runningDescent += wp.descent;
      return { ...wp, distance, totalAscent: runningAscent, totalDescent: runningDescent };
    });
  }

  // The two ends trade places along with the points, so a residual recorded
  // against one end has to travel with it — and one recorded against neither
  // must not appear as an `undefined` key on the other.
  const { startOffsetMeters, endOffsetMeters, ...rest } = variant;
  const offsets: Pick<ReversibleVariant, 'startOffsetMeters' | 'endOffsetMeters'> = {};
  if (endOffsetMeters !== undefined) offsets.startOffsetMeters = endOffsetMeters;
  if (startOffsetMeters !== undefined) offsets.endOffsetMeters = startOffsetMeters;

  return {
    ...rest,
    ...offsets,
    points: variant.points ? [...variant.points].reverse() : [],
    waypoints,
  } as V;
}

/**
 * Mirror the junction a variant is read from, leaving the walk along it as it
 * is: the waypoints move with the junction and keep their along-variant km.
 */
function mirrorStartJunction<V extends ReversibleVariant>(variant: V, totalDistance: number): V {
  const oldStart = variant.startDistance ?? 0;
  const newStart = roundKm(totalDistance - oldStart);
  const waypoints = variant.waypoints?.map(wp => ({
    ...wp,
    totalDistance: roundKm(newStart + Math.max(0, wp.totalDistance - oldStart)),
  }));
  return { ...variant, startDistance: newStart, waypoints };
}

/**
 * Reverse a variant with exactly one junction (see the module note). Returns
 * null when it has two junctions or none.
 */
function reverseSingleJunction<V extends ReversibleVariant>(variant: V, totalDistance: number): V | null {
  if (variant.startDistance != null && variant.endDistance == null) {
    return mirrorStartJunction(variant, totalDistance);
  }

  if (variant.startDistance == null && variant.endDistance != null) {
    // Its waypoints were counted from `points[0]` (there was no startDistance),
    // i.e. from 0.
    const newStart = roundKm(totalDistance - variant.endDistance);
    const turned = turnRound(variant, 0, newStart);
    delete turned.endDistance;
    return { ...turned, startDistance: newStart };
  }

  return null;
}

/**
 * Reverse alternate route variants, flipping start/end distances and
 * recomputing waypoint positions.
 *
 * Waypoint totalDistance is absolute trail km (junction + along-variant), so
 * reversal maps each waypoint's along-variant offset onto the reversed walk:
 * newAbs = newStart + (variantLength - oldAlongVariant). Per-waypoint
 * ascent/descent swap, matching the convention used for main-route waypoints.
 *
 * An alternate with one junction is mirrored about it and keeps reading from
 * it (see the module note). Alternates with no junction are returned
 * untouched — their waypoint km are variant-relative and there is nothing to
 * mirror.
 */
export function reverseAlternates<V extends ReversibleVariant>(
  alternates: V[],
  totalDistance: number,
): V[] {
  return alternates.map(alt => {
    if (alt.startDistance == null || alt.endDistance == null) {
      return reverseSingleJunction(alt, totalDistance) ?? alt;
    }

    const oldStart = alt.startDistance;
    const newStart = roundKm(totalDistance - alt.endDistance);
    return {
      ...turnRound(alt, oldStart, newStart),
      startDistance: newStart,
      endDistance: roundKm(totalDistance - oldStart),
    };
  });
}

/**
 * Transform side trips for direction change (flip attachment point).
 * A side trip is walked out-and-back the same way in either direction, so
 * only the junction km and the waypoints' absolute km move; along-variant
 * offsets and stats are unchanged.
 *
 * The same holds for a terminus, which travels in this list: it stays
 * attached at `startDistance` only, mirrored.
 *
 * Side trips without a junction are returned untouched — their waypoint km
 * are variant-relative and mirroring would corrupt them.
 */
export function transformSideTrips<V extends ReversibleVariant>(
  sideTrips: V[],
  totalDistance: number,
): V[] {
  return sideTrips.map(trip => {
    if (trip.startDistance != null && trip.endDistance != null) {
      return mirrorStartJunction(trip, totalDistance);
    }
    return reverseSingleJunction(trip, totalDistance) ?? trip;
  });
}
