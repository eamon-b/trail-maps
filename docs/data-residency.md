# D1 Data-Residency Verification

The comments API stores user content in Cloudflare D1 + R2. At creation time
the database was given the **Oceania (`oc`) location hint**, but Cloudflare
documents location hints as **best-effort, not a guarantee**: the primary can
be placed elsewhere, and read replicas (if ever enabled) are explicitly
multi-region. R2 buckets similarly take a location *hint* only.

Because of that, the privacy policy (`docs/privacy-policy.md`) deliberately
says data "may be stored or replicated in other regions". **Do not claim
Australian data residency in store listings or the policy** until the checks
below pass and Cloudflare's docs say hints are binding (they currently do
not).

## How to verify current placement

Run from `workers/comments-api/` with wrangler authenticated:

```bash
# Shows the database's current primary location (look for "running in" /
# location fields in the output)
npx wrangler d1 info <database-name>

# R2 bucket location (user content: photos, community routes)
npx wrangler r2 bucket info tracknotes-data
```

Record the output and date below each time this is re-checked.

## Australian Privacy Principles (APP) posture

The full analysis is in `docs/content-legal-posture.md` (decision 3).
Summary:

- APP 8 (cross-border disclosure) applies if user content leaves Australia.
  The safe posture — and the one the draft policy takes — is to disclose that
  storage is with Cloudflare and may be overseas, rather than to promise
  residency.
- The app collects minimal personal information (display name, posted
  content); no email. It does hold location data a hiker chooses to post: a
  shared waypoint placed with "Use my location", a community route's GPX
  (timestamps kept) and a published photo's EXIF GPS (see the privacy policy).
  This keeps the APP footprint small regardless of region, but location is not
  absent.

## Check log

| Date | Checked by | D1 location | R2 location | Notes |
|------|-----------|-------------|-------------|-------|
| 2026-08-19 | Claude (session) | `running_in_region: OC` | `location: OC` | Both in Oceania. `jurisdiction: null` — placement is observed, not contractually pinned, so the policy wording ("may be stored or replicated in other regions") stays. Re-check before each release. |
| 2026-10-30 | Claude (session) | `running_in_region: OC` | `location: OC` | Both in Oceania. `jurisdiction: null`, read replication disabled. Policy wording stays. |
| 2026-10-30 | Claude (session) | `running_in_region: OC` | `location: OC` | New database `tracknotes-comments` (`7ebd1642-…`, created with `--location oc`) for the Tracknotes rename, replacing `trail-maps-comments` once its data is copied across. `jurisdiction: null`, read replication disabled. Policy wording stays. |
| 2026-10-31 | Claude (session) | `running_in_region: OC` | `location: OC` | New bucket `tracknotes-data` (created with `locationHint: oc`) takes the comments API's photos and community routes, with the app's trail data and offline packs; `aus-map-data` keeps only the public contour dataset. Neither bucket held any user content at the move. `jurisdiction: default`. Policy wording stays. |
