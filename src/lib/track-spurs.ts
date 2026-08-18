/**
 * Self-retrace ("spur") detection and extraction for built tracks.
 *
 * Some source GPX files fold an out-and-back walk into the single main-route
 * trkseg — the Larapinta's Mt Sonder summit return sits inside the same
 * segment as the through-route. Track classification (`track-classification.ts`)
 * is name-based and cannot see it, so the doubled-back kilometres inflate the
 * trail length and the route passes the same waypoints twice (which fans out
 * into duplicate enriched waypoint rows sharing one stable id).
 *
 * {@link detectSelfRetraces} reports these episodes so the build can warn about
 * them; {@link extractSpur} lifts one out of the main route (as an explicit,
 * configured operation — detection alone must never mutate data, because many
 * retraces are the official route, e.g. the Bibbulmun's town walk-ins).
 */

import { haversineDistance } from './distance';

/** Minimal point shape the spur helpers need. */
export interface SpurPoint {
  lat: number;
  lon: number;
}

/** One out-and-back episode found in a track. */
export interface SelfRetrace {
  /** km along the track where the track first reaches the episode's start. */
  startKm: number;
  /** km of the farthest point reached before doubling back. */
  turnaroundKm: number;
  /** km along the track where the track returns to the episode's start. */
  endKm: number;
  /** km walked twice: the shorter of the out and back legs. */
  retraceLengthKm: number;
  /** Index of the episode's first point. */
  startIndex: number;
  /** Index of the turnaround point. */
  turnaroundIndex: number;
  /** Index of the episode's last point. */
  endIndex: number;
  /**
   * True when the episode touches a track terminus — an out-and-back spur off
   * an end point, which can be lifted into a side trip without splitting the
   * through-route. Mid-track retraces (`false`) are usually the official route
   * (a walk-in to a town and back out) and must be left alone.
   */
  terminal: boolean;
}

export interface DetectSelfRetracesOptions {
  /** How close two track points must be to count as the same place. */
  proximityMeters?: number;
  /** Minimum retraced-leg length to report, in km. */
  minRetraceKm?: number;
  /** How near a terminus an episode must start/end to count as terminal, in km. */
  terminalToleranceKm?: number;
}

const DEFAULT_PROXIMITY_METERS = 150;
const DEFAULT_MIN_RETRACE_KM = 1;
const DEFAULT_TERMINAL_TOLERANCE_KM = 0.5;

const METERS_PER_DEGREE_LAT = 111320;

/** Cumulative along-track distance in km for each point. */
export function cumulativeKm(points: SpurPoint[]): number[] {
  const result = new Array<number>(points.length);
  let running = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      running += haversineDistance(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon) / 1000;
    }
    result[i] = running;
  }
  return result;
}

/**
 * Build a lat/lon grid index whose cells are at least `proximityMeters` across,
 * so every point within the proximity radius of a query point lies in the
 * query's own cell or one of its 8 neighbours. Keeps detection near-linear on
 * the 60k-point tracks (a naive all-pairs scan is ~4e9 haversines).
 */
function buildGrid(
  points: SpurPoint[],
  proximityMeters: number,
): { cells: Map<string, number[]>; latCell: number; lonCell: number } {
  const latCell = proximityMeters / METERS_PER_DEGREE_LAT;
  let latSum = 0;
  for (const p of points) latSum += p.lat;
  const meanLat = points.length > 0 ? latSum / points.length : 0;
  // Longitude degrees shrink towards the poles; clamp so a near-polar track
  // cannot produce an unbounded cell width.
  const lonCell = latCell / Math.max(Math.cos((meanLat * Math.PI) / 180), 0.1);

  const cells = new Map<string, number[]>();
  points.forEach((p, i) => {
    const key = `${Math.floor(p.lat / latCell)},${Math.floor(p.lon / lonCell)}`;
    const bucket = cells.get(key);
    if (bucket) bucket.push(i);
    else cells.set(key, [i]);
  });

  return { cells, latCell, lonCell };
}

/**
 * Find out-and-back episodes in a track.
 *
 * A point pair (i, j) is a return-to-the-same-place when the two points are
 * within `proximityMeters` of each other but at least `2 * minRetraceKm` apart
 * along the track (an out-and-back that retraces L km spans at least 2L km).
 * Overlapping pairs are merged into one episode, whose turnaround is the point
 * farthest from its start.
 *
 * Detection is advisory: it reports, it never modifies the track.
 */
