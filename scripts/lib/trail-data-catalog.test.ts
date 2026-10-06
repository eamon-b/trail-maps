import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  CATALOG_KEY,
  buildCatalog,
  catalogKey,
  catalogsDiffer,
  diffCatalogs,
  digestTrailFile,
  indexProblems,
  mergeIndexEntry,
  parseAllowedTrails,
  parseCatalog,
  planUpload,
  previousIndexById,
  serializeIndex,
  sourceCommitVerdict,
  trailFileProblems,
  trailIdProblem,
  unapprovedRemovals,
  type MobileIndexEntry,
} from './trail-data-catalog.js';

const ROOT = path.resolve(__dirname, '..', '..');
const NOW = new Date('2026-10-06T05:06:07.890Z');
const BASE = { id: 'shikoku', name: 'Shikoku Henro', shortName: 'Henro', lengthKm: 154.1 };

function entry(overrides: Partial<MobileIndexEntry> = {}): MobileIndexEntry {
  return {
    ...BASE,
    dataVersion: '2026-09-01',
    updatedAt: '2026-09-01T00:00:00.000Z',
    md5: 'a'.repeat(32),
    bytes: 100,
    ...overrides,
  };
}

describe('digestTrailFile', () => {
  it('hashes the UTF-8 bytes, and counts bytes rather than characters', () => {
    expect(digestTrailFile('')).toEqual({ md5: 'd41d8cd98f00b204e9800998ecf8427e', bytes: 0 });
    // "é" is one character, two bytes.
    expect(digestTrailFile('é').bytes).toBe(2);
    expect(digestTrailFile('é')).toEqual(digestTrailFile(Buffer.from('é', 'utf-8')));
  });
});

describe('mergeIndexEntry', () => {
  const digest = { md5: 'b'.repeat(32), bytes: 200 };

  it('keeps updatedAt and dataVersion while the content is unchanged', () => {
    const previous = entry({ md5: digest.md5, bytes: digest.bytes });
    const merged = mergeIndexEntry({ ...BASE, name: 'Renamed' }, digest, previous, NOW);
    expect(merged).toEqual({ ...previous, name: 'Renamed' });
  });

  it('stamps now when the content changed', () => {
    const merged = mergeIndexEntry(BASE, digest, entry(), NOW);
    expect(merged.updatedAt).toBe('2026-10-06T05:06:07.890Z');
    expect(merged.dataVersion).toBe('2026-10-06');
    expect(merged.md5).toBe(digest.md5);
    expect(merged.bytes).toBe(200);
  });

  it('stamps now for a new trail, or a previous entry from before md5s', () => {
    expect(mergeIndexEntry(BASE, digest, undefined, NOW).updatedAt).toBe(NOW.toISOString());
    const legacy = { ...BASE, dataVersion: '2026-09-01' };
    expect(mergeIndexEntry(BASE, digest, legacy, NOW).dataVersion).toBe('2026-10-06');
  });

  it('writes the fields in the contract order', () => {
    expect(Object.keys(mergeIndexEntry(BASE, digest, undefined, NOW))).toEqual([
      'id', 'name', 'shortName', 'lengthKm', 'dataVersion', 'updatedAt', 'md5', 'bytes',
    ]);
  });
});

describe('previousIndexById', () => {
  it('reads entries by id', () => {
    const map = previousIndexById(serializeIndex([entry()]));
    expect(map.get('shikoku')?.md5).toBe('a'.repeat(32));
  });

  it('treats a missing or unreadable index as empty', () => {
    expect(previousIndexById(undefined).size).toBe(0);
    expect(previousIndexById('not json').size).toBe(0);
    expect(previousIndexById('{"id":"x"}').size).toBe(0);
  });
});

describe('buildCatalog', () => {
  it('adds a content-addressed key per trail, in index order', () => {
    const index = [entry({ id: 'b', md5: '0123456789abcdef0123456789abcdef' }), entry({ id: 'a' })];
    const catalog = buildCatalog(index, NOW);
    expect(catalog.format).toBe(1);
    expect(catalog.generatedAt).toBe(NOW.toISOString());
    expect(catalog.trails.map(t => t.id)).toEqual(['b', 'a']);
    expect(catalog.trails[0]).toEqual({ ...index[0], key: 'b.0123456789ab.json' });
    expect(catalogKey('a', 'f'.repeat(32))).toBe('a.ffffffffffff.json');
    expect(CATALOG_KEY).toBe('trails/v1/catalog.json');
  });
});

