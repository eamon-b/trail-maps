/**
 * Waypoint-sequence routes (P1 PR D, roadmap 10).
 *
 * A route is a name plus an ordered list of waypoints over EXISTING geometry
 * — no drawn geometry (decision 9). Leg metrics come from the same
 * along-track math the Measure tool uses (measureBetweenPoints); legs whose
 * endpoint sits genuinely off the track contribute a straight-line
 * (haversine) leg, flagged so the UI can label it "≈ straight line" and the
 * estimated time is never read as trail-accurate.
 *
 * Storage (migration 7): `waypoint_ref` holds a merged waypoint id;
 * `km_position` (base direction) is denormalized so legs survive waypoint
 * deletion — resolved as "(deleted waypoint)" at the stored km.
 */

import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/database';
import { haversineDistance } from '@lib/distance';
import { estimateHikingTime } from '@lib/day-calculator';
import { findNearestByDistance, isCustomWaypointId, type Trail, type TrailWaypoint } from '../lib/trail-utils';
import { measureBetweenPoints } from './measure-service';

/**
 * A waypoint more than this far from the track makes its legs straight-line
 * (haversine) instead of along-track: the trail distance between snap points
 * says nothing about how you reach a genuinely off-trail spot.
 */
export const OFF_TRACK_LEG_THRESHOLD_M = 200;

/**
 * How far a positional `wp-N` ref's resolved km may drift from the stored
 * denormalized km before we distrust the ref. Bundled ids are assigned by
 * array index (trail-utils `wp-${i}`, explicitly non-persistable) so a
 * data-version bump that reorders waypoints can make a stored `wp-12` resolve
 * to a *different* live waypoint — silently, since that waypoint still has
 * deleted:false. Real trail waypoints sit far more than 0.3 km apart, so a
 * genuine reorder lands well beyond this tolerance while the honest jitter of
 * a re-snapped/re-simplified track for the SAME waypoint stays under it.
 */
export const POSITIONAL_REF_KM_TOLERANCE_KM = 0.3;

