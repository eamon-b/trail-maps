/**
 * Bundled trail resolver.
 *
 * Tracknotes keeps waypoints and track geometry in the bundled trail JSON —
 * there is no `trails` SQLite table. This module resolves a bundled trail's
 * JSON (and its index metadata) by id, straight from the require() map in
 * trail-assets. Custom (user-imported) trails are not supported.
 */

import { TRAIL_DATA, type TrailJson } from './trail-assets';

export type { TrailJson } from './trail-assets';

export interface TrailIndexEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
}

const trailIndex: TrailIndexEntry[] = require('../../assets/trails/index.json');

/** All bundled trails' index metadata, in bundle order. */
export function listTrails(): TrailIndexEntry[] {
  return trailIndex;
}

/** Index metadata for one trail, or null if the id is unknown. */
export function getTrailIndexEntry(id: string): TrailIndexEntry | null {
  return trailIndex.find((entry) => entry.id === id) ?? null;
}

/** Whether a bundled trail with this id exists. */
export function hasTrail(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRAIL_DATA, id);
}

/** Resolve the full bundled trail JSON by id, or null if not bundled. */
export function getTrailJson(id: string): TrailJson | null {
  return TRAIL_DATA[id] ?? null;
}
