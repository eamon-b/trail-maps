import { describe, expect, it } from 'vitest';
import { describeDiff, localDataProblems, parseArgs } from './publish-trail-data.js';
import { buildCatalog, diffCatalogs, digestTrailFile, type MobileIndexEntry } from './lib/trail-data-catalog.js';

function trailFile(id: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({ config: { id }, waypoints: [], track: { points: [] }, ...extra }));
}

function indexFor(files: Record<string, Buffer>): MobileIndexEntry[] {
  return Object.entries(files).map(([id, bytes]) => ({
    id,
    name: id,
    shortName: id,
    lengthKm: 10,
    dataVersion: '2026-10-06',
    updatedAt: '2026-10-06T00:00:00.000Z',
    ...digestTrailFile(bytes),
  }));
}

describe('parseArgs', () => {
  it('reads the three flags and refuses anything else', () => {
    expect(parseArgs([])).toEqual({ all: false, dryRun: false, check: false });
    expect(parseArgs(['--dry-run', '--all'])).toEqual({ all: true, dryRun: true, check: false });
    expect(parseArgs(['--check']).check).toBe(true);
    expect(() => parseArgs(['--force'])).toThrow(/Unknown argument/);
  });
});

describe('localDataProblems', () => {
  const files = { a: trailFile('a'), b: trailFile('b') };

  it('passes when the index describes the files exactly', () => {
    expect(localDataProblems(indexFor(files), id => files[id as 'a' | 'b'])).toEqual([]);
  });

  it('fails a file whose bytes the index does not match', () => {
    const index = indexFor(files);
    const edited = { ...files, b: trailFile('b', { extra: 1 }) };
    const problems = localDataProblems(index, id => edited[id as 'a' | 'b']);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^b\.json: index\.json says md5/);
  });

  it('fails a missing file, a file that is another trail, and a reserved id', () => {
    expect(localDataProblems(indexFor(files), id => (id === 'a' ? files.a : undefined))).toEqual([
      'b.json: listed in index.json but missing',
    ]);
    const swapped = { a: trailFile('b') };
    expect(localDataProblems(indexFor(swapped), () => swapped.a)[0]).toMatch(/config\.id/);
    const reserved = { u_mine: trailFile('u_mine') };
    expect(localDataProblems(indexFor(reserved), () => reserved.u_mine)[0]).toMatch(/reserved/);
  });
});

describe('describeDiff', () => {
  it('names each trail that differs and how', () => {
    const [a, b] = indexFor({ a: trailFile('a'), b: trailFile('b') });
    const live = buildCatalog([a, b], new Date());
    const local = buildCatalog([{ ...a, name: 'A walk' }, { ...b, id: 'c' }], new Date());
    const lines = describeDiff(diffCatalogs(local, live), local, live);
    expect(lines).toEqual([
      expect.stringMatching(/^ {2}\+ c: new/),
      '  ~ a: name "a" -> "A walk"',
      '  - b: in the live catalog, not in index.json',
    ]);
  });
});
