import type { SQLiteDatabase } from 'expo-sqlite';
import { getDatabase } from '../db/database';

export interface Trail {
  id: string;
  name: string;
  shortName: string | null;
  region: string | null;
  lengthKm: number | null;
  metadataJson: string | null;
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
      `INSERT OR REPLACE INTO trails (id, name, short_name, region, length_km, metadata_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      [trail.id, trail.name, trail.shortName, trail.region, trail.lengthKm, trail.metadataJson]
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
      'SELECT * FROM trails ORDER BY name'
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
}