export interface Route {
  id: string;
  trailId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface RouteLeg {
  routeId: string;
  seq: number;
  /** Merged waypoint id (`wp-N` or `custom-…`), or null when unavailable */
  waypointRef: string | null;
  /** Trail km in the BASE (as-stored) direction — the deletion fallback */
  kmPosition: number;
}

/** Input for one leg when creating a route. */
export interface NewRouteLeg {
  waypointRef: string | null;
  kmPosition: number;
}

interface RouteRow {
  id: string;
  trail_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface RouteLegRow {
  route_id: string;
  seq: number;
  waypoint_ref: string | null;
  km_position: number;
}

function rowToRoute(row: RouteRow): Route {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function generateRouteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class RouteService {
  constructor(private db: SQLiteDatabase) {}

  static async create(): Promise<RouteService> {
    const db = await getDatabase();
    return new RouteService(db);
  }

  /** Create a named route with its ordered legs (transactional). */
  async createRoute(trailId: string, name: string, legs: NewRouteLeg[]): Promise<Route> {
    const id = generateRouteId();
    const now = new Date().toISOString();

    await this.db.execAsync('BEGIN');
    try {
      await this.db.runAsync(
        'INSERT INTO routes (id, trail_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [id, trailId, name, now, now]
      );
      for (let seq = 0; seq < legs.length; seq++) {
        await this.db.runAsync(
          'INSERT INTO route_legs (route_id, seq, waypoint_ref, km_position) VALUES (?, ?, ?, ?)',
          [id, seq, legs[seq].waypointRef, legs[seq].kmPosition]
        );
      }
      await this.db.execAsync('COMMIT');
    } catch (e) {
      await this.db.execAsync('ROLLBACK');
      throw e;
    }

    return { id, trailId, name, createdAt: now, updatedAt: now };
  }

  /** Routes for one trail, or all routes when trailId is omitted. */
  async listRoutes(trailId?: string): Promise<Route[]> {
    const rows = trailId
      ? await this.db.getAllAsync<RouteRow>(
          'SELECT * FROM routes WHERE trail_id = ? ORDER BY created_at DESC',
          [trailId]
        )
      : await this.db.getAllAsync<RouteRow>('SELECT * FROM routes ORDER BY created_at DESC');
    return rows.map(rowToRoute);
  }

  async getRoute(id: string): Promise<Route | null> {
    const row = await this.db.getFirstAsync<RouteRow>('SELECT * FROM routes WHERE id = ?', [id]);
    return row ? rowToRoute(row) : null;
  }

  /** Ordered legs of a route. */
  async getRouteLegs(routeId: string): Promise<RouteLeg[]> {
    const rows = await this.db.getAllAsync<RouteLegRow>(
      'SELECT * FROM route_legs WHERE route_id = ? ORDER BY seq',
      [routeId]
    );
    return rows.map(r => ({
      routeId: r.route_id,
      seq: r.seq,
      waypointRef: r.waypoint_ref,
      kmPosition: r.km_position,
    }));
  }

  async renameRoute(id: string, name: string): Promise<void> {
    await this.db.runAsync(
      'UPDATE routes SET name = ?, updated_at = ? WHERE id = ?',
      [name, new Date().toISOString(), id]
    );
  }

  async deleteRoute(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM routes WHERE id = ?', [id]);
  }
}

// ---------------------------------------------------------------------------
// Metrics assembly (pure — testable without a DB)
// ---------------------------------------------------------------------------

/** A route leg endpoint resolved against the (active-direction) trail. */
export interface ResolvedRoutePoint {
  seq: number;
  name: string;
  lat: number;
  lon: number;
  ele: number | null;
  /** km along the trail in the ACTIVE direction */
  km: number;
  /** Whether the point sits genuinely off the track (straight-line legs) */
  offTrack: boolean;
  /** The referenced waypoint no longer exists — km fallback in use */
  deleted: boolean;
}

/**
 * Resolve stored legs against a trail. `waypoint_ref` wins (merged waypoint
 * ids carry the live position in whatever direction the trail is displayed);
 * a missing waypoint falls back to the denormalized base-direction km,
 * rendered as "(deleted waypoint)".
 *
 * @param reversed whether `trail` is displayed reversed relative to storage
 *   (the km fallback is stored in base direction and must be mirrored)
 */
export function resolveRoutePoints(
  trail: Trail,
  legs: { seq: number; waypointRef: string | null; kmPosition: number }[],
  options?: { reversed?: boolean },
): ResolvedRoutePoint[] {
  const reversed = options?.reversed ?? false;
  const points = trail.track.points;

  return legs.map(leg => {
    const wp = leg.waypointRef
      ? trail.waypoints.find(w => w.id === leg.waypointRef)
      : undefined;

    // Stored km is base-direction; mirror it into the active (display)
    // direction so it lines up with the live waypoint km and drives the
    // fallback below.
    const activeKm = reversed ? trail.track.totalDistance - leg.kmPosition : leg.kmPosition;

    if (wp) {
      // Guard positional refs against silent mis-resolution. `custom-…` ids
      // are stable row references (and may be legitimately moved), so they
      // always follow their live position. A bundled `wp-N` id, however, can
      // point at a different waypoint after a data-version bump; if its live
      // km has drifted from the denormalized km beyond tolerance, distrust the
      // ref and degrade exactly like a deleted waypoint (km fallback below).
      const usable =
        isCustomWaypointId(wp.id) ||
        Math.abs((wp.totalDistance ?? 0) - activeKm) <= POSITIONAL_REF_KM_TOLERANCE_KM;
      if (usable) {
        return {
          seq: leg.seq,
          name: wp.name,
          lat: wp.lat,
          lon: wp.lon,
          ele: wp.elevation ?? null,
          km: wp.totalDistance ?? 0,
          offTrack: (wp.offTrackM ?? 0) > OFF_TRACK_LEG_THRESHOLD_M,
          deleted: false,
        };
      }
    }

    // Fallback: the waypoint is gone (or its ref no longer trustworthy) —
    // keep the geometry via the stored km.
    const idx = findNearestByDistance(points, activeKm);
    const pt = points[idx];
    return {
      seq: leg.seq,
      name: '(deleted waypoint)',
      lat: pt?.lat ?? 0,
      lon: pt?.lon ?? 0,
      ele: pt?.ele ?? null,
      km: activeKm,
      offTrack: false,
      deleted: true,
    };
  });
}

/** Metrics for one leg between two consecutive route points. */
export interface RouteLegMetric {
  from: ResolvedRoutePoint;
  to: ResolvedRoutePoint;
  distanceKm: number;
  ascentM: number;
  descentM: number;
  estimatedHours: number;
  waterSourceCount: number;
  /** Off-track endpoint(s): haversine straight line, NOT trail-accurate */
  straightLine: boolean;
}

export interface RouteMetrics {
  legs: RouteLegMetric[];
  totalKm: number;
  totalHours: number;
}

/**
 * Assemble per-leg and total metrics for an ordered list of resolved points
 * (decision 9). On-track legs reuse measureBetweenPoints (distance, ascent,
 * descent, Naismith time, water count between the two km positions);
 * off-track legs are straight-line haversine with flat-ground time and no
 * water count (nothing is known about the terrain between).
 */
export function assembleRouteMetrics(trail: Trail, points: ResolvedRoutePoint[]): RouteMetrics {
  const legs: RouteLegMetric[] = [];
  let totalKm = 0;
  let totalHours = 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];

    let metric: RouteLegMetric;
    if (from.offTrack || to.offTrack) {
      const distanceKm = Math.round(haversineDistance(from.lat, from.lon, to.lat, to.lon) / 100) / 10;
      metric = {
        from,
        to,
        distanceKm,
        ascentM: 0,
        descentM: 0,
        estimatedHours: estimateHikingTime(distanceKm, 0, 0),
        waterSourceCount: 0,
        straightLine: true,
      };
    } else {
      const measured = measureBetweenPoints(trail, from.km, to.km);
      // measureBetweenPoints normalizes to ascending km order, so its ascent /
      // descent describe walking low-km → high-km. A leg walked backwards
      // (to.km < from.km — e.g. the return leg of an out-and-back to a
      // lookout) reverses that: the measured ascent is really descent and vice
      // versa. Naismith time is direction-sensitive (descent is nearly free,
      // ascent is not), so recompute the estimate from the corrected figures
      // rather than reusing the wrong-direction hours.
      const descending = to.km < from.km;
      const ascentM = descending ? measured.descentM : measured.ascentM;
      const descentM = descending ? measured.ascentM : measured.descentM;
      metric = {
        from,
        to,
        distanceKm: measured.distanceKm,
        ascentM,
        descentM,
        estimatedHours: estimateHikingTime(measured.distanceKm, ascentM, descentM),
        waterSourceCount: measured.waterSourceCount,
        straightLine: false,
      };
    }

    legs.push(metric);
    totalKm += metric.distanceKm;
    totalHours += metric.estimatedHours;
  }

