-- FarOut comments API — photo attachments.
--
-- Photos live in R2 under `comments/{commentId}/{index}.{ext}` and are served
-- publicly via the existing pub-…r2.dev URL. We store the full public URLs as a
-- JSON array on the comment row (NULL = no photos). No separate table at this
-- scale: at most 4 URLs per comment, read straight back with the comment.
ALTER TABLE comments ADD COLUMN photo_urls_json TEXT;
