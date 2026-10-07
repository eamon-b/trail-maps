/**
 * Community routes on the device (`community-routes.ts`) and the pure rules
 * under it (`community-catalog.ts`): the cached list survives a restart and is
 * listed offline, a route is downloaded on open and checked against the list's
 * size and MD5 before the state names it, a downloaded route reads back
 * under its community id, and a download is never deleted because a list
 * leaves it out — only a 404 from its own detail flags it "taken down".
 *
 * expo-file-system is faked with the same classes as the trail-data-updates
 * spec.
 */

import { createHash } from 'crypto';
import { newPlan } from '@lib/plan-editor';
import { File as FsFile } from 'expo-file-system';
import {
  CommunityCopyUnreadableError,
  CommunityDownloadCancelledError,
  CommunityRouteTakenDownError,
  ensureCommunityRouteDownloaded,
  forgetCommunityRoute,
  getCommunityRouteInfo,
  listCachedCommunityRoutes,
  markCommunityRouteTakenDown,
  readCommunityTrail,
  refreshCommunityRoutes,
  removeCommunityRouteFromDevice,
  resetCommunityStateForTests,
  upsertCommunitySummary,
  COMMUNITY_REFRESH_MS,
} from '../community-routes';
import {
  MAX_COMMUNITY_PROBES,
  classifyCommunityProbe,
  communityFileName,
  mergeCommunityRoutes,
  parseCommunityList,
  parseCommunitySummary,
  planCommunitySync,
} from '../community-catalog';
import { createMigratedTestDb } from '../../db/__tests__/test-helpers';
import * as plansRepo from '../../db/plans-repo';
import { useSettingsStore } from '../../state/settings-store';

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

/**
 * The comments API: the list at `/v1/community/routes`, and each route's detail
 * at `/v1/community/routes/:id` — a row (200), or a bare status. A detail not
 * named answers 404, the worker's answer for a hidden or removed route.
 */
function listFetch(routes: unknown[], details: Record<string, unknown> = {}) {
  return jest.fn(async (url: string) => {
    const path = url.slice(API.length);
    if (path === '/v1/community/routes') {
      return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify({ routes }) };
    }
    const id = decodeURIComponent(path.replace('/v1/community/routes/', ''));
    const detail = details[id];
    if (typeof detail === 'number') {
      return {
        ok: detail >= 200 && detail < 300,
        status: detail,
        statusText: '',
        text: async () => JSON.stringify({ error: { code: 'x', message: `status ${detail}` } }),
      };
    }
    if (detail === undefined) {
      return {
        ok: false,
        status: 404,
        statusText: '',
        text: async () => JSON.stringify({ error: { code: 'not_found', message: 'Not found' } }),
      };
    }
    return { ok: true, status: 200, statusText: '', text: async () => JSON.stringify(detail) };
  }) as unknown as typeof fetch;
}

/** Calls the fake made to one route's detail. */
function detailCalls(fetchImpl: typeof fetch, id: string): number {
  return (fetchImpl as unknown as jest.Mock).mock.calls.filter((c) =>
    String(c[0]).endsWith(`/v1/community/routes/${id}`),
  ).length;
}

