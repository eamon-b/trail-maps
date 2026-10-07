/**
 * Tests for the contour tile worker's serve-time smoothing
 * (workers/contour-tiles/src/contour-smoothing.ts).
 *
 * Tiles are built and read back with a minimal protobuf encoder/decoder written
 * here, independently of the module under test, so a bug in its parser cannot
 * hide itself.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  smoothContourTile,
  smoothLine,
  type SmoothingOptions,
} from '../../workers/contour-tiles/src/contour-smoothing';

const AUSTRALIA: SmoothingOptions = { iterations: 3, tolerance: 2 };
const WORLD: SmoothingOptions = { iterations: 2, tolerance: 1 };

// --- Minimal MVT encoding ---------------------------------------------------

function varint(out: number[], value: number): void {
  while (value >= 0x80) {
    out.push((value % 128) | 0x80);
    value = Math.floor(value / 128);
  }
  out.push(value);
}

const zz = (n: number): number => (n >= 0 ? n * 2 : -n * 2 - 1);

function field(out: number[], num: number, wire: number): void {
  varint(out, num * 8 + wire);
}

function bytesField(out: number[], num: number, payload: number[]): void {
  field(out, num, 2);
  varint(out, payload.length);
  out.push(...payload);
}

type Point = [number, number];

function encodeGeometry(type: number, parts: Point[][]): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  for (const part of parts) {
    const ring = type === 3; // polygons end with ClosePath and omit the last point
    const pts = ring ? part.slice(0, -1) : part;
    varint(out, (1 << 3) | 1);
    varint(out, zz(pts[0][0] - cx));
    varint(out, zz(pts[0][1] - cy));
    [cx, cy] = pts[0];
    if (pts.length > 1) {
      varint(out, ((pts.length - 1) << 3) | 2);
      for (const [x, y] of pts.slice(1)) {
        varint(out, zz(x - cx));
        varint(out, zz(y - cy));
        cx = x;
        cy = y;
      }
    }
    if (ring) varint(out, (1 << 3) | 7);
  }
  return out;
}

interface TestFeature {
  id?: number;
  tags: number[];
  type: number;
  parts: Point[][];
}

function encodeFeature(f: TestFeature): number[] {
  const out: number[] = [];
  if (f.id !== undefined) {
    field(out, 1, 0);
    varint(out, f.id);
  }
  const tags: number[] = [];
  for (const t of f.tags) varint(tags, t);
  bytesField(out, 2, tags);
  field(out, 3, 0);
  varint(out, f.type);
  bytesField(out, 4, encodeGeometry(f.type, f.parts));
  return out;
}

function encodeTile(features: TestFeature[], extent = 4096, extentFirst = false): Uint8Array {
  const layer: number[] = [];
  field(layer, 15, 0);
  varint(layer, 2);
  bytesField(layer, 1, [...Buffer.from('contour')]);
  if (extentFirst) {
    field(layer, 5, 0);
    varint(layer, extent);
  }
  for (const f of features) bytesField(layer, 2, encodeFeature(f));
  bytesField(layer, 3, [...Buffer.from('elevation')]);
  // values: one sint64 (field 6) per elevation
  for (const v of [100, 200]) {
    const value: number[] = [];
    field(value, 6, 0);
    varint(value, zz(v));
    bytesField(layer, 4, value);
  }
  if (!extentFirst) {
    field(layer, 5, 0);
    varint(layer, extent);
  }
  const tile: number[] = [];
  bytesField(tile, 3, layer);
  return Uint8Array.from(tile);
}

// --- Minimal MVT decoding ---------------------------------------------------

class R {
  pos = 0;
  constructor(
    private buf: Uint8Array,
    private end = buf.length,
    start = 0
  ) {
    this.pos = start;
  }
  get done() {
    return this.pos >= this.end;
  }
  varint(): number {
    let v = 0;
    let s = 1;
    for (;;) {
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * s;
      if (b < 0x80) return v;
      s *= 128;
    }
  }
  bytes(): Uint8Array {
    const len = this.varint();
    const out = this.buf.subarray(this.pos, this.pos + len);
    this.pos += len;
    return out;
  }
}

interface DecodedFeature {
  id?: number;
  tags: number[];
  type: number;
  geometryBytes: Uint8Array;
  lines: Point[][];
}

interface DecodedLayer {
  other: { field: number; bytes: number[] }[];
  extent: number;
  features: DecodedFeature[];
}

const unzz = (n: number): number => (n % 2 === 0 ? n / 2 : -(n + 1) / 2);

function decodeGeometry(bytes: Uint8Array): Point[][] {
  const r = new R(bytes);
  const parts: Point[][] = [];
  let x = 0;
  let y = 0;
  while (!r.done) {
    const cmd = r.varint();
    const id = cmd & 7;
    const count = cmd >> 3;
    if (id === 7) continue;
    for (let i = 0; i < count; i++) {
      x += unzz(r.varint());
      y += unzz(r.varint());
      if (id === 1) parts.push([[x, y]]);
      else parts[parts.length - 1].push([x, y]);
    }
  }
  return parts;
}

function decodeTile(buf: Uint8Array): DecodedLayer[] {
  const layers: DecodedLayer[] = [];
  const r = new R(buf);
  while (!r.done) {
    const tag = r.varint();
    expect(tag).toBe((3 << 3) | 2);
    const lb = r.bytes();
    const lr = new R(lb);
    const layer: DecodedLayer = { other: [], extent: 4096, features: [] };
    while (!lr.done) {
      const t = lr.varint();
      const f = t >> 3;
      if (f === 2) {
        const fr = new R(lr.bytes());
        const feature: DecodedFeature = { tags: [], type: 0, geometryBytes: new Uint8Array(), lines: [] };
        while (!fr.done) {
          const ft = fr.varint();
          const ff = ft >> 3;
          if (ff === 1) feature.id = fr.varint();
          else if (ff === 2) {
            const tr = new R(fr.bytes());
            while (!tr.done) feature.tags.push(tr.varint());
          } else if (ff === 3) feature.type = fr.varint();
          else if (ff === 4) feature.geometryBytes = fr.bytes();
        }
        feature.lines = decodeGeometry(feature.geometryBytes);
        layer.features.push(feature);
      } else if (f === 5) {
        layer.extent = lr.varint();
      } else if ((t & 7) === 0) {
        layer.other.push({ field: f, bytes: [lr.varint()] });
      } else {
        layer.other.push({ field: f, bytes: [...lr.bytes()] });
      }
    }
    layers.push(layer);
  }
  return layers;
}

// --- Geometry helpers -------------------------------------------------------

/** Absolute turn at each interior vertex, in degrees. */
function turns(line: Point[]): number[] {
  const out: number[] = [];
  for (let i = 2; i < line.length; i++) {
    const ax = line[i - 1][0] - line[i - 2][0];
    const ay = line[i - 1][1] - line[i - 2][1];
    const bx = line[i][0] - line[i - 1][0];
    const by = line[i][1] - line[i - 1][1];
    out.push(Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)) * (180 / Math.PI));
  }
  return out;
}

