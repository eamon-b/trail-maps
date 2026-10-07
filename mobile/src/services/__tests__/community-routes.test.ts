/**
 * Community routes on the device (`community-routes.ts`) and the pure rules
 * under it (`community-catalog.ts`): the cached list survives a restart and is
 * listed offline, a route is downloaded on open and checked against the list's
 * size and MD5 before the state names it, and a downloaded route reads back
 * under its community id.
 *
 * expo-file-system is faked with the same classes as the trail-data-updates
 * spec.
 */

import { createHash } from 'crypto';
import {
  ensureCommunityRouteDownloaded,
  forgetCommunityRoute,
  listCachedCommunityRoutes,
  readCommunityTrail,
  refreshCommunityRoutes,
  resetCommunityStateForTests,
  upsertCommunitySummary,
  COMMUNITY_REFRESH_MS,
} from '../community-routes';
import {
  communityFileName,
  mergeCommunityRoutes,
  parseCommunityList,
  parseCommunitySummary,
  pruneInstalledCommunity,
} from '../community-catalog';

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

const ID = 'c_AbCdEfGhIjKlMnOp';
const ID2 = 'c_ZyXwVuTsRqPoNmLk';
const ROOT = 'file:///mock/document/community';
const API = 'https://api.test';
const T0 = Date.parse('2026-10-07T00:00:00.000Z');

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

function trailBody(id = 'u_abc'): string {
  return JSON.stringify({
    config: { id, name: 'Imported name', shortName: 'Imp', region: 'R', lengthKm: 5 },
    waypoints: [],
    track: { points: [{ lat: -37, lon: 145, ele: 1, distance: 0 }] },
  });
}

/** Publish a body at a URL and return the list row describing it. */
function publish(id: string, overrides: Record<string, unknown> = {}, body = trailBody()) {
  const url = `https://data.test/community/v1/${id}.json`;
  mockRemote[url] = body;
  return {
    id,
    name: `Route ${id}`,
    status: 'unverified',
    country: 'AU',
    state: 'VIC',
    lengthKm: 5,
    ascentM: 100,
    hasElevation: true,
    waypointCount: 0,
    bbox: [145, -37, 145.1, -36.9],
    start: { lat: -37, lon: 145 },
    submittedBy: 'Sam',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    verifiedAt: null,
    reviewed: false,
    trailUrl: url,
    md5: md5(body),
    bytes: Buffer.byteLength(body),
    ...overrides,
  };
}

function listFetch(routes: unknown[]) {
  return jest.fn(async () => ({
    ok: true,
    status: 200,
    statusText: '',
    text: async () => JSON.stringify({ routes }),
  })) as unknown as typeof fetch;
}

const ORIGINAL_API = process.env.EXPO_PUBLIC_API_BASE_URL;
afterAll(() => {
  if (ORIGINAL_API === undefined) delete process.env.EXPO_PUBLIC_API_BASE_URL;
  else process.env.EXPO_PUBLIC_API_BASE_URL = ORIGINAL_API;
});

beforeEach(() => {
  for (const k of Object.keys(mockFiles)) delete mockFiles[k];
  for (const k of Object.keys(mockDirs)) delete mockDirs[k];
  for (const k of Object.keys(mockRemote)) delete mockRemote[k];
  mockDownloadTargets.length = 0;
  mockDirs['file:///mock/document'] = true;
  process.env.EXPO_PUBLIC_API_BASE_URL = API;
  resetCommunityStateForTests();
});

describe('parseCommunitySummary', () => {
  it('accepts a well-formed row', () => {
    expect(parseCommunitySummary(publish(ID))?.id).toBe(ID);
  });

  it('refuses rows that could become a bad file name, URL or listing', () => {
    expect(parseCommunitySummary(publish('u_notcommunity'))).toBeNull();
    expect(parseCommunitySummary(publish('c_../../etc/passwd'))).toBeNull();
    expect(parseCommunitySummary(publish(ID, { trailUrl: 'file:///etc/passwd' }))).toBeNull();
    expect(parseCommunitySummary(publish(ID, { md5: 'nope' }))).toBeNull();
    expect(parseCommunitySummary(publish(ID, { status: 'hidden' }))).toBeNull();
  });

  it('keeps the good rows of a list with a bad one, and the first of a duplicate', () => {
    const list = parseCommunityList({
      routes: [publish(ID), { id: 'bad' }, publish(ID, { name: 'dup' }), publish(ID2)],
    });
    expect(list?.map((r) => [r.id, r.name])).toEqual([
      [ID, `Route ${ID}`],
      [ID2, `Route ${ID2}`],
    ]);
  });
});

describe('mergeCommunityRoutes', () => {
  it('keeps a downloaded route the list has since dropped', () => {
    const a = parseCommunitySummary(publish(ID))!;
    const b = parseCommunitySummary(publish(ID2))!;
    const merged = mergeCommunityRoutes([a], {
      [ID]: { summary: a, file: communityFileName(ID, a.md5) },
      [ID2]: { summary: b, file: communityFileName(ID2, b.md5) },
    });
    expect(merged.map((r) => [r.id, r.downloaded])).toEqual([
      [ID, true],
      [ID2, true],
    ]);
  });
});