export function detectSelfRetraces(
  points: SpurPoint[],
  options: DetectSelfRetracesOptions = {},
): SelfRetrace[] {
  const proximityMeters = options.proximityMeters ?? DEFAULT_PROXIMITY_METERS;
  const minRetraceKm = options.minRetraceKm ?? DEFAULT_MIN_RETRACE_KM;
  const terminalToleranceKm = options.terminalToleranceKm ?? DEFAULT_TERMINAL_TOLERANCE_KM;

  if (points.length < 3) return [];

  const km = cumulativeKm(points);
  const totalKm = km[km.length - 1];
  const minSpanKm = minRetraceKm * 2;
  if (totalKm < minSpanKm) return [];

  const { cells, latCell, lonCell } = buildGrid(points, proximityMeters);

  // For each j, the earliest i that is both physically near and far enough
  // along the track to constitute a doubling back.
  const pairs: { start: number; end: number }[] = [];
  for (let j = 0; j < points.length; j++) {
    const p = points[j];
    const latBucket = Math.floor(p.lat / latCell);
    const lonBucket = Math.floor(p.lon / lonCell);
    let earliest = -1;

    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const bucket = cells.get(`${latBucket + dLat},${lonBucket + dLon}`);
        if (!bucket) continue;
        for (const i of bucket) {
          // Buckets hold ascending indices, so once we reach j (or an index no
          // better than the best so far) nothing later in this bucket can win.
          if (i >= j) break;
          if (earliest !== -1 && i >= earliest) break;
          if (km[j] - km[i] < minSpanKm) continue;
          if (haversineDistance(points[i].lat, points[i].lon, p.lat, p.lon) > proximityMeters) continue;
          earliest = i;
        }
      }
    }

    if (earliest !== -1) pairs.push({ start: earliest, end: j });
  }

  if (pairs.length === 0) return [];

  // Merge overlapping pairs into episodes (pairs are already sorted by `end`,
  // sort by `start` for the standard interval merge).
  pairs.sort((a, b) => a.start - b.start || a.end - b.end);
  const episodes: { start: number; end: number }[] = [];
  for (const pair of pairs) {
    const last = episodes[episodes.length - 1];
    if (last && pair.start <= last.end) {
      last.end = Math.max(last.end, pair.end);
    } else {
      episodes.push({ ...pair });
    }
  }

  const retraces: SelfRetrace[] = [];
  for (const episode of episodes) {
    const anchor = points[episode.start];
    let turnaroundIndex = episode.start;
    let farthest = -1;
    for (let k = episode.start; k <= episode.end; k++) {
      const d = haversineDistance(anchor.lat, anchor.lon, points[k].lat, points[k].lon);
      if (d > farthest) {
        farthest = d;
        turnaroundIndex = k;
      }
    }

    const outLegKm = km[turnaroundIndex] - km[episode.start];
    const backLegKm = km[episode.end] - km[turnaroundIndex];
    const retraceLengthKm = Math.min(outLegKm, backLegKm);
    if (retraceLengthKm < minRetraceKm) continue;

    retraces.push({
      startKm: km[episode.start],
      turnaroundKm: km[turnaroundIndex],
      endKm: km[episode.end],
      retraceLengthKm,
      startIndex: episode.start,
      turnaroundIndex,
      endIndex: episode.end,
      terminal:
        km[episode.start] <= terminalToleranceKm ||
        totalKm - km[episode.end] <= terminalToleranceKm,
    });
  }

  return retraces;
}

export interface ExtractedSpur<P extends SpurPoint> {
  /** The main route with the spur's points removed. */
  trimmedMain: P[];
  /** The lifted spur, in walking order, including its junction point. */
  spurPoints: P[];
}

/** Index of the point whose along-track km is nearest `targetKm`. */
function indexAtKm(km: number[], targetKm: number): number {
  let best = 0;
  let bestDelta = Infinity;
  for (let i = 0; i < km.length; i++) {
    const delta = Math.abs(km[i] - targetKm);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = i;
    }
  }
  return best;
}

/**
 * Lift the km range [`fromKm`, `toKm`] out of a track as a separate spur.
 *
 * The junction point is kept on both sides: it stays as the trimmed route's
 * terminus (or, for a spur at the head of the track, `toKm`'s point becomes the
 * new start) and is also the spur's first point, so the spur still touches the
 * main route for junction matching.
 *
 * `fromKm`/`toKm` are in the track's own km space, i.e. after any build-time
 * reversal has already been applied.
 */
export function extractSpur<P extends SpurPoint>(
  points: P[],
  fromKm: number,
  toKm: number,
): ExtractedSpur<P> {
  if (points.length < 2) {
    throw new Error(`extractSpur: need at least 2 points, got ${points.length}`);
  }
  if (!(toKm > fromKm)) {
    throw new Error(`extractSpur: toKm (${toKm}) must be greater than fromKm (${fromKm})`);
  }

  const km = cumulativeKm(points);
  const startIndex = indexAtKm(km, fromKm);
  const endIndex = indexAtKm(km, toKm);

  if (endIndex <= startIndex) {
    throw new Error(
      `extractSpur: km range ${fromKm}–${toKm} resolves to a single point ` +
        `(index ${startIndex}) on a ${km[km.length - 1].toFixed(2)} km track`,
    );
  }

  const spurPoints = points.slice(startIndex, endIndex + 1);
  // A spur at the head of the track has its junction at `endIndex`, not
  // `startIndex`, so the trimmed route starts there instead of keeping the
  // spur's far terminus.
  const trimmedMain =
    startIndex === 0
      ? points.slice(endIndex)
      : [...points.slice(0, startIndex + 1), ...points.slice(endIndex + 1)];

  if (trimmedMain.length < 2) {
    throw new Error(
      `extractSpur: km range ${fromKm}–${toKm} would leave ${trimmedMain.length} main-route point(s)`,
    );
  }

  return { trimmedMain, spurPoints };
}
