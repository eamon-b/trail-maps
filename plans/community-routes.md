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
  the owner and admins. Hiding (by the AI review, reports or an admin) deletes
  the route's public JSON, so a hidden route cannot be downloaded; owner and
  admin detail then carries metadata only (`trailUrl: null`). An admin restore
  from hidden always republishes it from the private copy (idempotent; 500
  `trail_missing` if that copy is gone), and a hide re-reads the row after its
  purge and republishes a route a restore made live meanwhile. `removed` is the
  owner's or an admin's delete (tombstone; every R2 object of the route is
  purged best-effort).
- Reports count towards the 3-report hide only when filed after the route's
  last admin status change (`status_changed_at`), so a route an admin
  restored is not hidden again by the reports the admin already weighed. Only
  reports from accounts at least 24 hours old when they reported count; a
  younger account's report is stored and shown to admins but does not count.
- An owner can edit name/description/credit/region of their own route. Any
  edit of a `verified` route drops it back to `unverified` (the admin verified
  the old text), and re-runs the AI review.
- Replacing the GPX is a new submission (new id); the old one can be deleted.
- Concurrency: every row change sets `updated_at` strictly later than the
  value it read. An owner edit, an admin status change, a de-attribution and
  the AI review write only if the row's `status`/`updated_at` still match what
  they read; a lost race returns 409 `conflict` (edit, admin) or retries
  (de-attribution) and deletes the objects it wrote. A review that finishes
  after the row changed writes nothing.

## Automatic checks (`src/lib/community-checks.ts`)

Run by the **client** before upload (so the user sees them while still on the
upload page) and **again by the worker** on what was uploaded — the worker's
result is the one that counts. The checks read the processed `ProcessedTrail`,
never the client's `ImportReport` (which a client could forge). They first
rebuild it: only coordinates, elevations, names, text and waypoint
`trackIndex` are taken from the client. Point km, length, display points,
climb, waypoint and variant km, and variant junctions are recomputed as
`buildTrail` computes them for an import. Route breaks, POIs,
`cumAscent`/`cumDescent` and direction labels are dropped. Everything is
O(n log n) on a real track, with Douglas-Peucker budgeted, so the run fits a
Worker's CPU budget.

Each check yields `{ id, level: 'pass' | 'warn' | 'fail', message }`. Any
`fail` rejects the submission.

