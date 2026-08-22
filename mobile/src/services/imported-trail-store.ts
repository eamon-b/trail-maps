/**
 * On-disk store for user-imported GPX trails.
 *
 * Layout mirrors the tiles pattern — **disk is truth, SQLite is the view**:
 *
 *   {documentDir}/trails/{id}.json   the full ProcessedTrail/TrailJson payload
 *   imported_trails row              name / length / counts, for cheap listing
 *
 * A full-resolution track is hundreds of kilobytes; that never belongs in a
 * SQLite row (Tracknotes deliberately has no `trails` table — bundled trail
 * content is a Metro `require()` map, imported trail content is a file here).
 *
 * Write/delete ordering is chosen so a crash mid-operation leaves the recoverable
 * state, never a broken guide:
 *   - save:   FILE first, ROW second — a torn save leaves an orphan file, which
 *             is invisible to the UI and overwritten by the next import of the
 *             same content (the id is a content hash).
 *   - delete: ROW first, FILE second — a torn delete leaves an orphan file, not
 *             a listed guide whose data is gone.
 * The reverse orderings would produce a registry row pointing at nothing, i.e.
 * a guide that lists fine and then fails to open.
 */

import { Directory, File, Paths } from 'expo-file-system';

import type { SqlDatabase } from '../db/sql-database';
import {
  deleteImportedTrail,
  upsertImportedTrail,
  type ImportedTrail,
} from '../db/imported-trails-repo';
import { usePlanInputsStore } from '../features/plan/plan-inputs-store';
import type { TrailJson } from './trail-assets';

/** Root directory for imported trail JSON: {documentDir}/trails/ */
export function importedTrailsRoot(): Directory {
  return new Directory(Paths.document, 'trails');
}

/**
 * The only id shape allowed to become a path.
 *
 * Trail ids reach this module from two places: `@lib/gpx-import`, which mints
 * `u_<base36>`, and `@lib/trail-handoff`, which reads a `.tracknotes.json` that
 * arrived from a share sheet — i.e. from whoever sent it. That parser already
 * re-mints anything which is not a well-formed `u_` id, so this is the second
 * lock on the same door: the id is interpolated straight into a file name, and
 * a `..` or a `/` in it would write outside {documentDir}/trails.
 */
const SAFE_TRAIL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Path to one imported trail's JSON: {documentDir}/trails/{id}.json */
export function importedTrailFile(id: string): File {
  if (!SAFE_TRAIL_ID.test(id)) {
    throw new Error(`Refusing to use "${id}" as a trail file name.`);
  }
  return new File(importedTrailsRoot(), `${id}.json`);
}

/** Data-quality facts recorded on the registry row at import time. */
export interface ImportedTrailMeta {
  /** False when the source GPX carried no usable `<ele>` data. */
  hasElevation: boolean;
  /** Full-resolution track point count. */
  pointCount: number;
  /** Waypoint count. */
  waypointCount: number;
}

/**
 * Persist an imported trail: JSON to disk, then its registry row.
 *
 * Identity (`id`, `name`, `shortName`, `lengthKm`) is read off the trail's own
 * `config` — the importer is the single place that mints those, so the registry
 * can never disagree with the file it describes.
 */
export async function saveImportedTrail(
  db: SqlDatabase,
  trail: TrailJson,
  meta: ImportedTrailMeta,
): Promise<void> {
  const root = importedTrailsRoot();
  if (!root.exists) root.create({ intermediates: true, idempotent: true });

  // `write` truncates, so re-importing the same file is idempotent.
  importedTrailFile(trail.config.id).write(JSON.stringify(trail));

  await upsertImportedTrail(db, {
    id: trail.config.id,
    name: trail.config.name,
    shortName: trail.config.shortName,
    lengthKm: trail.config.lengthKm,
    hasElevation: meta.hasElevation,
    pointCount: meta.pointCount,
    waypointCount: meta.waypointCount,
  });
}

/**
 * Read an imported trail's JSON from disk.
 *
 * Returns null for a missing OR unparseable file rather than throwing: a torn
 * write and a deleted file are the same thing to every caller (show
 * "not found"), and a guide screen crashing on malformed JSON would be strictly
 * worse than the empty state. An id that isn't path-safe is "no such trail" too
 * — `loadTrail` is reached with a raw route param, which nothing has vetted.
 */
export async function readImportedTrail(id: string): Promise<TrailJson | null> {
  let file: File;
  try {
    file = importedTrailFile(id);
  } catch {
    return null;
  }
  if (!file.exists) return null;
  try {
    return JSON.parse(await file.text()) as TrailJson;
  } catch {
    return null;
  }
}

/**
 * Delete an imported trail and everything local that referenced it.
 *
 * Registry row + the manual SQL cascade first (favorites, routes/route_points,
 * sync_state, comments, outbox, waypoint_meta — see `imported-trails-repo`),
 * then the JSON file, then the plan-inputs preference entry.
 *
 * Deleting a bundled trail id is a no-op on the file/registry side (there is no
 * row and no file), so callers don't have to pre-check the source.
 */
export async function deleteImportedTrailEverywhere(
  db: SqlDatabase,
  id: string,
): Promise<void> {
  await deleteImportedTrail(db, id);

  const file = importedTrailFile(id);
  if (file.exists) file.delete();

  usePlanInputsStore.getState().clearTrail(id);
}

export type { ImportedTrail };
