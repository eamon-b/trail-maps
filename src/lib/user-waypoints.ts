/**
 * Hiker-added waypoints — places a hiker marks on a trail themselves.
 *
 * Two kinds, one shape:
 *
 * - **Private**: kept on the phone only (mobile SQLite `user_waypoints`). A
 *   campsite the hiker liked, their car, a note to self. Never sent anywhere.
 * - **Shared**: sent to the comments API (`PUT /v1/waypoints/:id`) and pulled by
 *   every phone that opens the trail — the water source or shop the guide is
 *   missing. Post-moderated like comments: anyone can report one, an admin can
 *   remove it, and enough distinct reports hide it.
 *
 * A hiker waypoint is NOT a curated waypoint. It never enters
 * `data/waypoint-ids.json`, the build, or `public/data/generated/*.json`; the
 * app merges it into the guide's trail at runtime (`placeUserWaypoints`), so the
 * map, list, elevation profile, detail screen and planner show it without any
 * of them learning a new list. Its id (`hw_<uuid>`) is what tells it apart.
 *
 * Platform-neutral (mobile via `@lib`, the worker relatively): no DOM, no Node.
 */

import { haversineDistance } from './distance';
import { calculateElevationBetween, type ElevationPoint } from './track-geometry';
import { routeBreakStarts } from './route-breaks';
import type { RouteBreak } from './trail-types';

/** Who can see a hiker waypoint. */
export type UserWaypointVisibility = 'private' | 'shared';

/**
 * The types a hiker can give a waypoint, in picker order. A deliberately short
 * subset of `WAYPOINT_TYPES`: the turn-off (`-access`) and structural types
 * (`gap`, `endpoint`, `milestone`) describe how a curated route is built, not a
 * place someone found. Each is a type the rest of the app already understands,
 * so a shared water source counts in the water-carry calculator and a campsite
 * is offered as a night's stop.
 */
export const USER_WAYPOINT_TYPES = [
  'water',
  'campsite',
  'hut',
  'resupply',
  'food',
  'accommodation',
  'town',
  'trailhead',
  'junction',
  'poi',
] as const;

export type UserWaypointType = (typeof USER_WAYPOINT_TYPES)[number];

export const USER_WAYPOINT_LIMITS = {
  nameMaxLength: 80,
  descriptionMaxLength: 1000,
  /**
   * How far from the trail a waypoint may be placed, in km. Beyond it the
   * waypoint is not about this trail; the form refuses it and the merge drops a
   * stored one rather than pin a km on it.
   */
  maxKmFromTrail: 5,
  /** New shared waypoints per account per day (the worker's rate bucket). */
  sharesPerDay: 20,
  /** Distinct reports that hide a shared waypoint. */
  reportsToHide: 3,
} as const;

/** The id prefix every hiker waypoint carries. */
export const USER_WAYPOINT_ID_PREFIX = 'hw_';

/** `hw_` + a lowercase v4 uuid: inside the comments API's waypoint-id pattern. */
const USER_WAYPOINT_ID_RE =
  /^hw_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Whether an id names a hiker-added waypoint (private or shared). */
export function isUserWaypointId(id: string | undefined | null): boolean {
  return typeof id === 'string' && USER_WAYPOINT_ID_RE.test(id);
}

/** A hiker waypoint id from a v4 uuid (the caller mints it: no crypto here). */
export function userWaypointId(uuid: string): string {
  return `${USER_WAYPOINT_ID_PREFIX}${uuid.toLowerCase()}`;
}

/** Whether a type is one a hiker may give a waypoint. */
export function isUserWaypointType(type: unknown): type is UserWaypointType {
  return typeof type === 'string' && (USER_WAYPOINT_TYPES as readonly string[]).includes(type);
}

