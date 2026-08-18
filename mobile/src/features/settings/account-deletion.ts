/**
 * Local half of account deletion.
 *
 * `DELETE /v1/me` removes the account server-side, but this device is still
 * holding a cache of what that account said: its own comments (mirrored rows
 * plus optimistic `source='local'` ones) and an outbox of work queued under the
 * now-dead token. The server's tombstones would eventually clear the mirrored
 * rows, except the account is gone, so this device will never sync as that user
 * again — nothing is coming to clean up after us. Hence an explicit purge.
 *
 * Scope is deliberately narrow: only the user's OWN authored data goes.
 * Favorites, saved routes and downloaded tiles are device-local content that
 * was never on the server, and the copy in Settings promises they stay.
 *
 * Other users' cached comments are kept — they are public content, unrelated to
 * this identity, and re-fetching them offline is impossible.
 */

import type { SqlDatabase } from '../../db/sql-database';

/**
 * Drop this device's authored comments and its entire outbox.
 *
 * Every outbox row is by definition the local user's pending work (a comment
 * post, a photo upload, a delete), all of it authenticated with the token the
 * server just invalidated, so clearing the table wholesale is correct — draining
 * it afterwards could only produce 401s.
 */
export async function purgeLocalAccountData(db: SqlDatabase, userId: string): Promise<void> {
  await db.runAsync('DELETE FROM comments WHERE author_id = ?', [userId]);
  await db.runAsync('DELETE FROM outbox');
}
