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
  points?: unknown[];
  waypoints?: VariantWaypointKmFields[];
}

function roundKm(km: number): number {
  return Math.round(km * 100) / 100;
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
 * Alternates without both junctions are returned untouched — their waypoint
 * km are variant-relative and there is no junction to mirror.
 */
export function reverseAlternates<V extends ReversibleVariant>(
  alternates: V[],
  totalDistance: number,
): V[] {
  return alternates.map(alt => {
    if (alt.startDistance == null || alt.endDistance == null) {
      return alt;
    }

    const oldStart = alt.startDistance;
    const newStart = totalDistance - alt.endDistance;
    const variantLen = alt.distance ?? 0;
    const pointCount = alt.points?.length ?? 0;

    let waypoints = alt.waypoints;
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

    return {
      ...alt,
      startDistance: newStart,
      endDistance: totalDistance - oldStart,
      points: alt.points ? [...alt.points].reverse() : [],
      waypoints,
    } as V;
  });
}

/**
 * Transform side trips for direction change (flip attachment point).
 * A side trip is walked out-and-back the same way in either direction, so
 * only the junction km and the waypoints' absolute km move; along-variant
 * offsets and stats are unchanged.
 *
 * Side trips without a junction are returned untouched — their waypoint km
 * are variant-relative and mirroring would corrupt them.
 */
export function transformSideTrips<V extends ReversibleVariant>(
  sideTrips: V[],
  totalDistance: number,
): V[] {
  return sideTrips.map(trip => {
    if (trip.startDistance == null) {
      return trip;
    }
    const oldStart = trip.startDistance;
    const newStart = totalDistance - oldStart;
    const waypoints = trip.waypoints?.map(wp => ({
      ...wp,
      totalDistance: roundKm(newStart + Math.max(0, wp.totalDistance - oldStart)),
    }));
    return { ...trip, startDistance: newStart, waypoints } as V;
  });
}
