-- FarOut comments API — community routes (`plans/community-routes.md`).
--
-- A hiker's imported GPX, shared with everyone. The processed trail JSON lives
-- in R2 (`community/v1/<id>.<md5[0..12]>.json`, content-addressed, public) and
-- the raw GPX beside it (`community/gpx/<id>.gpx`, private); this table holds
-- what the lists and the moderation queue need without reading either.
--
-- `status`: 'unverified' (public, passed the automatic checks), 'verified'
-- (an admin approved it), 'hidden' (AI review, user reports or an admin took it
-- down; owner and admins only), 'removed' (deleted; a tombstone).
--
-- A deleted account's routes stay up — they were released as CC0 — but are
-- de-attributed: `submitted_by_name` is cleared (and the stored trail JSON
-- rewritten without the name). `user_id` keeps pointing at the scrubbed,
-- unauthenticatable account row, so the moderation trail is intact.

CREATE TABLE community_routes (
  id TEXT PRIMARY KEY,                 -- 'c_' + 16 url-safe chars, server-minted
  user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('unverified', 'verified', 'hidden', 'removed')),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  credit TEXT,
  country TEXT NOT NULL,               -- ISO 3166-1 alpha-2, upper case
  state TEXT,                          -- trail-regions.ts code, or NULL
  length_km REAL NOT NULL,
  ascent_m REAL NOT NULL,
  has_elevation INTEGER NOT NULL,
  waypoint_count INTEGER NOT NULL,
  bbox_json TEXT NOT NULL,             -- [minLon, minLat, maxLon, maxLat]
  start_lat REAL NOT NULL,
  start_lon REAL NOT NULL,
  end_lat REAL NOT NULL,
  end_lon REAL NOT NULL,
  content_hash TEXT NOT NULL,          -- sha256 of the route geometry + waypoints (config excluded)
  md5 TEXT NOT NULL,                   -- md5 of the stored JSON bytes
  bytes INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  gpx_key TEXT,                        -- NULL when no GPX was uploaded
  checks_json TEXT NOT NULL,           -- CommunityCheck[] from the server's run
  review_json TEXT,                    -- CommunityAiReview
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (review_status IN ('pending', 'done', 'failed', 'skipped')),
  submitted_by_name TEXT,              -- display name at submission; NULL once de-attributed
  status_note TEXT,                    -- admin's note on the last status change
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  verified_at TEXT,
  verified_by TEXT,
  removed_at TEXT
);

-- The same route cannot be live twice; a removed one no longer blocks it.
CREATE UNIQUE INDEX idx_community_routes_hash_live
  ON community_routes(content_hash) WHERE status != 'removed';
CREATE INDEX idx_community_routes_list ON community_routes(status, country, state, created_at);
CREATE INDEX idx_community_routes_user ON community_routes(user_id, created_at);
CREATE INDEX idx_community_routes_start ON community_routes(start_lat, start_lon);

CREATE TABLE community_route_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id TEXT NOT NULL REFERENCES community_routes(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL
    CHECK (reason IN ('spam', 'offensive', 'inaccurate', 'unsafe', 'copyright', 'other')),
  note TEXT,                           -- optional, <= 500 chars
  created_at TEXT NOT NULL,
  UNIQUE (route_id, user_id)           -- one report per reporter per route
);

CREATE INDEX idx_community_route_reports_route ON community_route_reports(route_id);
CREATE INDEX idx_community_route_reports_user ON community_route_reports(user_id, created_at);
