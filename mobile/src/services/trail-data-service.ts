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
    await this.db.runAsync('DELETE FROM waypoints WHERE trail_id = ?', [trailId]);

    for (const wp of waypoints) {
      await this.db.runAsync(
        `INSERT INTO waypoints (trail_id, name, type, lat, lon, ele, km_position, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [trailId, wp.name, wp.type, wp.lat, wp.lon, wp.ele, wp.kmPosition, wp.description]
      );
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
}
