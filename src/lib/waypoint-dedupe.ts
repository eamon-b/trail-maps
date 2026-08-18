/**
 * Near-duplicate waypoint merging for built trail data.
 *
 * Source data often carries two `<wpt>`s for one physical feature: the AAWT has
 * "Talbot Hut Site" twice ~60 m apart, and the Larapinta marks a single
 * campsite with both a `WT:` water tank and a `C:` campsite pin (Rocky Bar Gap,
 * Rocky Gully) — after the CalTopo category overwrite both members end up with
 * the same cleaned name *and* the same type, so they render as two adjacent
 * identical-looking rows in the waypoint list and two overlapping map pins.
 *
 * {@link dedupeNearDuplicateWaypoints} collapses each such cluster to one
 * survivor. It is deliberately conservative: it only merges rows that share a
 * name *and* a type and sit within `radiusMeters` of each other, so genuinely
 * different features never collapse into one.
 *
 * The merge happens on *built* (post-id, post-enrich) rows, never on the source
 * waypoint list: the id registry must keep seeing every source waypoint so that
 * ids stay append-only and retired ids keep their comments. Dropped ids are
 * recorded on the survivor as `mergedIds` so they remain discoverable.
 */

import { haversineDistance } from './distance';

/** Default merge radius: catches the widest real pair seen in the data (125 m). */
export const WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS = 150;

/**
 * Minimal shape the merge needs. Enriched main-route rows, variant rows and
 * off-trail rows all satisfy it; the cumulative/segment fields are optional so
 * unenriched rows (off-trail waypoints) work too.
 */
export interface DedupableWaypoint {
  id?: string;
  name: string;
  type: string;
  lat: number;
  lon: number;
  description?: string;
  /** Ids of source waypoints already merged into this row. */
  mergedIds?: string[];
  /** Segment distance from the previous row (km). */
  distance?: number;
  /** Cumulative distance along the track (km) — the merge's ordering key. */
  totalDistance?: number;
  ascent?: number;
  descent?: number;
  totalAscent?: number;
  totalDescent?: number;
}

export interface WaypointDedupeOptions {
  /** Merge radius in metres. `<= 0` disables merging. */
  radiusMeters?: number;
  /**
   * Ids that win survivor selection when present in a cluster. Lets later
   * views (route variants, off-trail lists) keep the same canonical row the
   * main route kept, so one feature does not surface under two different ids.
   */
  preferIds?: Iterable<string>;
}

/** One collapsed cluster. */
export interface WaypointMerge {
  name: string;
  type: string;
  /** Id of the row that was kept (undefined only if the row had no id). */
  survivorId?: string;
  /** Ids of the rows that were dropped, in input order. */
  droppedIds: string[];
  /** Number of rows dropped (may exceed `droppedIds.length` for id-less rows). */
  droppedCount: number;
  /** Widest separation within the cluster, in metres. */
  maxSeparationMeters: number;
}

export interface WaypointDedupeResult<T extends DedupableWaypoint> {
  /** Input rows with each cluster collapsed to its survivor, order preserved. */
  waypoints: T[];
  /** One entry per collapsed cluster; empty when nothing merged. */
  merges: WaypointMerge[];
  /** Flat list of every dropped id, in input order. */
  droppedIds: string[];
}

/** Round km to 2dp, matching the precision the build writes. */
function roundKm(km: number): number {
  return Math.round(km * 100) / 100;
}

function trimmedDescription(description: string | undefined): string {
  return (description ?? '').trim();
}

/**
 * Group indices that share an exact name and type. Names arriving here are
 * already prefix-cleaned by `classifyWaypoint`, so exact matching is enough and
 * avoids fuzzily merging distinct features ("Hut Creek" vs "Hut Creek East").
 */