/** One hiker waypoint as stored and synced. */
export interface UserWaypoint {
  id: string;
  trailId: string;
  name: string;
  type: UserWaypointType;
  lat: number;
  lon: number;
  /** Free text; '' when there is none. */
  description: string;
  visibility: UserWaypointVisibility;
  /** True when this device's account made it (it may edit and delete it). */
  mine: boolean;
  /** Display name of the hiker who shared it; null for a private one. */
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The fields a hiker edits. */
export interface UserWaypointInput {
  name: string;
  type: string;
  lat: number;
  lon: number;
  description?: string | null;
}

/** A cleaned input, or the first problem in plain English. */
export type UserWaypointCheck =
  | { ok: true; value: { name: string; type: UserWaypointType; lat: number; lon: number; description: string } }
  | { ok: false; field: 'name' | 'type' | 'position' | 'description'; message: string };

/**
 * Validate and normalise what a hiker typed. Shared by the form and the
 * worker, so the phone refuses exactly what the server would.
 */
export function checkUserWaypointInput(input: Partial<UserWaypointInput>): UserWaypointCheck {
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length === 0) return { ok: false, field: 'name', message: 'Give the waypoint a name.' };
  if (name.length > USER_WAYPOINT_LIMITS.nameMaxLength) {
    return {
      ok: false,
      field: 'name',
      message: `The name can be at most ${USER_WAYPOINT_LIMITS.nameMaxLength} characters.`,
    };
  }
  if (!isUserWaypointType(input.type)) {
    return { ok: false, field: 'type', message: 'Choose what kind of place this is.' };
  }
  const { lat, lon } = input;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { ok: false, field: 'position', message: 'The position is not a valid coordinate.' };
  }
  const rawDescription = input.description ?? '';
  if (typeof rawDescription !== 'string') {
    return { ok: false, field: 'description', message: 'The note must be text.' };
  }
  const description = rawDescription.trim();
  if (description.length > USER_WAYPOINT_LIMITS.descriptionMaxLength) {
    return {
      ok: false,
      field: 'description',
      message: `The note can be at most ${USER_WAYPOINT_LIMITS.descriptionMaxLength} characters.`,
    };
  }
  return {
    ok: true,
    value: {
      name,
      type: input.type,
      // Six decimals is ~0.1 m: more is noise, and it keeps the wire stable.
      lat: Math.round(lat * 1e6) / 1e6,
      lon: Math.round(lon * 1e6) / 1e6,
      description,
    },
  };
}

// ---------------------------------------------------------------------------
// Placing hiker waypoints on a trail
// ---------------------------------------------------------------------------

/** The track point shape the placement needs (the mobile `TrackData` points). */
export interface PlaceableTrackPoint extends ElevationPoint {
  lat: number;
  lon: number;
}

/** The waypoint fields the placement reads and writes. */
export interface PlaceableWaypoint {
  id?: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  description?: string;
  elevation?: number;
  distance?: number;
  totalDistance?: number;
  ascent?: number;
  descent?: number;
  totalAscent?: number;
  totalDescent?: number;
  trackIndex?: number;
}

/** What a placed hiker waypoint carries beyond a curated one's fields. */
export interface UserWaypointInfo {
  visibility: UserWaypointVisibility;
  mine: boolean;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  /** Straight-line metres from the trail line to the place. */
  metresFromTrail: number;
}

export interface PlaceableTrail {
  waypoints: PlaceableWaypoint[];
  track: { points: PlaceableTrackPoint[]; breaks?: RouteBreak[] };
}

/** Where a position lands on a track: km along it and metres from it. */
export interface TrackPlacement {
  /** Nearest vertex (for `trackIndex`). */
  index: number;
  /** Km along the track at the nearest point of the nearest segment. */
  km: number;
  /** Metres from the position to the track line. */
  metres: number;
  /** Elevation at the nearest vertex. */
  elevation: number;
}

/**
 * Project a position onto a track's line. A local equirectangular projection
 * per segment is plenty at these distances (a few km at most) and keeps this a
 * single O(n) pass over a phone's ≤ 5,000 points. Route breaks are skipped: the
 * gap between two landings is water, not trail.
 */
export function placeOnTrack(
  lat: number,
  lon: number,
  points: readonly PlaceableTrackPoint[],
  breaks?: RouteBreak[],
): TrackPlacement | null {
  if (points.length === 0) return null;
  const breakStarts = routeBreakStarts(breaks, 'points');
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let bestI = 0;
  let bestT = 0;
  let bestSq = Infinity;

  const consider = (i: number, t: number) => {
    const a = points[i];
    const b = points[Math.min(i + 1, points.length - 1)];
    const dy = lat - (a.lat + (b.lat - a.lat) * t);
    const dx = (lon - (a.lon + (b.lon - a.lon) * t)) * cosLat;
    const sq = dx * dx + dy * dy;
    if (sq < bestSq) {
      bestSq = sq;
      bestI = i;
      bestT = t;
    }
  };

  consider(points.length - 1, 0);
  for (let i = 0; i < points.length - 1; i++) {
    // The step into a break is the ferry: only its start vertex is trail.
    if (breakStarts.has(i + 1)) {
      consider(i, 0);
      continue;
    }
    const a = points[i];
    const b = points[i + 1];
    const ex = (b.lon - a.lon) * cosLat;
    const ey = b.lat - a.lat;
    const lenSq = ex * ex + ey * ey;
    const t =
      lenSq > 0
        ? Math.max(0, Math.min(1, (((lon - a.lon) * cosLat) * ex + (lat - a.lat) * ey) / lenSq))
        : 0;
    consider(i, t);
  }

  const a = points[bestI];
  const b = points[Math.min(bestI + 1, points.length - 1)];
  const index = bestT < 0.5 ? bestI : Math.min(bestI + 1, points.length - 1);
  return {
    index,
    km: a.dist + (b.dist - a.dist) * bestT,
    metres: Math.round(
      haversineDistance(lat, lon, a.lat + (b.lat - a.lat) * bestT, a.lon + (b.lon - a.lon) * bestT),
    ),
    elevation: points[index].ele,
  };
}

