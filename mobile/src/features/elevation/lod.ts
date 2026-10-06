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
  const loOf = (b: number) => dStart + (span * b) / bucketCount;
  const hiOf = (b: number) => dStart + (span * (b + 1)) / bucketCount;

  // One pass over the points, each dropped straight into its bucket: scanning
  // the whole track once per bucket was O(points × buckets) — 2.3 M visits for
  // a 4.6k-point trail's fine level, on every trail open.
  const minIdx = new Int32Array(bucketCount).fill(-1);
  const maxIdx = new Int32Array(bucketCount).fill(-1);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!(p.dist >= dStart && p.dist <= dEnd)) continue;
    let b = Math.min(bucketCount - 1, Math.floor(((p.dist - dStart) / span) * bucketCount));
    // The division can land a boundary point one bucket off; settle it against
    // the same edges the buckets are defined by ([lo, hi), last one closed).
    while (b < bucketCount - 1 && p.dist >= hiOf(b)) b++;
    while (b > 0 && p.dist < loOf(b)) b--;
    if (minIdx[b] === -1 || p.ele < points[minIdx[b]].ele) minIdx[b] = i;
    if (maxIdx[b] === -1 || p.ele > points[maxIdx[b]].ele) maxIdx[b] = i;
  }

  const out: T[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const lo = minIdx[b];
    const hi = maxIdx[b];
    if (lo === -1 || hi === -1) continue;
    // Emit the two extremes in distance order so the polyline stays monotonic.
    if (lo === hi) {
      pushUnique(out, points[lo]);
    } else if (lo < hi) {
      pushUnique(out, points[lo]);
      pushUnique(out, points[hi]);
    } else {
      pushUnique(out, points[hi]);
      pushUnique(out, points[lo]);
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

/** First index whose `dist` is >= km (`points.length` if none). Binary search. */
function firstAtOrAfter<T extends ProfilePoint>(points: T[], km: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist < km) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose `dist` is > km (`points.length` if none). Binary search. */
function firstAfter<T extends ProfilePoint>(points: T[], km: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dist <= km) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Slice the points visible in [startKm, endKm], plus one neighbour on each side
 * so the drawn trace runs to (and past) both plot edges instead of stopping
 * short. `points` must be sorted ascending by `dist`.
 */
export function sliceByKm<T extends ProfilePoint>(
  points: T[],
  startKm: number,
  endKm: number,
): T[] {
  if (points.length === 0) return [];
  const lowKm = Math.min(startKm, endKm);
  const highKm = Math.max(startKm, endKm);
  const lo = Math.max(0, firstAtOrAfter(points, lowKm) - 1);
  const hi = Math.min(points.length - 1, firstAfter(points, highKm));
  if (hi < lo) return [];
  return points.slice(lo, hi + 1);
}

/**
 * Pick the points to draw for the visible window, trading detail for point
 * count.
 *
 * Zoomed in, the raw track inside the window is small enough to draw verbatim —
 * so deep zoom shows *full* resolution rather than the flat few samples an LOD
 * level would leave in a 1 km slice. Only once the raw slice exceeds `budget`
 * do we fall back to the precomputed extreme-preserving levels.
 */
export function selectWindowPoints<T extends ProfilePoint>(
  raw: T[],
  levels: LodLevels<T>,
  startKm: number,
  endKm: number,
  totalKm: number,
  budget = LOD_FINE_SAMPLES,
): T[] {
  const rawSlice = sliceByKm(raw, startKm, endKm);
  if (rawSlice.length <= budget) return rawSlice;
  const level = selectLodLevel(endKm - startKm, totalKm);
  return sliceByKm(level === 'fine' ? levels.fine : levels.coarse, startKm, endKm);
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