const offline = () =>
  jest.fn(async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;

const fileOf = (id: string) =>
  Object.keys(mockFiles).find((k) => k.startsWith(`${ROOT}/${id}.`) && k.endsWith('.json'));

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
  // Failed background updates are logged; the assertions say what happened.
  jest.spyOn(console, 'warn').mockImplementation(() => {});
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

describe('planCommunitySync', () => {
  it('never drops a download the list leaves out: it is probed instead', () => {
    const a = parseCommunitySummary(publish(ID))!;
    const b = parseCommunitySummary(publish(ID2))!;
    const plan = planCommunitySync([a], {
      [ID]: { summary: a, file: communityFileName(ID, a.md5), takenDown: true },
      [ID2]: { summary: b, file: communityFileName(ID2, b.md5) },
    });
    expect(Object.keys(plan.installed).sort()).toEqual([ID, ID2].sort());
    // Listed again: the flag is cleared.
    expect(plan.installed[ID].takenDown).toBeUndefined();
    expect(plan.probe).toEqual([ID2]);
    expect(plan.stale).toEqual([]);
  });

  it('names listed downloads whose md5 changed, and bounds the probes', () => {
    const a = parseCommunitySummary(publish(ID))!;
    const edited = { ...a, md5: 'a'.repeat(32) };
    const installed: Record<string, { summary: typeof a; file: string; takenDown?: boolean }> = {
      [ID]: { summary: a, file: communityFileName(ID, a.md5) },
    };
    const flagged = 'c_flaggedflaggedfl';
    installed[flagged] = { summary: { ...a, id: flagged }, file: communityFileName(flagged, a.md5), takenDown: true };
    for (let i = 0; i < MAX_COMMUNITY_PROBES + 5; i++) {
      const id = `c_${String(i).padStart(16, 'x')}`;
      installed[id] = { summary: { ...a, id }, file: communityFileName(id, a.md5) };
    }
    const plan = planCommunitySync([edited], installed);
    expect(plan.stale.map((r) => r.md5)).toEqual([edited.md5]);
    expect(plan.probe).toHaveLength(MAX_COMMUNITY_PROBES);
    // Never-flagged routes are asked about before ones already flagged.
    expect(plan.probe).not.toContain(flagged);
  });
});

describe('classifyCommunityProbe', () => {
  it('reads a 404 or a non-public status as gone, and anything unclear as unknown', () => {
    expect(classifyCommunityProbe({ ok: false, status: 404 }).kind).toBe('gone');
    expect(classifyCommunityProbe({ ok: false, status: 500 }).kind).toBe('unknown');
    expect(classifyCommunityProbe({ ok: false }).kind).toBe('unknown');
    expect(classifyCommunityProbe({ ok: true, detail: { ...publish(ID), status: 'hidden' } }).kind).toBe('gone');
    expect(classifyCommunityProbe({ ok: true, detail: publish(ID) }).kind).toBe('live');
    expect(classifyCommunityProbe({ ok: true, detail: 'nonsense' }).kind).toBe('unknown');
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

  it('keeps a download the list leaves out while its detail still answers', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID), publish(ID2)]) });
    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);

    // A truncated or stale list: ID is missing, but the server still has it.
    const fetchImpl = listFetch([publish(ID2)], { [ID]: publish(ID) });
    const res = await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl });
    expect(res.checked).toBe(true);
    expect(detailCalls(fetchImpl, ID)).toBe(1);
    expect(fileOf(ID)).toBeDefined();
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
    expect(getCommunityRouteInfo(ID)).toMatchObject({ downloaded: true, takenDown: false });
  });

  it('keeps a download on an empty list, and on a 5xx from its detail', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([], { [ID]: 503 }) });
    expect(fileOf(ID)).toBeDefined();
    expect(getCommunityRouteInfo(ID)?.takenDown).toBe(false);
  });

  it('flags a download "taken down" on a 404, keeps its file, and clears the flag when it is listed again', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID), publish(ID2)]) });
    await ensureCommunityRouteDownloaded(ID);

    await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([publish(ID2)]) });
    expect(fileOf(ID)).toBeDefined();
    expect(getCommunityRouteInfo(ID)).toMatchObject({ downloaded: true, takenDown: true });
    // Still opens: the hiker may be on it.
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
    // It survives a restart.
    resetCommunityStateForTests();
    expect(getCommunityRouteInfo(ID)?.takenDown).toBe(true);

    // An admin restored it: the next list names it again.
    await refreshCommunityRoutes({ now: T0 + 2, force: true, fetchImpl: listFetch([publish(ID), publish(ID2)]) });
    expect(getCommunityRouteInfo(ID)?.takenDown).toBe(false);
  });

  it('changes nothing when the list fetch fails', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    const before = JSON.stringify(listCachedCommunityRoutes());
    const res = await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: offline() });
    expect(res.checked).toBe(false);
    expect(JSON.stringify(listCachedCommunityRoutes())).toBe(before);
    expect(fileOf(ID)).toBeDefined();
  });

  it('never deletes the route being hiked or one with a plan', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID), publish(ID2)]) });
    await ensureCommunityRouteDownloaded(ID);
    await ensureCommunityRouteDownloaded(ID2);
    useSettingsStore.setState({ currentTrailId: ID });
    await plansRepo.upsertLocal(db as never, newPlan(ID2, 'Plan', 'NOBO', { idFactory: () => 'p1' }));

    // Both gone from the list, and from the server.
    await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([]) });
    expect(fileOf(ID)).toBeDefined();
    expect(fileOf(ID2)).toBeDefined();
    expect(useSettingsStore.getState().currentTrailId).toBe(ID);
    expect(await plansRepo.getByTrail(db as never, ID2)).not.toBeNull();
    useSettingsStore.setState({ currentTrailId: null });
  });

  it('downloads a listed route again when the list carries a new md5', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    const oldFile = fileOf(ID);

    // The owner renamed it: the worker republished new bytes under a new key.
    const edited = trailBody('c_edited');
    const row = publish(ID, { trailUrl: `https://data.test/community/v1/${ID}.v2.json` }, edited);
    mockRemote[row.trailUrl as string] = edited;
    await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([row]) });

    const newFile = fileOf(ID);
    expect(newFile).toBeDefined();
    expect(newFile).not.toBe(oldFile);
    expect(newFile!.endsWith(communityFileName(ID, md5(edited)))).toBe(true);
    expect(mockFiles[oldFile!]).toBeUndefined();
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
      // The server still lists the same copy: the download's own error stands.
      await ensureCommunityRouteDownloaded(ID, { fetchImpl: listFetch([row], { [ID]: row }) });
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

