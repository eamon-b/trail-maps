/**
 * Hiker-added waypoints: save, delete and report, offline-first.
 *
 * Every write lands in SQLite at once, so the waypoint is on the map before any
 * request is made. A private waypoint stops there. A shared one also queues a
 * write in the outbox, which `comment-sync`'s drain sends — the same queue,
 * backoff and 401 handling as comments and plans — and a pull later brings
 * everyone else's down (`pullTrail`). Changing a waypoint from shared to private
 * deletes the server copy; private to shared publishes it.
 *
 * A `waypoint` outbox row is a full replace, so only the newest one per
 * waypoint is kept queued (`replacePending`), exactly as for plans.
 */

import type { ReportReason } from '@lib/comments-api-types';
import {
  checkUserWaypointInput,
  userWaypointId,
  type UserWaypoint,
  type UserWaypointInput,
  type UserWaypointVisibility,
} from '@lib/user-waypoints';
import { getDatabase } from '../db/database';
import type { SqlDatabase } from '../db/sql-database';
import * as outboxRepo from '../db/outbox-repo';
import * as userWaypointsRepo from '../db/user-waypoints-repo';
import { uuidv4 } from '../api/uuid';
import { isApiConfigured } from '../api/client';
import { isServerKnown } from '../services/server-trails';
import {
  drainOutbox,
  type DrainResult,
  type SyncDeps,
  type WaypointOutboxPayload,
  type WaypointReportOutboxPayload,
} from './comment-sync';
import { emitSyncChange } from './sync-events';

/** Whether a trail's waypoints can be shared at all (not an import or community route). */
export function canShareWaypoints(trailId: string): boolean {
  return isServerKnown(trailId) && isApiConfigured();
}

async function resolveDb(deps: SyncDeps): Promise<SqlDatabase> {
  return deps.db ?? (await getDatabase());
}

export interface SaveUserWaypointInput {
  trailId: string;
  /** The waypoint being edited; absent for a new one. */
  existing?: UserWaypoint | null;
  input: UserWaypointInput;
  visibility: UserWaypointVisibility;
  /** Shown as the author until the server confirms (the account's display name). */
  displayName?: string | null;
}

/**
 * Create or edit a hiker waypoint. Throws with a plain-English message when the
 * input is invalid, or when it may not be shared here.
 */
export interface SaveUserWaypointResult {
  waypoint: UserWaypoint;
  /** The background send, when a server write was queued (tests await it). */
  drain: Promise<DrainResult> | null;
}

export async function saveUserWaypoint(
  args: SaveUserWaypointInput,
  deps: SyncDeps = {},
): Promise<SaveUserWaypointResult> {
  const { trailId, existing, visibility } = args;
  if (existing && !existing.mine) throw new Error('Only the hiker who added a waypoint can edit it.');
  if (existing && existing.trailId !== trailId) throw new Error('That waypoint is on another trail.');
  if (visibility === 'shared' && !canShareWaypoints(trailId)) {
    throw new Error('Waypoints on this trail can only be kept on this phone.');
  }
  const check = checkUserWaypointInput(args.input);
  if (!check.ok) throw new Error(check.message);

  const db = await resolveDb(deps);
  const nowIso = new Date((deps.now ?? Date.now)()).toISOString();
  const waypoint: UserWaypoint = {
    id: existing?.id ?? userWaypointId(uuidv4()),
    trailId,
    ...check.value,
    visibility,
    mine: true,
    authorName: visibility === 'shared' ? (existing?.authorName ?? args.displayName ?? null) : null,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  await userWaypointsRepo.saveLocal(db, waypoint);

  let queued = false;
  if (visibility === 'shared') {
    await outboxRepo.replacePending(db, 'waypoint', waypoint.id);
    await outboxRepo.replacePending(db, 'waypoint-delete', waypoint.id);
    const payload: WaypointOutboxPayload = {
      id: waypoint.id,
      request: {
        trailId,
        name: waypoint.name,
        type: waypoint.type,
        lat: waypoint.lat,
        lon: waypoint.lon,
        description: waypoint.description,
      },
    };
    await outboxRepo.enqueue(db, {
      id: uuidv4(),
      kind: 'waypoint',
      trailId,
      waypointId: waypoint.id,
      payload,
      createdAt: nowIso,
    });
    queued = true;
  } else if (existing?.visibility === 'shared') {
    // Made private: the server copy comes down, the phone keeps its own.
    await outboxRepo.replacePending(db, 'waypoint', waypoint.id);
    await outboxRepo.enqueue(db, {
      id: uuidv4(),
      kind: 'waypoint-delete',
      trailId,
      waypointId: waypoint.id,
      payload: { id: waypoint.id },
      createdAt: nowIso,
    });
    queued = true;
  }

  emitSyncChange({ trailId, userWaypoints: true });
  // Sent in the background: the waypoint is saved either way, and the outbox
  // retries a send that fails (offline, no identity yet).
  const drain = queued ? drainOutbox({ ...deps, db }) : null;
  drain?.catch(() => {});
  return { waypoint, drain };
}

/** Delete one of this account's waypoints (and its server copy, if shared). */
export async function deleteUserWaypoint(
  waypoint: UserWaypoint,
  deps: SyncDeps = {},
): Promise<{ drain: Promise<DrainResult> | null }> {
  if (!waypoint.mine) throw new Error('Only the hiker who added a waypoint can delete it.');
  const db = await resolveDb(deps);
  await userWaypointsRepo.deleteById(db, waypoint.id);
  let queued = false;
  if (waypoint.visibility === 'shared') {
    await outboxRepo.replacePending(db, 'waypoint', waypoint.id);
    // A DELETE of a waypoint the server never got is a 404, which settles it.
    await outboxRepo.enqueue(db, {
      id: uuidv4(),
      kind: 'waypoint-delete',
      trailId: waypoint.trailId,
      waypointId: waypoint.id,
      payload: { id: waypoint.id },
      createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
    });
    queued = true;
  }
  emitSyncChange({ trailId: waypoint.trailId, userWaypoints: true });
  const drain = queued ? drainOutbox({ ...deps, db }) : null;
  drain?.catch(() => {});
  // Wrapped: an async function returning a bare promise would wait for it.
  return { drain };
}

/** Report another hiker's shared waypoint. Queued like a comment report. */
export async function reportUserWaypoint(
  args: { waypoint: UserWaypoint; reason: ReportReason; detail?: string | null },
  deps: SyncDeps = {},
): Promise<void> {
  const { waypoint } = args;
  if (waypoint.visibility !== 'shared' || waypoint.mine) {
    throw new Error('Only another hiker’s shared waypoint can be reported.');
  }
  const db = await resolveDb(deps);
  const payload: WaypointReportOutboxPayload = {
    id: waypoint.id,
    reason: args.reason,
    detail: args.detail?.trim() ? args.detail.trim() : null,
  };
  await outboxRepo.enqueue(db, {
    id: uuidv4(),
    kind: 'waypoint-report',
    trailId: waypoint.trailId,
    waypointId: waypoint.id,
    payload,
    createdAt: new Date((deps.now ?? Date.now)()).toISOString(),
  });
  await drainOutbox({ ...deps, db });
}
