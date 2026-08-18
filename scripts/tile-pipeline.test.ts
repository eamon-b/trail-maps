import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import {
  validateMbtilesArtifact,
  writeManifest,
  fileSha256,
  fileMd5,
  contentAddressedKey,
  CONTOUR_MIN_ZOOM,
  MAX_ZOOM,
  CONTOUR_ZOOM_EXPECTATION,
  BASE_ZOOM_EXPECTATION,
} from './tile-pipeline';

/**
 * These tests exercise the mbtiles guards with real sqlite databases (the
 * validator shells out to the sqlite3 CLI), but never invoke GDAL or
 * tippecanoe — the fixtures are hand-built tile tables.
 */

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-pipeline-test-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface FixtureOpts {
  /** Zoom levels to insert one tile at each. */
  zooms: number[];
  /** metadata minzoom; defaults to min(zooms). Pass null to omit the row. */
  metaMinZoom?: number | null;
  /** metadata maxzoom; defaults to max(zooms). Pass null to omit the row. */
  metaMaxZoom?: number | null;
  extraMetadata?: Record<string, string>;
}

let fixtureCounter = 0;

function makeMbtiles(name: string, opts: FixtureOpts): string {
  const filePath = path.join(tmpDir, `${name}-${fixtureCounter++}.mbtiles`);
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

  const statements: string[] = [
    'CREATE TABLE metadata (name text, value text);',
    'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob);',
  ];

  for (const z of opts.zooms) {
    statements.push(`INSERT INTO tiles VALUES (${z}, 0, 0, x'00');`);
  }

  const metadata: Record<string, string> = {
    name: 'fixture',
    format: 'pbf',
    bounds: '138.0,-35.0,139.0,-31.0',
    ...opts.extraMetadata,
  };
  const min = opts.metaMinZoom === undefined ? Math.min(...opts.zooms) : opts.metaMinZoom;
  const max = opts.metaMaxZoom === undefined ? Math.max(...opts.zooms) : opts.metaMaxZoom;
  if (min !== null) metadata.minzoom = String(min);
  if (max !== null) metadata.maxzoom = String(max);

  for (const [k, v] of Object.entries(metadata)) {
    statements.push(`INSERT INTO metadata VALUES (${q(k)}, ${q(v)});`);
  }

  execFileSync('sqlite3', [filePath, statements.join('\n')]);
  return filePath;
}

const contourZooms = Array.from(
  { length: MAX_ZOOM - CONTOUR_MIN_ZOOM + 1 },
  (_, i) => CONTOUR_MIN_ZOOM + i
);

describe('validateMbtilesArtifact', () => {
  it('accepts a well-formed contour artifact against the contour expectation', () => {
    const file = makeMbtiles('contours', { zooms: contourZooms });
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).not.toThrow();
  });

  it('rejects a contour artifact built without the -Z flag (the z0–z8 incident)', () => {
    // Self-consistent metadata (minzoom=0 matches the tiles present), which is
    // exactly why the pre-expectation validator waved this through.
    const file = makeMbtiles('contours-noZ', { zooms: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
    expect(() => validateMbtilesArtifact(file)).not.toThrow();
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).toThrow(
      /lowest tile zoom is 0, expected 9/
    );
  });

  it('rejects an artifact missing the top of its zoom range', () => {
    const file = makeMbtiles('base-truncated', { zooms: [4, 5, 6, 7, 8] });
    expect(() => validateMbtilesArtifact(file, BASE_ZOOM_EXPECTATION)).toThrow(
      /highest tile zoom is 8, expected 15/
    );
  });

  it('rejects metadata minzoom that disagrees with the tiles table', () => {
    const file = makeMbtiles('meta-min-lie', { zooms: contourZooms, metaMinZoom: 0 });
    expect(() => validateMbtilesArtifact(file)).toThrow(
      /metadata minzoom=0 but lowest tile zoom is 9/
    );
  });

  it('rejects metadata maxzoom that disagrees with the tiles table', () => {
    const file = makeMbtiles('meta-max-lie', { zooms: contourZooms, metaMaxZoom: 14 });
    expect(() => validateMbtilesArtifact(file)).toThrow(
      /metadata maxzoom=14 but highest tile zoom is 15/
    );
  });

  it('still enforces the expected range when metadata zoom rows are absent', () => {
    const file = makeMbtiles('no-meta-zoom', {
      zooms: [0, 1, 2],
      metaMinZoom: null,
      metaMaxZoom: null,
    });
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).toThrow(
      /expected 9/
    );
  });

  it('rejects an empty tile table', () => {
    const file = makeMbtiles('empty', { zooms: [], metaMinZoom: 9, metaMaxZoom: 15 });
    expect(() => validateMbtilesArtifact(file)).toThrow(/contains no tiles/);
  });

  it('rejects non-integer metadata zooms before comparing them', () => {
    const file = makeMbtiles('bad-meta', {
      zooms: contourZooms,
      metaMinZoom: null,
      extraMetadata: { minzoom: 'nine' },
    });
    expect(() => validateMbtilesArtifact(file)).toThrow(/metadata minzoom is not an integer/);
  });
});

