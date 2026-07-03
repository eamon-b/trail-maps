# Part 6b: Crowd-Sourcing Design (v2.0)

> **Status:** Design complete — no code in this PR. Implementation is a future phase.
>
> **Supersedes** the open questions in `part-6-community-features.md` (backend choice,
> moderation workflow, offline sync conflict resolution, legal). That file remains the
> phasing skeleton (6a / 6b / 6c); this document is the engineering design for **6b**
> and *lands* the decisions 6b needs. Where the two disagree (e.g. "basic comment
> system" in 6b), this document wins: comments move to 6c.
>
> **Builds on:** Phase 4 item 2 — local custom waypoints (`custom_waypoints`, schema
> migration 5) — which is the on-device primitive every contribution flow starts from.

---

## 1. Scope & Product Framing

**Decision: 6b ships exactly three contribution types, in this priority order, all
text-only, all moderated before publication.**

| Priority | Contribution | Why this order |
|---|---|---|
| 1 | **Water-source status reports** ("flowing / low / dry" on an existing water waypoint) | Highest hiker value per byte; safety-relevant; the data model is trivially append-only; the UI is two taps on a waypoint the app already renders. |
| 2 | **Waypoint corrections & additions** (new waypoint, position/name/type fix, "no longer exists") | Directly reuses the item-2 long-press → `AddCustomWaypointSheet` flow — a submission is just a local custom waypoint the user chooses to share. |
| 3 | **Trail condition reports** (closure, hazard, general condition; text + km position) | Valuable but time-sensitive; under 6b's build-time distribution (Section 7) they publish as "recent history", not realtime. Full realtime conditions are the trigger for the 6c live API. |

Water reports come first because the local custom-waypoints feature already teaches
users to mark water, the calculators already consume `water`/`water-tank` types, and a
status observation is the smallest possible contribution — no free-text required, so
moderation load is minimal.

**Explicit non-goals for 6b** (all deferred to 6c or never):

- Photos, campsite ratings, comments/replies, helpfulness voting — 6c.
- User profiles, contribution stats pages, social features — 6c.
- Realtime/live data layer, push notifications — 6c.
- Background sync of any kind (see Section 3) — never in 6b; revisit in 6c.
- Editing *other users'* contributions from the app — never; corrections are new
  submissions, merged by moderation.
- Accounts as a requirement for anything: reading community data requires nothing
  (Section 7); submitting requires only an anonymous device id (Section 5).

6a (feedback-form-to-email, no backend) is unchanged and ships before any of this.

---

## 2. Contribution Data Model

### 2.1 Client side: `custom_waypoints` grows sync columns

Item 2 lands `custom_waypoints` as migration 5 (uuid PK, `trail_id` FK CASCADE, name,
type, lat/lon/ele, `km_position`, `off_track_m`, description, timestamps). 6b adds
**migration 6** — sync bookkeeping only, no shape change to the waypoint itself:

```sql
-- mobile migration 6 (6b)
ALTER TABLE custom_waypoints ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local';
  -- 'local'    private, never submitted (the default forever — sharing is opt-in)
  -- 'pending'  user tapped Share; queued in the outbox, not yet acknowledged
  -- 'synced'   server acknowledged receipt (queued or approved server-side)
  -- 'rejected' moderator rejected; row keeps working locally, badge explains why
ALTER TABLE custom_waypoints ADD COLUMN server_id TEXT;      -- server submission uuid
ALTER TABLE custom_waypoints ADD COLUMN deleted_at TEXT;     -- soft delete: a shared row
  -- can't be hard-deleted until the retraction has been pushed (outbox needs the id)
ALTER TABLE custom_waypoints ADD COLUMN device_id TEXT;      -- stamped at share time

-- Local outbox for water status observations (append-only, mirrors the server table)
CREATE TABLE water_observations (
  id TEXT PRIMARY KEY,                 -- uuid, client-generated (idempotency key)
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  waypoint_id TEXT NOT NULL,           -- bundled waypoint id or custom-<uuid>
  status TEXT NOT NULL,                -- 'flowing' | 'low' | 'dry'
  note TEXT,
  observed_at TEXT NOT NULL,           -- when the hiker was actually there
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_water_observations_trail ON water_observations(trail_id);
```

Key property (inherited from the item-2 decision): `custom_waypoints` is **never
touched by `dataVersion` bulk rewrites**, so a rejected or still-pending contribution
can never be wiped by a trail data refresh.

### 2.2 Server side (Supabase Postgres, Sydney — see Section 4)

```sql
CREATE TABLE devices (
  id uuid PRIMARY KEY,                          -- client-generated install uuid
  email text,                                   -- null unless magic-link linked (§5)
  email_verified_at timestamptz,
  trust_level smallint NOT NULL DEFAULT 0,      -- 0 = normal, 1 = trusted (§6, later)
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE waypoint_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id),
  trail_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new', 'correction', 'invalidation')),
  target_waypoint_id text,                      -- bundled waypoint id for correction/invalidation
  payload jsonb NOT NULL,                       -- { name, type, lat, lon, ele, km_position,
                                                --   off_track_m, description } (subset for corrections)
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'approved', 'rejected', 'spam')),
  moderator_note text,                          -- shown to the submitting device on rejection
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE water_observations (
  id uuid PRIMARY KEY,                          -- client uuid (idempotent re-push)
  device_id uuid NOT NULL REFERENCES devices(id),
  trail_id text NOT NULL,
  waypoint_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('flowing', 'low', 'dry')),
  note text,
  observed_at timestamptz NOT NULL,
  moderation_status text NOT NULL DEFAULT 'queued'
    CHECK (moderation_status IN ('queued', 'approved', 'rejected', 'spam')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE condition_reports (                -- priority 3; same moderation columns
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id),
  trail_id text NOT NULL,
  km_position real NOT NULL,
  category text NOT NULL CHECK (category IN ('closure', 'hazard', 'condition')),
  severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'caution', 'danger')),
  description text NOT NULL,
  observed_at timestamptz NOT NULL,
  expires_at timestamptz,                       -- moderator-set; conditions age out
  moderation_status text NOT NULL DEFAULT 'queued',
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);
```

### 2.3 Water status is an append-only observations table, not a mutable field

**Decision: water status is never a column on the waypoint that gets overwritten. Every
report is a new immutable row; the *published* status is computed server-side at fold
time by freshness ranking.**

Rationale, versus `waypoints.water_status = 'dry'` last-write-wins:

1. **The history *is* the data.** "Dry in Feb, flowing in June, three years running" is
   a seasonal pattern hikers actually plan around; a mutable field destroys it on every
   write. The datasheet can eventually show "last 3 reports" instead of one word.
2. **Conflicts vanish structurally.** Two hikers reporting the same tank on the same
   day is two rows, not a write conflict. There is nothing to merge, ever — which is
   what makes the Section 3 sync model so simple.
3. **Moderation and abuse handling are per-observation.** A bad actor's rows are
   rejected or bulk-marked spam without touching anyone else's data or reverting state.
4. **Freshness is a ranking problem, not a storage problem.** A mutable field can't
   distinguish "dry, reported yesterday" from "dry, reported 14 months ago" — the
   dangerous case for a safety-relevant datum.

Published freshness ranking (computed by the fold script, Section 7): consider approved
observations from the last 120 days; weight each `w = exp(-age_days / 30)`; the status
with the highest summed weight wins; publish `{ status, observedAt: max(observed_at),
reportCount, agreement }`. A waypoint with no observation inside the window publishes
`status: 'unknown'` — stale certainty is worse than honest ignorance for water.

---

## 3. Sync Model

**Decision: push-only submissions + curated pull. Devices push contributions to a
server inbox; the *only* read path back is moderated contributions folded into the
published trail JSON, delivered through the existing `dataVersion` refresh in
`trail-loader.ts`. Conflict resolution therefore reduces entirely to moderation. The
outbox drains when the app is foregrounded and online (plus a manual "Sync now"
button); there is no background sync.**

```
            PUSH (device → server)                    PULL (server → device)
  ┌──────────────┐     online +      ┌──────────┐   moderate    ┌────────────────┐
  │ local outbox │ ───foreground───▶ │  inbox   │ ────fold────▶ │ published      │
  │ (SQLite)     │    POST, retry    │ (queued) │  at build     │ trail JSON     │
  └──────────────┘                   └──────────┘  time         │ (dataVersion↑) │
        ▲                                                       └───────┬────────┘
        │              no shared mutable state anywhere                 │
        └────────── device re-imports on version change ◀──────────────┘
```

Why this and not the alternatives:

- **Not bidirectional last-write-wins:** LWW exists to reconcile concurrent edits to
  *shared mutable state*. We have none — contributions are append-only facts (Section
  2.3) or proposals that a single writer (the moderator) folds into a single canonical
  artifact (the trail JSON). Adding LWW would mean per-row vector clocks and
  tombstones to solve a problem the data model already dissolved, and it would let an
  unreviewed write clobber curated data — exactly what moderation exists to prevent.
- **Not CRDTs:** CRDTs buy automatic convergence for collaborative editing at the cost
  of significant library/protocol complexity and un-moderatable merge outcomes. Trail
  data is not a shared document; it is curated reference data with a review gate. A
  CRDT merge that "converges" on a wrong water status is a safety bug with no human in
  the loop.
- **No background sync:** consistent with the existing project policy of no always-on
  background activity (GPS is foreground/opt-in for the same reason). Contributions
  are not urgent by design under build-time distribution, an outbox flushed on
  app-open loses nothing (rows are durable in SQLite), and skipping WorkManager /
  BGTaskScheduler removes a whole class of platform-specific failure modes and
  battery/privacy review questions.

Outbox mechanics: each row carries a client-generated uuid used as the idempotency
key, so a retried POST after a dropped response cannot double-submit. Drain order is
FIFO per table; a 4xx (rejected/invalid) marks the row `rejected` with the server
message; a 5xx/network failure leaves it `pending` for the next foreground. A shared
custom waypoint deleted locally becomes a retraction push (`deleted_at` set, row kept
until the retraction is acknowledged).

Reconciliation with published data: when a device's own approved submission later
arrives inside bundled trail JSON, the published waypoint carries the submission uuid
as `sourceId`; the item-2 `mergeCustomWaypoints` step drops any local row whose
`server_id` matches a published `sourceId`, so the user never sees a duplicate.

---

## 4. Backend

**Decision: Supabase, project pinned to AWS ap-southeast-2 (Sydney), for all of 6b.
Tiles stay exactly where they are (Cloudflare Worker + R2). The two systems never
interact — no shared auth, no shared data, no cross-calls; the only place community
data and map data meet is inside the published trail JSON on the device.**

| Criterion | Supabase (Sydney) | Cloudflare Workers + D1 |
|---|---|---|
| **Auth effort** (anon device + email magic link) | Built in: `signInAnonymously()` + magic-link OTP are first-party; RLS ties rows to identity with zero custom code | Build it: token issuance, magic-link email delivery (needs an email provider), session storage, middleware — weeks of undifferentiated work |
| **Moderation tooling** | Supabase Studio table editor is a usable approve/reject queue on day one; SQL views for the queue; dashboard optional later | Nothing out of the box — first task is building an admin UI before a single submission can be reviewed |
| **Cost at 0–5k users** | Free tier (500 MB DB, 50k MAU) covers 6b comfortably; $25/mo Pro if it doesn't. Text-only rows are tiny | Effectively $0–5/mo — cheapest option, genuinely |
| **Lock-in** | Medium-low: it's plain Postgres; `pg_dump` is the complete exit. Auth/RLS are the sticky parts | Low, but D1-specific SQLite dialect + Workers runtime have their own gravity |
| **AU data residency** | Region-pinned Postgres in AWS Sydney at project creation — clean Privacy Act story (§8) | D1 has no region pinning guarantee suitable for a residency commitment; data locates near write traffic, not by promise |

Cloudflare wins only on raw cost, and the margin (~$25/mo worst case) is not worth
buying auth, an email pipeline, and an entire moderation UI with owner time — the
scarce resource here is a solo maintainer's hours, which is also why moderation tooling
is weighted so heavily. AU residency is a hard requirement given the Privacy Act
posture in Section 8, and only Supabase gives it as a checkbox.

The contour worker keeps its job unchanged. If 6c later wants a live read API, that
decision is made fresh (Supabase PostgREST would likely serve it, but nothing in 6b
pre-commits).

### API sketch

Supabase means most "endpoints" are PostgREST inserts guarded by RLS, fronted by one
Edge Function where server-side logic (rate limiting, device upsert) is needed:

```
POST /functions/v1/submit            Edge Function — the single write entrypoint.
                                     Body: { deviceId, items: [...] } (mixed batch of
                                     waypoint_submissions / water_observations /
                                     condition_reports). Upserts devices row, enforces
                                     rate limits (§5), inserts with service role,
                                     returns per-item { id, status } for outbox marking.

GET  /rest/v1/submission_status      PostgREST view, RLS: device sees only its own rows.
       ?device_id=eq.<uuid>          Returns { id, status, moderator_note, reviewed_at }
                                     — this is the rejection-feedback pull (§6).

POST /auth/v1/magiclink              Supabase Auth — optional email linking (§5).
```

RLS posture: anonymous key can call the Edge Function and read `submission_status`
(own rows only); no direct table INSERT/UPDATE/DELETE from clients; moderation writes
happen via Studio / service role only. The fold script (Section 7) reads approved rows
with the service-role key from CI.

---

## 5. Identity

**Decision: anonymous device-id submissions, with an optional email magic link for
attribution and rejection/approval notification. Rate-limit on device id + IP. Reading
community data requires no identity at all — approved data ships inside trail data
updates, indistinguishable from bundled data.**

- **Device id:** a uuid generated on first launch, stored in SQLite, sent with every
  submission. It is the moderation handle (trust level, spam bans) and the key for
  status feedback. It is not portable across reinstalls — acceptable for 6b; pending
  local rows survive in SQLite regardless, and lost attribution of *past approved*
  contributions costs nothing functionally.
- **Optional email (magic link):** purely additive — unlocks "notify me when reviewed"
  and a display name on attributed contributions. Never required, never gates any
  feature, collected with the APP 5 notice (Section 8). Linking merges the email onto
  the existing `devices` row; no password ever exists.
- **Rate limits (enforced in the Edge Function):** per device *and* per IP, e.g.
  30 submissions/day and 5/minute per device, 100/day per IP, with a small burst
  allowance; over-limit returns 429 and the outbox retries next foreground. Device ids
  are free to mint, which is why the IP dimension exists; IPs are shared (CGNAT), which
  is why the device dimension exists. Neither is airtight — the moderation queue is
  the real backstop, rate limiting just keeps the queue human-sized.
- **No accounts to read:** this falls out of Section 7 and is a deliberate product
  stance — a hiker who never contributes still gets every community improvement with
  zero signup friction and zero PII collected.

---

## 6. Moderation

**Decision: 100% pre-publication moderation — nothing user-submitted reaches another
device without human approval. Owner-moderated (Eamon) initially, via Supabase Studio
on a SQL queue view. Auto-signals annotate, they do not auto-publish. Rejection
feedback flows back to the submitting device via the status pull. Trusted-user bypass
is designed in (the `trust_level` column) but switched on only as a later stage.**

Pre-publication is viable precisely because 6b's distribution is build-time: there is
no expectation of instant publication, so the queue can be worked in batches. Target
SLA: median < 24h, p95 < 72h (measured, Section 9).

```
  device outbox
       │  POST /functions/v1/submit
       ▼
  Edge Function ──── rate limit exceeded ──▶ 429 (outbox retries later)
       │
       ▼  insert, status = 'queued'
  ┌─────────────────────────────────────────────┐
  │ auto-signals (annotate only, never publish) │
  │  • proximity+type dedupe: new waypoint      │
  │    within 100 m of same-type existing/      │
  │    queued one → flag "possible duplicate"   │
  │  • profanity/URL filter on text fields      │
  │    → flag "language"                        │
  │  • (6c, photos) EXIF strip + geo-check      │
  └──────────────────┬──────────────────────────┘
                     ▼
              moderation queue  ◀── trusted devices (trust_level ≥ 1):
              (Studio view,          skip queue for water observations
               oldest first)         only — LATER STAGE, off in 6b
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     approve      reject        spam
        │            │            │ (device flagged; future
        │            │            │  submissions auto-queue-bottom)
        │            ▼            │
        │   moderator_note ───────┴──▶ GET submission_status
        │                              (device shows "rejected: <note>";
        │                              local row keeps working, badge only)
        ▼
   approved set
        │  scripts/fetch-contributions.ts (CI, service role)
        ▼
   folded into data/trails/*/trail.json  ──▶  Section 7 pipeline
```

Notes:

- **Dedupe signal, not auto-merge:** two reports of the same tank are usually
  *corroboration*; the moderator merges by approving one and rejecting the other with
  note "duplicate of an approved report — thanks, it corroborated it".
- **Corrections/invalidations** are applied by the moderator editing the source
  `data/trails/*/trail.json` (or approving the row for the fold script to apply
  mechanically — start manual, automate when volume justifies).
- **Rejection is not punishment:** the local waypoint keeps functioning on the
  submitter's device (`sync_status = 'rejected'`, note shown). Only `spam` has teeth.
- **Trusted users (later stage):** `trust_level` promotion is manual, based on approval
  history; bypass applies to water observations only (lowest blast radius) and every
  bypassed row is still visible in an audit view and revocable before the next fold.
- **Escalation/appeal:** reply channel is the 6a feedback email; a solo-moderated 6b
  needs no more process than that.

---

## 7. Distribution Back to Devices

**Decision: for 6b, approved contributions are folded into the published trail JSON at
build time and reach devices through the existing `dataVersion` refresh path in
`loadBundledTrails()`. No live read API, no new runtime dependency, no new permission,
and community data is offline-first by construction. A live API layer is deferred to
6c.**

Pipeline (only the first step is new):

1. **`scripts/fetch-contributions.ts` (new, CI):** service-role read of approved
   `waypoint_submissions` / `water_observations` / `condition_reports`; computes the
   freshness ranking (Section 2.3); writes contributions into the trail source data
   (new waypoints with `sourceId`, `waterStatus` blocks on water waypoints, a
   `conditions` array on the trail).
2. `npm run build:trails` + `build-mobile-trails.ts` — unchanged, now carrying the new
   fields.
3. Bump `dataVersion` per changed trail in the index.
4. Ship via EAS OTA update (JSON is bundled JS-side data — no store review) and web
   deploy.
5. On next app launch, `loadBundledTrails()` sees the changed `dataVersion` and
   re-imports — the exact code path that ships trail fixes today. Web pages get the
   same data for free from the same JSON.

Published shape additions:

```ts
// on a water waypoint in trail JSON
waterStatus?: {
  status: 'flowing' | 'low' | 'dry' | 'unknown';
  observedAt: string;      // ISO date of newest contributing observation
  reportCount: number;     // observations inside the 120-day window
  agreement: number;       // 0–1, weight share of the winning status
}
sourceId?: string;         // submission uuid — enables device-side dedupe (§3)

// on the trail object
conditions?: Array<{
  id: string; kmPosition: number;
  category: 'closure' | 'hazard' | 'condition';
  severity: 'info' | 'caution' | 'danger';
  description: string; observedAt: string; expiresAt?: string;
}>
```

Why this beats a live API for 6b: hikers are offline when the data matters, and this
path makes community data exactly as offline-capable as the trail itself with zero new
failure modes; the client diff is nearly nil (render `waterStatus`/`conditions`, plus
the `sourceId` dedupe); and there is no read-side server to scale, cache, or secure.
The honest cost is latency — publication cadence equals release cadence (target: a
weekly cron fold + EAS update whenever the approved set changed). That is fine for
water seasonality and waypoint fixes, and merely *adequate* for conditions — which is
exactly the pressure that justifies the 6c live layer, rather than building it on
spec. Every UI element built for 6b renders unchanged when 6c swaps the transport.

---

## 8. Legal

**Decisions:**

1. **Contribution licensing — CC0 (public domain dedication), granted at submission
   time.** The submit sheet's first-use notice includes: *"Contributions are dedicated
   to the public domain (CC0) so they can be freely redistributed, including in this
   app and other mapping projects."* CC0 is chosen over CC-BY-SA because: (a)
   attribution stacking is unworkable when hundreds of micro-contributions are folded
   into one JSON artifact; (b) ShareAlike would arguably contaminate the published
   trail-data files and complicate any future licensing of the dataset; (c) **OSM
   compatibility** — CC0 data can be ingested into OpenStreetMap (ODbL) without a
   waiver, whereas CC-BY-SA is not ODbL-compatible; keeping the door open to
   contributing water-point data upstream to OSM is worth more than attribution. The
   in-app display-name credit for linked users (Section 5) is a product courtesy, not
   a license term.
2. **Safety-critical water-data disclaimer.** Water status is the one datum where a
   wrong value can hurt someone. Required: a one-time acknowledgement before community
   water data is first displayed, persistent "reported <date> by hikers — conditions
   change, always carry contingency water" phrasing on `waterStatus` UI (the existing
   `unknown`-when-stale rule in Section 2.3 is itself a safety control), and a ToS
   clause disclaiming reliance on user-submitted data to the extent permitted by the
   Australian Consumer Law (blanket disclaimers can't exclude ACL consumer guarantees,
   so the wording must be "to the maximum extent permitted by law" and reviewed once
   before launch).
