import { createHash } from 'crypto';
import { haversineDistance } from '../../src/lib/distance';

/**
 * Stable waypoint IDs for the trail build pipeline.
 *
 * Bundled trail waypoints have no intrinsic identity — they come from parsed
 * GPX `<wpt>` elements and clients otherwise synthesise positional `wp-${i}`
 * ids that shift whenever the source data is re-simplified. Server-side
 * features (e.g. comments) need ids that survive trail-data rebuilds.
 *
 * Design: deterministic mint + committed registry (`data/waypoint-ids.json`).
 * On each build every produced waypoint is matched against a committed
 * registry of prior ids by proximity (same type, within {@link MATCH_RADIUS_METERS}).
 * Matches reuse the stored id (and refresh the stored coordinates so slow drift
 * is tracked); unmatched waypoints mint a new deterministic id and append an
 * entry. Entries are never deleted, so retired waypoints keep their ids.
 */

/** Max distance (metres) a built waypoint may be from a registry entry to be
 * considered the same waypoint. */
export const MATCH_RADIUS_METERS = 100;

/** Ids must be URL/comment-safe and reasonably short. */
export const ID_PATTERN = /^[a-z0-9_-]{4,64}$/;

/** A single committed registry entry. */
export interface WaypointRegistryEntry {
  id: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
}

/** The registry file shape: trailId -> list of entries. */
export type WaypointRegistry = Record<string, WaypointRegistryEntry[]>;

/** Minimal shape of a built waypoint needed to assign an id. */
export interface WaypointForId {
  name: string;
  type: string;
  lat: number;
  lon: number;
}

function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

/**
 * Mint a deterministic id for a waypoint. Uses an 8-hex-char sha1 slice by
 * default, extending to 12 chars if the short form already exists in the
 * registry (collision). Throws if even the 12-char form collides.
 */
function mintId(
  trailId: string,
  wp: WaypointForId,
  existingIds: Set<string>,
): string {
  const basis = `${trailId}|${wp.type}|${wp.lat.toFixed(5)}|${wp.lon.toFixed(5)}`;
  const hex = sha1Hex(basis);
  let id = `w_${hex.slice(0, 8)}`;
  if (existingIds.has(id)) {
    id = `w_${hex.slice(0, 12)}`;
    if (existingIds.has(id)) {
      throw new Error(
        `Waypoint id collision for "${wp.name}" (${basis}): both the 8- and ` +
          `12-hex forms are already claimed. Widen the mint hash length.`,
      );
    }
  }
  if (!ID_PATTERN.test(id)) {
    throw new Error(`Minted waypoint id "${id}" does not match ${ID_PATTERN}`);
  }
  return id;
}

interface Candidate {
  entryIndex: number;
  exactName: boolean;
  distance: number;
  id: string;
}

/**
 * Assign a stable id to each built waypoint, mutating `registry` in place.
 *
 * For each waypoint (in input order):
 *  - Find unclaimed registry entries of the same `type` within
 *    {@link MATCH_RADIUS_METERS}. Rank them by exact name match, then by
 *    proximity, then by id (deterministic tie-break).
 *  - Match → reuse the entry's id and refresh its stored name/lat/lon.
 *  - No candidate entries at all → mint a new id and append an entry.
 *  - Had candidate entries but every one was already claimed by another
 *    built waypoint this run → throw (ambiguous identity; needs a human).
 *
 * Returns ids parallel to `waypoints`.
 */
export function assignWaypointIds(
  trailId: string,
  waypoints: WaypointForId[],
  registry: WaypointRegistry,
): string[] {
  const entries = registry[trailId] ?? (registry[trailId] = []);
  const existingIds = new Set(entries.map((e) => e.id));
  // Only entries that already existed in the committed registry are match
  // candidates. Entries minted during this run belong solely to the waypoint
  // that minted them, so two genuinely-distinct waypoints sitting within the
  // match radius of each other (e.g. "Big River 1" / "Big River 2") each mint
  // their own id on a first build instead of colliding.
  const initialEntryCount = entries.length;
  // entryIndex -> waypoint index that claimed it
  const claimedBy = new Map<number, number>();
  const results: string[] = new Array(waypoints.length);

  waypoints.forEach((wp, wpIndex) => {
    // Gather candidate registry entries: same type, within radius.
    const candidates: Candidate[] = [];
    for (let entryIndex = 0; entryIndex < initialEntryCount; entryIndex++) {
      const entry = entries[entryIndex];
      if (entry.type !== wp.type) continue;
      const distance = haversineDistance(wp.lat, wp.lon, entry.lat, entry.lon);
      if (distance > MATCH_RADIUS_METERS) continue;
      candidates.push({
        entryIndex,
        exactName: entry.name === wp.name,
        distance,
        id: entry.id,
      });
    }

    // Rank: exact-name matches first, then nearest, then id for stability.
    candidates.sort((a, b) => {
      if (a.exactName !== b.exactName) return a.exactName ? -1 : 1;
      if (a.distance !== b.distance) return a.distance - b.distance;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const pick = candidates.find((c) => !claimedBy.has(c.entryIndex));

    if (pick) {
      // Matched an existing entry: reuse id, refresh drifted coordinates/name.
      const entry = entries[pick.entryIndex];
      entry.name = wp.name;
      entry.lat = wp.lat;
      entry.lon = wp.lon;
      claimedBy.set(pick.entryIndex, wpIndex);
      results[wpIndex] = entry.id;
      return;
    }

    if (candidates.length > 0) {
      // Every nearby same-type entry was already claimed by another waypoint.
      const conflict = candidates[0];
      const otherWpIndex = claimedBy.get(conflict.entryIndex);
      const otherName =
        otherWpIndex !== undefined ? waypoints[otherWpIndex].name : '(unknown)';
      throw new Error(
        `Ambiguous waypoint identity for trail "${trailId}": "${wp.name}" ` +
          `(${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}) resolves to registry ` +
          `entry ${conflict.id} which was already claimed by "${otherName}". ` +
          `Two built waypoints map to the same stored waypoint — resolve by ` +
          `hand (move/rename one, or split the registry entry).`,
      );
    }

    // No candidate: mint a fresh deterministic id and append an entry.
    const id = mintId(trailId, wp, existingIds);
    existingIds.add(id);
    const newEntry: WaypointRegistryEntry = {
      id,
      name: wp.name,
      type: wp.type,
      lat: wp.lat,
      lon: wp.lon,
    };
    entries.push(newEntry);
    // A freshly appended entry is immediately claimed by this waypoint so a
    // later identical waypoint this run cannot silently steal it.
    claimedBy.set(entries.length - 1, wpIndex);
    results[wpIndex] = id;
  });

  return results;
}

/**
 * Serialise a registry deterministically for stable git diffs: trail keys
 * sorted alphabetically, entries within each trail sorted by id, fixed key
 * order per entry.
 */
export function stringifyRegistry(registry: WaypointRegistry): string {
  const ordered: WaypointRegistry = {};
  for (const trailId of Object.keys(registry).sort()) {
    const entries = [...registry[trailId]].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    ordered[trailId] = entries.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      lat: e.lat,
      lon: e.lon,
    }));
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
