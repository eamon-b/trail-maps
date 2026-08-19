-- FarOut comments API — user reports, waypoint descriptions, photo dedupe.
--
-- Three unrelated additions land together because they ship as one release:
--   1. comment_reports — user-submitted moderation reports (Apple UGC).
--   2. comments.photo_hashes_json — sha-256 hex per stored photo, parallel to
--      photo_urls_json (same order), so a retried upload is recognised as a
--      replay instead of storing the same image twice. NULL on rows predating
--      this migration; those photos are simply not dedupe-protected.
--   3. waypoint_descriptions — curated per-waypoint prose served over the same
--      delta-sync channel as comments. An empty description is a "cleared"
--      tombstone, not a deletion, so clients converge without a second table.

CREATE TABLE comment_reports (
  id TEXT PRIMARY KEY,                -- uuid v4, server-minted
  comment_id TEXT NOT NULL REFERENCES comments(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL CHECK (reason IN ('spam','offensive','inaccurate','other')),
  detail TEXT,                        -- optional free text, <= 500 chars
  created_at TEXT NOT NULL,
  UNIQUE (comment_id, user_id)        -- one report per reporter per comment
);

CREATE INDEX idx_comment_reports_comment ON comment_reports(comment_id);

ALTER TABLE comments ADD COLUMN photo_hashes_json TEXT;

CREATE TABLE waypoint_descriptions (
  trail_id TEXT NOT NULL,
  waypoint_id TEXT NOT NULL,
  description TEXT NOT NULL,          -- '' means cleared (tombstone)
  updated_at TEXT NOT NULL,           -- drives `since` delta reads
  PRIMARY KEY (trail_id, waypoint_id)
);

CREATE INDEX idx_waypoint_descriptions_sync ON waypoint_descriptions(trail_id, updated_at);