describe('reading a damaged copy', () => {
  it('forgets a corrupt copy of a listed route so the next open downloads it again', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    mockFiles[fileOf(ID)!] = '{ not json';

    expect(await readCommunityTrail(ID)).toBeNull();
    expect(fileOf(ID)).toBeUndefined();
    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
  });

  it('keeps a corrupt copy of a route that is no longer shared, and says so', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    markCommunityRouteTakenDown(ID);
    const file = fileOf(ID)!;
    mockFiles[file] = '{ not json';

    await expect(readCommunityTrail(ID)).rejects.toBeInstanceOf(CommunityCopyUnreadableError);
    expect(mockFiles[file]).toBe('{ not json');
    expect(getCommunityRouteInfo(ID)).toMatchObject({ downloaded: true, takenDown: true });
  });

  it('keeps the copy when the read itself fails', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    const file = fileOf(ID)!;
    const spy = jest
      .spyOn(FsFile.prototype as unknown as { text(): Promise<string> }, 'text')
      .mockRejectedValueOnce(new Error('EIO'));

    await expect(readCommunityTrail(ID)).rejects.toBeInstanceOf(CommunityCopyUnreadableError);
    spy.mockRestore();
    expect(mockFiles[file]).toBeDefined();
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
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

  it('is forgotten, file, plan and pin and all, when its owner deletes it', async () => {
    const db = await createMigratedTestDb();
    upsertCommunitySummary(publish(ID));
    await ensureCommunityRouteDownloaded(ID);
    await plansRepo.upsertLocal(db as never, newPlan(ID, 'Plan', 'NOBO', { idFactory: () => 'p1' }));
    useSettingsStore.setState({ currentTrailId: ID });

    await forgetCommunityRoute(ID, { db: db as never });
    expect(listCachedCommunityRoutes()).toEqual([]);
    expect(await readCommunityTrail(ID)).toBeNull();
    expect(await plansRepo.getByTrail(db as never, ID)).toBeNull();
    expect(useSettingsStore.getState().currentTrailId).toBeNull();
  });
});

describe('removing a route from this phone', () => {
  it('deletes the copy and its local state but keeps a still-shared route listed', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    await plansRepo.upsertLocal(db as never, newPlan(ID, 'Plan', 'NOBO', { idFactory: () => 'p1' }));

    await removeCommunityRouteFromDevice(ID, { db: db as never });
    expect(fileOf(ID)).toBeUndefined();
    expect(await plansRepo.getByTrail(db as never, ID)).toBeNull();
    expect(listCachedCommunityRoutes().map((r) => [r.id, r.downloaded])).toEqual([[ID, false]]);
  });

  it('makes a taken-down route disappear from the list', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    markCommunityRouteTakenDown(ID);
    expect(getCommunityRouteInfo(ID)?.takenDown).toBe(true);

    await removeCommunityRouteFromDevice(ID, { db: db as never });
    expect(listCachedCommunityRoutes()).toEqual([]);
  });
});

