-- FarOut comments API — initial schema.
--
-- Anonymous device identity (users) plus post-moderated per-waypoint comments
-- with optional structured water reports. Comments are soft-deleted (tombstoned)
-- so delta sync can propagate removals to offline clients.

CREATE TABLE users (
  id TEXT PRIMARY KEY,                -- uuid v4, server-minted
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,    -- sha256 hex of bearer token
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE comments (
  id TEXT PRIMARY KEY,                -- uuid v4, CLIENT-minted = idempotency key
  trail_id TEXT NOT NULL,
  waypoint_id TEXT NOT NULL,          -- opaque, ^[a-z0-9_-]{4,64}$
  user_id TEXT NOT NULL REFERENCES users(id),
  text TEXT,
  water_status TEXT CHECK (water_status IN ('flowing','low','dry')),
  observed_at TEXT,                   -- clamped <= now+10min server-side
  created_at TEXT NOT NULL,           -- server clock, feed ordering
  updated_at TEXT NOT NULL,           -- bumped on delete; drives delta sync
  deleted_at TEXT,
  deleted_by TEXT CHECK (deleted_by IN ('owner','admin')),
  CHECK (text IS NOT NULL OR water_status IS NOT NULL)
);

CREATE INDEX idx_comments_feed ON comments(trail_id, waypoint_id, created_at DESC);
CREATE INDEX idx_comments_sync ON comments(trail_id, updated_at, id);
CREATE INDEX idx_comments_user ON comments(user_id);
