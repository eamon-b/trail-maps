-- FarOut comments API — community routes, follow-ups to 0005
-- (`plans/community-routes.md`).
--
-- `deattribute_pending`: set, in the same statement that clears
-- `submitted_by_name`, when the submitter deletes their account; cleared once
-- the route's stored JSON has been rewritten without the name. The rewrite
-- runs from `waitUntil` and may not finish, so the scheduled handler retries
-- every route still marked.
--
-- `removed_by`: who removed a route — 'owner' (their own delete) or 'admin'
-- (a moderator removed someone else's). NULL on routes removed before this
-- migration and on live ones.
--
-- `blocks_resubmit`: a removed route whose track may not be shared again: one
-- an admin removed, or one its owner deleted while an admin had it hidden
-- (deleting and re-sharing must not be a way out of a moderator's hide). The
-- unique index in 0005 ignores removed routes, so the submit handler checks
-- this one itself.

ALTER TABLE community_routes ADD COLUMN deattribute_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE community_routes ADD COLUMN removed_by TEXT CHECK (removed_by IN ('owner', 'admin'));
ALTER TABLE community_routes ADD COLUMN blocks_resubmit INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_community_routes_deattribute_pending
  ON community_routes(id) WHERE deattribute_pending = 1;
CREATE INDEX idx_community_routes_hash_blocked
  ON community_routes(content_hash) WHERE blocks_resubmit = 1;
CREATE INDEX idx_community_routes_review_pending
  ON community_routes(updated_at) WHERE review_status = 'pending';
