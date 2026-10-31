-- Tracknotes comments API — automated review of comments and shared waypoints
-- (`src/content-review.ts`).
--
-- The first qualifying report of a comment or shared waypoint, or a Llama Guard
-- flag when it is posted, asks Claude whether it is clearly bad; a confident
-- "remove" hides it at once (`deleted_by = 'reports'`, the provisional hide an
-- admin can restore). The three-report hide stays as the backstop.
--
--   review_status        NULL (never reviewed) | pending | done | failed
--   review_json          the review as `ContentReview` (lib/comments-api-types.ts)
--   review_requested_at  when the pending review was claimed; the cron re-runs
--                        one left pending (its `waitUntil` cut short)
--
-- Plain columns: `deleted_by` keeps its values, so neither table is rebuilt.

ALTER TABLE comments ADD COLUMN review_status TEXT;
ALTER TABLE comments ADD COLUMN review_json TEXT;
ALTER TABLE comments ADD COLUMN review_requested_at TEXT;

ALTER TABLE shared_waypoints ADD COLUMN review_status TEXT;
ALTER TABLE shared_waypoints ADD COLUMN review_json TEXT;
ALTER TABLE shared_waypoints ADD COLUMN review_requested_at TEXT;

-- Only reviewed rows: serves the cron's pending sweep (status, then claim
-- time) and the admin queue's "or reviewed" arm.
CREATE INDEX idx_comments_review ON comments(review_status, review_requested_at)
  WHERE review_status IS NOT NULL;
CREATE INDEX idx_shared_waypoints_review ON shared_waypoints(review_status, review_requested_at)
  WHERE review_status IS NOT NULL;
