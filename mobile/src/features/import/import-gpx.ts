/**
 * The GPX import flow, with no UI attached.
 *
 * Pick a file → read its text → run the shared ingestion pipeline → persist.
 * Every step is a plain async function so the screen (`app/import.tsx`) is only
 * responsible for rendering state, and so this can be unit-tested without a
 * renderer.
 *
 * Two mobile-specific constraints shape it:
 *
 * 1. **Hermes has no DOMParser**, so `importGpx` must be handed the
 *    fast-xml-parser adapter. That is the only reason this wrapper exists
 *    instead of the screen calling `@lib/gpx-import` directly — forgetting the
 *    adapter fails at runtime, not at compile time.
 * 2. **Ingestion is synchronous and CPU-bound.** A 60k-point file spends a
 *    noticeable time in `buildTrail`, and JS is single-threaded, so the stage
 *    label the user is reading would never paint. {@link yieldToUi} hands the
 *    thread back between stages so React can flush the label (and the spinner
 *    can animate) before the blocking work starts.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { importGpx, type ImportGpxResult, type ImportReport } from '@lib/gpx-import';
import { fxpXmlAdapter } from '@lib/xml-adapter-fxp';
import type { ProcessedTrail } from '@lib/trail-types';

import { getDatabase } from '../../db/database';
import { saveImportedTrail } from '../../services/imported-trail-store';
import type { TrailJson } from '../../services/trail-assets';

/** The name `@lib/gpx-import` falls back to when a file names nothing. */
const GENERIC_NAME = 'Imported trail';

/** Coarse progress, for the screen's status line. */
export type ImportStage = 'reading' | 'ingesting';

/** A file the user chose, already copied into the app's cache directory. */
export interface PickedGpxFile {
  /** `file://` URI — see `copyToCacheDirectory` below. */
  uri: string;
  /** Display name from the provider, e.g. `larapinta.gpx`. */
  fileName: string;
}

export interface ImportedGpx extends ImportGpxResult {
  /** Pre-filled name for the editable field: file name when the GPX names nothing. */
  suggestedName: string;
}

/**
 * Show the system document picker.
 *
 * The wildcard `type` is deliberate: Android content providers report `.gpx`
 * under at least `application/gpx+xml`, `application/xml`, `text/xml` and
 * `application/octet-stream` depending on which app wrote the file, and a
 * narrow MIME filter greys out exactly the file the user came to import. A
 * wrong file is caught immediately by the parser instead.
 *
 * `copyToCacheDirectory` is what turns an Android `content://` URI into a
 * `file://` one that `expo-file-system`'s `File` can read.
 *
 * Returns null when the user cancels.
 */
export async function pickGpxFile(): Promise<PickedGpxFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (result.canceled) return null;

  const asset = result.assets?.[0];
  if (!asset) return null;
  return { uri: asset.uri, fileName: asset.name ?? '' };
}

/**
 * Read and ingest a picked GPX file.
 *
 * @throws whatever `importGpx` throws (malformed XML, unparseable coordinates,
 * size caps, no track points) plus file-read errors — the screen renders the
 * message, since every one of them is something the user can act on.
 */
export async function importGpxFromUri(
  uri: string,
  options: { fileName?: string; onStage?: (stage: ImportStage) => void } = {},
): Promise<ImportedGpx> {
  options.onStage?.('reading');
  await yieldToUi();
  const text = await new File(uri).text();

  options.onStage?.('ingesting');
  await yieldToUi();
  const result = importGpx(text, { adapter: fxpXmlAdapter });

  return { ...result, suggestedName: suggestName(result.report, options.fileName) };
}

/**
 * Persist an imported trail under the (possibly user-edited) name.
 *
 * The name is written into `config` before saving because the registry row is
 * derived from `config` — see `saveImportedTrail`. That keeps the file and its
 * registry row incapable of disagreeing.
 *
 * @returns the trail id to navigate to.
 */
export async function saveImport(
  imported: Pick<ImportedGpx, 'trail' | 'report'>,
  name: string,
): Promise<string> {
  const trail = applyTrailName(imported.trail, name);
  const db = await getDatabase();
  await saveImportedTrail(db, trail as unknown as TrailJson, {
    hasElevation: imported.report.hasElevation,
    pointCount: imported.report.pointCount,
    waypointCount: imported.report.waypointCount,
  });
  return trail.config.id;
}

/**
 * Overwrite a built trail's display name, leaving its id (a content hash of the
 * source file) alone — renaming is not re-importing.
 */
export function applyTrailName(trail: ProcessedTrail, name: string): ProcessedTrail {
  const trimmed = name.trim() || GENERIC_NAME;
  return { ...trail, config: { ...trail.config, name: trimmed, shortName: trimmed } };
}

/**
 * What to pre-fill the name field with: whatever the GPX called itself, else
 * the file name minus its extension, else the generic fallback.
 */
export function suggestName(report: ImportReport, fileName?: string): string {
  if (report.name && report.name !== GENERIC_NAME) return report.name;
  const base = (fileName ?? '').replace(/\.[^./]+$/, '').trim();
  return base || GENERIC_NAME;
}

/**
 * Hand the JS thread back long enough for React to commit and paint.
 *
 * Two macrotask hops, not one: the first lets React flush the render that the
 * `onStage` callback just scheduled, the second lets that commit reach the
 * screen before the caller resumes with several hundred milliseconds of
 * blocking parse work. (`InteractionManager.runAfterInteractions` would be the
 * classic choice here, but it is deprecated as of RN 0.86 and warns on every
 * call.)
 */
export function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(() => setTimeout(resolve, 0), 0);
  });
}
