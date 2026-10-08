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
 * entry.
 *
 * Entries are never deleted, but an entry no waypoint matched in a build is
 * marked `retired`. A retired id carries its comments and curated description
 * with it, so proximity alone must not hand it on: a *different* waypoint
 * added later within {@link MATCH_RADIUS_METERS} would otherwise inherit the
 * old place's comments as its own. A retired entry is reclaimed only by a
 * waypoint of the same type, in range, AND with the same name — the waypoint
 * coming back — which clears the flag.
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
  /**
   * Set when no waypoint in the trail's latest build matched this entry. Such
   * an entry is reclaimable only by an exact name match; see the module note.
   * Absent (never `false`) on a live entry, so the file only grows the key
   * where it means something.
   */
  retired?: true;
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
 * The 8-hex form of `hex`, or its 12-hex form if the short one is taken, or
 * null when both are claimed.
 */
function firstFreeId(hex: string, existingIds: Set<string>): string | null {
  const short = `w_${hex.slice(0, 8)}`;
  if (!existingIds.has(short)) return short;
  const long = `w_${hex.slice(0, 12)}`;
  if (!existingIds.has(long)) return long;
  return null;
}

/**
 * Mint a deterministic id for a waypoint. Uses an 8-hex-char sha1 slice by
 * default, extending to 12 chars if the short form already exists in the
 * registry (collision).
 *
 * The basis is trail + type + position, deliberately *not* the name: a waypoint
 * that gets renamed must keep its id. That leaves one case the hash length
 * cannot resolve — two distinct waypoints of the same type at the same
 * coordinate, where widening the slice just yields the same string again. The
 * CDT has eight of them: several towns hitched from a single pass or trailhead
 * ("Pagosa Springs / South Fork / Del Norte (access: Wolf Creek Pass (US 160))"
 * all sit on the pass), and Te Araroa's Rangitata road end serves Geraldine,
 * Peel Forest, Mesopotamia Station and Mt Potts Lodge the same way. They are
 * real, distinct rows, so the fallback folds the
 * name into the hash for the *later* arrival only — the first waypoint at a
 * position keeps the position-only id it has always had, so no existing id in
 * the committed registry moves.
 */
function mintId(
  trailId: string,
  wp: WaypointForId,
  existingIds: Set<string>,
): string {
  const basis = `${trailId}|${wp.type}|${wp.lat.toFixed(5)}|${wp.lon.toFixed(5)}`;
  let id = firstFreeId(sha1Hex(basis), existingIds);
  if (!id) {
    // Same basis as an id already minted: distinguish by name (see above).
    id = firstFreeId(sha1Hex(`${basis}|${wp.name}`), existingIds);
  }
  if (!id) {
    throw new Error(
      `Waypoint id collision for "${wp.name}" (${basis}): neither the position ` +
        `nor the position+name hash has a free 8- or 12-hex form. Widen the ` +
        `mint hash length.`,
    );
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
 * First, every waypoint whose exact name is on an unclaimed registry entry of
 * the same `type` within {@link MATCH_RADIUS_METERS} claims that entry (the
 * nearest, if several). A waypoint therefore keeps its id even when a newcomer
 * of the same type lands within the radius and comes before it in the input.
 *
 * Then, for each remaining waypoint (in input order):
 *  - Find unclaimed registry entries of the same `type` within
 *    {@link MATCH_RADIUS_METERS} — a retired entry only when its name is the
 *    waypoint's exact name. Rank them by exact name match, then by proximity,
 *    then by id (deterministic tie-break).
 *  - Match → reuse the entry's id, refresh its stored name/lat/lon, and clear
 *    any `retired` flag.
 *  - No candidate entries at all, or only entries their own exact names
 *    claimed in the first step → mint a new id and append an entry.
 *  - Had candidate entries but every one was already claimed by another
 *    built waypoint this run, by proximity or under this waypoint's own name
 *    → throw (ambiguous identity; needs a human).
 *
 * Afterwards every pre-existing entry of this trail that no waypoint claimed
 * is marked `retired`. Call it once per trail per build, with every waypoint
 * the trail has, or entries for the ones left out are retired.
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

  // Gather candidate registry entries for a waypoint: same type, within radius.
  const candidatesFor = (wp: WaypointForId): Candidate[] => {
    const candidates: Candidate[] = [];
    for (let entryIndex = 0; entryIndex < initialEntryCount; entryIndex++) {
      const entry = entries[entryIndex];
      if (entry.type !== wp.type) continue;
      // A retired id goes back only to the waypoint it belonged to (same name),
      // never to a newcomer that happens to sit within the radius.
      if (entry.retired && entry.name !== wp.name) continue;
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
    return candidates;
  };

  // Matched an existing entry: reuse id, refresh drifted coordinates/name.
  const claim = (wp: WaypointForId, wpIndex: number, entryIndex: number): void => {
    const entry = entries[entryIndex];
    entry.name = wp.name;
    entry.lat = wp.lat;
    entry.lon = wp.lon;
    delete entry.retired;
    claimedBy.set(entryIndex, wpIndex);
    results[wpIndex] = entry.id;
  };

  // Pass 1: exact names claim their own entries before proximity can.
  const claimedByName = new Set<number>();
  waypoints.forEach((wp, wpIndex) => {
    const own = candidatesFor(wp).find((c) => c.exactName && !claimedBy.has(c.entryIndex));
    if (own) {
      claim(wp, wpIndex, own.entryIndex);
      claimedByName.add(own.entryIndex);
    }
  });

  waypoints.forEach((wp, wpIndex) => {
    if (results[wpIndex] !== undefined) return;
    const candidates = candidatesFor(wp);
    const pick = candidates.find((c) => !claimedBy.has(c.entryIndex));

    if (pick) {
      claim(wp, wpIndex, pick.entryIndex);
      return;
    }

    // Entries their own names claimed say nothing about this waypoint: it is
    // a different place nearby. Anything else claimed first is ambiguous.
    if (candidates.some((c) => c.exactName || !claimedByName.has(c.entryIndex))) {
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

  // Whatever this build did not match is gone from the trail as built: retire
  // it, so its id (and the comments keyed to it) cannot pass to a newcomer.
  for (let entryIndex = 0; entryIndex < initialEntryCount; entryIndex++) {
    if (!claimedBy.has(entryIndex)) entries[entryIndex].retired = true;
  }

  return results;
}

/**
 * Serialise a registry deterministically for stable git diffs: trail keys
 * sorted alphabetically, entries within each trail sorted by id, fixed key
 * order per entry, `retired` written only on retired entries.
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
      ...(e.retired ? { retired: true as const } : {}),
    }));
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
