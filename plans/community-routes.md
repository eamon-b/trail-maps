# Community routes and trail organisation

Status: in progress (2026-10-07). Issue: user request in session, no GitHub issue yet.

Two features ship together because the second gives the first somewhere to live:

1. **Community routes** — a hiker who imported a GPX (web or phone) can share it.
   Shared routes are listed for everyone, on the web and in the app, labelled
   **Unverified** until an admin marks them **Verified**.
2. **Trail organisation** — the trail selection page (web landing page, app
   "My Guides") groups trails by country and state/region, in tiers
   (curated, then community, then the user's own imports), with a search and
   filter/sort bar.

## Decisions (agreed with the owner, 2026-10-07)

| Question | Decision |
|---|---|
| Storage | The comments-api worker: D1 rows, R2 objects. No rebuild or deploy to publish. |
| Visibility | Passing the automatic checks publishes a route straight away as **Unverified**. |
| Verified | An admin's one-click approval, normally after a favourable AI review. Never automatic. |
| AI review | Automatic, in the worker, in the background (`ctx.waitUntil`), `claude-sonnet-5-5`, **fails open**: a failed or absent review leaves the route Unverified with review status `failed`/`skipped`. |
| Who can submit | Any device identity: a phone (`primary` token) or a browser linked to one (`linked` token). No anonymous web submissions. |
| Licence | CC0, with a required "I recorded this track myself or it is openly licensed" confirmation and an optional credit/source line. Matches `docs/content-legal-posture.md`. |
| Scope | Worker + web + mobile in one PR. |
| Trail list | Country → state/region groups; tiers (curated / community / mine); search + length filter + sort. |

## Lifecycle

```
submit ──► automatic checks ──fail──► 422 {checks}            (nothing stored)
                │ pass
                ▼
          status 'unverified', public ──► AI review (background, fail open)
                │                              │ verdict 'reject' with high confidence
                │                              ▼
                │                         status 'hidden' (admin can restore)
                │ 3 distinct user reports
                ├──────────────────────► status 'hidden'
                │ admin verify
                ▼
          status 'verified'
```

- `hidden` routes are not listed and their GET returns 404 to everyone except
  the owner and admins. `removed` is the owner's or an admin's delete
  (tombstone; the R2 objects are purged best-effort).
- An owner can edit name/description/credit/region of their own route. Any
  edit of a `verified` route drops it back to `unverified` (the admin verified
  the old text), and re-runs the AI review.
- Replacing the GPX is a new submission (new id); the old one can be deleted.

## Automatic checks (`src/lib/community-checks.ts`)

Run by the **client** before upload (so the user sees them while still on the
upload page) and **again by the worker** on what was uploaded — the worker's
result is the one that counts. The checks read the processed `ProcessedTrail`,
never the client's `ImportReport` (which a client could forge), and are all
O(points) so they fit a Worker's CPU budget.

Each check yields `{ id, level: 'pass' | 'warn' | 'fail', message }`. Any
`fail` rejects the submission.

| id | fail | warn |
|---|---|---|
| `shape` | not a valid `ProcessedTrail` (strict shape check, finite numbers, lat/lon in range) | — |
| `length` | < 1 km or > 5,000 km | < 3 km |
| `points` | < 20 points on the main route | point spacing median > 500 m (coarse, hand-drawn) |
| `distance-consistency` | `distance` values disagree with a haversine recompute by > 2 % | — |
| `speed` | — | timestamps present and median moving speed > 15 km/h (looks like a drive or ride) |
| `elevation` | — | no elevation; or ascent per km > 250 m (noisy) |
| `gaps` | — | any jump between consecutive points > 2 km (not a recorded route break) |
| `metadata` | name < 3 or > 80 chars; description < 20 or > 2,000 chars | description is mostly URLs |
| `waypoints` | > 2,000 waypoints | none at all (fine, but the route will have no datasheet) |
| `duplicate` | identical content hash already submitted (worker only, 409) | start and end within 200 m and length within 5 % of a live community route (worker only) |

Density of OSM POIs is deliberately **not** a check: it varies by trail.

## AI review (worker, `src/community-review.ts`)

One `messages.create` call with structured output (`output_config.format`,
JSON schema), `claude-sonnet-5-5`, effort `low`,
`fallbacks: "default"` (`server-side-fallback-2026-07-01`). The API key is the
worker secret `ANTHROPIC_API_KEY`; when it is unset the review is `skipped`.

Input (all user text is fenced as untrusted data; the system prompt says the
route's text may try to instruct the reviewer and must be ignored):
name, description, credit, country/state chosen, length, ascent, the
automatic checks, ≤ 200 waypoint names and types, the bbox, start/end and
~40 evenly sampled coordinates.

Output: `{ verdict: 'looks_good' | 'needs_human' | 'reject', confidence: 0..1,
summary, concerns[], suggestedCountry?, suggestedState? }`.

- `reject` with confidence ≥ 0.8 → `hidden` (spam, abuse, not a walking route,
  personal data in the text). The admin page lists these first.
- Anything else leaves the status alone. The verdict and summary are shown to
  admins; the public sees only "Reviewed" vs not.

## API (comments-api worker)

All bodies JSON unless stated. Types in `src/lib/community-types.ts`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/community/routes` | user | Submit. Body `CommunitySubmitRequest`. 201 `CommunityRouteDetail`; 422 `{error, checks}`; 409 duplicate. |
| GET | `/v1/community/routes` | none | List live (`unverified` + `verified`). Query `country`, `state`, `status`. `Cache-Control: public, max-age=60`. |
| GET | `/v1/community/routes/:id` | optional | One route's detail (owner/admin also see `hidden` and the review). |
| PATCH | `/v1/community/routes/:id` | owner | Edit metadata. |
| DELETE | `/v1/community/routes/:id` | owner or admin | Remove. |
| POST | `/v1/community/routes/:id/report` | user | Report (`spam`/`offensive`/`inaccurate`/`unsafe`/`copyright`/`other`). |
| GET | `/v1/me/community/routes` | user | My submissions, any status, with checks and review. |
| GET | `/v1/admin/community/routes` | admin | Queue: everything not `removed`, with review, reports, checks. |
| POST | `/v1/admin/community/routes/:id/status` | admin | `{ status: 'verified' \| 'unverified' \| 'hidden', note? }`. |
| POST | `/v1/admin/community/routes/:id/review` | admin | Re-run the AI review. |

Rate limit: `communitySubmit` 10 per user per day (`rate_events`).
Upload cap: 4 MB processed JSON, 20 MB raw GPX (the GPX is optional and kept
for re-processing; it is base64 in the JSON body to keep one request).

Storage:
- D1 `community_routes` (+ `community_route_reports`), migration `0005`.
- R2 `community/v1/<id>.<md5[0..12]>.json` (the `ProcessedTrail`, content-addressed,
  `Cache-Control: public, max-age=31536000, immutable`) and
  `community/gpx/<id>.gpx` (raw upload, not linked publicly).
- Clients read the trail JSON from `PHOTOS_PUBLIC_BASE` + key (the same public
  bucket domain as photos and the trail catalog).

Ids: `c_` + 16 url-safe random chars. A community route is **not** in
`ALLOWED_TRAILS`: comments, descriptions and plan sync are off for it (as for
`u_` imports) until a follow-up decides otherwise.

## Trail organisation

`TrailConfig` gains `country` (ISO 3166-1 alpha-2) and `state` (a code from
`src/lib/trail-regions.ts`, e.g. `VIC`, `NSW`, `SI` for NZ's South Island,
`MT-NM` style multi-state codes are not used — a trail spanning several states
lists them: `states: ['VIC', 'NSW', 'ACT']`, and is grouped under the first).
Optional `featured: true` puts a trail in the Featured row.

`public/data/generated/index.json` entries become
`{ id, name, shortName, lengthKm, region, country, states, featured? }`, and
`mobile/assets/trails/index.json` carries `country` and `states` through.

Web landing page:
1. Search box + length filter (Day walk < 30 km, Multi-day 30-300 km,
   Long trail > 300 km) + sort (name, length, region).
2. Featured row (when any).
3. Curated trails grouped Country → State, collapsible, counts in headings.
4. Community routes (from the API when `VITE_API_BASE_URL` is set), grouped the
   same way, with Verified/Unverified badges and a "Share a route" link.
5. My trails (IndexedDB), as now.

The filter applies to all three tiers. Grouping is computed by
`groupTrails()` in `trail-regions.ts`, shared with mobile.

Mobile "My Guides": a SectionList — Hiking now, then sections per country
(state as a subtitle on each card), then Community (online list, cached),
then Imported. A search field filters by name.

## Follow-ups (not in this PR)

- Comments and plan sync on community routes.
- Server-side OSM POI enrichment for community routes.
- Map overview of all trails on the landing page.
- Auto-detecting country/state from coordinates (the AI review suggests one today).