describe('removing a route while it downloads', () => {
  /** Hold the next download until `release()`; the real fake then runs. */
  function holdNextDownload(): { started: Promise<void>; release: () => void } {
    const download = (FsFile as unknown as { downloadFileAsync: jest.Mock }).downloadFileAsync;
    const real = download.getMockImplementation()!;
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const startedP = new Promise<void>((resolve) => {
      started = resolve;
    });
    download.mockImplementationOnce(async (...args: unknown[]) => {
      started();
      await gate;
      return real(...args);
    });
    return { started: startedP, release };
  }

  it('wins over the download an open started', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    const hold = holdNextDownload();
    const opening = ensureCommunityRouteDownloaded(ID).then(
      () => 'opened',
      (err: unknown) => err,
    );
    await hold.started;

    const removing = removeCommunityRouteFromDevice(ID, { db: db as never });
    hold.release();
    await removing;

    expect(await opening).toBeInstanceOf(CommunityDownloadCancelledError);
    expect(fileOf(ID)).toBeUndefined();
    expect(Object.keys(mockFiles).filter((k) => k.endsWith('.part'))).toEqual([]);
    expect(getCommunityRouteInfo(ID)?.downloaded).toBe(false);
    // It survives a restart: the state on disk does not name it either.
    resetCommunityStateForTests();
    expect(getCommunityRouteInfo(ID)?.downloaded).toBe(false);

    // Opening it again afterwards downloads it as usual.
    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    expect(getCommunityRouteInfo(ID)?.downloaded).toBe(true);
  });

  it('starts afresh when it is opened again before the cancelled download settles', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    const hold = holdNextDownload();
    const first = ensureCommunityRouteDownloaded(ID).then(
      () => 'opened',
      (err: unknown) => err,
    );
    await hold.started;
    await removeCommunityRouteFromDevice(ID, { db: db as never });

    const second = ensureCommunityRouteDownloaded(ID);
    hold.release();
    expect(await first).toBeInstanceOf(CommunityDownloadCancelledError);
    expect(await second).toBe(true);
    expect(getCommunityRouteInfo(ID)?.downloaded).toBe(true);
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
  });

  it('wins over an update a refresh started', async () => {
    const db = await createMigratedTestDb();
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    const edited = trailBody('c_edited');
    const row = publish(ID, { trailUrl: `https://data.test/community/v1/${ID}.v2.json` }, edited);
    mockRemote[row.trailUrl as string] = edited;

    const hold = holdNextDownload();
    const refreshing = refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([row]) });
    await hold.started;
    const removing = removeCommunityRouteFromDevice(ID, { db: db as never });
    hold.release();
    await Promise.all([refreshing, removing]);

    expect(fileOf(ID)).toBeUndefined();
    expect(getCommunityRouteInfo(ID)?.downloaded).toBe(false);
  });
});

describe('opening a route the server no longer has', () => {
  it('throws the taken-down error on a 404 and drops the stale list row', async () => {
    // Listed, never downloaded; its public copy and its detail are both gone.
    const row = publish(ID);
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([row]) });
    delete mockRemote[row.trailUrl as string];
    const fetchImpl = listFetch([]);

    let caught: unknown;
    try {
      await ensureCommunityRouteDownloaded(ID, { fetchImpl });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommunityRouteTakenDownError);
    expect(listCachedCommunityRoutes()).toEqual([]);
  });

  it('throws the taken-down error for a link to a route the server does not have', async () => {
    await expect(
      ensureCommunityRouteDownloaded(ID, { fetchImpl: listFetch([]) }),
    ).rejects.toBeInstanceOf(CommunityRouteTakenDownError);
  });

  it('surfaces a network failure as an ordinary error (retryable)', async () => {
    let caught: unknown;
    try {
      await ensureCommunityRouteDownloaded(ID, { fetchImpl: offline() });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(CommunityRouteTakenDownError);
  });

  it('opens the older copy when the newer one will not download', async () => {
    await refreshCommunityRoutes({ now: T0, fetchImpl: listFetch([publish(ID)]) });
    await ensureCommunityRouteDownloaded(ID);
    const edited = trailBody('c_edited');
    const row = publish(ID, { trailUrl: 'https://data.test/missing.json', md5: md5(edited) }, edited);
    delete mockRemote['https://data.test/missing.json'];
    // Listed under a new md5, and the refresh's own attempt fails too.
    await refreshCommunityRoutes({ now: T0 + 1, force: true, fetchImpl: listFetch([row]) });
    expect(await ensureCommunityRouteDownloaded(ID)).toBe(true);
    expect((await readCommunityTrail(ID))?.config.id).toBe(ID);
  });
});