const meanTurn = (line: Point[]): number => {
  const t = turns(line);
  return t.length ? t.reduce((a, b) => a + b, 0) / t.length : 0;
};

function distanceToPolyline([px, py]: Point, line: Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const [bx, by] = line[i];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

const flat = (line: Point[]): number[] => line.flat();
const points = (line: number[]): Point[] =>
  Array.from({ length: line.length / 2 }, (_, i) => [line[2 * i], line[2 * i + 1]] as Point);

/** A sawtooth like the ones tippecanoe leaves at low zooms. */
const ZIGZAG: Point[] = [
  [100, 100], [300, 400], [500, 120], [700, 420], [900, 140], [1100, 440], [1300, 160],
];

// --- Tests --------------------------------------------------------------------

describe('smoothLine', () => {
  it('rounds the corners of a sawtooth', () => {
    const out = points(smoothLine(flat(ZIGZAG), AUSTRALIA));
    expect(meanTurn(ZIGZAG)).toBeGreaterThan(100);
    expect(meanTurn(out)).toBeLessThan(25);
  });

  it('keeps both endpoints exactly, so lines still meet across tile edges', () => {
    for (const options of [AUSTRALIA, WORLD]) {
      const out = points(smoothLine(flat(ZIGZAG), options));
      expect(out[0]).toEqual(ZIGZAG[0]);
      expect(out[out.length - 1]).toEqual(ZIGZAG[ZIGZAG.length - 1]);
    }
  });

  it('keeps a closed ring closed', () => {
    const ring: Point[] = [[0, 0], [400, 0], [400, 400], [0, 400], [0, 0]];
    const out = points(smoothLine(flat(ring), AUSTRALIA));
    expect(out[0]).toEqual(out[out.length - 1]);
    // The corners are cut all the way round, including the one at the seam.
    expect(out.some(([x, y]) => x === 0 && y === 0)).toBe(false);
    for (const p of out) expect(distanceToPolyline(p, ring)).toBeLessThan(120);
  });

  it('stays close to the original line', () => {
    const out = points(smoothLine(flat(ZIGZAG), AUSTRALIA));
    // Chaikin never leaves the original's convex hull and moves a vertex at
    // most a quarter of its shorter neighbouring segment per pass.
    for (const p of out) {
      expect(p[0]).toBeGreaterThanOrEqual(100);
      expect(p[0]).toBeLessThanOrEqual(1300);
      expect(p[1]).toBeGreaterThanOrEqual(100);
      expect(p[1]).toBeLessThanOrEqual(440);
      expect(distanceToPolyline(p, ZIGZAG)).toBeLessThan(150);
    }
  });

  it('drops the vertices extra passes add along a straight run', () => {
    const straight: Point[] = [[0, 0], [1000, 0], [2000, 0], [3000, 0]];
    expect(points(smoothLine(flat(straight), AUSTRALIA))).toEqual([[0, 0], [3000, 0]]);
  });

  it('leaves a two-point line alone', () => {
    expect(smoothLine([0, 0, 50, 50], AUSTRALIA)).toEqual([0, 0, 50, 50]);
  });

  it('scales the tolerance with the extent', () => {
    // After smoothing, this bow peaks about 6 units off its chord: above the
    // tolerance of 2 at extent 4096, below the 8 it scales to at extent 16384.
    const bow = [0, 0, 500, 8, 1000, 0];
    expect(smoothLine(bow, AUSTRALIA, 4096).length).toBeGreaterThan(4);
    expect(smoothLine(bow, AUSTRALIA, 16384)).toEqual([0, 0, 1000, 0]);
  });
});

describe('smoothContourTile', () => {
  const features: TestFeature[] = [
    { id: 1, tags: [0, 0], type: 2, parts: [ZIGZAG] },
    {
      id: 2,
      tags: [0, 1],
      type: 2,
      parts: [
        [[-50, 2000], [200, 2300], [400, 2000], [600, 2300]],
        [[3000, 3000], [3200, 3300], [3400, 3000], [3600, 3300], [4200, 3000]],
      ],
    },
    { id: 3, tags: [0, 0], type: 1, parts: [[[10, 10]]] },
    { id: 4, tags: [0, 1], type: 3, parts: [[[0, 0], [100, 0], [100, 100], [0, 0]]] },
  ];

  it('changes only LineString geometry', () => {
    const input = encodeTile(features);
    const before = decodeTile(input);
    const after = decodeTile(smoothContourTile(input, AUSTRALIA));

    expect(after).toHaveLength(1);
    expect(after[0].other).toEqual(before[0].other); // version, name, keys, values
    expect(after[0].extent).toBe(before[0].extent);
    expect(after[0].features.map(({ id, tags, type }) => ({ id, tags, type }))).toEqual(
      before[0].features.map(({ id, tags, type }) => ({ id, tags, type }))
    );
    // Point and polygon geometry is byte-for-byte what came in.
    expect(after[0].features[2].geometryBytes).toEqual(before[0].features[2].geometryBytes);
    expect(after[0].features[3].geometryBytes).toEqual(before[0].features[3].geometryBytes);
  });

  it('smooths every part of a multi-line feature and keeps their endpoints', () => {
    const after = decodeTile(smoothContourTile(encodeTile(features), AUSTRALIA));
    const before = decodeTile(encodeTile(features));
    for (const i of [0, 1]) {
      const inLines = before[0].features[i].lines;
      const outLines = after[0].features[i].lines;
      expect(outLines).toHaveLength(inLines.length);
      outLines.forEach((line, j) => {
        expect(line[0]).toEqual(inLines[j][0]);
        expect(line[line.length - 1]).toEqual(inLines[j][inLines[j].length - 1]);
        expect(meanTurn(line)).toBeLessThan(meanTurn(inLines[j]));
      });
    }
  });

  it('reads the extent wherever the layer puts it', () => {
    const late = decodeTile(smoothContourTile(encodeTile(features, 512, false), AUSTRALIA));
    const early = decodeTile(smoothContourTile(encodeTile(features, 512, true), AUSTRALIA));
    expect(late[0].features[0].lines).toEqual(early[0].features[0].lines);
  });

  it('returns an empty tile unchanged', () => {
    expect(smoothContourTile(new Uint8Array(), AUSTRALIA)).toEqual(new Uint8Array());
  });

  it('throws on a truncated tile instead of serving garbage', () => {
    const input = encodeTile(features);
    expect(() => smoothContourTile(input.subarray(0, input.length - 7), AUSTRALIA)).toThrow();
  });

  it('smooths a live z13 tile without losing a feature', () => {
    // Mt Sonder, NT: contours/13/7112/4648 as served on 2026-10-07.
    const input = new Uint8Array(
      readFileSync(resolve(__dirname, '../../workers/contour-tiles/test-fixtures/contours-13-7112-4648.pbf'))
    );
    const before = decodeTile(input);
    const after = decodeTile(smoothContourTile(input, AUSTRALIA));

    expect(after[0].other).toEqual(before[0].other);
    expect(after[0].features.length).toBe(before[0].features.length);
    // Corners sharper than 45° are what reads as jagged. (A mean turn would
    // not do: rounding to the integer grid jitters the many short segments
    // smoothing adds by a few degrees each.)
    const sharp = { before: 0, after: 0, verticesBefore: 0, verticesAfter: 0 };
    after[0].features.forEach((feature, i) => {
      const original = before[0].features[i];
      expect({ id: feature.id, tags: feature.tags, type: feature.type }).toEqual({
        id: original.id,
        tags: original.tags,
        type: original.type,
      });
      feature.lines.forEach((line, j) => {
        const src = original.lines[j];
        const [sx, sy] = src[0];
        const [ex, ey] = src[src.length - 1];
        if (sx === ex && sy === ey) {
          // A closed ring is smoothed all the way round, its start included.
          expect(line[0]).toEqual(line[line.length - 1]);
        } else {
          expect(line[0]).toEqual(src[0]);
          expect(line[line.length - 1]).toEqual(src[src.length - 1]);
        }
        const before = turns(src);
        const after = turns(line);
        sharp.before += before.filter((t) => t > 45).length;
        sharp.after += after.filter((t) => t > 45).length;
        sharp.verticesBefore += before.length;
        sharp.verticesAfter += after.length;
      });
    });
    // Measured: 41% of corners sharp before, under 2% after.
    expect(sharp.before / sharp.verticesBefore).toBeGreaterThan(0.3);
    expect(sharp.after / sharp.verticesAfter).toBeLessThan(0.05);
  });
});
