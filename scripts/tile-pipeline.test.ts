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
  projectedEpsgFor,
  CONTOUR_TIERS,
  CONTOUR_LAYER,
  CONTOUR_TIPPECANOE_DEFAULTS,
  contourTierLayer,
  contourTierLayerArg,
  contourTierFilter,
  contourTierRenameArgs,
  contourTippecanoeArgs,
  contourSettingsHash,
  TIPPECANOE_VERSION,
  parseTippecanoeVersion,
  compareVersions,
  checkTippecanoeVersion,
} from './tile-pipeline';

/**
 * These tests exercise the mbtiles guards with real sqlite databases (the
 * validator shells out to the sqlite3 CLI), but never invoke GDAL or
 * tippecanoe — the fixtures are hand-built tile tables.
 */

// The CLI is not on every machine (it is on GitHub's Ubuntu runners). Without it the
// fixtures cannot be built and the validator has nothing to shell out to, so the
// suites that need it are skipped rather than failed — locally only: in CI a missing
// sqlite3 fails them, so a runner image change cannot quietly skip them.
let hasSqlite3 = true;
try {
  execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
} catch {
  hasSqlite3 = false;
}
const describeWithSqlite3 = describe.skipIf(!hasSqlite3 && !process.env.CI);

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

const contourZooms = Array.from({ length: MAX_ZOOM - CONTOUR_MIN_ZOOM + 1 }, (_, i) => CONTOUR_MIN_ZOOM + i);

describe('projectedEpsgFor', () => {
  it('keeps MGA for Australian trails', () => {
    expect(projectedEpsgFor(138.5, -33.4)).toBe(28354); // Heysen
    expect(projectedEpsgFor(116.0, -33.0)).toBe(28350); // Bibbulmun
  });

  it('uses the southern-hemisphere UTM zone in New Zealand', () => {
    expect(projectedEpsgFor(172.6, -41.0)).toBe(32759);
  });

  it('uses the northern-hemisphere UTM zone in the US', () => {
    expect(projectedEpsgFor(-108.5, 40.0)).toBe(32612); // CDT
  });

  it('clamps the antimeridian to zone 60', () => {
    expect(projectedEpsgFor(180, -40)).toBe(32760);
  });
});

// ---------------------------------------------------------------------------
// Contour tiers
//
// tippecanoe's `-L {"file","layer"}` object has no `minzoom` key: the tiers'
// zoom gating has to go through a per-layer `$zoom` feature filter and a
// tile-join rename, and these pin the three halves of that to each other.
// ---------------------------------------------------------------------------

