/**
 * Serve-time smoothing of contour line geometry, kept free of runtime
 * dependencies (no pmtiles, no Workers globals) so the root test suite can
 * import the real function rather than a copy of it.
 *
 * Why: below an archive's maxzoom, tippecanoe simplifies every contour to a
 * few straight segments, so at z9-z14 lines draw as sawtooth polygons (median
 * turn between segments: ~100° at z9 and ~30° at z14 in the Australia archive,
 * against ~5° at z15). Rebuilding the archives takes days of compute; cutting
 * the corners here at serve time takes milliseconds per tile and reaches every
 * client, including app builds already shipped.
 *
 * How: Chaikin corner cutting (each pass replaces a vertex with points 1/4 and
 * 3/4 of the way along its two segments), then Douglas-Peucker at a sub-pixel
 * tolerance to drop the points the extra passes added on straight runs. The
 * method was chosen by rendering live tiles with MapLibre against a
 * full-detail z15 reference; the per-source settings and how they were tuned
 * are in index.ts (SMOOTHING).
 *
 * The tile is rewritten at the protobuf level: only the `geometry` of
 * LineString features changes. Layer names, keys, values, feature ids, tags,
 * other geometry types and unknown fields are copied through byte for byte.
 *
 * Line endpoints never move, so a contour that leaves one tile still meets its
 * continuation in the next. Closed rings (first point == last point) are
 * smoothed all the way round and stay closed.
 */

export interface SmoothingOptions {
  /** Chaikin passes. Each one roughly doubles a line's vertices before simplification. */
  iterations: number;
  /**
   * Douglas-Peucker tolerance after smoothing, in units of a 4096-extent tile
   * (scaled to the layer's own extent). 0 keeps every smoothed vertex.
   */
  tolerance: number;
}

const GEOMETRY_TYPE_LINESTRING = 2;
const DEFAULT_EXTENT = 4096;

// Protobuf field numbers from the Mapbox Vector Tile spec (vector_tile.proto).
const TILE_LAYERS = 3;
const LAYER_FEATURES = 2;
const LAYER_EXTENT = 5;
const FEATURE_TYPE = 3;
const FEATURE_GEOMETRY = 4;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_BYTES = 2;
const WIRE_FIXED32 = 5;

const CMD_MOVE_TO = 1;
const CMD_LINE_TO = 2;
const CMD_CLOSE_PATH = 7;

// --- Protobuf reading -------------------------------------------------------

class Reader {
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** Varints up to 2^53, which covers every length, tag and uint32 here. */
  varint(): number {
    let result = 0;
    let shift = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('Truncated varint');
      const byte = this.buf[this.pos++];
      result += (byte & 0x7f) * shift;
      if (byte < 0x80) return result;
      shift *= 128;
    }
    throw new Error('Varint too long');
  }

  /** Skip the payload of a field whose tag has just been read. */
  skip(wireType: number): void {
    switch (wireType) {
      case WIRE_VARINT:
        this.varint();
        break;
      case WIRE_FIXED64:
        this.pos += 8;
        break;
      case WIRE_BYTES: {
        // Not `this.pos += this.varint()`: that reads pos before the length
        // varint advances it.
        const length = this.varint();
        this.pos += length;
        break;
      }
      case WIRE_FIXED32:
        this.pos += 4;
        break;
      default:
        throw new Error(`Unsupported wire type ${wireType}`);
    }
    if (this.pos > this.end) throw new Error('Truncated field');
  }
}

// --- Protobuf writing -------------------------------------------------------

class Writer {
  buf: Uint8Array;
  pos = 0;

  constructor(initialSize = 256) {
    this.buf = new Uint8Array(initialSize);
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let size = Math.max(this.buf.length * 2, 64);
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }

  varint(value: number): void {
    this.ensure(10);
    while (value >= 0x80) {
      this.buf[this.pos++] = (value % 128) | 0x80;
      value = Math.floor(value / 128);
    }
    this.buf[this.pos++] = value;
  }

  bytes(src: Uint8Array, start: number, end: number): void {
    this.ensure(end - start);
    this.buf.set(src.subarray(start, end), this.pos);
    this.pos += end - start;
  }

  /** Write `tag, length, payload` for a length-delimited field built by `fill`. */
  message(field: number, fill: (w: Writer) => void): void {
    const inner = new Writer();
    fill(inner);
    this.varint((field << 3) | WIRE_BYTES);
    this.varint(inner.pos);
    this.bytes(inner.buf, 0, inner.pos);
  }

  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

const zigzag = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);
const unzigzag = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

// --- Geometry ---------------------------------------------------------------

/** A line as interleaved x,y tile coordinates. */
type Line = number[];

/**
 * Decode a LineString geometry into its lines. Returns null for anything that
 * is not a plain MoveTo/LineTo sequence, so the caller leaves it untouched.
 */
