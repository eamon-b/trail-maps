/**
 * The file import flow, with no UI attached.
 *
 * Pick a file → read its text → run the shared ingestion pipeline → persist.
 * Every step is a plain async function so the screen (`app/import.tsx`) is only
 * responsible for rendering state, and so this can be unit-tested without a
 * renderer.
 *
 * Two file formats arrive here and both end at the same review screen:
 *
 * - **GPX**, the general case — parsed and ingested by `@lib/gpx-import`.
 * - **`.tracknotes.json`**, the web → mobile handoff — a trail that was already
 *   ingested in the browser, read back by `@lib/trail-handoff`. No re-ingestion
 *   happens: both ends speak {@link ProcessedTrail}, so the phone gets exactly
 *   the trail the browser showed.
 *
 * {@link detectImportFormat} picks the branch, and the handoff branch
 * synthesizes an {@link ImportReport} so `app/import.tsx` never has to know
 * which one it got.
 *
 * Two mobile-specific constraints shape the rest:
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
import {
  handoffImportReport,
  looksLikeHandoffJson,
  parseHandoffJson,
} from '@lib/trail-handoff';
import { fxpXmlAdapter } from '@lib/xml-adapter-fxp';
import type { ProcessedTrail } from '@lib/trail-types';

import { getDatabase } from '../../db/database';
import { saveImportedTrail } from '../../services/imported-trail-store';
import type { TrailJson } from '../../services/trail-assets';

/** The name `@lib/gpx-import` falls back to when a file names nothing. */
const GENERIC_NAME = 'Imported trail';

/**
 * Largest file this app will read into memory, in bytes.
 *
 * `@lib/gpx-parser`'s own cap is 50 MB, which is a *desktop* number and — more
 * to the point — is checked one frame too late: by the time `parseGpx` sees the
 * string, the whole file has already been read. Reading 50 MB of UTF-8 produces
 * a ~100 MB JS string before fast-xml-parser's validate and parse passes each
 * walk it again, which is an out-of-memory kill on a mid-range phone rather
 * than an error message.
 *
 * 20 MB comfortably clears a verbose 100k-point Garmin track (extensions,
 * heart rate, cadence) — the point cap below is what actually bounds the
 * interesting case — while keeping peak memory in a range a phone survives.
 */
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/**
 * Caps handed to the shared parser, rather than letting it use its web
 * defaults. `maxPointCount` matches `GPX_MAX_POINT_COUNT`; it is restated here
 * so the mobile budget is visible at the call site rather than inherited.
 */
const MOBILE_PARSE_LIMITS = { maxFileSize: MAX_IMPORT_BYTES, maxPointCount: 100000 };

/** Human-readable megabytes, for the size-cap message. */
function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Coarse progress, for the screen's status line. */
export type ImportStage = 'reading' | 'ingesting';

/** Which reader a file's bytes should go through. */
export type ImportFormat = 'gpx' | 'handoff';

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
 * wrong file is caught immediately by the parser instead. The wildcard is also
 * what lets a `.tracknotes.json` handoff file through without a second picker
 * or a MIME list that would have to enumerate `application/json` too.
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
 * Decide how to read a file's bytes.
 *
 * The file name wins when it carries a usable extension, because it is the
 * cheap and unambiguous signal. It often carries nothing, though: an Android
 * `content://` URI handed over by a share sheet frequently resolves to an
 * opaque document id with no extension at all, so the text itself has to
 * decide, and "starts with `{`" separates the two formats cleanly (a GPX file
 * always starts with `<`).
 *
 * Note the asymmetry — a `.json` name is trusted, but an unrecognised name
 * falls through to GPX. GPX is the format users actually have, and its parser
 * produces a far better error message for a wrong file than the JSON one does.
 */
export function detectImportFormat(fileName: string | undefined, text: string): ImportFormat {
  const name = (fileName ?? '').trim().toLowerCase();
  if (name.endsWith('.gpx')) return 'gpx';
  if (name.endsWith('.json')) return 'handoff';
  return looksLikeHandoffJson(text) ? 'handoff' : 'gpx';
}

/**
 * Read and ingest a picked file — a GPX track or a `.tracknotes.json` handoff.
 *
 * Named for GPX because that is the overwhelmingly common case and because
 * `app/import.tsx` calls it by this name; {@link detectImportFormat} decides
 * what actually happens to the bytes.
 *
 * @throws whatever `importGpx` throws (malformed XML, unparseable coordinates,
 * size caps, no track points) or `parseHandoffJson` throws (wrong format, a
 * future file version, malformed track points), plus file-read errors — the
 * screen renders the message, since every one of them is something the user can
 * act on.
 */
export async function importGpxFromUri(
  uri: string,
  options: { fileName?: string; onStage?: (stage: ImportStage) => void } = {},
): Promise<ImportedGpx> {
  options.onStage?.('reading');
  await yieldToUi();

  // Before the read, not after: the point of the cap is to never hold the
  // bytes. `size` is 0 for a file the OS won't tell us about, which reads as
  // "under the cap" and lets the parser's own limits have the last word.
  const file = new File(uri);
  const size = file.size ?? 0;
  if (size > MAX_IMPORT_BYTES) {
    throw new Error(
      `That file is ${megabytes(size)} — the limit is ${megabytes(MAX_IMPORT_BYTES)}.`,
    );
  }
  const text = await file.text();

  options.onStage?.('ingesting');
  await yieldToUi();
  const result = ingestText(text, detectImportFormat(options.fileName, text));

  return { ...result, suggestedName: suggestName(result.report, options.fileName) };
}

/** Format dispatch, split out so both branches are visible side by side. */
function ingestText(text: string, format: ImportFormat): ImportGpxResult {
  if (format === 'handoff') {
    // Already ingested on the other device: no parsing, no simplification, no
    // elevation cleaning — just validation and a report describing what landed.
    const trail = parseHandoffJson(text);
    return { trail, report: handoffImportReport(trail) };
  }
  return importGpx(text, { adapter: fxpXmlAdapter, limits: MOBILE_PARSE_LIMITS });
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