3. **Australian Privacy Act 1988 (APPs).** PII collected is minimal by design: device
   uuid, optional email, submission timestamps + trail locations. Compliance posture:
   - *APP 1/5 — open + collection notice:* a privacy policy page and an in-app notice
     at first submission stating what is collected, why, that storage is in Australia
     (Supabase Sydney, Section 4), and the contact address.
   - *APP 3 — minimal collection:* no name, no phone, no account required; email only
     if the user opts in; observation locations are trail features, not user tracking.
     One deliberate mitigation: published data never includes device identifiers, and
     `observed_at` is published at day granularity so a fold can't be used to place a
     specific hiker at a specific tank at a specific hour.
   - *APP 11 — security:* RLS everywhere, service-role key only in CI secrets.
   - *APP 12/13 — access + correction/deletion:* a settings-screen "Delete my
     contributions and data" action (Edge Function: unlink email, delete device row,
     reject-and-tombstone unpublished submissions) plus the same via email request.
     Already-published CC0 contributions are anonymous and stay published; the notice
     says so explicitly.
   - The project is almost certainly under the $3M small-business threshold, so much
     of the Act may not strictly apply — comply anyway; it is cheap at this scale and
     the residency choice was made for it.
4. **ToS + takedown.** A short ToS covering the CC0 grant, acceptable use, moderation
   rights, and disclaimer, accepted implicitly at first submission (link + "by
   submitting you agree"). Takedown process: any content can be reported via the 6a
   feedback email; target acknowledge within 72h; since all content is pre-moderated
   and text-only, takedown means rejecting/unpublishing a row and running the fold —
   minutes of work. Land-manager requests (e.g. a parks service asking to remove a
   sensitive site) are honored by default.

---

## 9. Rollout & Metrics

**Pilot: one trail (Bibbulmun — highest traffic, best water-tank density, existing
maintainer familiarity), water observations only, for the first 8 weeks. Then waypoint
corrections on all trails, then condition reports.**

Instrumentation is nearly free: every metric below is a SQL query over the
submissions tables (no client analytics needed for 6b).

**Success criteria (evaluate at week 8 of the pilot):**

| Metric | Target |
|---|---|
| Submissions/week (pilot trail, steady state) | ≥ 5 |
| Distinct contributing devices | ≥ 10 |
| Moderation latency | median < 24 h, p95 < 72 h |
| Rejection rate (excl. duplicates) | < 30 % |
| Spam share of queue | < 10 % |
| Pilot-trail water waypoints with an observation < 90 days old | ≥ 20 % |
| Fold-to-device latency (approval → dataVersion shipped) | ≤ 7 days |

**Kill / pause criteria** (any of these → freeze submissions UI behind a flag, keep
published data, write a retro before reinvesting):

- < 1 submission/week averaged over 3 consecutive months post-pilot.
- Spam > 50 % of queue for 4 consecutive weeks despite rate-limit tuning.
- Moderation backlog p95 > 2 weeks (i.e. solo moderation is unsustainable) with no
  trusted-user pipeline able to absorb it.
- Any credible incident of harm traced to published community data → immediate
  unpublish of the category + process review (this one is a pause-and-review, not a
  metric).

Because distribution is build-time, "killing" 6b costs nothing operationally: stop the
fold cron, hide the share buttons; devices keep the last published data and all local
custom waypoints. That reversibility is a deliberate property of this design.

### Appendix: Open Questions (deferred, mostly 6c)

- **Photos:** storage cost model (Supabase Storage vs R2), EXIF stripping pipeline,
  moderation effort per item (much higher than text) — the main reason photos are 6c.
- **Reputation:** is manual `trust_level` promotion enough, or does 6c need
  approval-ratio auto-promotion? What revokes trust?
- **Live read API (6c):** PostgREST direct vs a thin cached endpoint; how the client
  merges live conditions over folded ones; offline caching of live data.
- **Offline peer sharing:** hikers meeting on trail exchanging observations
  device-to-device (Bluetooth/QR) — genuinely useful in no-coverage areas,
  genuinely hard (trust, replay); parked indefinitely.
- **Notification channel:** email on review outcome exists via magic link; is push
  (Expo Notifications) worth its infrastructure before 6c?
- **Cross-app data sharing:** publishing the CC0 water dataset as a standalone feed
  (or to OSM) — when volume justifies it, and who maintains the mapping.
- **Web submissions:** the web planner could accept corrections too; identity story
  differs (no stable device id in a browser) — revisit after mobile proves demand.
- **Moderation dashboard:** at what queue volume does Supabase Studio stop being
  enough and a purpose-built review UI (with map preview of the submission) pay off?
