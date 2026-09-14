/**
 * A uniform-grid nearest-point index over a list of lat/lon points.
 *
 * The map's hover readout has to answer "which track point is under the
 * cursor?" on every mousemove. Scanning the whole display copy was fine while
 * that copy was capped at ~3,000 points; it is not once a long trail keeps
 * 20,000+ of them (see MAX_TOLERANCE_METERS in `trail-ingest.ts`). This buckets
 * the points into square cells once and then searches outwards from the query's
 * own cell, stopping as soon as the next ring cannot hold anything closer.
 *
 * Distance is measured in raw degrees (`dlat² + dlon²`), exactly as the linear
 * scan it replaces did: the index is a lookup accelerator, not a change of
 * metric, and over the few hundred metres a hover cares about the difference
 * from a true great-circle nearest is not observable. Ties resolve to the
 * earliest point, again matching the scan.
 *
 * Platform-neutral: no DOM, no Leaflet, so the mobile map can reuse it.
 */

/** The least a point needs to be indexed. */
export interface IndexablePoint {
  lat: number;
  lon: number;
}

/** Aim for roughly this many points per cell when sizing the grid. */
const TARGET_POINTS_PER_CELL = 2;

/** Fallback cell size (degrees) when every point sits on the same spot. */
const MIN_CELL_SIZE_DEGREES = 1e-6;

/** Inclusive integer range, as the ring walk wants it. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

export class PointIndex<P extends IndexablePoint> {
  private readonly points: readonly P[];
  private readonly cells = new Map<number, number[]>();
  private readonly cellSize: number;
  private readonly minLat: number;
  private readonly minLon: number;
  private readonly cols: number;
  private readonly rows: number;

  constructor(points: readonly P[]) {
    this.points = points;

    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const point of points) {
      if (point.lat < minLat) minLat = point.lat;
      if (point.lat > maxLat) maxLat = point.lat;
      if (point.lon < minLon) minLon = point.lon;
      if (point.lon > maxLon) maxLon = point.lon;
    }

    if (points.length === 0) {
      this.cellSize = MIN_CELL_SIZE_DEGREES;
      this.minLat = 0;
      this.minLon = 0;
      this.cols = 1;
      this.rows = 1;
      return;
    }

    this.minLat = minLat;
    this.minLon = minLon;

    // Square cells sized so the bounding box holds about one cell per
    // TARGET_POINTS_PER_CELL points. A degenerate box (one point, or a
    // perfectly straight line) falls back to the floor rather than dividing by
    // zero.
    const area = Math.max(maxLat - minLat, 0) * Math.max(maxLon - minLon, 0);
    const wanted =
      area > 0
        ? Math.sqrt((area * TARGET_POINTS_PER_CELL) / points.length)
        : Math.max(maxLat - minLat, maxLon - minLon, 0) /
          Math.max(1, points.length / TARGET_POINTS_PER_CELL);
    this.cellSize = Math.max(wanted, MIN_CELL_SIZE_DEGREES);

    this.cols = Math.floor((maxLon - minLon) / this.cellSize) + 1;
    this.rows = Math.floor((maxLat - minLat) / this.cellSize) + 1;

    for (let i = 0; i < points.length; i++) {
      const key = this.key(this.col(points[i].lon), this.row(points[i].lat));
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(i);
      else this.cells.set(key, [i]);
    }
  }

  /** How many points the index covers. */
  get size(): number {
    return this.points.length;
  }

  private col(lon: number): number {
    return Math.floor((lon - this.minLon) / this.cellSize);
  }

  private row(lat: number): number {
    return Math.floor((lat - this.minLat) / this.cellSize);
  }

  private key(col: number, row: number): number {
    return row * this.cols + col;
  }

  /**
   * Index of the point nearest `(lat, lon)`, or -1 when the index is empty.
   */
  nearestIndex(lat: number, lon: number): number {
    if (this.points.length === 0) return -1;

    // The query can be well outside the trail's bounding box (the cursor is
    // nowhere near the line), so the search starts from the nearest cell that
    // exists rather than from a cell index thousands of rings away.
    const centreCol = Math.max(0, Math.min(this.cols - 1, this.col(lon)));
    const centreRow = Math.max(0, Math.min(this.rows - 1, this.row(lat)));

    let best = -1;
    let bestDistSq = Infinity;

    for (let ring = 0; ; ring++) {
      const colLo = centreCol - ring;
      const colHi = centreCol + ring;
      const rowLo = centreRow - ring;
      const rowHi = centreRow + ring;

      for (let row = Math.max(0, rowLo); row <= Math.min(this.rows - 1, rowHi); row++) {
        // Past the first ring only the perimeter is new: a full row of cells on
        // the top and bottom edges, and just the two end cells in between.
        const onRowEdge = ring === 0 || row === rowLo || row === rowHi;
        const cols = onRowEdge
          ? range(Math.max(0, colLo), Math.min(this.cols - 1, colHi))
          : [colLo, colHi].filter((col) => col >= 0 && col < this.cols);

        for (const col of cols) {
          const bucket = this.cells.get(this.key(col, row));
          if (!bucket) continue;
          for (const i of bucket) {
            const point = this.points[i];
            const dLat = point.lat - lat;
            const dLon = point.lon - lon;
            const distSq = dLat * dLat + dLon * dLon;
            // `<` only: ties keep the earliest point, as a forward scan does.
            if (distSq < bestDistSq) {
              bestDistSq = distSq;
              best = i;
            }
          }
        }
      }

      // Every cell there is has now been searched.
      if (colLo <= 0 && rowLo <= 0 && colHi >= this.cols - 1 && rowHi >= this.rows - 1) break;

      // Anything still unsearched lies outside the rectangle these rings cover,
      // so it is at least this far from the query. Once the best so far is
      // nearer, no further ring can beat it. (Negative while the query sits
      // outside that rectangle, which keeps the search expanding.)
      const gap = Math.min(
        lon - (this.minLon + colLo * this.cellSize),
        this.minLon + (colHi + 1) * this.cellSize - lon,
        lat - (this.minLat + rowLo * this.cellSize),
        this.minLat + (rowHi + 1) * this.cellSize - lat
      );
      if (best >= 0 && gap > 0 && bestDistSq <= gap * gap) break;
    }

    return best;
  }

  /** The point nearest `(lat, lon)`, or null when the index is empty. */
  nearest(lat: number, lon: number): P | null {
    const index = this.nearestIndex(lat, lon);
    return index < 0 ? null : this.points[index];
  }
}

/** Build a {@link PointIndex}; the function form reads better at call sites. */
export function buildPointIndex<P extends IndexablePoint>(points: readonly P[]): PointIndex<P> {
  return new PointIndex(points);
}