  return {
    legs,
    totalKm: Math.round(totalKm * 10) / 10,
    totalHours: Math.round(totalHours * 10) / 10,
  };
}

/**
 * Map overlay geometry for a route: highlighted track spans for on-track
 * legs, straight dashed lines for off-track legs (visually distinct so the
 * estimate is never read as trail-accurate).
 */
export function routeOverlayGeometry(points: ResolvedRoutePoint[]): {
  spans: { startKm: number; endKm: number }[];
  straightLegs: { from: [number, number]; to: [number, number] }[];
} {
  const spans: { startKm: number; endKm: number }[] = [];
  const straightLegs: { from: [number, number]; to: [number, number] }[] = [];

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    if (from.offTrack || to.offTrack) {
      straightLegs.push({ from: [from.lat, from.lon], to: [to.lat, to.lon] });
    } else {
      spans.push({
        startKm: Math.min(from.km, to.km),
        endKm: Math.max(from.km, to.km),
      });
    }
  }

  return { spans, straightLegs };
}

/** Convert a TrailWaypoint tapped in the builder into a resolved point. */
export function waypointToRoutePoint(wp: TrailWaypoint, seq: number): ResolvedRoutePoint {
  return {
    seq,
    name: wp.name,
    lat: wp.lat,
    lon: wp.lon,
    ele: wp.elevation ?? null,
    km: wp.totalDistance ?? 0,
    offTrack: (wp.offTrackM ?? 0) > OFF_TRACK_LEG_THRESHOLD_M,
    deleted: false,
  };
}
