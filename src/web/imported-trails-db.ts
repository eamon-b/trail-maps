/**
 * IndexedDB store for user-imported trails (web).
 *
 * A deliberately tiny, dependency-free wrapper around IndexedDB. localStorage is
 * not an option here: a full-resolution imported track blows past the ~5MB quota.
 *
 * Layout: database `tracknotes-imports` (version 1) with a single object store
 * `trails` keyed by `id`, plus a `createdAt` index used to list newest-first.
 *
 * Availability: every operation rejects with `IndexedDbUnavailableError` when the
 * environment has no `indexedDB` (private-mode lockdowns, exotic browsers, SSR).
 * Callers should branch on `isIndexedDbAvailable()` up front and degrade to a
 * "your browser can't store imported trails" state rather than try/catch each call.
 */

import type { ProcessedTrail } from '@lib/trail-types';

/** The stored trail payload — the shared processed-trail shape from `@lib`. */
export type ImportedTrailData = ProcessedTrail;

/** Row metadata, i.e. everything except the (large) trail payload. */
export interface ImportedTrailSummary {
  /** Synthetic import id (`u_…`); also the object-store key. */
  id: string;
  /** User-facing trail name (user-controlled — escape before rendering). */
  name: string;
  /** Total trail length in kilometres. */
  lengthKm: number;
  /** Epoch milliseconds; the sort key for `listTrailSummaries`. */
  createdAt: number;
}

/** A stored record: summary metadata plus the full processed trail object. */
export interface ImportedTrailRecord<T = ImportedTrailData> extends ImportedTrailSummary {
  trail: T;
}

export const DB_NAME = 'tracknotes-imports';
export const DB_VERSION = 1;
export const STORE_NAME = 'trails';
export const CREATED_AT_INDEX = 'createdAt';

/** Thrown by every operation when the environment exposes no `indexedDB`. */
export class IndexedDbUnavailableError extends Error {
  constructor() {
    super('IndexedDB is not available in this environment');
    this.name = 'IndexedDbUnavailableError';
  }
}

/** Cached connection. Reset to null on any open/connection failure. */
let connectionPromise: Promise<IDBDatabase> | null = null;

function getFactory(): IDBFactory | null {
  // Read off globalThis so this never throws a ReferenceError in odd runtimes.
  const scope = globalThis as { indexedDB?: IDBFactory | null };
  return scope.indexedDB ?? null;
}

/**
 * True when IndexedDB can be used at all. Callers should check this before
 * offering import/persistence UI so they can degrade gracefully.
 */
export function isIndexedDbAvailable(): boolean {
  try {
    return getFactory() !== null;
  } catch {
    return false;
  }
}

function errorOf(source: { error?: DOMException | null }, fallback: string): Error {
  return source.error ?? new Error(fallback);
}

function openDatabase(): Promise<IDBDatabase> {
  const factory = getFactory();
  if (!factory) return Promise.reject(new IndexedDbUnavailableError());

  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    // If we bail out via onblocked, a late onsuccess must not leak a connection.
    let settled = false;

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex(CREATED_AT_INDEX, 'createdAt', { unique: false });
      }
    };

    request.onblocked = () => {
      // Another tab holds an older-version connection open. Fail fast instead of
      // hanging forever; the next call re-opens.
      settled = true;
      reject(new Error('IndexedDB upgrade blocked by another open connection'));
    };

    request.onerror = () => {
      settled = true;
      reject(errorOf(request, 'Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      // Another tab wants to upgrade: close so we never block it, and drop the
      // cached connection so the next call re-opens at the new version.
      db.onversionchange = () => {
        db.close();
        connectionPromise = null;
      };
      db.onclose = () => {
        connectionPromise = null;
      };
      resolve(db);
    };
  });
}