/**
 * The trail with its hiker waypoints placed among the curated ones, in km
 * order. Each lands at the km of the nearest point on the main route, with that
 * point's elevation, and the curated waypoint after it has its arriving leg
 * (distance, ascent, descent) re-measured from it, so the list's legs still
 * add up. Nothing else about the curated waypoints changes.
 *
 * Works on the trail as stored (NOBO); apply direction afterwards, as the guide
 * does for everything else. A waypoint further than `maxKmFromTrail` from the
 * route is left out. Returns the same trail object when there is nothing to
 * place.
 */
export function placeUserWaypoints<T extends PlaceableTrail>(
  trail: T,
  userWaypoints: readonly UserWaypoint[],
): T {
  if (userWaypoints.length === 0) return trail;
  const points = trail.track.points;
  if (points.length === 0) return trail;
  const breakStarts = routeBreakStarts(trail.track.breaks, 'points');

  type W = T['waypoints'][number];
  const placed: Array<W & { userWaypoint: UserWaypointInfo }> = [];
  for (const uw of userWaypoints) {
    const at = placeOnTrack(uw.lat, uw.lon, points, trail.track.breaks);
    if (!at || at.metres > USER_WAYPOINT_LIMITS.maxKmFromTrail * 1000) continue;
    const km = Math.round(at.km * 100) / 100;
    const climb = calculateElevationBetween(0, km, points, breakStarts);
    placed.push({
      id: uw.id,
      name: uw.name,
      type: uw.type,
      lat: uw.lat,
      lon: uw.lon,
      ...(uw.description ? { description: uw.description } : {}),
      elevation: Math.round(at.elevation),
      totalDistance: km,
      totalAscent: climb.gain,
      totalDescent: climb.loss,
      distance: 0,
      ascent: 0,
      descent: 0,
      trackIndex: at.index,
      userWaypoint: {
        visibility: uw.visibility,
        mine: uw.mine,
        authorName: uw.authorName,
        createdAt: uw.createdAt,
        updatedAt: uw.updatedAt,
        metresFromTrail: at.metres,
      },
    } as unknown as W & { userWaypoint: UserWaypointInfo });
  }
  if (placed.length === 0) return trail;

  // Stable: a hiker waypoint at the same km as a curated one sorts after it.
  const merged: W[] = [...trail.waypoints, ...placed].map((w, i) => ({ w, i }))
    .sort((a, b) => (a.w.totalDistance ?? 0) - (b.w.totalDistance ?? 0) || a.i - b.i)
    .map(({ w }) => w);

  const isPlaced = new Set<W>(placed);
  const out = merged.map((w, i) => {
    const prev = merged[i - 1];
    // Re-measure the arriving leg of every hiker waypoint, and of whatever
    // follows one (its previous waypoint changed). Every other leg is as built.
    if (!isPlaced.has(w) && !(prev && isPlaced.has(prev))) return w;
    const fromKm = prev?.totalDistance ?? 0;
    const toKm = w.totalDistance ?? 0;
    const leg = calculateElevationBetween(fromKm, toKm, points, breakStarts);
    return {
      ...w,
      distance: Math.round((toKm - fromKm) * 100) / 100,
      ascent: leg.gain,
      descent: leg.loss,
    };
  });

  return { ...trail, waypoints: out };
}

/** The hiker-waypoint details of a placed waypoint, or null for a curated one. */
export function userWaypointInfo(waypoint: object): UserWaypointInfo | null {
  const info = (waypoint as { userWaypoint?: UserWaypointInfo }).userWaypoint;
  return info && typeof info === 'object' ? info : null;
}
