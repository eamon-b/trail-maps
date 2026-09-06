/**
 * `data/trails/<dir>/pois.json` — the reviewable, committed home of a trail's
 * OpenStreetMap points of interest.
 *
 * POIs are deliberately NOT waypoints: they are uncurated OSM data, they carry
 * no `data/waypoint-ids.json` registry id, and they must survive a
 * `npm run build:trails` (which rewrites every `public/data/generated/*.json`
 * from scratch). So `scripts/fetch-pois.ts` writes them here, into the repo,
 * and `scripts/build-trails.ts` folds them into the generated JSON.
 *
 * File shape:
 *
 * ```json
 * {
 *   "source": "OpenStreetMap",
 *   "attribution": "© OpenStreetMap contributors (ODbL)",
 *   "fetchedAt": "2026-09-06T10:00:00.000Z",
 *   "searchRadiusKm": 2,
 *   "endpoint": "https://overpass-api.de/api/interpreter",
 *   "rejected": ["node/123456", "way/98765"],
 *   "pois": [ { "id": 123456, "type": "node", "category": "water", ... } ]
 * }
 * ```
 *
 * - `pois` holds **everything** the fetch found, rejections included, so a
 *   reviewer can see what was thrown away and why it keeps not coming back.
 * - `rejected` is hand-edited: a list of `poiKey` strings (`<type>/<id>`) that
 *   the build drops. A re-fetch reads the existing file and carries the list
 *   over verbatim, so review work is never lost to a refresh.
 * - Everything is sorted by `distanceAlongTrail` then key and written with
 *   stable 2-space JSON, so a re-fetch diff shows only what actually moved.
 */

import * as fs from 'fs';
import * as path from 'path';

import { poiKey } from '../../src/lib/trail-pois.js';
import type { TrailPOI } from '../../src/lib/trail-types.js';

/** The file name inside a `data/trails/<dir>` directory. */
export const POIS_FILENAME = 'pois.json';

/** Provenance defaults written into every fetched file. */
export const POI_SOURCE = 'OpenStreetMap';
export const POI_ATTRIBUTION = '© OpenStreetMap contributors (ODbL)';

/** The serialized form of `data/trails/<dir>/pois.json`. */
export interface TrailPOIFile {
  source: string;
  attribution: string;
  /** ISO timestamp of the fetch that produced `pois`. */
  fetchedAt: string;
  /** Corridor half-width used for the fetch, km. */
  searchRadiusKm: number;
  /** Overpass instance the fetch used. */
  endpoint: string;
  /** Hand-edited `<type>/<id>` keys the build must drop. Order is preserved. */
  rejected: string[];
  /** Everything found, rejected entries included. Sorted by trail km, then key. */
  pois: TrailPOI[];
}

/** The filesystem calls these helpers make. Injectable so tests need no disk. */
export interface PoiFileIO {
  existsSync(filePath: string): boolean;
  readFileSync(filePath: string, encoding: 'utf-8'): string;
}

const NODE_IO: PoiFileIO = {
  existsSync: fs.existsSync,
  readFileSync: (filePath, encoding) => fs.readFileSync(filePath, encoding),
};

/** Where a trail directory's POI file lives. */
export function trailPOIPath(trailDir: string): string {
  return path.join(trailDir, POIS_FILENAME);
}

/** Sort POIs by distance along the trail, ties broken by key, so the order is total. */
export function sortTrailPOIs(pois: TrailPOI[]): TrailPOI[] {
  return [...pois].sort((a, b) => {
    const byDistance = a.distanceAlongTrail - b.distanceAlongTrail;
    if (byDistance !== 0 && Number.isFinite(byDistance)) {
      return byDistance;
    }
    return poiKey(a) < poiKey(b) ? -1 : poiKey(a) > poiKey(b) ? 1 : 0;
  });
}

function fail(filePath: string, detail: string): never {
  throw new Error(`Invalid POI file ${filePath}: ${detail}`);
}