function getConnection(): Promise<IDBDatabase> {
  if (!connectionPromise) {
    connectionPromise = openDatabase().catch((err: unknown) => {
      connectionPromise = null;
      throw err;
    });
  }
  return connectionPromise;
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(errorOf(tx, 'IndexedDB transaction failed'));
    tx.onabort = () => reject(errorOf(tx, 'IndexedDB transaction aborted'));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(errorOf(request, 'IndexedDB request failed'));
  });
}

/**
 * Run `work` inside a transaction on the `trails` store.
 *
 * Retries once on a dead connection (e.g. the db was closed by `onversionchange`
 * between calls) after dropping the cached connection.
 */
async function runTransaction<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Promise<T>,
): Promise<T> {
  if (!isIndexedDbAvailable()) throw new IndexedDbUnavailableError();

  for (let attempt = 0; attempt < 2; attempt++) {
    const db = await getConnection();
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE_NAME, mode);
    } catch (err) {
      // InvalidStateError: the connection is closed. Reset and try once more.
      connectionPromise = null;
      if (attempt === 0) continue;
      throw err instanceof Error ? err : new Error(String(err));
    }

    const done = transactionDone(tx);
    // Attach a no-op handler so a transaction failure during `work` is never an
    // unhandled rejection; awaiting `done` below still surfaces the error.
    void done.catch(() => undefined);

    try {
      const result = await work(tx.objectStore(STORE_NAME));
      await done;
      return result;
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // Already finished or aborting — nothing to do.
      }
      throw err;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('IndexedDB transaction could not be started');
}

function toSummary(record: ImportedTrailSummary): ImportedTrailSummary {
  return {
    id: record.id,
    name: record.name,
    lengthKm: record.lengthKm,
    createdAt: record.createdAt,
  };
}

/** Insert or replace a stored trail (keyed by `record.id`). */
export async function putTrail<T = ImportedTrailData>(record: ImportedTrailRecord<T>): Promise<void> {
  if (!record || typeof record.id !== 'string' || record.id === '') {
    throw new TypeError('putTrail requires a record with a non-empty string id');
  }
  await runTransaction('readwrite', async (store) => {
    await requestToPromise(store.put(record));
  });
}

/** Fetch one stored trail, or null when no record has that id. */
export async function getTrail<T = ImportedTrailData>(
  id: string,
): Promise<ImportedTrailRecord<T> | null> {
  const record = await runTransaction('readonly', (store) =>
    requestToPromise(store.get(id) as IDBRequest<ImportedTrailRecord<T> | undefined>),
  );
  return record ?? null;
}

/**
 * List stored trails' metadata, newest first. Ties on `createdAt` are broken by
 * id so the order is deterministic.
 *
 * Note what this costs. IndexedDB has no projection, so `getAll()` structure-
 * clones each *whole* record — full track included — and `toSummary` then
 * throws the payload away. That is fine for the handful of imports a browser
 * realistically holds and wrong at a hundred; the fix when it matters is a
 * second object store holding only the summaries, written alongside the
 * payload.
 */
export async function listTrailSummaries(): Promise<ImportedTrailSummary[]> {
  const records = await runTransaction('readonly', (store) => {
    const source: IDBObjectStore | IDBIndex = store.indexNames.contains(CREATED_AT_INDEX)
      ? store.index(CREATED_AT_INDEX)
      : store;
    return requestToPromise(source.getAll() as IDBRequest<ImportedTrailSummary[]>);
  });

  return records
    .map(toSummary)
    .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
}

/** Delete a stored trail. Resolves normally when the id is not present. */
export async function deleteTrail(id: string): Promise<void> {
  await runTransaction('readwrite', async (store) => {
    await requestToPromise(store.delete(id));
  });
}

/**
 * Close the cached connection, if any. Mainly for tests and teardown; normal
 * callers can ignore it since the connection is opened lazily on demand.
 */
export async function closeImportedTrailsDb(): Promise<void> {
  const pending = connectionPromise;
  connectionPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    db.onversionchange = null;
    db.onclose = null;
    db.close();
  } catch {
    // The connection never opened — nothing to close.
  }
}