describe('contour tiers', () => {
  it('partition every 10 m elevation exactly once', () => {
    // Evaluate the SQL `where` clauses in JS: `(CAST(elevation AS INTEGER) % n) = 0`.
    const matches = (where: string, e: number): boolean =>
      new Function(
        'e',
        `return ${where
          .replace(/CAST\(elevation AS INTEGER\)/g, 'e')
          .replace(/ AND /g, ' && ')
          .replace(/(?<![!<>=])=(?!=)/g, '==')};`
      )(e) as boolean;
    for (let e = -200; e <= 3000; e += 10) {
      const tiers = CONTOUR_TIERS.filter(t => matches(t.where, e));
      expect(tiers, `${e} m`).toHaveLength(1);
    }
  });

  it('name each tier layer under the served layer, never as it', () => {
    for (const tier of CONTOUR_TIERS) {
      expect(contourTierLayer(tier)).toBe(`${CONTOUR_LAYER}_${tier.suffix}`);
      expect(contourTierLayer(tier)).not.toBe(CONTOUR_LAYER);
    }
  });

  it('pass tippecanoe only the keys its -L object honours', () => {
    const tier = CONTOUR_TIERS[1];
    expect(JSON.parse(contourTierLayerArg('/tmp/x_z10.fgb', tier))).toEqual({
      file: '/tmp/x_z10.fgb',
      layer: 'contour_z10',
    });
  });

  it('gate every tier above the archive minzoom at its own minzoom, and only those', () => {
    const filter = JSON.parse(contourTierFilter()) as Record<string, unknown>;
    for (const tier of CONTOUR_TIERS) {
      if (tier.minZoom === CONTOUR_MIN_ZOOM) {
        // An unnamed layer passes the filter at every zoom.
        expect(filter).not.toHaveProperty(contourTierLayer(tier));
      } else {
        expect(filter[contourTierLayer(tier)]).toEqual(['>=', '$zoom', tier.minZoom]);
      }
    }
    expect(Object.keys(filter)).toHaveLength(CONTOUR_TIERS.length - 1);
  });

  it('rename every tier layer back to the served layer', () => {
    const args = contourTierRenameArgs();
    expect(args).toHaveLength(CONTOUR_TIERS.length * 2);
    for (const tier of CONTOUR_TIERS) {
      expect(args).toContain(`${contourTierLayer(tier)}:${CONTOUR_LAYER}`);
    }
    expect(args.filter(a => a === '-R')).toHaveLength(CONTOUR_TIERS.length);
  });

  it('tile with the zoom range, the decision-gate bundle and the tier filter by default', () => {
    const args = contourTippecanoeArgs();
    expect(args).toContain(`-Z${CONTOUR_MIN_ZOOM}`);
    expect(args).toContain(`-z${MAX_ZOOM}`);
    expect(args).toContain('--simplification=2');
    expect(args).toContain('--simplify-only-low-zooms');
    expect(args).toContain('--minimum-detail=7');
    expect(args).toContain('--maximum-tile-bytes=1000000');
    expect(args).toContain('--drop-smallest-as-needed');
    expect(args).not.toContain('--visvalingam');
    expect(args[args.indexOf('-j') + 1]).toBe(contourTierFilter());
    expect(CONTOUR_TIPPECANOE_DEFAULTS.tiered).toBe(true);
    // Both served attributes, nothing else.
    const kept = args.flatMap((a, i) => (a === '-y' ? [args[i + 1]] : []));
    expect(kept).toEqual(['elevation', 'is_index']);
  });

  it('let the experiment harness turn the tiers and the algorithm off and on', () => {
    const untiered = contourTippecanoeArgs({ tiered: false, visvalingam: true, maxTileBytes: undefined });
    expect(untiered).not.toContain('-j');
    expect(untiered).toContain('--visvalingam');
    expect(untiered.some(a => a.startsWith('--maximum-tile-bytes'))).toBe(false);
    expect(contourTippecanoeArgs({ simplification: 14, minimumDetail: 4 })).toEqual(
      expect.arrayContaining(['--simplification=14', '--minimum-detail=4'])
    );
  });

  it('is quiet unless verbose', () => {
    expect(contourTippecanoeArgs()).toContain('-q');
    expect(contourTippecanoeArgs({}, { verbose: true })).not.toContain('-q');
  });
});

describe('contourSettingsHash', () => {
  it('is stable and ignores verbosity', () => {
    expect(contourSettingsHash()).toMatch(/^[0-9a-f]{12}$/);
    expect(contourSettingsHash()).toBe(contourSettingsHash({}));
  });

  it('changes with any setting that changes the tiles', () => {
    const base = contourSettingsHash();
    expect(contourSettingsHash({ tiered: false })).not.toBe(base);
    expect(contourSettingsHash({ simplification: 14 })).not.toBe(base);
    expect(contourSettingsHash({ minimumDetail: 4 })).not.toBe(base);
  });
});