describe('buildCatalog sourceCommit', () => {
  const commit = 'c'.repeat(40);

  it('records the commit only when known', () => {
    expect(buildCatalog([entry()], NOW, commit).sourceCommit).toBe(commit);
    expect('sourceCommit' in buildCatalog([entry()], NOW, null)).toBe(false);
    expect('sourceCommit' in buildCatalog([entry()], NOW)).toBe(false);
  });

  it('is ignored by the diff, so a new commit alone never re-publishes', () => {
    const live = buildCatalog([entry()], NOW, 'a'.repeat(40));
    const local = buildCatalog([entry()], NOW, commit);
    expect(catalogsDiffer(diffCatalogs(local, live))).toBe(false);
  });
});

describe('unapprovedRemovals', () => {
  it('names live trails the local catalog drops, unless --remove named them', () => {
    const live = buildCatalog([entry({ id: 'a' }), entry({ id: 'b' }), entry({ id: 'c' })], NOW);
    const local = buildCatalog([entry({ id: 'a' })], NOW);
    const diff = diffCatalogs(local, live);
    expect(unapprovedRemovals(diff, new Set())).toEqual(['b', 'c']);
    expect(unapprovedRemovals(diff, new Set(['b']))).toEqual(['c']);
    expect(unapprovedRemovals(diff, new Set(['b', 'c']))).toEqual([]);
    expect(unapprovedRemovals(diffCatalogs(local, null), new Set())).toEqual([]);
  });
});

describe('sourceCommitVerdict', () => {
  const live = 'a'.repeat(40);
  const head = 'b'.repeat(40);

  it('passes when the live commit is in HEAD\'s history, or is HEAD', () => {
    expect(sourceCommitVerdict(live, head, true)).toEqual({ kind: 'ok' });
    expect(sourceCommitVerdict(head, head, null)).toEqual({ kind: 'ok' });
  });

  it('refuses a checkout that has not seen the live publish', () => {
    // The regression: a stale checkout that rebuilt stamps its files `now`,
    // so the updatedAt rollback check let it revert newer live data.
    expect(sourceCommitVerdict(live, head, false).kind).toBe('refuse');
    expect(sourceCommitVerdict(live, head, null)).toEqual({
      kind: 'refuse',
      message: expect.stringMatching(/does not have/),
    });
  });

  it('has nothing to compare against a catalog without a commit', () => {
    expect(sourceCommitVerdict(undefined, head, null)).toEqual({ kind: 'ok' });
    expect(sourceCommitVerdict(undefined, null, null)).toEqual({ kind: 'ok' });
  });

  it('warns, rather than refusing, when git cannot read HEAD', () => {
    expect(sourceCommitVerdict(live, null, null).kind).toBe('warn');
  });
});

describe('validation', () => {
  it('accepts plain trail ids and refuses unsafe or reserved ones', () => {
    expect(trailIdProblem('hume-and-hovell')).toBeNull();
    expect(trailIdProblem('great_north_walk')).toBeNull();
    expect(trailIdProblem('u_abc')).toMatch(/reserved/);
    expect(trailIdProblem('../etc')).not.toBeNull();
    expect(trailIdProblem('')).not.toBeNull();
    expect(trailIdProblem('x'.repeat(65))).not.toBeNull();
  });

  it('checks every index entry field and duplicate ids', () => {
    expect(indexProblems([entry()])).toEqual([]);
    expect(indexProblems([])).toEqual(['index.json lists no trails']);
    expect(indexProblems([entry(), entry()])).toEqual(['trail id "shikoku" is listed twice']);
    const bad = indexProblems([{ id: 'x', name: 'X', shortName: 'X', lengthKm: 1, dataVersion: '2026-10-06' }]);
    expect(bad.join('\n')).toMatch(/updatedAt/);
    expect(bad.join('\n')).toMatch(/md5/);
    expect(bad.join('\n')).toMatch(/bytes/);
  });

  it('requires a trail file to be the trail it is listed as', () => {
    const good = { config: { id: 'shikoku' }, waypoints: [], track: { points: [{ lat: 33, lon: 134 }] } };
    expect(trailFileProblems('shikoku', good)).toEqual([]);
    expect(trailFileProblems('shikoku', { ...good, track: { points: [] } })).toEqual([
      'shikoku.json: track.points is empty',
    ]);
    expect(trailFileProblems('shikoku', { ...good, config: { id: 'heysen' } })).toHaveLength(1);
    expect(trailFileProblems('shikoku', { config: { id: 'shikoku' } })).toHaveLength(2);
    expect(trailFileProblems('shikoku', [])).toHaveLength(1);
  });
});