function decodeLines(r: Reader): Line[] | null {
  const lines: Line[] = [];
  let x = 0;
  let y = 0;
  let current: Line | null = null;
  while (!r.done) {
    const command = r.varint();
    const id = command & 0x7;
    const count = Math.floor(command / 8);
    if (id === CMD_MOVE_TO) {
      if (count !== 1) return null;
      x += unzigzag(r.varint());
      y += unzigzag(r.varint());
      current = [x, y];
      lines.push(current);
    } else if (id === CMD_LINE_TO) {
      if (!current) return null;
      for (let i = 0; i < count; i++) {
        x += unzigzag(r.varint());
        y += unzigzag(r.varint());
        current.push(x, y);
      }
    } else if (id === CMD_CLOSE_PATH) {
      return null; // not valid in a LineString
    } else {
      return null;
    }
  }
  return lines;
}

function encodeLines(w: Writer, lines: Line[]): void {
  let x = 0;
  let y = 0;
  for (const line of lines) {
    const points = line.length / 2;
    w.varint((1 << 3) | CMD_MOVE_TO);
    w.varint(zigzag(line[0] - x));
    w.varint(zigzag(line[1] - y));
    x = line[0];
    y = line[1];
    w.varint(((points - 1) * 8) | CMD_LINE_TO);
    for (let i = 2; i < line.length; i += 2) {
      w.varint(zigzag(line[i] - x));
      w.varint(zigzag(line[i + 1] - y));
      x = line[i];
      y = line[i + 1];
    }
  }
}

// Scratch buffers for the smoothing passes, grown on demand and reused across
// lines and tiles. Safe to share: smoothContourTile is synchronous, so no two
// calls in an isolate ever interleave.
let scratchA = new Float64Array(4096);
let scratchB = new Float64Array(4096);

/**
 * Chaikin corner cutting. Returns the smoothed coordinates as the first
 * `length` entries of a scratch buffer, valid until the next call.
 */
function chaikin(line: Line, iterations: number): { coords: Float64Array; length: number } {
  const n0 = line.length / 2;
  const closed = n0 >= 3 && line[0] === line[line.length - 2] && line[1] === line[line.length - 1];
  // Each pass turns n points into 2(n - 1) + 2 (open) or 2(n - 1) + 1 (closed).
  let finalPoints = n0;
  for (let pass = 0; pass < iterations; pass++) finalPoints = 2 * (finalPoints - 1) + (closed ? 1 : 2);
  if (scratchA.length < finalPoints * 2) {
    scratchA = new Float64Array(finalPoints * 4);
    scratchB = new Float64Array(finalPoints * 4);
  }
  let src = scratchA;
  let dst = scratchB;
  for (let i = 0; i < line.length; i++) src[i] = line[i];
  let n = n0;
  for (let pass = 0; pass < iterations; pass++) {
    let m = 0;
    if (!closed) {
      dst[0] = src[0];
      dst[1] = src[1];
      m = 1;
    }
    for (let i = 0; i < n - 1; i++) {
      const ax = src[2 * i];
      const ay = src[2 * i + 1];
      const bx = src[2 * i + 2];
      const by = src[2 * i + 3];
      dst[2 * m] = 0.75 * ax + 0.25 * bx;
      dst[2 * m + 1] = 0.75 * ay + 0.25 * by;
      dst[2 * m + 2] = 0.25 * ax + 0.75 * bx;
      dst[2 * m + 3] = 0.25 * ay + 0.75 * by;
      m += 2;
    }
    if (closed) {
      dst[2 * m] = dst[0];
      dst[2 * m + 1] = dst[1];
    } else {
      dst[2 * m] = src[2 * n - 2];
      dst[2 * m + 1] = src[2 * n - 1];
    }
    n = m + 1;
    const swap = src;
    src = dst;
    dst = swap;
  }
  return { coords: src, length: n * 2 };
}

/** Douglas-Peucker; returns which vertices to keep. Endpoints are always kept. */
function simplifyMask(line: Float64Array, length: number, tolerance: number): Uint8Array {
  const n = length / 2;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  if (tolerance <= 0) return keep.fill(1);
  const tol2 = tolerance * tolerance;
  const stack = [0, n - 1];
  while (stack.length) {
    const b = stack.pop()!;
    const a = stack.pop()!;
    const ax = line[2 * a];
    const ay = line[2 * a + 1];
    const dx = line[2 * b] - ax;
    const dy = line[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstIndex = -1;
    for (let i = a + 1; i < b; i++) {
      const px = line[2 * i] - ax;
      const py = line[2 * i + 1] - ay;
      let d2: number;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        const cross = dx * py - dy * px;
        d2 = (cross * cross) / len2;
      }
      if (d2 > worst) {
        worst = d2;
        worstIndex = i;
      }
    }
    if (worst > tol2) {
      keep[worstIndex] = 1;
      stack.push(a, worstIndex, worstIndex, b);
    }
  }
  return keep;
}

