-- FarOut comments API — shared hiker waypoints.
--
-- A place a hiker added to a trail and chose to share with everyone: the water
-- source or shop the guide is missing (`src/lib/user-waypoints.ts`). Private
-- waypoints never leave the phone, so only shared ones live here.
--
-- Post-moderated like comments: soft-deleted (tombstoned) so delta sync can
-- tell offline phones it is gone, whether its owner deleted it, an admin
-- removed it, or `reportsToHide` distinct reports hid it.

CREATE TABLE shared_waypoints (
  id TEXT PRIMARY KEY,                 -- 'hw_' + uuid v4, CLIENT-minted = idempotency key
  trail_id TEXT NOT NULL,              -- must be in ALLOWED_TRAILS
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL,                  -- one of USER_WAYPOINT_TYPES
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,            -- bumped on every edit/delete; drives delta sync
  deleted_at TEXT,
  deleted_by TEXT CHECK (deleted_by IN ('owner', 'admin', 'reports')),
  restored_at TEXT                     -- last admin restore: only reports filed after it count
);

CREATE INDEX idx_shared_waypoints_sync ON shared_waypoints(trail_id, updated_at, id);
CREATE INDEX idx_shared_waypoints_user ON shared_waypoints(user_id, created_at);

CREATE TABLE shared_waypoint_reports (
  id TEXT PRIMARY KEY,                 -- uuid v4, server-minted
  waypoint_id TEXT NOT NULL REFERENCES shared_waypoints(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('spam','offensive','inaccurate','other')),
  detail TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (waypoint_id, user_id)        -- one report per reporter per waypoint
);

CREATE INDEX idx_shared_waypoint_reports_wp ON shared_waypoint_reports(waypoint_id);
