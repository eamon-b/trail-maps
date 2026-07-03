import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/database';
import { TRAIL_DATA, type TrailJson } from './trail-loader';

export interface Trail {
  id: string;
  name: string;
  shortName: string | null;
  region: string | null;
  lengthKm: number | null;
  metadataJson: string | null;
  dataVersion: string | null;
  isCustom: boolean;
  sourceFilename: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Waypoint {
  id: number;
  trailId: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele: number | null;
  kmPosition: number | null;
  description: string | null;
}

/** Waypoint types users can pick when adding a custom waypoint. */
export const CUSTOM_WAYPOINT_TYPES = ['water', 'water-tank', 'campsite', 'poi'] as const;
export type CustomWaypointType = (typeof CUSTOM_WAYPOINT_TYPES)[number];

/**
 * A user-created waypoint. Stored in the dedicated `custom_waypoints` table
 * (never the bulk-rewritten `waypoints` table), so trail data refreshes can't
 * wipe it. `lat`/`lon` are the raw pressed location; `kmPosition` is the
 * snapped trail km used by distance math; `offTrackM` is the metres between
 * the two.
 */
export interface CustomWaypoint {
  id: string;
  trailId: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele: number | null;
  kmPosition: number;
  offTrackM: number | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Input for creating a custom waypoint (id + timestamps are generated). */
export type NewCustomWaypoint = {
  trailId: string;
  name: string;
  type?: string;
  lat: number;
  lon: number;
  ele?: number | null;
  kmPosition: number;
  offTrackM?: number | null;
  description?: string | null;
};

/** Fields of a custom waypoint that can be edited after creation. */
export type CustomWaypointUpdate = Partial<
  Pick<CustomWaypoint, 'name' | 'type' | 'lat' | 'lon' | 'ele' | 'kmPosition' | 'offTrackM' | 'description'>
>;

interface TrailRow {
  id: string;
  name: string;
  short_name: string | null;
  region: string | null;
  length_km: number | null;
  metadata_json: string | null;
  data_version: string | null;
  is_custom: number;
  source_filename: string | null;
  created_at: string;
  updated_at: string;
}

interface WaypointRow {
  id: number;
  trail_id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele: number | null;
  km_position: number | null;
  description: string | null;
}

interface CustomWaypointRow {
  id: string;
  trail_id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  ele: number | null;
  km_position: number;
  off_track_m: number | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTrail(row: TrailRow): Trail {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    region: row.region,
    lengthKm: row.length_km,
    metadataJson: row.metadata_json,
    dataVersion: row.data_version,
    isCustom: row.is_custom === 1,
    sourceFilename: row.source_filename,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCustomWaypoint(row: CustomWaypointRow): CustomWaypoint {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lon: row.lon,
    ele: row.ele,
    kmPosition: row.km_position,
    offTrackM: row.off_track_m,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate a unique custom waypoint id. Same base36-timestamp precedent as
 * generateCustomTrailId in custom-trail-service.ts, plus a random suffix so
 * rapid successive adds can't collide.
 */
function generateCustomWaypointId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rowToWaypoint(row: WaypointRow): Waypoint {
  return {
    id: row.id,
    trailId: row.trail_id,
    name: row.name,
    type: row.type,
    lat: row.lat,
    lon: row.lon,
    ele: row.ele,
    kmPosition: row.km_position,
    description: row.description,
  };
}

export class TrailDataService {
  constructor(private db: SQLiteDatabase) {}

  static async create(): Promise<TrailDataService> {
    const db = await getDatabase();
    return new TrailDataService(db);
  }

  async storeTrail(trail: Omit<Trail, 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.db.runAsync(
      `INSERT OR REPLACE INTO trails (id, name, short_name, region, length_km, metadata_json, data_version, is_custom, source_filename, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [trail.id, trail.name, trail.shortName, trail.region, trail.lengthKm, trail.metadataJson, trail.dataVersion, trail.isCustom ? 1 : 0, trail.sourceFilename]
    );
  }

  async getTrail(id: string): Promise<Trail | null> {
    const row = await this.db.getFirstAsync<TrailRow>(
      'SELECT * FROM trails WHERE id = ?',
      [id]
    );
    return row ? rowToTrail(row) : null;
  }

  async listTrails(): Promise<Trail[]> {
    const rows = await this.db.getAllAsync<TrailRow>(
      'SELECT * FROM trails ORDER BY is_custom ASC, CASE WHEN is_custom = 1 THEN created_at END DESC, name ASC'
    );
    return rows.map(rowToTrail);
  }

  async deleteTrail(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM trails WHERE id = ?', [id]);
  }

  async storeWaypoints(trailId: string, waypoints: Omit<Waypoint, 'id' | 'trailId'>[]): Promise<void> {
    await this.db.execAsync('BEGIN');
    try {
      await this.db.runAsync('DELETE FROM waypoints WHERE trail_id = ?', [trailId]);

      for (const wp of waypoints) {
        await this.db.runAsync(
          `INSERT INTO waypoints (trail_id, name, type, lat, lon, ele, km_position, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [trailId, wp.name, wp.type, wp.lat, wp.lon, wp.ele, wp.kmPosition, wp.description]
        );
      }
      await this.db.execAsync('COMMIT');
    } catch (e) {
      await this.db.execAsync('ROLLBACK');
      throw e;
    }
  }

  async getWaypoints(trailId: string): Promise<Waypoint[]> {
    const rows = await this.db.getAllAsync<WaypointRow>(
      'SELECT * FROM waypoints WHERE trail_id = ? ORDER BY km_position',
      [trailId]
    );
    return rows.map(rowToWaypoint);
  }

  /** Get full trail track data (config, track points, waypoints) from bundled JSON or custom trail storage */
  async getTrailTrackData(trailId: string): Promise<TrailJson | null> {
    // Check bundled data first
    const bundled = TRAIL_DATA[trailId];
    if (bundled) return bundled;

    // Check custom trail data in SQLite
    const row = await this.db.getFirstAsync<{ track_data_json: string | null }>(
      'SELECT track_data_json FROM trails WHERE id = ? AND is_custom = 1',
      [trailId]
    );
    if (row?.track_data_json) {
      return JSON.parse(row.track_data_json) as TrailJson;
    }

    return null;
  }

  /** Store custom trail track data as JSON */
  async storeCustomTrailData(trailId: string, trackData: TrailJson): Promise<void> {
    await this.db.runAsync(
      'UPDATE trails SET track_data_json = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [JSON.stringify(trackData), trailId]
    );
  }

  /** Update custom trail name and description */
  async updateCustomTrail(trailId: string, name: string, description?: string): Promise<void> {
    const shortName = name.length > 10 ? name.substring(0, 10).toUpperCase() : name.toUpperCase();

    // Update the trails table
    await this.db.runAsync(
      'UPDATE trails SET name = ?, short_name = ?, updated_at = datetime(\'now\') WHERE id = ? AND is_custom = 1',
      [name, shortName, trailId]
    );

    // Also update the track data JSON with the new name
    const row = await this.db.getFirstAsync<{ track_data_json: string | null }>(
      'SELECT track_data_json FROM trails WHERE id = ?',
      [trailId]
    );
    if (row?.track_data_json) {
      const data = JSON.parse(row.track_data_json) as TrailJson;
      data.config.name = name;
      data.config.shortName = shortName;
      if (description !== undefined) {
        (data as Record<string, unknown>).description = description;
      }
      await this.db.runAsync(
        'UPDATE trails SET track_data_json = ? WHERE id = ?',
        [JSON.stringify(data), trailId]
      );
    }
  }

  /** Get total storage used by custom trails in bytes (approximate) */
  async getCustomTrailStorageBytes(): Promise<number> {
    const row = await this.db.getFirstAsync<{ total: number }>(
      'SELECT COALESCE(SUM(LENGTH(track_data_json)), 0) as total FROM trails WHERE is_custom = 1'
    );
    return row?.total ?? 0;
  }

  /** List only custom trails */
  async listCustomTrails(): Promise<Trail[]> {
    const rows = await this.db.getAllAsync<TrailRow>(
      'SELECT * FROM trails WHERE is_custom = 1 ORDER BY created_at DESC'
    );
    return rows.map(rowToTrail);
  }

  // -------------------------------------------------------------------------
  // Custom waypoints (user-created, per-trail)
  // -------------------------------------------------------------------------

  /** Add a user-created waypoint. Returns the stored row (with generated id). */
  async addCustomWaypoint(wp: NewCustomWaypoint): Promise<CustomWaypoint> {
    const id = generateCustomWaypointId();
    const now = new Date().toISOString();
    const type = wp.type ?? 'water';

    await this.db.runAsync(
      `INSERT INTO custom_waypoints (id, trail_id, name, type, lat, lon, ele, km_position, off_track_m, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, wp.trailId, wp.name, type, wp.lat, wp.lon, wp.ele ?? null, wp.kmPosition, wp.offTrackM ?? null, wp.description ?? null, now, now]
    );

    return {
      id,
      trailId: wp.trailId,
      name: wp.name,
      type,
      lat: wp.lat,
      lon: wp.lon,
      ele: wp.ele ?? null,
      kmPosition: wp.kmPosition,
      offTrackM: wp.offTrackM ?? null,
      description: wp.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Get all custom waypoints for a trail, ordered along the trail. */
  async getCustomWaypoints(trailId: string): Promise<CustomWaypoint[]> {
    const rows = await this.db.getAllAsync<CustomWaypointRow>(
      'SELECT * FROM custom_waypoints WHERE trail_id = ? ORDER BY km_position',
      [trailId]
    );
    return rows.map(rowToCustomWaypoint);
  }

  /** Update editable fields of a custom waypoint. */
  async updateCustomWaypoint(id: string, updates: CustomWaypointUpdate): Promise<void> {
    const columnByField: Record<keyof CustomWaypointUpdate, string> = {
      name: 'name',
      type: 'type',
      lat: 'lat',
      lon: 'lon',
      ele: 'ele',
      kmPosition: 'km_position',
      offTrackM: 'off_track_m',
      description: 'description',
    };

    const setClauses: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [field, column] of Object.entries(columnByField) as [keyof CustomWaypointUpdate, string][]) {
      if (field in updates) {
        setClauses.push(`${column} = ?`);
        params.push(updates[field] ?? null);
      }
    }
    if (setClauses.length === 0) return;

    setClauses.push('updated_at = ?');
    params.push(new Date().toISOString());
    params.push(id);

    await this.db.runAsync(
      `UPDATE custom_waypoints SET ${setClauses.join(', ')} WHERE id = ?`,
      params
    );
  }

  /** Delete a custom waypoint by id. */
  async deleteCustomWaypoint(id: string): Promise<void> {
    await this.db.runAsync('DELETE FROM custom_waypoints WHERE id = ?', [id]);
  }
}