/**
 * Smooth one line in tile coordinates. Endpoints are exact; every other vertex
 * is rounded to the integer grid, and consecutive duplicates are dropped.
 * Lines too short to smooth come back unchanged.
 */
export function smoothLine(line: Line, options: SmoothingOptions, extent = DEFAULT_EXTENT): Line {
  if (line.length < 6) return line;
  const { coords: smoothed, length } = chaikin(line, options.iterations);
  const keep = simplifyMask(smoothed, length, (options.tolerance * extent) / DEFAULT_EXTENT);
  const out: number[] = [];
  for (let i = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    const x = Math.round(smoothed[2 * i]);
    const y = Math.round(smoothed[2 * i + 1]);
    const last = out.length - 2;
    if (last >= 0 && out[last] === x && out[last + 1] === y) continue;
    out.push(x, y);
  }
  return out.length >= 4 ? out : line;
}

// --- Tile rewrite -----------------------------------------------------------

function writeFeature(w: Writer, buf: Uint8Array, start: number, end: number, extent: number, options: SmoothingOptions): void {
  // First pass: is this a LineString, and where is its geometry?
  const r = new Reader(buf, start, end);
  let type = 0;
  let geomStart = -1;
  let geomEnd = -1;
  while (!r.done) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 0x7;
    if (field === FEATURE_TYPE && wire === WIRE_VARINT) {
      type = r.varint();
    } else if (field === FEATURE_GEOMETRY && wire === WIRE_BYTES) {
      const length = r.varint();
      geomStart = r.pos;
      geomEnd = r.pos + length;
      r.pos = geomEnd;
      if (geomEnd > end) throw new Error('Truncated geometry');
    } else {
      r.skip(wire);
    }
  }

  const lines =
    type === GEOMETRY_TYPE_LINESTRING && geomStart >= 0
      ? decodeLines(new Reader(buf, geomStart, geomEnd))
      : null;

  w.message(LAYER_FEATURES, (fw) => {
    if (!lines) {
      fw.bytes(buf, start, end);
      return;
    }
    // Second pass: copy every field, swapping in the smoothed geometry.
    const copy = new Reader(buf, start, end);
    while (!copy.done) {
      const fieldStart = copy.pos;
      const tag = copy.varint();
      const field = Math.floor(tag / 8);
      const wire = tag & 0x7;
      copy.skip(wire);
      if (field === FEATURE_GEOMETRY && wire === WIRE_BYTES) {
        const smoothed = lines.map((line) => smoothLine(line, options, extent));
        fw.message(FEATURE_GEOMETRY, (gw) => encodeLines(gw, smoothed));
      } else {
        fw.bytes(buf, fieldStart, copy.pos);
      }
    }
  });
}

function writeLayer(w: Writer, buf: Uint8Array, start: number, end: number, options: SmoothingOptions): void {
  // The extent may follow the features in the encoding, so find it first.
  let extent = DEFAULT_EXTENT;
  const scan = new Reader(buf, start, end);
  while (!scan.done) {
    const tag = scan.varint();
    if (Math.floor(tag / 8) === LAYER_EXTENT && (tag & 0x7) === WIRE_VARINT) {
      extent = scan.varint();
    } else {
      scan.skip(tag & 0x7);
    }
  }

  w.message(TILE_LAYERS, (lw) => {
    const r = new Reader(buf, start, end);
    while (!r.done) {
      const fieldStart = r.pos;
      const tag = r.varint();
      const wire = tag & 0x7;
      if (Math.floor(tag / 8) === LAYER_FEATURES && wire === WIRE_BYTES) {
        const length = r.varint();
        const featureStart = r.pos;
        r.pos += length;
        if (r.pos > end) throw new Error('Truncated feature');
        writeFeature(lw, buf, featureStart, r.pos, extent, options);
      } else {
        r.skip(wire);
        lw.bytes(buf, fieldStart, r.pos);
      }
    }
  });
}

/**
 * Return a copy of an uncompressed MVT tile with every LineString smoothed.
 * Throws on a malformed tile; the caller decides whether to serve it as is.
 */
export function smoothContourTile(tile: Uint8Array, options: SmoothingOptions): Uint8Array {
  const w = new Writer(tile.length * 2);
  const r = new Reader(tile);
  while (!r.done) {
    const fieldStart = r.pos;
    const tag = r.varint();
    const wire = tag & 0x7;
    if (Math.floor(tag / 8) === TILE_LAYERS && wire === WIRE_BYTES) {
      const length = r.varint();
      const layerStart = r.pos;
      r.pos += length;
      if (r.pos > tile.length) throw new Error('Truncated layer');
      writeLayer(w, tile, layerStart, r.pos, options);
    } else {
      r.skip(wire);
      w.bytes(tile, fieldStart, r.pos);
    }
  }
  return w.result();
}
