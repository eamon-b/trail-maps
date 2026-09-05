import * as fs from 'fs';
import * as path from 'path';

/**
 * Curated waypoint descriptions for the trail build pipeline.
 *
 * Two channels carry curated prose to the app, and they share a key space:
 *
 *  - **Bundled** — this file's `descriptions.json`, applied to the built trail
 *    JSON so the text ships inside the app bundle and works offline.
 *  - **Synced** — the `waypoint_descriptions` table in the comments API, read
 *    by mobile over `GET /v1/trails/:trailId/descriptions?since=` and rendered
 *    with precedence `synced ?? bundled`.
 *
 * Both are keyed by the stable waypoint id from `data/waypoint-ids.json`, so
 * the same authored file can seed the bundle (here) and be pushed to D1 later
 * with `scripts/upload-descriptions.ts` — no second copy of the prose.
 *
 * Editing: a trail's file lives at `data/trails/<trail>/descriptions.json`.
 * It is optional; trails without one build exactly as before.
 *
 * Voice: descriptions state what is there — facilities, water and its source,
 * seasonality, access, history — and stop at the facts. They do not instruct
 * the walker ("treat the water", "fill up here", "check before you rely on
 * it", "carry enough for the night") or address them in the second person.
 * Deciding where to camp and how much water to carry is the walker's, not
 * ours; the text's job is to give them what they need to decide.
 */

/** Filename looked up inside each trail directory. */
export const DESCRIPTIONS_FILENAME = 'descriptions.json';

/**
 * Longest description accepted. Mirrors `MAX_DESCRIPTION_LEN` in
 * `workers/comments-api/src/validation.ts` so anything that builds can also be
 * uploaded — a bundled description the admin endpoint would reject with a 400
 * is a trap we'd only discover at upload time.
 */
export const MAX_DESCRIPTION_LENGTH = 4000;

/** Same id shape the registry mints and the comments API validates. */
const WAYPOINT_ID_PATTERN = /^[a-z0-9_-]{4,64}$/;

/** One authored description. `name` is an editing aid; the build ignores it. */
export interface CuratedDescription {
  waypointId: string;
  /** Human-readable waypoint name, so the file is reviewable without a lookup. */
  name?: string;
  description: string;
}

/** Shape of a `descriptions.json` file. */
export interface CuratedDescriptionsFile {
  trailId: string;
  /** Free-text editor note; ignored by the build. */
  note?: string;
  descriptions: CuratedDescription[];
}

/** Minimal waypoint shape needed to attach a curated description. */
export interface DescribableWaypoint {
  id?: string;
  description?: string;
}

/** Result of applying a description set to a waypoint list. */
export interface ApplyDescriptionsResult {
  /** How many waypoints had their description set. */
  applied: number;
  /** Authored ids that matched no waypoint (stale after a data change). */
  unmatchedIds: string[];
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

/**
 * Validate a parsed `descriptions.json` payload and return its entries.
 *
 * Strict on purpose: a typo'd id silently produces a waypoint with no prose,
 * which is invisible until someone opens that waypoint on a phone.
 */
export function parseCuratedDescriptions(
  raw: unknown,
  expectedTrailId: string,
  source: string
): CuratedDescription[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(source, 'expected a JSON object');
  }
  const file = raw as Partial<CuratedDescriptionsFile>;

  if (typeof file.trailId !== 'string' || file.trailId.length === 0) {
    fail(source, 'missing "trailId"');
  }
  if (file.trailId !== expectedTrailId) {
    fail(source, `"trailId" is "${file.trailId}" but the trail directory builds "${expectedTrailId}"`);
  }
  if (!Array.isArray(file.descriptions)) {
    fail(source, 'missing "descriptions" array');
  }

  const seen = new Set<string>();
  return file.descriptions.map((entry, index) => {
    const where = `descriptions[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail(source, `${where} must be an object`);
    }
    const { waypointId, name, description } = entry as Partial<CuratedDescription>;

    if (typeof waypointId !== 'string' || !WAYPOINT_ID_PATTERN.test(waypointId)) {
      fail(source, `${where} has an invalid "waypointId" (expected ${WAYPOINT_ID_PATTERN})`);
    }
    if (seen.has(waypointId)) {
      fail(source, `${where} repeats waypointId "${waypointId}"`);
    }
    seen.add(waypointId);

    if (name !== undefined && typeof name !== 'string') {
      fail(source, `${where} ("${waypointId}") has a non-string "name"`);
    }
    if (typeof description !== 'string') {
      fail(source, `${where} ("${waypointId}") is missing "description"`);
    }
    const trimmed = description.trim();
    if (trimmed.length === 0) {
      // The API models a cleared description as a tombstone row; in bundled
      // data the equivalent is simply not listing the waypoint.
      fail(source, `${where} ("${waypointId}") has an empty "description" — delete the entry instead`);
    }
    if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
      fail(
        source,
        `${where} ("${waypointId}") is ${trimmed.length} characters; the API caps descriptions at ${MAX_DESCRIPTION_LENGTH}`
      );
    }

    return { waypointId, ...(name === undefined ? {} : { name }), description: trimmed };
  });
}

/**
 * Load `<trailDir>/descriptions.json` if it exists. Returns `[]` when the trail
 * has no curated content; throws when the file exists but is malformed.
 */
export function loadCuratedDescriptions(trailDir: string, trailId: string): CuratedDescription[] {
  const filePath = path.join(trailDir, DESCRIPTIONS_FILENAME);
  if (!fs.existsSync(filePath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`${filePath}: invalid JSON — ${(error as Error).message}`);
  }
  return parseCuratedDescriptions(raw, trailId, filePath);
}

/**
 * Overwrite waypoint descriptions with the curated text, matching on stable id.
 *
 * Curated prose wins over whatever the GPX/CalTopo source carried: source
 * descriptions are terse fragments ("With general store and caravan park.")
 * that the curated pass is meant to replace.
 *
 * Mutates in place, and must run after ids are assigned but before the waypoint
 * list is split into main / variant / off-trail views — those views copy from
 * these same objects, so one pass here reaches every place a waypoint surfaces.
 */
export function applyCuratedDescriptions(
  waypoints: DescribableWaypoint[],
  descriptions: CuratedDescription[]
): ApplyDescriptionsResult {
  const byId = new Map(descriptions.map(d => [d.waypointId, d.description]));
  const matched = new Set<string>();
  let applied = 0;

  for (const waypoint of waypoints) {
    if (!waypoint.id) continue;
    const text = byId.get(waypoint.id);
    if (text === undefined) continue;
    waypoint.description = text;
    matched.add(waypoint.id);
    applied++;
  }

  return {
    applied,
    unmatchedIds: descriptions.map(d => d.waypointId).filter(id => !matched.has(id)),
  };
}
