-- FarOut comments API — day-planner plans, per-device tokens, browser linking.
--
-- Three tables land together because they ship as one release (see
-- `plans/day-planner.md`, "Server (Phase 2)"):
--   1. plans — one live plan document per (user, trail), soft-deleted so the
--      delta-sync channel can carry tombstones exactly as comments do.
--   2. device_tokens — the auth lookup moves off `users.token_hash` so one
--      account can hold several tokens (the phone's `primary`, plus `linked`
--      browser tokens that expire and can be revoked one at a time).
--   3. link_codes — the short, single-use code a phone shows and a browser
--      exchanges for a `linked` token.
-- Plus `rate_events`, a tiny append-only log backing the two rate limits that
-- cannot be counted off an existing table (plan PUTs per user, device-link
-- attempts per IP).

CREATE TABLE plans (
  id TEXT PRIMARY KEY,                 -- uuid v4, CLIENT-minted = idempotency key
  user_id TEXT NOT NULL REFERENCES users(id),
  trail_id TEXT NOT NULL,              -- must be in ALLOWED_TRAILS (never a `u_` import)
  document_json TEXT NOT NULL,         -- PlanDocument, <= 64 KB serialised
  share_id TEXT UNIQUE,                -- NULL until shared; 22-char url-safe random
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,            -- bumped on every write/delete; drives delta sync
  deleted_at TEXT
);

-- One live plan per trail per user (the line to drop if multiple named plans
-- ever come back). Deleted rows are exempt so a tombstone never blocks a rewrite.
CREATE UNIQUE INDEX idx_plans_user_trail_live ON plans(user_id, trail_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_plans_sync ON plans(user_id, updated_at, id);

CREATE TABLE device_tokens (           -- replaces users.token_hash as the auth lookup
  token_hash TEXT PRIMARY KEY,         -- sha256 hex of the bearer token
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'linked')),
  label TEXT,                          -- "Chrome on macOS", set by the linking browser
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at TEXT,                     -- NULL = never; linked tokens roll 180 days on use
  revoked_at TEXT
);

CREATE INDEX idx_device_tokens_user ON device_tokens(user_id, created_at);

-- Backfill: every existing account's token becomes its `primary` device token.
-- `users.token_hash` stays for one release so a rollback is possible; a later
-- 0005 drops it.
INSERT INTO device_tokens (token_hash, user_id, kind, label, created_at, last_seen_at, expires_at, revoked_at)
SELECT token_hash, id, 'primary', NULL, created_at, last_seen_at, NULL, NULL FROM users;

CREATE TABLE link_codes (
  code TEXT PRIMARY KEY,               -- 8 chars from an alphabet without 0/O/1/I
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,            -- created_at + 10 min
  used_at TEXT                         -- single use: set on the exchange that wins
);

CREATE INDEX idx_link_codes_user ON link_codes(user_id, expires_at);

-- Rolling-window rate limit counters. `bucket` names the limit, `key` the
-- subject (a user id, an IP). Rows are pruned off the response path once the
-- window has passed, so this stays small.
CREATE TABLE rate_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_rate_events_window ON rate_events(bucket, key, created_at);