| id | fail | warn |
|---|---|---|
| `shape` | not a valid `ProcessedTrail` (strict shape check, finite numbers, lat/lon in range); an alternate/side trip/terminus whose first point is not within 500 m of the route or of an attached alternate | — |
| `length` | < 1 km or > 5,000 km | < 3 km |
| `points` | < 20 points on the main route | point spacing median > 500 m (coarse, hand-drawn) |
| `distance-consistency` | the client's `dist` values go backwards, or its last point's `dist` or `track.totalDistance` differ from the haversine length by > 2 % (min 0.05 km). The stored km are the recomputed ones either way. | — |
| `speed` | — | the raw GPX (`gpxText`, sent only when the web form's "Include the original GPX file" is ticked; the phone has none) has ≥ 10 timed `<trkpt>`s and their median moving speed is > 15 km/h (looks like a drive or ride). No GPX → pass with a note. |
| `elevation` | — | no elevation; or ascent per km > 250 m (noisy). The ascent is recomputed from the points (3 m hysteresis); the client's `totalAscent`/`totalDescent` and per-point `cumAscent`/`cumDescent` are never stored |
| `gaps` | — | any jump between consecutive points > 2 km (a community route has no route breaks; any the client declares are ignored) |
| `metadata` | name < 3 or > 80 chars; description < 20 or > 2,000 chars | description, or the waypoint descriptions taken together, mostly URLs |
| `waypoints` | > 2,000 waypoints, counting main-route, off-trail and every variant's | none at all (fine, but the route will have no datasheet) |
| `duplicate` | identical content hash already submitted (worker only, 409; `existingId` only when it is the caller's own route) | start and end within 200 m and length within 5 % of a live community route (worker only; names that route by id) |

Density of OSM POIs is deliberately **not** a check: it varies by trail.

## AI review (worker, `src/community-review.ts`)

One `messages.create` call with structured output (`output_config.format`,
JSON schema), `claude-sonnet-5-5`, effort `low`,
`fallbacks: "default"` (`server-side-fallback-2026-07-01`). The API key is the
worker secret `ANTHROPIC_API_KEY`; when it is unset the review is `skipped`.

Input (all user text is fenced as untrusted data; the system prompt says the
route's text may try to instruct the reviewer and must be ignored):
name, description, credit, country/state chosen, length, ascent, the
automatic checks, ≤ 200 waypoint names and types in all (the main route's,
plus an even sample of off-trail and variant waypoint names — at least 50 of
the 200 when there are that many), a sample of waypoint descriptions (≤ 60,
link-bearing ones first, each ≤ 200 chars, ≤ 8,000 chars in all), the names
of ≤ 50 alternates/side trips, the bbox, start/end and ~40 evenly sampled
coordinates.

Output: `{ verdict: 'looks_good' | 'needs_human' | 'reject', confidence: 0..1,
summary, concerns[], suggestedCountry?, suggestedState? }`. The SDK client
uses a 20 s timeout and 1 retry so a review fits the `waitUntil` budget.

- `reject` with confidence ≥ 0.8 → `hidden` (spam, abuse, not a walking route,
  personal data in the text). The admin page lists these first.
- Anything else leaves the status alone. The verdict and summary are shown to
  admins; the public sees only "Reviewed" vs not.

## API (comments-api worker)

All bodies JSON unless stated. Types in `src/lib/community-types.ts`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/v1/community/routes` | user | Submit. Body `CommunitySubmitRequest`. 201 `CommunityRouteDetail`; 422 `{error, checks}`; 409 duplicate; 413 `trail_too_large`. |
| GET | `/v1/community/routes` | none | List live (`unverified` + `verified`). Query `country`, `state`, `status`. `Cache-Control: public, max-age=60`. |
| GET | `/v1/community/routes/:id` | optional | One route's detail (owner/admin also see `hidden` and the review). |
| PATCH | `/v1/community/routes/:id` | owner | Edit metadata. 409 `conflict` if the route changed during the edit. |
| DELETE | `/v1/community/routes/:id` | owner or admin | Remove. |
| POST | `/v1/community/routes/:id/report` | user | Report (`spam`/`offensive`/`inaccurate`/`unsafe`/`copyright`/`other`). Not one's own route (400 `own_route`); a repeat report from the same user is answered 200 and counts once. |
| GET | `/v1/me/community/routes` | user | My submissions, any status, with checks and review. |
| GET | `/v1/admin/community/routes` | admin | Queue: everything not `removed`, with review, reports, checks. |
| POST | `/v1/admin/community/routes/:id/status` | admin | `{ status: 'verified' \| 'unverified' \| 'hidden', note? }`. 409 `conflict` if the route changed meanwhile. |
| POST | `/v1/admin/community/routes/:id/review` | admin | Re-run the AI review. |

Rate limits (`rate_events`): `communitySubmitAttempt` 30 submit requests per
user per day, spent before the body is parsed, failed ones included;
`communitySubmit` 10 published routes per user per day, spent only after the
checks pass and the stored JSON measures ≤ 4 MB; `communityEdit` 20 PATCHes
that change something per user per day.
Upload cap: 4 MB processed JSON, 5 MB raw GPX (`COMMUNITY_LIMITS.gpxMaxBytes`;
the GPX is optional and kept for re-processing; it is base64 in the JSON body
to keep one request; the web share form sends it only while "Include the
original GPX file" is ticked, the default, and always leaves out a larger one;
a file whose head is not `<gpx` is dropped and the route stored without it).
A request whose non-GPX part exceeds 4 MB + 64 KB is refused 413
`trail_too_large` before it is checked.

`GET /v1/community/routes/:id` sends `Cache-Control: private, no-store` to any
request carrying a bearer token, and `Vary: Authorization` with the public
`max-age=60`.

Storage:
- D1 `community_routes` (+ `community_route_reports`), migration `0005`.
- R2 (the PHOTOS bucket). The bucket has no private area — all of it is
  served at `PHOTOS_PUBLIC_BASE` — so private objects are protected by
  unguessable keys (128 random bits) that are recorded in the row and never
  returned by the API; an R2 custom domain serves by exact key and does not
  list.
  - `community/private/<id>/<32 random hex>.json` (`private_key`): the
    canonical `ProcessedTrail`, rewritten on every republish.
  - `community/v1/<id>.<md5[0..12]>.json` (`r2_key`): the public copy, same
    bytes, content-addressed, `Cache-Control: public, max-age=300` (short, so an edge copy
    does not outlive a hide by more than a few minutes). Exists only while the route is `unverified`/`verified`
    (`r2_key` is NULL while hidden).
  - `community/private/<id>/<32 random hex>.gpx` (`gpx_key`): the raw upload.
- A republish (owner edit, de-attribution) writes a new private and public
  object and updates the row; it never deletes the old public object, because
  lists cached for 60 s at the edge and up to 30 min on phones still name it.
  Old versions go when the route is hidden (every object under
  `community/v1/<id>.` is deleted) or removed (that prefix and
  `community/private/<id>/` are purged).
- Clients read the trail JSON from `PHOTOS_PUBLIC_BASE` + key (the same public
  bucket domain as photos and the trail catalog). The app never deletes a
  downloaded route because a list leaves it out; it probes the route's detail
  and a 404 marks it "No longer shared" (file kept until the hiker removes it).

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
   Long trail > 300 km) + sort (name, shortest first, longest first).
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
