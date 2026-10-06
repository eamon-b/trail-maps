/**
 * Over-the-air trail data: the I/O half (`trail-data-updates`). The decisions
 * themselves (`planTrailDataSync`, `isNewer`) have their own pure spec; this
 * one drives them through a fake disk, a fake R2 and a fake catalog endpoint,
 * and checks the guarantees the module documents:
 *
 * - a copy is only ever replaced by a strictly newer one, and only after it
 *   has passed the size, MD5 and shape checks — a failed download leaves the
 *   previous copy and no `.part` file behind;
 * - the check is throttled (6 h, 5 min after a failure) and single-flight;
 * - catalog-only trails are listed and server-known, but downloaded only when
 *   opened;
 * - the state file survives a restart, a torn one reads as empty, and files the
 *   state does not name are swept.
 *
 * expo-file-system is mocked locally with classes rather than `jest.fn()`
 * factories: `sweepOrphans` walks `Directory.list()` with `instanceof File`,
 * which a plain object returned from a mock constructor would fail.
 */

import { createHash } from 'crypto';

import {
  activeDownload,
  checkForTrailDataUpdates,
  ensureTrailDownloaded,
  initTrailData,
  listRemoteTrails,
  readDownloadedTrail,
  resetTrailDataStateForTests,
  CHECK_INTERVAL_MS,
} from '../trail-data-updates';
import { isServerKnown, registerRemoteTrailIds } from '../server-trails';
import type { CatalogEntry } from '../trail-catalog';
import { useTrailDataStore } from '../../state/trail-data-store';
import { File } from 'expo-file-system';

// ---------------------------------------------------------------------------
// Fake disk + fake R2
// ---------------------------------------------------------------------------

/** uri → file contents. */
const mockFiles: Record<string, string> = {};
/** Directory uris that exist. */
const mockDirs: Record<string, boolean> = {};
/** Published objects: URL → body. A URL that is absent 404s. */
const mockRemote: Record<string, string> = {};
/** Where each download was written, captured at call time (the File is renamed after). */
const mockDownloadTargets: string[] = [];

jest.mock('expo-file-system', () => {
  const { createHash: hash } = jest.requireActual('crypto') as typeof import('crypto');

  function join(args: unknown[]): string {
    const parts: string[] = [];
    for (const a of args) {
      if (typeof a === 'string') {
        parts.push(a.replace('file://', '').replace(/\/$/, ''));
      } else if (a && typeof a === 'object' && 'uri' in a) {
        parts.push((a as { uri: string }).uri.replace('file://', '').replace(/\/$/, ''));
      }
    }
    return 'file://' + parts.join('/');
  }

  function parentOf(uri: string): string {
    return uri.slice(0, uri.lastIndexOf('/'));
  }

  class MockFile {
    uri: string;

    constructor(...args: unknown[]) {
      this.uri = join(args);
    }

    get exists(): boolean {
      return mockFiles[this.uri] !== undefined;
    }

    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }

    get size(): number {
      return Buffer.byteLength(mockFiles[this.uri] ?? '');
    }

    textSync(): string {
      if (mockFiles[this.uri] === undefined) throw new Error('ENOENT');
      return mockFiles[this.uri];
    }

    async text(): Promise<string> {
      return this.textSync();
    }

    write(data: string): void {
      if (!mockDirs[parentOf(this.uri)]) throw new Error('ENOENT: parent directory missing');
      mockFiles[this.uri] = data;
    }

    delete(): void {
      if (mockFiles[this.uri] === undefined) throw new Error('ENOENT');
      delete mockFiles[this.uri];
    }

    /** Native semantics: throws on a missing source or an existing target. */
    rename(newName: string): void {
      const target = `${parentOf(this.uri)}/${newName}`;
      if (mockFiles[this.uri] === undefined) throw new Error('rename: source missing');
      if (mockFiles[target] !== undefined) throw new Error('rename: target exists');
      mockFiles[target] = mockFiles[this.uri];
      delete mockFiles[this.uri];
      this.uri = target;
    }

    info(options?: { md5?: boolean }): { exists: boolean; size?: number; md5?: string } {
      const data = mockFiles[this.uri];
      if (data === undefined) return { exists: false };
      return {
        exists: true,
        size: Buffer.byteLength(data),
        ...(options?.md5 ? { md5: hash('md5').update(data).digest('hex') } : {}),
      };
    }

    static downloadFileAsync = jest.fn(async (url: string, destination: MockFile) => {
      const body = mockRemote[url];
      mockDownloadTargets.push(destination.uri);
      if (body === undefined) throw new Error(`404 ${url}`);
      destination.write(body);
      return destination;
    });
  }

  class MockDirectory {
    uri: string;

    constructor(...args: unknown[]) {
      this.uri = join(args);
    }

    get exists(): boolean {
      return mockDirs[this.uri] === true;
    }

    create(): void {
      mockDirs[this.uri] = true;
    }

    list(): MockFile[] {
      return Object.keys(mockFiles)
        .filter((uri) => parentOf(uri) === this.uri)
        .map((uri) => new MockFile(uri));
    }
  }

  return {
    __esModule: true,
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: '/mock/document', cache: '/mock/cache' },
  };
});