describe('parseCatalog', () => {
  it('reads a format-1 catalog and refuses anything else', () => {
    const catalog = buildCatalog([entry()], NOW);
    expect(parseCatalog(JSON.stringify(catalog))).toEqual(catalog);
    expect(() => parseCatalog(JSON.stringify({ ...catalog, format: 2 }))).toThrow(/format/);
    expect(() => parseCatalog('{"format":1}')).toThrow(/trails/);
    expect(() => parseCatalog('<html>')).toThrow();
  });

  it('reads a sourceCommit and refuses one that is not a commit id', () => {
    const catalog = buildCatalog([entry()], NOW, 'd'.repeat(40));
    expect(parseCatalog(JSON.stringify(catalog)).sourceCommit).toBe('d'.repeat(40));
    expect(() => parseCatalog(JSON.stringify({ ...catalog, sourceCommit: 'main' }))).toThrow(
      /sourceCommit/
    );
  });
});

describe('planUpload', () => {
  const a = entry({ id: 'a', md5: '1'.repeat(32) });
  const b = entry({ id: 'b', md5: '2'.repeat(32) });
  const live = buildCatalog([a, b], new Date('2026-09-01T00:00:00Z'));

  it('uploads every file and the catalog when nothing is live yet', () => {
    const plan = planUpload(buildCatalog([a, b], NOW), null);
    expect(plan.files.map(t => t.id)).toEqual(['a', 'b']);
    expect(plan.uploadCatalog).toBe(true);
    expect(plan.diff.added).toEqual(['a', 'b']);
  });

  it('uploads nothing when the live catalog matches, whatever its generatedAt', () => {
    const plan = planUpload(buildCatalog([a, b], NOW), live);
    expect(plan.files).toEqual([]);
    expect(plan.uploadCatalog).toBe(false);
  });

  it('uploads every file and the catalog with --all', () => {
    const plan = planUpload(buildCatalog([a, b], NOW), live, { all: true });
    expect(plan.files).toHaveLength(2);
    expect(plan.uploadCatalog).toBe(true);
  });

  it('uploads only the changed file, then the catalog', () => {
    const b2 = { ...b, md5: '3'.repeat(32), updatedAt: NOW.toISOString(), dataVersion: '2026-10-06' };
    const plan = planUpload(buildCatalog([a, b2], NOW), live);
    expect(plan.files.map(t => t.key)).toEqual(['b.333333333333.json']);
    expect(plan.uploadCatalog).toBe(true);
    expect(plan.diff.changed).toEqual(['b']);
  });

  it('republishes the catalog alone for a metadata-only change', () => {
    const plan = planUpload(buildCatalog([{ ...a, name: 'Renamed' }, b], NOW), live);
    expect(plan.files).toEqual([]);
    expect(plan.uploadCatalog).toBe(true);
    expect(plan.diff.changed).toEqual(['a']);
  });

  it('notices a removed or reordered trail', () => {
    const removed = diffCatalogs(buildCatalog([a], NOW), live);
    expect(removed.removed).toEqual(['b']);
    expect(catalogsDiffer(removed)).toBe(true);
    const reordered = diffCatalogs(buildCatalog([b, a], NOW), live);
    expect(reordered.reordered).toBe(true);
    expect(catalogsDiffer(reordered)).toBe(true);
  });
});

describe('the committed mobile index', () => {
  const dir = path.join(ROOT, 'mobile', 'assets', 'trails');
  const text = fs.readFileSync(path.join(dir, 'index.json'), 'utf-8');
  const index = JSON.parse(text) as MobileIndexEntry[];

  it('is well formed and written the way build-mobile-trails writes it', () => {
    expect(indexProblems(index)).toEqual([]);
    expect(serializeIndex(index)).toBe(text);
  });

  it('describes the committed trail files byte for byte', () => {
    for (const trail of index) {
      const digest = digestTrailFile(fs.readFileSync(path.join(dir, `${trail.id}.json`)));
      expect({ id: trail.id, ...digest }).toEqual({ id: trail.id, md5: trail.md5, bytes: trail.bytes });
      expect(trail.updatedAt.slice(0, 10)).toBe(trail.dataVersion);
    }
  });
});

describe('parseAllowedTrails', () => {
  it('reads the array literal', () => {
    const source = "export const ALLOWED_TRAILS: readonly string[] = [\n  'aawt',\n  \"cdt\",\n];";
    expect(parseAllowedTrails(source)).toEqual(['aawt', 'cdt']);
    expect(() => parseAllowedTrails('nothing here')).toThrow();
  });
});