describe('file hashing helpers', () => {
  function digest(algorithm: string, data: Buffer): string {
    return crypto.createHash(algorithm).update(data).digest('hex');
  }

  it('matches a one-shot digest for a file smaller than the read chunk', () => {
    const filePath = path.join(tmpDir, `small-${fixtureCounter++}.bin`);
    const data = Buffer.from('the quick brown fox\n');
    fs.writeFileSync(filePath, data);

    expect(fileSha256(filePath)).toBe(digest('sha256', data));
    expect(fileMd5(filePath)).toBe(digest('md5', data));
  });

  it('matches a one-shot digest across several read chunks', () => {
    // Larger than the 4 MiB internal read window, so the chunk loop runs
    // multiple times and a partial final chunk is hashed.
    const filePath = path.join(tmpDir, `large-${fixtureCounter++}.bin`);
    const data = crypto.randomBytes(4 * 1024 * 1024 + 12_345);
    fs.writeFileSync(filePath, data);

    expect(fileSha256(filePath)).toBe(digest('sha256', data));
    expect(fileMd5(filePath)).toBe(digest('md5', data));
  });

  it('handles an empty file', () => {
    const filePath = path.join(tmpDir, `empty-${fixtureCounter++}.bin`);
    fs.writeFileSync(filePath, Buffer.alloc(0));

    expect(fileSha256(filePath)).toBe(digest('sha256', Buffer.alloc(0)));
    expect(fileMd5(filePath)).toBe(digest('md5', Buffer.alloc(0)));
  });

  it('splices the hash prefix before the extension', () => {
    const sha = 'a'.repeat(52) + 'b'.repeat(12);
    expect(contentAddressedKey('base.mbtiles', '58ce65fc4290' + sha)).toBe(
      'base.58ce65fc4290.mbtiles'
    );
    expect(contentAddressedKey('contours.mbtiles', 'deadbeef1234' + sha)).toBe(
      'contours.deadbeef1234.mbtiles'
    );
  });
});

describe('writeManifest', () => {
  function outDir(name: string): string {
    const dir = path.join(tmpDir, `out-${name}-${fixtureCounter++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const bounds = { west: 138, south: -35, east: 139, north: -31 };

  it('validates each mbtiles entry against its declared zoom range', () => {
    const dir = outDir('bad-zoom');
    const bad = makeMbtiles('contours-bad', { zooms: [0, 5, 8] });
    expect(() =>
      writeManifest('demo', dir, bounds, [
        { name: 'contours.mbtiles', path: bad, expectedZoom: CONTOUR_ZOOM_EXPECTATION },
      ])
    ).toThrow(/expected 9/);
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  it('throws rather than writing a manifest with zero files', () => {
    const dir = outDir('empty-manifest');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() =>
        writeManifest('demo', dir, bounds, [
          { name: 'base.mbtiles', path: path.join(dir, 'base.mbtiles') },
          { name: 'contours.mbtiles', path: path.join(dir, 'contours.mbtiles') },
        ])
      ).toThrow(/refusing to write an empty manifest/);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(false);
  });

  it('warns about a missing file but still writes the files that exist', () => {
    const dir = outDir('partial');
    const contours = makeMbtiles('contours-ok', { zooms: contourZooms });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let manifest;
    try {
      manifest = writeManifest('demo', dir, bounds, [
        { name: 'base.mbtiles', path: path.join(dir, 'base.mbtiles') },
        { name: 'contours.mbtiles', path: contours, expectedZoom: CONTOUR_ZOOM_EXPECTATION },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }

    expect(manifest.files.map(f => f.name)).toEqual(['contours.mbtiles']);
    expect(manifest.totalSize).toBeGreaterThan(0);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    expect(written.trailId).toBe('demo');
    expect(written.files).toHaveLength(1);
  });

  it('records md5 and a content-addressed key for every file', () => {
    const dir = outDir('content-addressed');
    const base = makeMbtiles('base-ok', { zooms: [4, 9, 15] });
    const contours = makeMbtiles('contours-ok', { zooms: contourZooms });

    const manifest = writeManifest('demo', dir, bounds, [
      { name: 'base.mbtiles', path: base },
      { name: 'contours.mbtiles', path: contours, expectedZoom: CONTOUR_ZOOM_EXPECTATION },
    ]);

    const sourcePaths: Record<string, string> = {
      'base.mbtiles': base,
      'contours.mbtiles': contours,
    };

    for (const file of manifest.files) {
      const bytes = fs.readFileSync(sourcePaths[file.name]);

      // Independently computed digests — not just the pipeline agreeing with itself.
      expect(file.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(file.md5).toBe(crypto.createHash('md5').update(bytes).digest('hex'));
      expect(file.size).toBe(bytes.length);

      const stem = file.name.replace(/\.mbtiles$/, '');
      expect(file.key).toBe(`${stem}.${file.sha256!.slice(0, 12)}.mbtiles`);
      expect(file.key).toMatch(/^[a-z]+\.[0-9a-f]{12}\.mbtiles$/);
      // The key is a remote-only alias; the local/on-device filename is unchanged.
      expect(file.name).toBe(`${stem}.mbtiles`);
    }

    // Distinct content must land on distinct keys.
    expect(manifest.files[0].key).not.toBe(manifest.files[1].key);

    const written = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
    expect(written.files).toEqual(manifest.files);
  });

  it('reproduces the same key when rewritten over unchanged files', () => {
    const dir = outDir('stable-key');
    const contours = makeMbtiles('contours-stable', { zooms: contourZooms });
    const input = [
      { name: 'contours.mbtiles', path: contours, expectedZoom: CONTOUR_ZOOM_EXPECTATION },
    ];

    const first = writeManifest('demo', dir, bounds, input);
    const second = writeManifest('demo', dir, bounds, input);

    expect(second.files[0].key).toBe(first.files[0].key);
    expect(second.files[0].md5).toBe(first.files[0].md5);
  });
});
