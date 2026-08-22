/**
 * Trail resolver — bundled trails plus user-imported ones.
 *
 * Tracknotes keeps waypoints and track geometry in trail JSON, never in SQLite.
 * There are two sources for that JSON and this module is the single place that
 * knows about both:
 *
 * - **bundled** (`source: 'bundled'`): the six shipped trails, resolved
 *   synchronously from the Metro `require()` map in `trail-assets`.
 * - **imported** (`source: 'imported'`): a user's GPX, ingested at runtime and
 *   written to `{documentDir}/trails/{id}.json` with a registry row in
 *   `imported_trails` (see `services/imported-trail-store.ts`). Reading one is
 *   asynchronous — a file read plus a SQLite query.
 *
 * So the API comes in pairs: the sync bundled-only functions (`listTrails`,
 * `getTrailJson`, `getTrailIndexEntry`, `hasTrail`) stay for callers that
 * genuinely only mean bundled data, and the async ones (`listAllTrails`,
 * `loadTrail`, `getTrailIndexEntryAsync`) span both sources. Prefer the async
 * trio anywhere a user-imported id can appear.
 *
 * {@link isServerKnown} is the server boundary: only bundled trail ids exist in
 * the comments API's allowlist and in `data/waypoint-ids.json`, so anything that
 * talks to the network must gate on it. An imported id must never be sent.
 */

import { TRAIL_DATA, type TrailJson } from './trail-assets';
import { getDatabase } from '../db/database';
import { getImportedTrail, listImportedTrails } from '../db/imported-trails-repo';
import { readImportedTrail } from './imported-trail-store';

export type { TrailJson } from './trail-assets';

/** Where a trail's JSON comes from. */
export type TrailSource = 'bundled' | 'imported';

export interface TrailIndexEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
  /** Bundled by default — index.json predates imports and carries no field. */
  source: TrailSource;
}

const trailIndex: TrailIndexEntry[] = (
  require('../../assets/trails/index.json') as Omit<TrailIndexEntry, 'source'>[]
).map((entry) => ({ ...entry, source: 'bundled' as const }));

/** All bundled trails' index metadata, in bundle order. */
export function listTrails(): TrailIndexEntry[] {
  return trailIndex;
}

/** Index metadata for one BUNDLED trail, or null if the id is not bundled. */
export function getTrailIndexEntry(id: string): TrailIndexEntry | null {
  return trailIndex.find((entry) => entry.id === id) ?? null;
}

/** Whether a bundled trail with this id exists. */
export function hasTrail(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(TRAIL_DATA, id);
}

/**
 * The server boundary — implemented in `services/server-trails` and re-exported
 * here so callers already talking to the loader keep one import, while the sync
 * engine can gate on it without dragging the bundled JSON, `expo-file-system`
 * and SQLite into its module graph.
 */
export { isServerKnown } from './server-trails';

/** Resolve the full bundled trail JSON by id, or null if not bundled. */
export function getTrailJson(id: string): TrailJson | null {
  return TRAIL_DATA[id] ?? null;
}

/**
 * Resolve a trail from either source: the bundled require() map first (a
 * synchronous hit that never touches disk), otherwise the imported trail's
 * JSON file.
 *
 * Returns null for an unknown id AND for a torn import whose registry row
 * outlived its file — both are "no such guide" to every caller.
 */
export async function loadTrail(id: string): Promise<TrailJson | null> {
  const bundled = getTrailJson(id);
  if (bundled) return bundled;
  return readImportedTrail(id);
}

/**
 * Every trail the app can open: bundled first (stable bundle order), then
 * imported ones newest-first.
 *
 * A database failure degrades to the bundled list rather than an empty guide
 * list — the shipped trails are readable with no database at all, and a broken
 * registry must not take them down with it.
 */
export async function listAllTrails(): Promise<TrailIndexEntry[]> {
  let imported: TrailIndexEntry[] = [];
  try {
    const db = await getDatabase();
    imported = (await listImportedTrails(db)).map((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      lengthKm: row.lengthKm,
      source: 'imported' as const,
    }));
  } catch {
    imported = [];
  }
  return [...trailIndex, ...imported];
}

/**
 * Index metadata for a trail from either source — the async counterpart of
 * {@link getTrailIndexEntry}, for screens (headers, titles) that can be handed
 * an imported id.
 */
export async function getTrailIndexEntryAsync(id: string): Promise<TrailIndexEntry | null> {
  const bundled = getTrailIndexEntry(id);
  if (bundled) return bundled;

  try {
    const db = await getDatabase();
    const row = await getImportedTrail(db, id);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      lengthKm: row.lengthKm,
      source: 'imported',
    };
  } catch {
    return null;
  }
}