// Two bundled trails. `server-trails` and `trail-data-updates` both read this.
jest.mock(
  '../../../assets/trails/index.json',
  () => [
    {
      id: 'alpha',
      name: 'Alpha Track',
      shortName: 'Alpha',
      lengthKm: 100,
      dataVersion: '2026-09-01',
      updatedAt: '2026-09-01T00:00:00.000Z',
      md5: 'a'.repeat(32),
      bytes: 1000,
    },
    {
      id: 'beta',
      name: 'Beta Walk',
      shortName: 'Beta',
      lengthKm: 50,
      dataVersion: '2026-09-01',
      updatedAt: '2026-09-01T00:00:00.000Z',
      md5: 'b'.repeat(32),
      bytes: 500,
    },
  ],
  { virtual: true },
);

const mockDownload = (File as unknown as { downloadFileAsync: jest.Mock }).downloadFileAsync;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE = 'https://data.example.test';
const TRAILS_URL = `${BASE}/trails/v1`;
const ROOT = 'file:///mock/document/trail-data';
const STATE_URI = `${ROOT}/state.json`;
/** A realistic clock: `lastAttemptAt` starts at 0, so tiny `now`s would read as "just retried". */
const T0 = Date.parse('2026-10-06T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function trailBody(id: string, label = 'v'): string {
  return JSON.stringify({
    config: { id, name: `${id} ${label}`, shortName: id, region: 'R', lengthKm: 1 },
    waypoints: [{ id: 'w_1', name: label, lat: 0, lon: 0, type: 'water' }],
    track: { points: [{ lat: 0, lon: 0, ele: 1, dist: 0 }] },
  });
}

/**
 * Publish a trail to the fake R2 and return its catalog entry. `body` is what
 * is served; `md5`/`bytes` override what the catalog claims about it.
 */
function publish(
  id: string,
  updatedAt: string,
  options: { body?: string; md5?: string; bytes?: number; name?: string; lengthKm?: number } = {},
): CatalogEntry {
  const body = options.body ?? trailBody(id, updatedAt);
  const sum = md5(body);
  // Keyed by the md5 the catalog advertises, as the publish script keys it: a
  // wrong `md5` option serves this body under the key that md5 names.
  const key = `${id}.${(options.md5 ?? sum).slice(0, 12)}.json`;
  mockRemote[`${TRAILS_URL}/${key}`] = body;
  return {
    id,
    name: options.name ?? `${id} name`,
    shortName: id,
    lengthKm: options.lengthKm ?? 10,
    updatedAt,
    md5: options.md5 ?? sum,
    bytes: options.bytes ?? Buffer.byteLength(body),
    key,
  };
}

