/**
 * Which offline tile pack — if any — a guide can use.
 *
 * Tile packs are built server-side, one per *bundled* trail (a 20 km corridor
 * around its track, see `scripts/build-tiles.ts`), and downloaded into
 * `{documentDir}/tiles/{trailId}/`. A user-imported GPX has no pack of its own
 * and never will, so the app does the next best thing: if the import lies inside
 * a bundled trail's coverage, it reuses *that* trail's pack.
 *
 * The reuse is an alias, not a copy. Directory names stay equal to the bundled
 * trail id (`tileManager.getDownloadedTrails()` enumerates dir names, so a
 * second name for the same bytes would double-count storage and desync the
 * badges), and downloading "for" an import is literally downloading the
 * bundled pack — with the same progress, the same update check, and one
 * shared delete.
 *
 * ## The containment rule
 *
 * Coverage is approximated by the bundled track's bounding box plus a small
 * {@link PACK_BBOX_BUFFER_DEG} margin — deliberately far less than the pack's
 * 20 km corridor, because a bbox overstates a corridor everywhere the trail is
 * not straight. An import wins a pack when its own bbox is fully inside a
 * candidate's; failing that, when at least {@link MIN_PACK_OVERLAP} of the
 * import's bbox *area* is covered, and then the best-covered candidate wins.
 *
 * It is an approximation in both directions and that is accepted for v1: a
 * matched import can still find blank tiles where it wanders off the corridor
 * (the map degrades to empty ground, not an error), and a genuinely uncovered
 * import is told plainly that offline maps aren't available rather than being
 * walked into a 404. Per-bbox packs are the real fix and are out of scope.
 */

import { calculateTrailBounds, type TrackPoint, type TrailBounds } from './trail-bounds';
import { getTrailJson, isServerKnown, listTrails } from './trail-loader';

/**
 * Margin added to a bundled track's bbox when treating it as pack coverage.
 * ~5 km — well inside the pack's own 20 km corridor, so the approximation
 * stays conservative near the ends of a trail without claiming the corners of
 * the bbox that the corridor never reaches.
 */
export const PACK_BBOX_BUFFER_DEG = 0.05;

/** Minimum share of an import's bbox a pack must cover to be offered. */
export const MIN_PACK_OVERLAP = 0.8;

/** A bundled pack and the area it is taken to cover. */
export interface PackCandidate {
  /** Bundled trail id — also the on-disk tile directory name. */
  trailId: string;
  /** Display name, for "Uses the … offline pack". */
  name: string;
  bounds: TrailBounds;
}

/** What a guide should do about offline maps. */
export type OfflinePackResolution =
  /** A bundled guide: it has its own pack. */
  | { kind: 'own' }
  /** An import that falls inside a bundled trail's coverage. */
  | { kind: 'bundled'; packTrailId: string; packName: string }
  /** An import with no usable pack — online only. */
  | { kind: 'none' };

