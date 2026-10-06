/**
 * The one serialised write path onto the shared SQLite connection.
 *
 * Every caller of `getDatabase()` shares ONE connection, and a bare `BEGIN` on
 * it is connection-wide: a second `BEGIN` issued while the first transaction is
 * still open throws "cannot start a transaction within a transaction". That
 * overlap is ordinary, not exotic — a sync ack (`plansRepo.upsertServerAck`)
 * landing while the hiker taps a stop, or a route saved while a pull applies —
 * and the loser's edit was simply dropped. So every repo transaction goes
 * through {@link withTransaction}, which queues them per connection.
 *
 * A plain promise chain rather than expo-sqlite's
 * `withExclusiveTransactionAsync`: that opens a second connection, which the
 * better-sqlite3 test adapter (an in-memory database per test) cannot share,
 * and the chain gives the same guarantee for the writes that need it.
 *
 * Not re-entrant: `fn` must not itself call `withTransaction` on the same
 * database, or it waits for its own turn forever. No repo nests them.
 *
 * Kept out of `database.ts` so the repos stay importable without the native
 * open path (several tests mock that module wholesale).
 */

import type { SqlDatabase } from './sql-database';

/** Per-connection tail of the queue. Never rejects — see {@link withWriteLock}. */
const tails = new WeakMap<object, Promise<void>>();

/**
 * Run `fn` once every write queued before it on `db` has settled, and hold the
 * queue until `fn` settles. Its result (or rejection) is passed through.
 */
export function withWriteLock<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(db) ?? Promise.resolve();
  const run = previous.then(fn);
  // The tail swallows the outcome: one failed write must not wedge every write
  // queued behind it.
  tails.set(
    db,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/**
 * `BEGIN` → `fn` → `COMMIT` (or `ROLLBACK` on a throw), serialised with every
 * other transaction on `db`.
 */
export function withTransaction<T>(db: SqlDatabase, fn: () => Promise<T>): Promise<T> {
  return withWriteLock(db, async () => {
    await db.execAsync('BEGIN');
    try {
      const result = await fn();
      await db.execAsync('COMMIT');
      return result;
    } catch (e) {
      // A failed ROLLBACK (the transaction already ended) must not mask the
      // error that caused it.
      await db.execAsync('ROLLBACK').catch(() => undefined);
      throw e;
    }
  });
}