function catalogOf(trails: unknown[]) {
  return { format: 1, generatedAt: '2026-10-06T00:00:00.000Z', trails };
}

const fetchMock = jest.fn();

function serveCatalog(trails: unknown[]): void {
  fetchMock.mockImplementation(async () => ({
    ok: true,
    status: 200,
    json: async () => catalogOf(trails),
  }));
}

function failCatalog(): void {
  fetchMock.mockImplementation(async () => {
    throw new TypeError('Network request failed');
  });
}

function savedState(): {
  catalog: { trails: { id: string }[] } | null;
  lastCheckedAt: number | null;
  installed: Record<string, { file: string; updatedAt: string }>;
} {
  return JSON.parse(mockFiles[STATE_URI]);
}

function filesInRoot(): string[] {
  return Object.keys(mockFiles)
    .filter((uri) => uri.startsWith(`${ROOT}/`))
    .map((uri) => uri.slice(ROOT.length + 1))
    .sort();
}

/** Simulate an app restart: forget memory, keep the disk. */
function restart(): void {
  resetTrailDataStateForTests();
}

const realFetch = global.fetch;
const realBaseUrl = process.env.EXPO_PUBLIC_TILE_BASE_URL;

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  global.fetch = realFetch;
  if (realBaseUrl === undefined) delete process.env.EXPO_PUBLIC_TILE_BASE_URL;
  else process.env.EXPO_PUBLIC_TILE_BASE_URL = realBaseUrl;
});

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockDirs)) delete mockDirs[k];
  for (const k of Object.keys(mockRemote)) delete mockRemote[k];
  mockDownloadTargets.length = 0;
  mockDirs['file:///mock/document'] = true;
  jest.clearAllMocks();
  fetchMock.mockReset();
  serveCatalog([]);
  process.env.EXPO_PUBLIC_TILE_BASE_URL = `${BASE}/`;
  resetTrailDataStateForTests();
  registerRemoteTrailIds([]);
  useTrailDataStore.setState({ revision: 0, checking: false, downloading: {} });
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('without a tile base URL', () => {
  beforeEach(() => {
    delete process.env.EXPO_PUBLIC_TILE_BASE_URL;
  });

  it('skips the check without touching the network', async () => {
    await expect(checkForTrailDataUpdates({ force: true, now: T0 })).resolves.toEqual({
      checked: false,
      updated: [],
      failed: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useTrailDataStore.getState().checking).toBe(false);
  });

  it('cannot download a catalog-only trail', async () => {
    await expect(ensureTrailDownloaded('gamma')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('updating a bundled trail', () => {
  it('downloads a newer catalog copy and makes it the one to read', async () => {
    const entry = publish('alpha', '2026-10-01T00:00:00.000Z', { name: 'Alpha Track (fixed)' });
    serveCatalog([entry]);

    const result = await checkForTrailDataUpdates({ now: T0 });

    expect(result).toEqual({ checked: true, updated: ['alpha'], failed: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${TRAILS_URL}/catalog\\.json\\?m=\\d+$`)),
      expect.anything(),
    );
    expect(mockDownload).toHaveBeenCalledWith(
      `${TRAILS_URL}/${entry.key}`,
      expect.anything(),
      { idempotent: true },
    );
    // Written to a part file first, never straight over a working copy.
    expect(mockDownloadTargets).toEqual([`${ROOT}/${entry.key}.part`]);

    // Promoted from the part file, named by the state.
    expect(filesInRoot()).toEqual([entry.key, 'state.json'].sort());
    const state = savedState();
    expect(state.lastCheckedAt).toBe(T0);
    expect(state.installed.alpha).toEqual(expect.objectContaining({ file: entry.key, md5: entry.md5 }));

    expect(activeDownload('alpha')).toEqual(
      expect.objectContaining({ id: 'alpha', name: 'Alpha Track (fixed)', file: entry.key }),
    );
    const json = await readDownloadedTrail('alpha');
    expect(json?.config.id).toBe('alpha');
    expect(json?.waypoints[0].name).toBe('2026-10-01T00:00:00.000Z');

    // Untouched trail: nothing downloaded, nothing to read.
    expect(activeDownload('beta')).toBeNull();
    await expect(readDownloadedTrail('beta')).resolves.toBeNull();

    // The UI was told, and no spinner is left on.
    const status = useTrailDataStore.getState();
    expect(status.revision).toBeGreaterThan(0);
    expect(status.checking).toBe(false);
    expect(status.downloading).toEqual({});
  });

  it.each([
    ['older', '2026-08-01T00:00:00.000Z'],
    ['equal', '2026-09-01T00:00:00.000Z'],
  ])('does not download an %s catalog entry', async (_label, updatedAt) => {
    serveCatalog([publish('alpha', updatedAt)]);

    const result = await checkForTrailDataUpdates({ now: T0 });

    expect(result).toEqual({ checked: true, updated: [], failed: [] });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(activeDownload('alpha')).toBeNull();
    expect(filesInRoot()).toEqual(['state.json']);
  });

  it('deletes the previous file once an update to a new key is in place', async () => {
    const v2 = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([v2]);
    await checkForTrailDataUpdates({ now: T0 });

    const v3 = publish('alpha', '2026-10-05T00:00:00.000Z');
    serveCatalog([v3]);
    const result = await checkForTrailDataUpdates({ force: true, now: T0 + HOUR });

    expect(result.updated).toEqual(['alpha']);
    expect(filesInRoot()).toEqual([v3.key, 'state.json'].sort());
    expect(savedState().installed.alpha.file).toBe(v3.key);
    expect(activeDownload('alpha')?.updatedAt).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('a download that fails its checks', () => {
  let v2: CatalogEntry;

  beforeEach(async () => {
    v2 = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([v2]);
    await checkForTrailDataUpdates({ now: T0 });
    expect(activeDownload('alpha')?.file).toBe(v2.key);
  });

  async function expectPreviousCopyKept(bad: CatalogEntry) {
    serveCatalog([bad]);
    const result = await checkForTrailDataUpdates({ force: true, now: T0 + HOUR });

    expect(result).toEqual({ checked: true, updated: [], failed: ['alpha'] });
    expect(mockDownload).toHaveBeenLastCalledWith(
      `${TRAILS_URL}/${bad.key}`,
      expect.anything(),
      expect.anything(),
    );
    // No part file, no half-promoted file: only the old copy and the state.
    expect(filesInRoot()).toEqual([v2.key, 'state.json'].sort());
    expect(savedState().installed.alpha.file).toBe(v2.key);
    expect(activeDownload('alpha')?.file).toBe(v2.key);
    await expect(readDownloadedTrail('alpha')).resolves.toEqual(
      expect.objectContaining({ config: expect.objectContaining({ id: 'alpha' }) }),
    );
    expect(useTrailDataStore.getState().downloading).toEqual({});
    // Not stamped as checked, so the next automatic check retries it.
    expect(savedState().lastCheckedAt).toBe(T0);
  }

  it('rejects an MD5 mismatch', async () => {
    await expectPreviousCopyKept(
      publish('alpha', '2026-10-05T00:00:00.000Z', { md5: '0'.repeat(32) }),
    );
  });

  it('rejects a size mismatch', async () => {
    const entry = publish('alpha', '2026-10-05T00:00:00.000Z');
    await expectPreviousCopyKept({ ...entry, bytes: entry.bytes + 1 });
  });

  it('rejects a file that is a different trail', async () => {
    await expectPreviousCopyKept(
      publish('alpha', '2026-10-05T00:00:00.000Z', { body: trailBody('beta', 'imposter') }),
    );
  });

  it('rejects a body with no track', async () => {
    await expectPreviousCopyKept(
      publish('alpha', '2026-10-05T00:00:00.000Z', {
        body: JSON.stringify({ config: { id: 'alpha' }, waypoints: [], track: { points: [] } }),
      }),
    );
  });

  it('keeps the previous copy when the object is missing (404)', async () => {
    const entry = publish('alpha', '2026-10-05T00:00:00.000Z');
    delete mockRemote[`${TRAILS_URL}/${entry.key}`];
    await expectPreviousCopyKept(entry);
  });

  it('throws from ensureTrailDownloaded for a catalog-only trail, leaving no part file', async () => {
    serveCatalog([publish('gamma', '2026-10-01T00:00:00.000Z', { md5: 'f'.repeat(32) })]);
    await checkForTrailDataUpdates({ force: true, now: T0 + HOUR });

    await expect(ensureTrailDownloaded('gamma')).rejects.toThrow('Checksum mismatch');
    expect(filesInRoot()).toEqual([v2.key, 'state.json'].sort());
    expect(activeDownload('gamma')).toBeNull();
  });
});

describe('throttling', () => {
  it('reaches the network at most once per interval unless forced', async () => {
    serveCatalog([]);

    await expect(checkForTrailDataUpdates({ now: T0 })).resolves.toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(checkForTrailDataUpdates({ now: T0 + HOUR })).resolves.toEqual(
      expect.objectContaining({ checked: false }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(checkForTrailDataUpdates({ force: true, now: T0 + HOUR })).resolves.toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The forced check reset the clock: still throttled 5 h later.
    await checkForTrailDataUpdates({ now: T0 + HOUR + CHECK_INTERVAL_MS - MINUTE });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await checkForTrailDataUpdates({ now: T0 + HOUR + CHECK_INTERVAL_MS });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats a last check stamped in the future (a wrong clock) as stale', async () => {
    serveCatalog([]);
    await checkForTrailDataUpdates({ now: T0 + 48 * HOUR });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    restart();
    await checkForTrailDataUpdates({ now: T0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('remembers the last check across a restart', async () => {
    await checkForTrailDataUpdates({ now: T0 });
    restart();
    await checkForTrailDataUpdates({ now: T0 + HOUR });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not record a failed check, but waits 5 minutes before retrying', async () => {
    failCatalog();
    const failed = await checkForTrailDataUpdates({ now: T0 });
    expect(failed).toEqual(
      expect.objectContaining({ checked: false, error: 'Network request failed' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Nothing was written: lastCheckedAt is still unset.
    expect(mockFiles[STATE_URI]).toBeUndefined();

    await checkForTrailDataUpdates({ now: T0 + 4 * MINUTE });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await checkForTrailDataUpdates({ force: true, now: T0 + 4 * MINUTE });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Past the retry interval (counted from the forced attempt) an automatic
    // check goes out again — the 6 h throttle does not apply to a failure.
    serveCatalog([]);
    await expect(checkForTrailDataUpdates({ now: T0 + 10 * MINUTE })).resolves.toEqual(
      expect.objectContaining({ checked: true }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(savedState().lastCheckedAt).toBe(T0 + 10 * MINUTE);
  });

  it('treats a non-OK response and an unreadable catalog as failures', async () => {
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    await expect(checkForTrailDataUpdates({ force: true, now: T0 })).resolves.toEqual(
      expect.objectContaining({ checked: false, error: 'Catalog request failed (503)' }),
    );

    fetchMock.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ format: 2, trails: [] }),
    }));
    await expect(checkForTrailDataUpdates({ force: true, now: T0 })).resolves.toEqual(
      expect.objectContaining({ checked: false }),
    );
    expect(mockFiles[STATE_URI]).toBeUndefined();
  });

  it('is single-flight: concurrent callers share one fetch', async () => {
    serveCatalog([publish('alpha', '2026-10-01T00:00:00.000Z')]);

    const first = checkForTrailDataUpdates({ now: T0 });
    const second = checkForTrailDataUpdates({ force: true, now: T0 });
    expect(second).toBe(first);
    expect(useTrailDataStore.getState().checking).toBe(true);

    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(useTrailDataStore.getState().checking).toBe(false);
  });
});

describe('when the bundle catches up', () => {
  it('removes a download that a newer bundle supersedes', async () => {
    // A copy downloaded before an app update whose bundle is newer still.
    const old = publish('alpha', '2026-08-15T00:00:00.000Z');
    mockDirs[ROOT] = true;
    mockFiles[`${ROOT}/${old.key}`] = mockRemote[`${TRAILS_URL}/${old.key}`];
    mockFiles[STATE_URI] = JSON.stringify({
      catalog: null,
      lastCheckedAt: null,
      installed: { alpha: { ...old, file: old.key } },
    });
    restart();

    // Already ignored for reading, before any check.
    expect(activeDownload('alpha')).toBeNull();
    await expect(readDownloadedTrail('alpha')).resolves.toBeNull();

    serveCatalog([old]);
    const result = await checkForTrailDataUpdates({ now: T0 });

    expect(result).toEqual({ checked: true, updated: [], failed: [] });
    expect(mockDownload).not.toHaveBeenCalled();
    expect(filesInRoot()).toEqual(['state.json']);
    expect(savedState().installed).toEqual({});
  });
});

describe('catalog-only trails', () => {
  it('are listed and server-known, but not downloaded by a check', async () => {
    const gamma = publish('gamma', '2026-10-01T00:00:00.000Z', { name: 'Gamma Way', lengthKm: 77 });
    serveCatalog([publish('alpha', '2026-08-01T00:00:00.000Z'), gamma]);

    expect(isServerKnown('gamma')).toBe(false);
    const result = await checkForTrailDataUpdates({ now: T0 });

    expect(result).toEqual({ checked: true, updated: [], failed: [] });
    expect(mockDownload).not.toHaveBeenCalled();
    // Bundled trails are never listed as remote, whatever the catalog says.
    expect(listRemoteTrails()).toEqual([
      expect.objectContaining({ id: 'gamma', name: 'Gamma Way', lengthKm: 77, downloaded: false }),
    ]);
    expect(listRemoteTrails()[0]).not.toHaveProperty('key');
    expect(isServerKnown('gamma')).toBe(true);
    expect(activeDownload('gamma')).toBeNull();
  });

  it('are downloaded by ensureTrailDownloaded, once, however many callers ask', async () => {
    const gamma = publish('gamma', '2026-10-01T00:00:00.000Z');
    serveCatalog([gamma]);
    await checkForTrailDataUpdates({ now: T0 });

    const [a, b] = await Promise.all([ensureTrailDownloaded('gamma'), ensureTrailDownloaded('gamma')]);

    expect([a, b]).toEqual([true, true]);
    expect(mockDownload).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // the stored catalog was enough
    expect(listRemoteTrails()).toEqual([expect.objectContaining({ id: 'gamma', downloaded: true })]);
    await expect(readDownloadedTrail('gamma')).resolves.toEqual(
      expect.objectContaining({ config: expect.objectContaining({ id: 'gamma' }) }),
    );

    // Already on the device: no further network.
    await expect(ensureTrailDownloaded('gamma')).resolves.toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(1);
  });

  it('asks the server when the stored catalog does not list the trail', async () => {
    serveCatalog([publish('gamma', '2026-10-01T00:00:00.000Z')]);

    await expect(ensureTrailDownloaded('gamma')).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(savedState().catalog?.trails.map((t) => t.id)).toEqual(['gamma']);
    expect(isServerKnown('gamma')).toBe(true);
  });

  it('fetch a fresh copy when the downloaded file has gone missing', async () => {
    const gamma = publish('gamma', '2026-10-01T00:00:00.000Z');
    serveCatalog([gamma]);
    await ensureTrailDownloaded('gamma');
    delete mockFiles[`${ROOT}/${gamma.key}`];

    await expect(ensureTrailDownloaded('gamma')).resolves.toBe(true);
    expect(mockDownload).toHaveBeenCalledTimes(2);
    await expect(readDownloadedTrail('gamma')).resolves.not.toBeNull();
  });

  it('leave the update pass to the next check when opening one refreshes the catalog', async () => {
    serveCatalog([publish('gamma', '2026-10-01T00:00:00.000Z')]);
    await ensureTrailDownloaded('gamma');
    expect(savedState().lastCheckedAt).toBeNull();

    // A newer bundled-trail copy in that same catalog is still picked up by
    // the very next automatic check, not six hours later.
    serveCatalog([
      publish('gamma', '2026-10-01T00:00:00.000Z'),
      publish('alpha', '2026-10-01T00:00:00.000Z'),
    ]);
    const result = await checkForTrailDataUpdates({ now: T0 });
    expect(result.updated).toEqual(['alpha']);
  });

  it('resolves false for a trail neither bundled nor published', async () => {
    serveCatalog([]);
    await expect(ensureTrailDownloaded('nowhere')).resolves.toBe(false);
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it('resolves false for a bundled trail without fetching anything', async () => {
    await expect(ensureTrailDownloaded('alpha')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('are updated by a check once downloaded', async () => {
    serveCatalog([publish('gamma', '2026-10-01T00:00:00.000Z')]);
    await ensureTrailDownloaded('gamma');

    const newer = publish('gamma', '2026-10-05T00:00:00.000Z');
    serveCatalog([newer]);
    const result = await checkForTrailDataUpdates({ force: true, now: T0 });

    expect(result.updated).toEqual(['gamma']);
    expect(activeDownload('gamma')?.file).toBe(newer.key);
  });

  it('stay listed (as downloaded) after the catalog drops them', async () => {
    serveCatalog([publish('gamma', '2026-10-01T00:00:00.000Z')]);
    await ensureTrailDownloaded('gamma');

    serveCatalog([]);
    await checkForTrailDataUpdates({ force: true, now: T0 });

    expect(listRemoteTrails()).toEqual([expect.objectContaining({ id: 'gamma', downloaded: true })]);
    expect(isServerKnown('gamma')).toBe(true);
    await expect(readDownloadedTrail('gamma')).resolves.not.toBeNull();
  });

  it('never include an imported (u_) id, which is never server-known', async () => {
    serveCatalog([
      publish('u_abc123', '2026-10-01T00:00:00.000Z'),
      publish('gamma', '2026-10-01T00:00:00.000Z'),
    ]);
    await checkForTrailDataUpdates({ now: T0 });

    expect(listRemoteTrails().map((t) => t.id)).toEqual(['gamma']);
    expect(isServerKnown('u_abc123')).toBe(false);
    await expect(ensureTrailDownloaded('u_abc123')).resolves.toBe(false);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});

describe('the state file', () => {
  it('is re-read from disk after a restart', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    const gamma = publish('gamma', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha, gamma]);
    await checkForTrailDataUpdates({ now: T0 });

    restart();
    registerRemoteTrailIds([]);
    expect(isServerKnown('gamma')).toBe(false);

    initTrailData();
    expect(isServerKnown('gamma')).toBe(true);
    expect(activeDownload('alpha')?.file).toBe(alpha.key);
    expect(listRemoteTrails().map((t) => t.id)).toEqual(['gamma']);
    await expect(readDownloadedTrail('alpha')).resolves.not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reads a torn file as empty, falling back to the bundle', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    mockDirs[ROOT] = true;
    mockFiles[`${ROOT}/${alpha.key}`] = mockRemote[`${TRAILS_URL}/${alpha.key}`];
    mockFiles[STATE_URI] = '{"catalog": {"format": 1, "trai';
    restart();

    expect(activeDownload('alpha')).toBeNull();
    expect(listRemoteTrails()).toEqual([]);

    // And an automatic check is not throttled by a lastCheckedAt it cannot read.
    serveCatalog([]);
    await expect(checkForTrailDataUpdates({ now: T0 })).resolves.toEqual(
      expect.objectContaining({ checked: true }),
    );
  });

  it('recovers from the temp file when the app died between deleting and renaming', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    const gamma = publish('gamma', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha, gamma]);
    await checkForTrailDataUpdates({ now: T0 });
    expect(filesInRoot()).not.toContain('state.json.tmp');

    mockFiles[`${STATE_URI}.tmp`] = mockFiles[STATE_URI];
    delete mockFiles[STATE_URI];
    restart();

    expect(activeDownload('alpha')?.file).toBe(alpha.key);
    expect(listRemoteTrails().map((t) => t.id)).toEqual(['gamma']);
  });

  it('prefers a complete state file over a torn temp file', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha]);
    await checkForTrailDataUpdates({ now: T0 });

    mockFiles[`${STATE_URI}.tmp`] = '{"catalog": {"for';
    restart();
    expect(activeDownload('alpha')?.file).toBe(alpha.key);

    // The next save replaces the stale temp file rather than failing on it.
    await checkForTrailDataUpdates({ force: true, now: T0 + MINUTE });
    expect(filesInRoot()).toEqual([alpha.key, 'state.json'].sort());
  });

  it('drops an installed record whose id does not match its key', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    mockDirs[ROOT] = true;
    mockFiles[`${ROOT}/${alpha.key}`] = mockRemote[`${TRAILS_URL}/${alpha.key}`];
    mockFiles[STATE_URI] = JSON.stringify({
      catalog: null,
      lastCheckedAt: null,
      installed: { beta: { ...alpha, file: alpha.key } },
    });
    restart();

    expect(activeDownload('alpha')).toBeNull();
    expect(activeDownload('beta')).toBeNull();
  });

  it('reads a missing downloaded file as no copy at all', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha]);
    await checkForTrailDataUpdates({ now: T0 });
    delete mockFiles[`${ROOT}/${alpha.key}`];

    await expect(readDownloadedTrail('alpha')).resolves.toBeNull();
  });

  it('forgets an unreadable download, so the next check fetches it again', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha]);
    await checkForTrailDataUpdates({ now: T0 });
    delete mockFiles[`${ROOT}/${alpha.key}`];

    await expect(readDownloadedTrail('alpha')).resolves.toBeNull();
    expect(savedState().installed).toEqual({});

    const result = await checkForTrailDataUpdates({ force: true, now: T0 + MINUTE });
    expect(result.updated).toEqual(['alpha']);
    await expect(readDownloadedTrail('alpha')).resolves.not.toBeNull();
  });

  it('reads a corrupt downloaded file as no copy at all', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha]);
    await checkForTrailDataUpdates({ now: T0 });
    mockFiles[`${ROOT}/${alpha.key}`] = 'not json';

    await expect(readDownloadedTrail('alpha')).resolves.toBeNull();
  });
});

describe('orphan sweep', () => {
  it('deletes files the state does not name after a successful check', async () => {
    const alpha = publish('alpha', '2026-10-01T00:00:00.000Z');
    serveCatalog([alpha]);
    await checkForTrailDataUpdates({ now: T0 });

    mockFiles[`${ROOT}/stray.0123456789ab.json`] = '{}';
    mockFiles[`${ROOT}/alpha.deadbeef0000.json.part`] = 'half';

    await checkForTrailDataUpdates({ force: true, now: T0 + HOUR });

    expect(filesInRoot()).toEqual([alpha.key, 'state.json'].sort());
  });

  it('leaves the files alone when the check fails', async () => {
    mockDirs[ROOT] = true;
    mockFiles[`${ROOT}/stray.0123456789ab.json`] = '{}';
    failCatalog();

    await checkForTrailDataUpdates({ force: true, now: T0 });

    expect(filesInRoot()).toEqual(['stray.0123456789ab.json']);
  });
});