describe('pruneInstalledCommunity', () => {
  it('keeps listed downloads and names the files of the rest', () => {
    const a = parseCommunitySummary(publish(ID))!;
    const b = parseCommunitySummary(publish(ID2))!;
    const fileB = communityFileName(ID2, b.md5);
    const result = pruneInstalledCommunity([a], {
      [ID]: { summary: a, file: communityFileName(ID, a.md5) },
      [ID2]: { summary: b, file: fileB },
    });
    expect(Object.keys(result.installed)).toEqual([ID]);
    expect(result.droppedFiles).toEqual([fileB]);
  });
});

describe('refreshCommunityRoutes', () => {
  it('caches the list on disk so it is listed offline after a restart', async () => {
    const fetchImpl = listFetch([publish(ID)]);
    const res = await refreshCommunityRoutes({ now: T0, fetchImpl });
    expect(res.checked).toBe(true);
    expect(listCachedCommunityRoutes().map((r) => r.id)).toEqual([ID]);

    resetCommunityStateForTests();
    expect(mockFiles[`${ROOT}/state.json`]).toBeDefined();
    expect(listCachedCommunityRoutes().map((r) => [r.id, r.downloaded])).toEqual([[ID, false]]);
  });

  it('is throttled unless forced', async () => {
    const fetchImpl = listFetch([publish(ID)]);
    await refreshCommunityRoutes({ now: T0, fetchImpl });
    const skipped = await refreshCommunityRoutes({ now: T0 + 60_000, fetchImpl });
    expect(skipped.checked).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await refreshCommunityRoutes({ now: T0 + 60_000, fetchImpl, force: true });
    await refreshCommunityRoutes({ now: T0 + 2 * COMMUNITY_REFRESH_MS, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('does nothing without an API base URL', async () => {
    delete process.env.EXPO_PUBLIC_API_BASE_URL;
    const fetchImpl = listFetch([publish(ID)]);
    expect((await refreshCommunityRoutes({ now: T0, fetchImpl })).checked).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a downloaded route, file and all, once a fresh list no longer has it', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID), publish(ID2)]) });
    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    expect(await ensureCommunityRouteDownloaded(ID2)).toBe(true);
    const fileOf = (id: string) =>
      Object.keys(mockFiles).find((k) => k.startsWith(`${ROOT}/${id}.`) && k.endsWith('.json'));
    expect(fileOf(ID)).toBeDefined();

    // ID was hidden or removed: the next list leaves it out.
    const res = await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([publish(ID2)]) });
    expect(res.checked).toBe(true);
    expect(listCachedCommunityRoutes().map((r) => r.id)).toEqual([ID2]);
    expect(fileOf(ID)).toBeUndefined();
    expect(await readCommunityTrail(ID)).toBeNull();
    expect((await readCommunityTrail(ID2))?.config.id).toBe(ID2);

    // A failed refresh prunes nothing.
    const offline = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await refreshCommunityRoutes({ now: T0 + 2, force: true, fetchImpl: offline });
    expect(fileOf(ID2)).toBeDefined();
  });

  it('keeps the cached list when offline', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    const offline = jest.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const res = await refreshCommunityRoutes({ now: T0, fetchImpl: offline, force: true });
    expect(res.checked).toBe(false);
    expect(listCachedCommunityRoutes().map((r) => r.id)).toEqual([ID]);
  });
});

describe('downloading on open', () => {
  it('downloads, verifies and reads the route back under its community id', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    expect(await readCommunityTrail(ID)).toBeNull();

    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    const trail = await readCommunityTrail(ID);
    expect(trail?.config.id).toBe(ID);
    expect(trail?.config.name).toBe(`Route ${ID}`);
    expect(listCachedCommunityRoutes()[0].downloaded).toBe(true);
    // No .part left behind.
    expect(Object.keys(mockFiles).filter((k) => k.endsWith('.part'))).toEqual([]);
  });

  it('refuses a file whose checksum does not match the list, leaving nothing behind', async () => {
    const row = publish(ID, { md5: 'f'.repeat(32) });
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([row]) });
    let caught: unknown;
    try {
      await ensureCommunityRouteDownloaded(ID);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/Checksum/);
    expect(Object.keys(mockFiles).filter((k) => k.startsWith(ROOT) && !k.endsWith('state.json'))).toEqual(
      [],
    );
    expect(await readCommunityTrail(ID)).toBeNull();
  });

  it('is false for a non-community id and never downloads it', async () => {
    expect(await ensureCommunityRouteDownloaded('u_abc')).toBe(false);
    expect(await ensureCommunityRouteDownloaded('heysen')).toBe(false);
    expect(mockDownloadTargets).toEqual([]);
  });
});

describe('a route this phone just shared', () => {
  it('is listed at once and downloads the server copy on first open', async () => {
    const serverCopy = trailBody('c_server_rebuilt');
    upsertCommunitySummary(publish(ID, {}, serverCopy));
    expect(listCachedCommunityRoutes().map((r) => [r.id, r.downloaded])).toEqual([[ID, false]]);
    expect(await readCommunityTrail(ID)).toBeNull();

    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    expect(mockDownloadTargets).toHaveLength(1);
    // The file under the server's md5 holds the server's bytes.
    const file = Object.keys(mockFiles).find((k) => k.endsWith(communityFileName(ID, md5(serverCopy))));
    expect(file && mockFiles[file]).toBe(serverCopy);
  });

  it('is forgotten, file and all, when its owner deletes it', async () => {
    upsertCommunitySummary(publish(ID));
    await ensureCommunityRouteDownloaded(ID);
    forgetCommunityRoute(ID);
    expect(listCachedCommunityRoutes()).toEqual([]);
    expect(await readCommunityTrail(ID)).toBeNull();
  });
});