function isPOI(value: unknown): value is TrailPOI {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const poi = value as Record<string, unknown>;
  return (
    typeof poi.id === 'number' &&
    typeof poi.type === 'string' &&
    typeof poi.category === 'string' &&
    typeof poi.lat === 'number' &&
    typeof poi.lon === 'number' &&
    typeof poi.distanceAlongTrail === 'number' &&
    typeof poi.distanceFromTrail === 'number'
  );
}

/**
 * Parse a POI file's text. Throws an error naming `filePath` for anything
 * malformed — these files are hand-edited, so a bad `rejected` entry must stop
 * the build loudly rather than silently un-reject a POI.
 */
export function parseTrailPOIFile(text: string, filePath: string): TrailPOIFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(filePath, error instanceof Error ? error.message : 'could not be parsed as JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(filePath, 'expected a JSON object at the top level');
  }
  const file = raw as Record<string, unknown>;

  if (!Array.isArray(file.pois)) {
    fail(filePath, 'expected a "pois" array');
  }
  for (const [index, poi] of file.pois.entries()) {
    if (!isPOI(poi)) {
      fail(
        filePath,
        `pois[${index}] is not a POI (needs id, type, category, lat, lon, distanceAlongTrail, distanceFromTrail)`
      );
    }
  }

  const rejected = file.rejected ?? [];
  if (!Array.isArray(rejected) || rejected.some(entry => typeof entry !== 'string')) {
    fail(filePath, 'expected "rejected" to be an array of "<type>/<id>" strings');
  }

  return {
    source: typeof file.source === 'string' ? file.source : POI_SOURCE,
    attribution: typeof file.attribution === 'string' ? file.attribution : POI_ATTRIBUTION,
    fetchedAt: typeof file.fetchedAt === 'string' ? file.fetchedAt : '',
    searchRadiusKm: typeof file.searchRadiusKm === 'number' ? file.searchRadiusKm : NaN,
    endpoint: typeof file.endpoint === 'string' ? file.endpoint : '',
    rejected: rejected as string[],
    pois: file.pois as TrailPOI[],
  };
}

/** The POIs the build should publish: everything except the rejected keys, sorted. */
export function poisForBuild(file: TrailPOIFile): TrailPOI[] {
  const rejected = new Set(file.rejected);
  return sortTrailPOIs(file.pois.filter(poi => !rejected.has(poiKey(poi))));
}

/** Read a trail directory's POI file, or null when it has none. */
export function readTrailPOIFile(trailDir: string, io: PoiFileIO = NODE_IO): TrailPOIFile | null {
  const filePath = trailPOIPath(trailDir);
  if (!io.existsSync(filePath)) {
    return null;
  }
  return parseTrailPOIFile(io.readFileSync(filePath, 'utf-8'), filePath);
}

/**
 * The POIs `build-trails` should attach to a trail, or null when the trail has
 * no POI file (in which case the generated JSON gets no `pois` key at all).
 */
export function readTrailPOIsForBuild(
  trailDir: string,
  io: PoiFileIO = NODE_IO
): TrailPOI[] | null {
  const file = readTrailPOIFile(trailDir, io);
  return file === null ? null : poisForBuild(file);
}

/**
 * Build the file to write after a fetch, carrying the existing hand-edited
 * `rejected` list over unchanged.
 */
export function buildTrailPOIFile(options: {
  existing: TrailPOIFile | null;
  pois: TrailPOI[];
  fetchedAt: string;
  searchRadiusKm: number;
  endpoint: string;
}): TrailPOIFile {
  return {
    source: POI_SOURCE,
    attribution: POI_ATTRIBUTION,
    fetchedAt: options.fetchedAt,
    searchRadiusKm: options.searchRadiusKm,
    endpoint: options.endpoint,
    rejected: [...(options.existing?.rejected ?? [])],
    pois: sortTrailPOIs(options.pois),
  };
}

/** Stable 2-space JSON with a trailing newline, so re-fetch diffs stay readable. */
export function stringifyTrailPOIFile(file: TrailPOIFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Write a trail directory's POI file. */
export function writeTrailPOIFile(trailDir: string, file: TrailPOIFile): string {
  const filePath = trailPOIPath(trailDir);
  fs.writeFileSync(filePath, stringifyTrailPOIFile(file));
  return filePath;
}
