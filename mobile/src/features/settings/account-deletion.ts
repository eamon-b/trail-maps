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
 * Scope is deliberately narrow: only the user's OWN account data goes — the
 * comments they authored and the day plans they synced. Favorites, saved routes
 * and downloaded tiles are device-local content that was never on the server,
 * and the copy in Settings promises they stay.
 *
 * Other users' cached comments are kept — they are public content, unrelated to
 * this identity, and re-fetching them offline is impossible.
 */

import type { SqlDatabase } from '../../db/sql-database';
import * as plansRepo from '../../db/plans-repo';
import { PLANS_SYNC_KEY } from '../../sync/comment-sync';

/**
 * Drop this device's authored comments, its day plans, and its entire outbox.
 *
 * Every outbox row is by definition the local user's pending work (a comment
 * post, a photo upload, a delete, a plan write), all of it authenticated with
 * the token the server just invalidated, so clearing the table wholesale is
 * correct — draining it afterwards could only produce 401s.
 *
 * Plans go with the account rather than staying as device-local content: they
 * are private, server-backed documents the server has just soft-deleted, and a
 * plan left behind would be re-uploaded under whatever identity this device
 * registers next. The `__plans__` high-water mark goes with them, so a fresh
 * account's first pull is a full snapshot rather than a delta since the deleted
 * account's last sync.
 */
export async function purgeLocalAccountData(db: SqlDatabase, userId: string): Promise<void> {
  await db.runAsync('DELETE FROM comments WHERE author_id = ?', [userId]);
  await plansRepo.purgeAll(db);
  await db.runAsync('DELETE FROM sync_state WHERE trail_id = ?', [PLANS_SYNC_KEY]);
  await db.runAsync('DELETE FROM outbox');
}
