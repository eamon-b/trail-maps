/**
 * Level-of-detail (LOD) downsampling for the elevation profile.
 *
 * The raw trail track has thousands of points (~2k–4.6k). Rendering — and
 * re-fitting on every zoom/pan window change — against the full array is
 * wasteful, but naive stride-sampling drops sharp peaks (a lone spike between
 * two sampled indices vanishes). This module builds **extreme-preserving**
 * downsamples: it buckets points by distance and keeps the min- and max-
 * elevation point in each bucket, so peaks and troughs always survive.
 *
 * Two levels are precomputed once per trail (a coarse full-trail overview and
 * a finer level for zoomed-in windows) and selected per zoom — resampling
 * therefore never runs per animation frame.
 */

/** Minimal shape the profile needs from a track point. */
export interface ProfilePoint {
  lat: number;
  lon: number;
  ele: number;
  /** Cumulative distance along the trail in km. */
  dist: number;
}

/** Point counts for the two precomputed LOD levels. */
export const LOD_COARSE_SAMPLES = 500;
export const LOD_FINE_SAMPLES = 2000;

/**
 * Downsample `points` to at most ~`targetCount` points while preserving local
 * extremes. Points are bucketed evenly across the distance span; each bucket
 * contributes its lowest and highest point (in distance order), so a single
 * spike is retained as a bucket maximum.
 *
 * Guarantees:
 *  - the first and last points are always present,
 *  - output is sorted by distance (monotonic, same as the input),
 *  - inputs already at/under the target are returned as a shallow copy.
 */
export function buildLod<T extends ProfilePoint>(points: T[], targetCount: number): T[] {
  if (points.length === 0) return [];
  if (targetCount < 2 || points.length <= targetCount) return points.slice();

  const first = points[0];
  const last = points[points.length - 1];
  const dStart = first.dist;
  const dEnd = last.dist;
  const span = dEnd - dStart;

  // Degenerate span (all points at one distance): fall back to a plain stride.
  if (span <= 0) return strideSample(points, targetCount);

  // Two points per bucket (a min and a max), so halve the target.
  const bucketCount = Math.max(1, Math.floor(targetCount / 2));
  const out: T[] = [];

  for (let b = 0; b < bucketCount; b++) {
    const lo = dStart + (span * b) / bucketCount;
    // Include the right edge in the final bucket so the last point is covered.
    const hi = dStart + (span * (b + 1)) / bucketCount;
    const isLast = b === bucketCount - 1;

    let minPt: T | null = null;
    let minIdx = -1;
    let maxPt: T | null = null;
    let maxIdx = -1;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const inBucket = isLast ? p.dist >= lo && p.dist <= hi : p.dist >= lo && p.dist < hi;
      if (!inBucket) continue;
      if (minPt === null || p.ele < minPt.ele) {
        minPt = p;
        minIdx = i;
      }
      if (maxPt === null || p.ele > maxPt.ele) {
        maxPt = p;
        maxIdx = i;
      }
    }

    if (minPt === null || maxPt === null) continue;
    // Emit the two extremes in distance order so the polyline stays monotonic.
    if (minIdx === maxIdx) {
      pushUnique(out, minPt);
    } else if (minIdx < maxIdx) {
      pushUnique(out, minPt);
      pushUnique(out, maxPt);
    } else {
      pushUnique(out, maxPt);
      pushUnique(out, minPt);
    }
  }

  // Bucketing keys off min/max elevation, which can drop the exact endpoints;
  // pin them so the profile always spans the full trail.
  if (out.length === 0 || out[0] !== first) out.unshift(first);
  if (out[out.length - 1] !== last) out.push(last);

  return out;
}

/** Two precomputed LOD levels for a trail. */
export interface LodLevels<T extends ProfilePoint> {
  coarse: T[];
  fine: T[];
}

/** Build the coarse (overview) and fine (zoomed) levels in one pass. */
export function buildLodLevels<T extends ProfilePoint>(points: T[]): LodLevels<T> {
  return {
    coarse: buildLod(points, LOD_COARSE_SAMPLES),
    fine: buildLod(points, LOD_FINE_SAMPLES),
  };
}

/**
 * Pick which LOD level to render for the current visible window. The fine
 * level kicks in once the window covers less than `fineThreshold` of the whole
 * trail (default 60%) — i.e. as soon as the user zooms in enough that the extra
 * resolution is visible.
 */
export function selectLodLevel(
  visibleSpanKm: number,
  totalKm: number,
  fineThreshold = 0.6,
): 'coarse' | 'fine' {
  if (totalKm <= 0) return 'coarse';
  return visibleSpanKm / totalKm < fineThreshold ? 'fine' : 'coarse';
}

/** Even stride sampling (no extreme preservation) — degenerate fallback. */
function strideSample<T>(points: T[], count: number): T[] {
  if (points.length <= count) return points.slice();
  const step = (points.length - 1) / (count - 1);
  const out: T[] = [];
  for (let i = 0; i < count - 1; i++) out.push(points[Math.round(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

function pushUnique<T>(arr: T[], item: T): void {
  if (arr.length === 0 || arr[arr.length - 1] !== item) arr.push(item);
}