/** The minimum a trail has to expose for its bbox to be computed. */
export interface PackTrailInput {
  track?: {
    points?: { lat: number; lon: number }[];
    displayPoints?: { lat: number; lon: number }[];
  };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

function area(b: TrailBounds): number {
  return Math.max(0, b.east - b.west) * Math.max(0, b.north - b.south);
}

function contains(outer: TrailBounds, inner: TrailBounds): boolean {
  return (
    inner.west >= outer.west &&
    inner.east <= outer.east &&
    inner.south >= outer.south &&
    inner.north <= outer.north
  );
}

/**
 * Share of `inner`'s bbox area that `outer` covers, in 0..1.
 *
 * A degenerate import (a single point, or a track running exactly north–south)
 * has zero area, so the ratio would be 0/0; those fall back to a containment
 * test, which is the honest answer for them.
 */
export function overlapRatio(outer: TrailBounds, inner: TrailBounds): number {
  const innerArea = area(inner);
  if (innerArea === 0) return contains(outer, inner) ? 1 : 0;

  const overlap = area({
    west: Math.max(outer.west, inner.west),
    south: Math.max(outer.south, inner.south),
    east: Math.min(outer.east, inner.east),
    north: Math.min(outer.north, inner.north),
  });
  return overlap / innerArea;
}

/**
 * The best pack for an imported bbox, or null when none covers enough of it.
 * Full containment wins outright; otherwise the largest covered share wins,
 * and ties break on candidate order (bundle order) so the answer is stable.
 */
export function pickPack(
  imported: TrailBounds,
  candidates: readonly PackCandidate[],
): PackCandidate | null {
  let best: PackCandidate | null = null;
  let bestRatio = 0;

  for (const candidate of candidates) {
    if (contains(candidate.bounds, imported)) return candidate;
    const ratio = overlapRatio(candidate.bounds, imported);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
  }

  return bestRatio >= MIN_PACK_OVERLAP ? best : null;
}

// ---------------------------------------------------------------------------
// Bundled coverage table
// ---------------------------------------------------------------------------

let candidateCache: PackCandidate[] | null = null;

/** Bbox of whichever point list a trail actually carries, or null if none. */
export function trailBounds(trail: PackTrailInput | null | undefined): TrailBounds | null {
  // displayPoints first: it is the simplified line, an order of magnitude
  // smaller, and a Douglas-Peucker simplification keeps the extreme vertices —
  // so it yields the same bbox for a fraction of the walk.
  const points = trail?.track?.displayPoints?.length
    ? trail.track.displayPoints
    : trail?.track?.points;
  if (!points || points.length === 0) return null;
  return calculateTrailBounds(points as unknown as TrackPoint[], 0);
}

/**
 * Coverage boxes for the bundled packs, computed once from the bundled JSON.
 *
 * Lazy and memoised: each bundled trail JSON is already in the Metro bundle, so
 * this costs one walk of six simplified tracks the first time a guide asks, and
 * nothing afterwards.
 */
export function bundledPackCandidates(): PackCandidate[] {
  if (candidateCache) return candidateCache;

  candidateCache = listTrails().flatMap((entry) => {
    const bounds = trailBounds(getTrailJson(entry.id));
    if (!bounds) return [];
    return [
      {
        trailId: entry.id,
        name: entry.name,
        bounds: {
          west: bounds.west - PACK_BBOX_BUFFER_DEG,
          south: bounds.south - PACK_BBOX_BUFFER_DEG,
          east: bounds.east + PACK_BBOX_BUFFER_DEG,
          north: bounds.north + PACK_BBOX_BUFFER_DEG,
        },
      },
    ];
  });
  return candidateCache;
}

/** Test seam — drop the memoised coverage table. */
export function resetBundledPackCandidates(): void {
  candidateCache = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Which pack this guide should use. Bundled guides own theirs; imports borrow
 * one when their bbox is covered (see the module docs for the rule).
 *
 * @param candidates test seam — defaults to the bundled coverage table.
 */
export function resolveOfflinePack(
  trailId: string,
  trail: PackTrailInput | null | undefined,
  candidates: readonly PackCandidate[] = bundledPackCandidates(),
): OfflinePackResolution {
  if (isServerKnown(trailId)) return { kind: 'own' };

  const bounds = trailBounds(trail);
  if (!bounds) return { kind: 'none' };

  const pack = pickPack(bounds, candidates);
  if (!pack) return { kind: 'none' };
  return { kind: 'bundled', packTrailId: pack.trailId, packName: pack.name };
}

// ---------------------------------------------------------------------------
// Screen state
// ---------------------------------------------------------------------------

/** What the Offline maps screen (and the map pane) do with a resolution. */
export interface OfflinePackPlan {
  /** Tile directory to download / delete / render from; null when unavailable. */
  packTrailId: string | null;
  /** Whether the download and delete actions apply at all. */
  packAvailable: boolean;
  /** Line explaining a borrowed or missing pack; null when the guide owns one. */
  note: string | null;
}

/**
 * The Offline maps screen's whole decision, as a pure function so it can be
 * asserted without mounting the screen.
 */
export function offlinePackPlan(
  resolution: OfflinePackResolution,
  trailId: string,
): OfflinePackPlan {
  switch (resolution.kind) {
    case 'own':
      return { packTrailId: trailId, packAvailable: true, note: null };
    case 'bundled':
      return {
        packTrailId: resolution.packTrailId,
        packAvailable: true,
        note: `Uses the ${resolution.packName} offline pack — this guide's track is inside its coverage.`,
      };
    case 'none':
      return {
        packTrailId: null,
        packAvailable: false,
        note: "Offline maps aren't available for imported trails outside a bundled trail's coverage. The map works online.",
      };
  }
}