describe('tippecanoe version pin', () => {
  it('parses the version tippecanoe prints', () => {
    expect(parseTippecanoeVersion('tippecanoe v2.79.0\n')).toBe('2.79.0');
    expect(parseTippecanoeVersion('2.78.0')).toBe('2.78.0');
    expect(parseTippecanoeVersion('command not found')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('2.79.0', '2.8.1')).toBeGreaterThan(0);
    expect(compareVersions('1.27.13', '1.27.9')).toBeGreaterThan(0);
    expect(compareVersions('2.79.0', '2.79.0')).toBe(0);
  });

  it('fails a release too old for the $zoom tier filter', () => {
    expect(checkTippecanoeVersion('1.26.2', false).status).toBe('fail');
    expect(checkTippecanoeVersion(null, false).status).toBe('fail');
  });

  it('warns on another capable release, and fails it when the pin is required', () => {
    expect(checkTippecanoeVersion(TIPPECANOE_VERSION, true).status).toBe('ok');
    expect(checkTippecanoeVersion('2.82.0', false).status).toBe('warn');
    expect(checkTippecanoeVersion('2.82.0', true).status).toBe('fail');
  });

  it('is the release contours/scripts/remote/bootstrap.sh builds', () => {
    const bootstrap = fs.readFileSync(path.join(__dirname, '../contours/scripts/remote/bootstrap.sh'), 'utf8');
    const m = bootstrap.match(/^TIPPECANOE_REF="\$\{TIPPECANOE_REF:-([^}]+)\}"$/m);
    expect(m?.[1]).toBe(TIPPECANOE_VERSION);
  });
});

describeWithSqlite3('validateMbtilesArtifact (needs the sqlite3 CLI)', () => {
  it('accepts a well-formed contour artifact against the contour expectation', () => {
    const file = makeMbtiles('contours', { zooms: contourZooms });
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).not.toThrow();
  });

  it('rejects a contour artifact built without the -Z flag (the z0–z8 incident)', () => {
    // Self-consistent metadata (minzoom=0 matches the tiles present), which is
    // exactly why the pre-expectation validator waved this through.
    const file = makeMbtiles('contours-noZ', { zooms: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
    expect(() => validateMbtilesArtifact(file)).not.toThrow();
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).toThrow(/lowest tile zoom is 0, expected 9/);
  });

  it('rejects an artifact missing the top of its zoom range', () => {
    const file = makeMbtiles('base-truncated', { zooms: [4, 5, 6, 7, 8] });
    expect(() => validateMbtilesArtifact(file, BASE_ZOOM_EXPECTATION)).toThrow(/highest tile zoom is 8, expected 15/);
  });

  it('rejects metadata minzoom that disagrees with the tiles table', () => {
    const file = makeMbtiles('meta-min-lie', { zooms: contourZooms, metaMinZoom: 0 });
    expect(() => validateMbtilesArtifact(file)).toThrow(/metadata minzoom=0 but lowest tile zoom is 9/);
  });

  it('rejects metadata maxzoom that disagrees with the tiles table', () => {
    const file = makeMbtiles('meta-max-lie', { zooms: contourZooms, metaMaxZoom: 14 });
    expect(() => validateMbtilesArtifact(file)).toThrow(/metadata maxzoom=14 but highest tile zoom is 15/);
  });

  it('still enforces the expected range when metadata zoom rows are absent', () => {
    const file = makeMbtiles('no-meta-zoom', {
      zooms: [0, 1, 2],
      metaMinZoom: null,
      metaMaxZoom: null,
    });
    expect(() => validateMbtilesArtifact(file, CONTOUR_ZOOM_EXPECTATION)).toThrow(/expected 9/);
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
    expect(contentAddressedKey('base.mbtiles', '58ce65fc4290' + sha)).toBe('base.58ce65fc4290.mbtiles');
    expect(contentAddressedKey('contours.mbtiles', 'deadbeef1234' + sha)).toBe('contours.deadbeef1234.mbtiles');
  });
});

describeWithSqlite3('writeManifest (needs the sqlite3 CLI)', () => {
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
    const input = [{ name: 'contours.mbtiles', path: contours, expectedZoom: CONTOUR_ZOOM_EXPECTATION }];

    const first = writeManifest('demo', dir, bounds, input);
    const second = writeManifest('demo', dir, bounds, input);

    expect(second.files[0].key).toBe(first.files[0].key);
    expect(second.files[0].md5).toBe(first.files[0].md5);
  });
});
