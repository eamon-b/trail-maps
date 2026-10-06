/**
 * Trail resolver — bundled trails, their over-the-air updates, catalog-only
 * trails, and user-imported ones.
 *
 * Tracknotes keeps waypoints and track geometry in trail JSON, never in SQLite.
 * This module is the single place that knows every source of that JSON:
 *
 * - **bundled** (`source: 'bundled'`): the shipped trails, resolved
 *   synchronously from the Metro `require()` map in `trail-assets` — unless a
 *   newer copy has been downloaded from the R2 catalog
 *   (`services/trail-data-updates`), which is then read from disk instead.
 *   The bundle is the seed and the offline fallback, never stale for long.
 * - **remote** (`source: 'remote'`): a trail published to the catalog after
 *   this build was made. Listed from the last catalog; its JSON is downloaded
 *   the first time the guide is opened (`GuideProvider`).
 * - **imported** (`source: 'imported'`): a user's GPX, ingested at runtime and
 *   written to `{documentDir}/trails/{id}.json` with a registry row in
 *   `imported_trails` (see `services/imported-trail-store.ts`).
 *
 * So the API comes in pairs: the sync functions (`listTrails`,
 * `getTrailJson`, `getTrailIndexEntry`, `hasTrail`) answer from memory — the
 * bundle and the small trail-data state file — and the async ones
 * (`listAllTrails`, `loadTrail`, `getTrailIndexEntryAsync`) span every source.
 * Prefer the async trio anywhere a non-bundled id can appear.
 *
 * {@link isServerKnown} is the server boundary: only bundled and catalog trail
 * ids exist in the comments API's allowlist and in `data/waypoint-ids.json`, so
 * anything that talks to the network must gate on it. An imported id must
 * never be sent.
 */

import { TRAIL_DATA, type TrailJson } from './trail-assets';
import { getDatabase } from '../db/database';
import { getImportedTrail, listImportedTrails } from '../db/imported-trails-repo';
import { readImportedTrail } from './imported-trail-store';
import {
  activeDownload,
  getRemoteTrail,
  listRemoteTrails,
  readDownloadedTrail,
  type RemoteTrailInfo,
} from './trail-data-updates';

export type { TrailJson } from './trail-assets';

/** Where a trail's JSON comes from. */
export type TrailSource = 'bundled' | 'remote' | 'imported';

export interface TrailIndexEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
  /** ISO time the trail's content last changed (bundled and remote only). */
  updatedAt?: string;
  /** Bundled by default — index.json predates imports and carries no field. */
  source: TrailSource;
  /**
   * Remote trails only: false until the JSON has been downloaded, i.e. the
   * guide needs a connection to open the first time.
   */
  downloaded?: boolean;
}

interface BundledIndexEntry {
  id: string;
  name: string;
  shortName: string;
  lengthKm: number;
  dataVersion?: string;
  updatedAt?: string;
}

const bundledIndex: readonly BundledIndexEntry[] = require('../../assets/trails/index.json');

function toIndexEntry(
  info: BundledIndexEntry,
  source: TrailSource,
  downloaded?: boolean,
): TrailIndexEntry {
  return {
    id: info.id,
    name: info.name,
    shortName: info.shortName,
    lengthKm: info.lengthKm,
    ...(info.dataVersion ? { dataVersion: info.dataVersion } : {}),
    ...(info.updatedAt ? { updatedAt: info.updatedAt } : {}),
    source,
    ...(downloaded === undefined ? {} : { downloaded }),
  };
}

function remoteIndexEntry(info: RemoteTrailInfo): TrailIndexEntry {
  return toIndexEntry(info, 'remote', info.downloaded);
}

/**
 * All bundled trails' index metadata, in bundle order. A trail with a newer
 * downloaded copy reports that copy's name and length.
 */
export function listTrails(): TrailIndexEntry[] {
  return bundledIndex.map((entry) => toIndexEntry(activeDownload(entry.id) ?? entry, 'bundled'));
}

/**
 * Index metadata for a bundled or catalog trail, or null. Synchronous: both
 * come from memory (the bundle, and the trail-data state file).
 */
export function getTrailIndexEntry(id: string): TrailIndexEntry | null {
  const bundled = bundledIndex.find((entry) => entry.id === id);
  if (bundled) return toIndexEntry(activeDownload(id) ?? bundled, 'bundled');
  const remote = getRemoteTrail(id);
  return remote ? remoteIndexEntry(remote) : null;
}

/** Whether a bundled trail with this id exists (downloaded updates aside). */
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

/**
 * The bundled trail JSON, synchronously — but only while it is the copy to
 * use. Null when the id is not bundled AND when a newer download supersedes the
 * bundle, so a caller holding a non-null result never shows outdated data;
 * such callers fall back to {@link loadTrail}.
 */
export function getTrailJson(id: string): TrailJson | null {
  if (activeDownload(id)) return null;
  return TRAIL_DATA[id] ?? null;
}

/**
 * The JSON shipped in this build, whatever has been downloaded since. For
 * callers that want something stable rather than current — the offline-pack
 * coverage table only needs each trail's rough bounds.
 */
export function getBundledTrailJson(id: string): TrailJson | null {
  return TRAIL_DATA[id] ?? null;
}

/**
 * Resolve a trail from any source: a newer downloaded copy first, then the
 * bundled require() map (a synchronous hit that never touches disk), then the
 * imported trail's JSON file.
 *
 * A downloaded copy that cannot be read falls through to the bundle — the
 * guide opens on older data rather than not at all. Returns null for an
 * unknown id, for a remote trail not downloaded yet, AND for a torn import
 * whose registry row outlived its file.
 */
export async function loadTrail(id: string): Promise<TrailJson | null> {
  const downloaded = await readDownloadedTrail(id);
  if (downloaded) return downloaded;
  const bundled = TRAIL_DATA[id];
  if (bundled) return bundled;
  return readImportedTrail(id);
}

/**
 * Every trail the app can list: bundled first (stable bundle order), then
 * catalog-only ones (catalog order), then imported ones newest-first.
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
  return [...listTrails(), ...listRemoteTrails().map(remoteIndexEntry), ...imported];
}

/**
 * Index metadata for a trail from either source — the async counterpart of
 * {@link getTrailIndexEntry}, for screens (headers, titles) that can be handed
 * an imported id.
 */
export async function getTrailIndexEntryAsync(id: string): Promise<TrailIndexEntry | null> {
  const known = getTrailIndexEntry(id);
  if (known) return known;

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
