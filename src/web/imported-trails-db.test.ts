import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CREATED_AT_INDEX,
  DB_NAME,
  DB_VERSION,
  IndexedDbUnavailableError,
  STORE_NAME,
  closeImportedTrailsDb,
  deleteTrail,
  getTrail,
  isIndexedDbAvailable,
  listTrailSummaries,
  putTrail,
  type ImportedTrailRecord,
} from './imported-trails-db';

/** Stand-in for the processed trail payload — only the shape matters here. */
interface TestTrail {
  config: { id: string; name: string };
  tracks: { name: string; points: number[][] }[];
}

function makeRecord(
  id: string,
  overrides: Partial<ImportedTrailRecord<TestTrail>> = {},
): ImportedTrailRecord<TestTrail> {
  return {
    id,
    name: `Trail ${id}`,
    lengthKm: 12.5,
    createdAt: 1_700_000_000_000,
    trail: {
      config: { id, name: `Trail ${id}` },
      tracks: [{ name: 'main', points: [[1, 2, 3]] }],
    },
    ...overrides,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onblocked = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
  });
}

beforeEach(async () => {
  await closeImportedTrailsDb();
  await deleteDatabase();
});

afterEach(async () => {
  await closeImportedTrailsDb();
});

describe('isIndexedDbAvailable', () => {
  it('is true when a global indexedDB exists', () => {
    expect(isIndexedDbAvailable()).toBe(true);
  });
});

describe('schema', () => {
  it('creates the trails store keyed by id with a createdAt index', async () => {
    // Force the lazy open, then inspect the resulting database directly.
    await putTrail(makeRecord('u_schema'));
    await closeImportedTrailsDb();

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    try {
      expect(Array.from(db.objectStoreNames)).toEqual([STORE_NAME]);
      const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
      expect(store.keyPath).toBe('id');
      expect(Array.from(store.indexNames)).toContain(CREATED_AT_INDEX);
    } finally {
      db.close();
    }
  });
});

describe('putTrail / getTrail', () => {
  it('round-trips a record including the nested trail payload', async () => {
    const record = makeRecord('u_abc');
    await putTrail(record);

    const loaded = await getTrail<TestTrail>('u_abc');
    expect(loaded).toEqual(record);
    expect(loaded?.trail.tracks[0].points).toEqual([[1, 2, 3]]);
  });

  it('returns null for an unknown id', async () => {
    expect(await getTrail('u_missing')).toBeNull();
  });

  it('replaces an existing record with the same id', async () => {
    await putTrail(makeRecord('u_abc'));
    await putTrail(makeRecord('u_abc', { name: 'Renamed', lengthKm: 99 }));

    const loaded = await getTrail<TestTrail>('u_abc');
    expect(loaded?.name).toBe('Renamed');
    expect(loaded?.lengthKm).toBe(99);
    expect(await listTrailSummaries()).toHaveLength(1);
  });

  it('rejects a record without a usable id', async () => {
    await expect(putTrail(makeRecord(''))).rejects.toBeInstanceOf(TypeError);
  });

  it('re-opens transparently after the connection is closed', async () => {
    await putTrail(makeRecord('u_abc'));
    await closeImportedTrailsDb();

    expect(await getTrail('u_abc')).not.toBeNull();
  });
});

describe('listTrailSummaries', () => {
  it('returns an empty array when nothing is stored', async () => {
    expect(await listTrailSummaries()).toEqual([]);
  });

  it('returns summaries newest first, without the trail payload', async () => {
    await putTrail(makeRecord('u_old', { createdAt: 1000 }));
    await putTrail(makeRecord('u_new', { createdAt: 3000 }));
    await putTrail(makeRecord('u_mid', { createdAt: 2000 }));

    const summaries = await listTrailSummaries();

    expect(summaries.map((s) => s.id)).toEqual(['u_new', 'u_mid', 'u_old']);
    expect(summaries[0]).toEqual({
      id: 'u_new',
      name: 'Trail u_new',
      lengthKm: 12.5,
      createdAt: 3000,
    });
    expect(summaries[0]).not.toHaveProperty('trail');
  });

  it('breaks createdAt ties deterministically by id', async () => {
    await putTrail(makeRecord('u_b', { createdAt: 5000 }));
    await putTrail(makeRecord('u_a', { createdAt: 5000 }));

    expect((await listTrailSummaries()).map((s) => s.id)).toEqual(['u_a', 'u_b']);
  });
});

describe('deleteTrail', () => {
  it('removes the record', async () => {
    await putTrail(makeRecord('u_abc'));
    await putTrail(makeRecord('u_def'));

    await deleteTrail('u_abc');

    expect(await getTrail('u_abc')).toBeNull();
    expect((await listTrailSummaries()).map((s) => s.id)).toEqual(['u_def']);
  });

  it('resolves when the id is not present', async () => {
    await expect(deleteTrail('u_missing')).resolves.toBeUndefined();
  });
});

describe('when IndexedDB is unavailable', () => {
  let descriptor: PropertyDescriptor | undefined;

  beforeEach(async () => {
    await closeImportedTrailsDb();
    descriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
    Reflect.deleteProperty(globalThis, 'indexedDB');
  });

  afterEach(() => {
    if (descriptor) Object.defineProperty(globalThis, 'indexedDB', descriptor);
  });

  it('reports unavailable', () => {
    expect(isIndexedDbAvailable()).toBe(false);
  });

  it('rejects every operation with IndexedDbUnavailableError', async () => {
    await expect(getTrail('u_abc')).rejects.toBeInstanceOf(IndexedDbUnavailableError);
    await expect(listTrailSummaries()).rejects.toBeInstanceOf(IndexedDbUnavailableError);
    await expect(deleteTrail('u_abc')).rejects.toBeInstanceOf(IndexedDbUnavailableError);
    await expect(putTrail(makeRecord('u_abc'))).rejects.toBeInstanceOf(IndexedDbUnavailableError);
  });
});