function bucketByNameAndType<T extends DedupableWaypoint>(waypoints: readonly T[]): Map<string, number[]> {
  const buckets = new Map<string, number[]>();
  waypoints.forEach((wp, index) => {
    const key = `${wp.name}\u0000${wp.type}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });
  return buckets;
}

/**
 * Single-linkage clustering of one bucket: two rows within `radiusMeters` join
 * the same cluster, so a chain of three pins at one site collapses together
 * even when the outer two are slightly further apart than the radius.
 */
function clusterBucket<T extends DedupableWaypoint>(
  waypoints: readonly T[],
  indices: number[],
  radiusMeters: number
): number[][] {
  const parent = new Map<number, number>(indices.map(i => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = i;
    while (parent.get(walk) !== root) {
      const next = parent.get(walk)!;
      parent.set(walk, root);
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  for (let a = 0; a < indices.length; a++) {
    for (let b = a + 1; b < indices.length; b++) {
      const wpA = waypoints[indices[a]];
      const wpB = waypoints[indices[b]];
      if (haversineDistance(wpA.lat, wpA.lon, wpB.lat, wpB.lon) <= radiusMeters) {
        union(indices[a], indices[b]);
      }
    }
  }

  const clusters = new Map<number, number[]>();
  for (const index of indices) {
    const root = find(index);
    const cluster = clusters.get(root);
    if (cluster) cluster.push(index);
    else clusters.set(root, [index]);
  }
  return [...clusters.values()].filter(cluster => cluster.length > 1);
}

/**
 * Pick the cluster member to keep. Preference order:
 * 1. an explicitly preferred id (keeps views consistent with the main route),
 * 2. the smallest `totalDistance` — the first one reached along the track,
 * 3. the lexicographically smallest id (deterministic across rebuilds),
 * 4. input order (the only tiebreak left for rows without ids or km).
 */
function pickSurvivor<T extends DedupableWaypoint>(
  waypoints: readonly T[],
  cluster: number[],
  preferIds: Set<string>
): number {
  return cluster.reduce((best, index) => {
    const a = waypoints[index];
    const b = waypoints[best];

    const aPreferred = a.id !== undefined && preferIds.has(a.id);
    const bPreferred = b.id !== undefined && preferIds.has(b.id);
    if (aPreferred !== bPreferred) return aPreferred ? index : best;

    const aKm = a.totalDistance;
    const bKm = b.totalDistance;
    if (aKm !== undefined && bKm !== undefined && aKm !== bKm) return aKm < bKm ? index : best;
    if (aKm !== undefined && bKm === undefined) return index;
    if (aKm === undefined && bKm !== undefined) return best;

    const aId = a.id ?? '';
    const bId = b.id ?? '';
    if (aId !== bId) return aId < bId ? index : best;

    return best;
  }, cluster[0]);
}

/** Survivor description plus the dropped rows' distinct descriptions. */
function mergeDescriptions<T extends DedupableWaypoint>(survivor: T, dropped: readonly T[]): string | undefined {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const description of [survivor.description, ...dropped.map(d => d.description)]) {
    const trimmed = trimmedDescription(description);
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    parts.push(trimmed);
  }
  if (parts.length === 0) return survivor.description;
  return parts.join('\n\n');
}

/** Ids retired by this merge: the dropped rows' ids plus anything they already absorbed. */
function mergeIds<T extends DedupableWaypoint>(survivor: T, dropped: readonly T[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>(survivor.id === undefined ? [] : [survivor.id]);
  for (const id of [...(survivor.mergedIds ?? []), ...dropped.flatMap(d => [d.id, ...(d.mergedIds ?? [])])]) {
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Re-derive a surviving row's *segment* fields after rows in front of it were
 * dropped. `distance`/`ascent`/`descent` are deltas from the previous row, so
 * dropping a row leaves the next one measuring from a row that no longer
 * exists. The dropped run's own origin (`totalDistance - distance`) is the
 * position the segment should now start from, which works for main-route rows
 * (first segment measured from km 0) and variant rows (offset by the junction
 * km) alike.
 */
function recomputeSegments<T extends DedupableWaypoint>(row: T, droppedRun: readonly T[]): T {
  const origin = droppedRun[0];
  if (origin === undefined) return row;
  if (row.totalDistance === undefined || row.distance === undefined) return row;
  if (origin.totalDistance === undefined || origin.distance === undefined) return row;

  const updated: T = { ...row };
  updated.distance = roundKm(row.totalDistance - (origin.totalDistance - origin.distance));
  if (
    row.totalAscent !== undefined && row.ascent !== undefined &&
    origin.totalAscent !== undefined && origin.ascent !== undefined
  ) {
    updated.ascent = Math.round(row.totalAscent - (origin.totalAscent - origin.ascent));
  }
  if (
    row.totalDescent !== undefined && row.descent !== undefined &&
    origin.totalDescent !== undefined && origin.descent !== undefined
  ) {
    updated.descent = Math.round(row.totalDescent - (origin.totalDescent - origin.descent));
  }
  return updated;
}

/**
 * Collapse near-duplicate waypoints (same name, same type, within
 * `radiusMeters`) to one survivor each.
 *
 * The survivor keeps its own id, coordinates and elevation/km statistics; the
 * dropped rows contribute their distinct descriptions and land in the
 * survivor's `mergedIds`. Rows that are not part of any cluster come back as
 * the same object references, untouched.
 */
export function dedupeNearDuplicateWaypoints<T extends DedupableWaypoint>(
  waypoints: readonly T[],
  options: WaypointDedupeOptions = {}
): WaypointDedupeResult<T> {
  const radiusMeters = options.radiusMeters ?? WAYPOINT_DEDUPE_DEFAULT_RADIUS_METERS;
  if (waypoints.length < 2 || radiusMeters <= 0) {
    return { waypoints: [...waypoints], merges: [], droppedIds: [] };
  }

  const preferIds = new Set<string>(options.preferIds ?? []);

  // index -> cluster it survives, and the set of indices being dropped
  const survivorClusters = new Map<number, number[]>();
  const droppedIndices = new Set<number>();
  const found: { survivorIndex: number; merge: WaypointMerge }[] = [];

  for (const indices of bucketByNameAndType(waypoints).values()) {
    if (indices.length < 2) continue;
    for (const cluster of clusterBucket(waypoints, indices, radiusMeters)) {
      const survivorIndex = pickSurvivor(waypoints, cluster, preferIds);
      const droppedInOrder = cluster.filter(index => index !== survivorIndex).sort((a, b) => a - b);
      survivorClusters.set(survivorIndex, droppedInOrder);
      for (const index of droppedInOrder) droppedIndices.add(index);

      let maxSeparationMeters = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          const wpA = waypoints[cluster[a]];
          const wpB = waypoints[cluster[b]];
          maxSeparationMeters = Math.max(
            maxSeparationMeters,
            haversineDistance(wpA.lat, wpA.lon, wpB.lat, wpB.lon)
          );
        }
      }

      const survivor = waypoints[survivorIndex];
      const droppedIds = droppedInOrder
        .map(index => waypoints[index].id)
        .filter((id): id is string => id !== undefined);
      found.push({
        survivorIndex,
        merge: {
          name: survivor.name,
          type: survivor.type,
          survivorId: survivor.id,
          droppedIds,
          droppedCount: droppedInOrder.length,
          maxSeparationMeters,
        },
      });
    }
  }

  // Report in input order so the merge log reads top-to-bottom along the trail.
  const merges = found
    .sort((a, b) => a.survivorIndex - b.survivorIndex)
    .map(entry => entry.merge);

  if (merges.length === 0) {
    return { waypoints: [...waypoints], merges: [], droppedIds: [] };
  }

  const output: T[] = [];
  let droppedRun: T[] = [];
  waypoints.forEach((wp, index) => {
    if (droppedIndices.has(index)) {
      droppedRun.push(wp);
      return;
    }

    let row = wp;
    const droppedForThisRow = survivorClusters.get(index);
    if (droppedForThisRow !== undefined) {
      const droppedRows = droppedForThisRow.map(i => waypoints[i]);
      row = { ...row };
      const description = mergeDescriptions(wp, droppedRows);
      if (description !== undefined) row.description = description;
      const ids = mergeIds(wp, droppedRows);
      if (ids.length > 0) row.mergedIds = ids;
    }
    if (droppedRun.length > 0) {
      row = recomputeSegments(row, droppedRun);
      droppedRun = [];
    }
    output.push(row);
  });

  return {
    waypoints: output,
    merges,
    droppedIds: merges.flatMap(merge => merge.droppedIds),
  };
}
