# Part 6b: Crowd-Sourcing Design (v2.1)

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
| 2 | **Waypoint corrections & additions** (new waypoint, position/name/type fix, "no longer exists") | Directly reuses the item-2 long-press → `AddWaypointSheet` flow — a submission is just a local custom waypoint the user chooses to share. |
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
  (Section 7); submitting requires only an anonymous identity (Section 5).

6a (feedback-form-to-email, no backend) is unchanged and ships before any of this.

---

## 2. Contribution Data Model

### 2.0 Prerequisite work item: stable waypoint ids in published trail JSON

Everything below that references a "bundled waypoint id"
(`water_observations.waypoint_id`, `waypoint_submissions.target_waypoint_id`,
the Section 7 fold join) currently has nothing real to point at: published
trail JSON waypoints carry **no id at all**. The mobile client synthesizes
positional ids — `trailJsonToTrail` in `mobile/src/lib/trail-utils.ts` assigns
`wp-${i}` by array index — which shift the moment the fold inserts a community
waypoint into the array, and SQLite waypoint rowids are rewritten on every
re-import. Keying observations or corrections on any of those is building on
sand.

**Decision: the first 6b implementation task — before any server work — is
stable waypoint ids.** Generated deterministically at build time in
`build-trails.ts` (e.g. trail id + type + rounded coordinates, so rebuilds are
stable and collisions surface as build errors), carried through
`build-mobile-trails.ts` into the mobile JSON, and surfaced by
`trailJsonToTrail` in place of the synthetic `wp-${i}`. All observation and
correction references — client outbox, server tables, and the fold — key on
these ids. Community-added waypoints use their submission uuid as their stable
id (published as `sourceId`, Section 7), so a single namespace covers both
cases.

### 2.1 Client side: `custom_waypoints` grows sync columns

Item 2 lands `custom_waypoints` as migration 5 (text PK — a base36
timestamp+random id, `${Date.now().toString(36)}-<random>`, *not* a uuid —
`trail_id` FK CASCADE, name, type, lat/lon/ele, `km_position`, `off_track_m`,
description, timestamps). That the local id is locally minted and non-uuid is
exactly why every *submission* carries its own client-minted uuid (§2.2, §3):
the submission uuid, not the local row id, is the idempotency key and the
cross-system handle. 6b adds **migration 6** — sync bookkeeping only, no shape
change to the waypoint itself:

```sql
-- mobile migration 6 (6b)
ALTER TABLE custom_waypoints ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local';
  -- 'local'    private, never submitted (the default forever — sharing is opt-in)
  -- 'pending'  user tapped Share; queued in the outbox, not yet acknowledged
  -- 'synced'   server acknowledged receipt (queued or approved server-side)
  -- 'rejected' moderator rejected; row keeps working locally, badge explains why
ALTER TABLE custom_waypoints ADD COLUMN server_id TEXT;      -- submission uuid, minted
  -- CLIENT-side at share time; sent as the server-row PK (idempotency key, §2.2/§3),
  -- later matched against published sourceId / duplicate_of for dedupe (§3)
ALTER TABLE custom_waypoints ADD COLUMN deleted_at TEXT;     -- soft delete: a shared row
  -- can't be hard-deleted until the retraction has been pushed (outbox needs the id)
ALTER TABLE custom_waypoints ADD COLUMN device_id TEXT;      -- local install uuid, stamped
  -- at share time — local correlation/debugging only; the server-side identity is the
  -- Supabase anonymous auth uid (§5), never this value

-- Local outbox for water status observations (append-only, mirrors the server table)
CREATE TABLE water_observations (
  id TEXT PRIMARY KEY,                 -- uuid, client-generated (idempotency key)
  trail_id TEXT NOT NULL REFERENCES trails(id) ON DELETE CASCADE,
  waypoint_id TEXT NOT NULL,           -- stable bundled waypoint id (§2.0), or
                                       -- 'custom-<localId>' for a custom waypoint
                                       -- (remapped to its submission uuid at push, §3)
  status TEXT NOT NULL,                -- 'flowing' | 'low' | 'dry'
  note TEXT,
  observed_at TEXT NOT NULL,           -- when the hiker was actually there
  sync_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_water_observations_trail ON water_observations(trail_id);
```

Key property — and a **MUST-HOLD invariant, not a free lunch**: `custom_waypoints`
is never touched by `dataVersion` bulk rewrites, so a rejected or still-pending
contribution can never be wiped by a trail data refresh. The first draft claimed
this followed automatically from being a separate table. It does not: as shipped
in item 2, `storeTrail` in `mobile/src/services/trail-data-service.ts` used
`INSERT OR REPLACE INTO trails`, and with `PRAGMA foreign_keys = ON` the REPLACE
deletes the old trail row first — cascading through every `ON DELETE CASCADE` FK
and wiping `custom_waypoints` (and plans) on every refresh. The property holds
only because the Phase 4 review fix changes `storeTrail` to a non-destructive
`ON CONFLICT(id) DO UPDATE` upsert. 6b depends on that fix landing first and
must pin it with a regression test ("re-importing a trail at a new `dataVersion`
preserves `custom_waypoints` rows"); every sync decision below assumes it.

### 2.2 Server side (Supabase Postgres, Sydney — see Section 4)

```sql
CREATE TABLE devices (
  id uuid PRIMARY KEY,                          -- = auth.uid() of the Supabase anonymous
                                                --   session (§5) — NOT client-minted
  email text,                                   -- null unless magic-link linked (§5)
  email_verified_at timestamptz,
  trust_level smallint NOT NULL DEFAULT 0,      -- 0 = normal, 1 = trusted (§6, later)
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

CREATE TABLE waypoint_submissions (
  id uuid PRIMARY KEY,                          -- CLIENT-generated (idempotency key, §3)
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
                                                -- nullable: privacy deletion anonymizes
                                                --   in place, it never deletes rows (§8)
  trail_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('new', 'correction', 'invalidation')),
  target_waypoint_id text,                      -- stable bundled waypoint id (§2.0) for
                                                --   correction/invalidation
  payload jsonb NOT NULL,                       -- { name, type, lat, lon, ele, km_position,
                                                --   off_track_m, description } (subset for corrections)
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'approved', 'rejected', 'spam', 'retracted')),
  duplicate_of uuid REFERENCES waypoint_submissions(id),
                                                -- set when rejected as duplicate of an
                                                --   approved submission (§3, §6)
  moderator_note text,                          -- shown to the submitting device on rejection
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz
);

CREATE TABLE water_observations (
  id uuid PRIMARY KEY,                          -- client uuid (idempotent re-push)
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,  -- nullable, as above (§8)
  trail_id text NOT NULL,
  waypoint_id text NOT NULL,                    -- stable bundled waypoint id (§2.0), or
                                                --   the waypoint submission uuid for
                                                --   community/custom waypoints (§3)
  status text NOT NULL CHECK (status IN ('flowing', 'low', 'dry')),
  note text,
  observed_at timestamptz NOT NULL,
  moderation_status text NOT NULL DEFAULT 'queued'
    CHECK (moderation_status IN ('queued', 'approved', 'rejected', 'spam', 'retracted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  CHECK (observed_at <= created_at)             -- no future-dated observations (§2.3);
                                                --   the Edge Function clamps before insert
);

CREATE TABLE condition_reports (                -- priority 3; same moderation columns
                                                --   and observed_at CHECK as above
  id uuid PRIMARY KEY,                          -- CLIENT-generated (idempotency key, §3)
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
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

The ranking needs one guard the first draft missed: **`observed_at` must be
clamped.** A future-dated observation has negative `age_days`, so
`exp(-age_days / 30)` exceeds 1 without bound — a single vandal (or a device
with a broken clock) could dominate the published status of a safety-critical
datum. Three layers: the Edge Function rejects (or clamps) any `observed_at`
beyond `now()` plus a small clock-skew allowance (~10 minutes); the schema
enforces `CHECK (observed_at <= created_at)` (§2.2); and the fold caps every
weight at 1 (`w = min(1, exp(-age_days / 30))`) as defense-in-depth. The
moderation queue also displays observation dates relative to now — a row
reading "observed 3 days from now" is unmissable to the moderator.

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

Outbox mechanics: **every** submission type — waypoint submissions, water
observations, condition reports — carries a client-generated uuid that is the
server-row PK, inserted with `ON CONFLICT DO NOTHING` semantics in the Edge
Function, so a retried POST after a dropped response cannot double-submit and a
partially-failed batch can be re-sent whole. (The first draft gave only
`water_observations` a client key; server-side `gen_random_uuid()` on the other
two left retry correlation positional, which breaks exactly when it matters —
on retry after partial failure. Fixed in §2.2.) `/submit` items and the
per-item response entries both carry this client id explicitly; the outbox
marks rows by id, never by position. Drain order is FIFO per table; a 4xx
(rejected/invalid) marks the row `rejected` with the server message; a
5xx/network failure leaves it `pending` for the next foreground.

Observations against custom waypoints: locally an observation may reference
`custom-<localId>`. If that waypoint has been shared, the push remaps
`waypoint_id` to the waypoint's submission uuid — the `server_id` stamped at
share time (§2.1) — because that uuid is the only identifier both sides know,
and it is what the fold joins on for community waypoints (§7). **Observations
against a never-shared local waypoint are never pushed**: they stay local-only,
since nothing on the server (or in anyone else's data) exists for them to
attach to. Sharing the waypoint later makes its queued observations pushable.

Retraction: deleting a shared custom waypoint (or explicitly retracting any
submission) sets `deleted_at` locally and enqueues a **retraction item** in
`/submit` carrying the submission's client uuid. The server marks the
submission `status = 'retracted'` — a first-class status in the §2.2 CHECKs —
whether it was still `queued` or already `approved`; the fold excludes
retracted rows, so retracting an approved submission removes the waypoint, or
may flip a published water status, at the next fold (the confirmation sheet
says so). Once the ack returns, the client hard-deletes the soft-deleted local
row.

Reconciliation with published data: when a device's own approved submission
later arrives inside bundled trail JSON, the published waypoint carries the
submission uuid as `sourceId`, and the merge step drops any local row whose
`server_id` matches a published `sourceId`, so the user never sees a duplicate.
Two honest corrections to the first draft here:

- **This dedupe does not exist yet.** The item-2 `mergeCustomWaypoints` (in
  `mobile/src/lib/trail-utils.ts`) simply appends custom waypoints and re-sorts
  by km; it has no `sourceId` logic. The real 6b work is: add `sourceId` (and
  stable ids, §2.0) to the published JSON schema, emit them from
  `build-trails.ts` / `build-mobile-trails.ts`, and add the dedupe pass to the
  merge.
- **The rejected-corroborator case.** When two hikers submit the same tank, the
  moderator approves one and rejects the other as a duplicate — but the
  rejected device's `server_id` then matches no published `sourceId`, so a
  naive dedupe leaves that hiker a permanent duplicate pin wearing a "rejected"
  badge. Fix: the moderator sets `duplicate_of` (§2.2) when rejecting as
  duplicate; `submission_status` exposes it; the client also drops local rows
  whose submission's `duplicate_of` matches a published `sourceId`; and the
  badge for that case reads **"confirmed by the community"**, not "rejected".

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
POST /auth (signInAnonymously)       Supabase Auth — called once, lazily, at first
                                     submission; creates the anonymous identity
                                     everything below hangs off (§5).

POST /functions/v1/submit            Edge Function — the single write entrypoint,
                                     called with the anonymous-session JWT. Body:
                                     { items: [...] } — a mixed batch of
                                     waypoint_submissions / water_observations /
                                     condition_reports / retractions, every item
                                     carrying its client-generated uuid. Derives
                                     the device from auth.uid() (upserting the
                                     devices row), enforces rate limits (§5),
                                     validates observed_at (§2.3), inserts with
                                     service role using ON CONFLICT DO NOTHING,
                                     returns per-item { clientId, status } for
                                     outbox marking.

GET  /rest/v1/submission_status      PostgREST view; RLS binds rows to auth.uid(),
                                     so the server decides whose rows you see —
                                     no query-parameter filtering. Returns
                                     { id, status, duplicate_of, moderator_note,
                                     reviewed_at } — the rejection-feedback pull
                                     (§3, §6).

POST /auth/v1/magiclink              Supabase Auth — optional email linking (§5).
```

RLS posture: the shared anon *API key* only identifies the app; every policy is
bound to `auth.uid()` of the device's anonymous session (§5), so "own rows only"
is enforced by the server, not by a client-supplied filter. (The first draft's
`?device_id=eq.<uuid>` filter over a shared key was not security: RLS had no
authenticated principal to bind to, and the device uuid became a guessable
bearer secret over submission history and moderator notes.) No direct table
INSERT/UPDATE/DELETE from clients; moderation writes happen via Studio /
service role only. The fold script (Section 7) reads approved rows with the
service-role key from CI.

---

## 5. Identity

**Decision: Supabase anonymous auth — `signInAnonymously()` called lazily at
first submission — is the identity, with an optional email magic link for
attribution and rejection/approval notification. Rate-limit on identity + IP.
Reading community data requires no identity at all — approved data ships inside
trail data updates, indistinguishable from bundled data.**

- **Server identity = `auth.uid()`:** the first time a user shares anything, the
  app calls `signInAnonymously()` and persists the session; the resulting
  `auth.uid()` is `devices.id`, the moderation handle (trust level, spam bans),
  and the principal every RLS policy binds to. The first draft used a
  client-minted install uuid sent as a request parameter — unimplementable as
  security: with only the shared anon key there is no authenticated principal
  for RLS, so "device sees its own rows" degrades to a client-supplied filter,
  and the uuid becomes a guessable bearer secret. §4 reflects the fix.
- **Local install uuid:** the uuid generated on first launch and stored in
  SQLite is kept, but demoted to a *local correlation id* (stamped on outbox
  rows for debugging and support requests). It never authenticates anything and
  never leaves the device as a credential.
- **Reinstalls:** uninstalling discards the anonymous session, so a reinstall is
  a new identity — acceptable for 6b; lost attribution of *past approved*
  contributions costs nothing functionally. Linking an email (below) is the
  durability upgrade: signing in with the same magic-link email after a
  reinstall merges history back onto one identity.
- **Optional email (magic link):** purely additive — unlocks "notify me when reviewed"
  and a display name on attributed contributions. Never required, never gates any
  feature, collected with the APP 5 notice (Section 8). Linking merges the email onto
  the existing `devices` row; no password ever exists.
- **Rate limits (enforced in the Edge Function):** per device *and* per IP, e.g.
  30 submissions/day and 5/minute per device, 100/day per IP, with a small burst
  allowance; over-limit returns 429 and the outbox retries next foreground. Anonymous
  identities are still cheap to mint (uninstall/reinstall, scripted sign-ins), which is
  why the IP dimension exists; IPs are shared (CGNAT), which is why the per-identity
  dimension exists. Neither is airtight — the moderation queue is
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
  *corroboration*; the moderator merges by approving one and rejecting the other
  with `duplicate_of` set to the approved submission's id (§2.2) and a note
  "duplicate of an approved report — thanks, it corroborated it".
  `submission_status` exposes `duplicate_of`; the client renders that case as
  **"confirmed by the community"**, not "rejected", and uses it to drop the
  local pin once the approved twin is published (§3).
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

1. **`scripts/fetch-contributions.ts` (new, CI):** service-role read of
   approved, non-retracted `waypoint_submissions` / `water_observations` /
   `condition_reports`; joins observations to waypoints on the **stable
   waypoint id** (§2.0) for bundled waypoints and on the **submission uuid**
   for community waypoints (§3) — never on array position; computes the
   freshness ranking (Section 2.3, weights capped at 1); writes contributions
   into the trail source data (new waypoints with `sourceId` — which is also
   their stable id — `waterStatus` blocks on water waypoints, a `conditions`
   array on the trail).
2. `npm run build:trails` + `build-mobile-trails.ts` — already emitting stable
   waypoint ids after the §2.0 prerequisite; the fold adds no further changes
   here beyond carrying the new fields through.
3. Bump `dataVersion` per changed trail in the index.
4. Ship via EAS OTA update (JSON is bundled JS-side data — no store review) and web
   deploy.
5. On next app launch, `loadBundledTrails()` sees the changed `dataVersion` and
   re-imports — the exact code path that ships trail fixes today. Web pages get the
   same data for free from the same JSON.

Published shape additions:

```ts
// on every published waypoint (the §2.0 prerequisite)
id: string;                // stable waypoint id, deterministic at build time

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
failure modes, and there is no read-side server to scale, cache, or secure. The
client diff is modest, not "nearly nil" as the first draft claimed: render
`waterStatus`/`conditions`; add stable ids and `sourceId` to the published JSON
schema and emit them from `build-trails.ts` / `build-mobile-trails.ts` (§2.0);
add the `sourceId`/`duplicate_of` dedupe pass to `mergeCustomWaypoints`, which
today just appends and re-sorts with no dedupe logic at all (§3); plus the
outbox, anonymous-auth session, and retraction flow of §3–§5. Still far smaller
than a live read layer, and every piece stays offline-first by construction.
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
3. **Australian Privacy Act 1988 (APPs).** PII collected is minimal by design: an
   anonymous device identity (the auth uid, §5), optional email, submission
   timestamps + trail locations. Compliance posture:
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
     contributions and data" action (Edge Function), plus the same via email
     request. The flow is **anonymize-in-place, not row deletion** — the first
     draft's "delete device row, tombstone submissions" was both impossible and
     dangerous: submission rows FK the device row (so it could not be deleted
     as written), and deleting *approved* observations would make the next
     weekly fold silently flip published water statuses — a privacy request
     must never mutate safety data. Concretely: erase and unlink the email;
     hard-delete or tombstone only *unpublished* (queued/pending) rows; keep
     approved/published rows but sever their device link — `device_id` is
     nullable with `ON DELETE SET NULL` (§2.2), so deleting the `devices` row
     anonymizes everything it touched in one statement. Published aggregates
     are unaffected by design: they are CC0, already carry no device identifier
     (see APP 3), and the notice says so explicitly.
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

---

## Revision History

- **v2.1 (2026-07-05):** incorporated the Phase 4 design-review findings.
  Identity moved from a client-minted device uuid to Supabase anonymous auth
  with RLS bound to `auth.uid()` (§4, §5); client-generated uuid idempotency
  keys extended from water observations to all three submission types and to
  `/submit` item/response correlation (§2.2, §3, §4); stable waypoint ids in
  the published JSON made an explicit prerequisite work item (§2.0) with all
  references rekeyed on them; the custom-waypoint → submission-uuid observation
  remap defined, including the never-shared-stays-local rule (§2.1, §3, §7);
  `observed_at` clamped server-side with fold weights capped at 1 (§2.2, §2.3);
  privacy deletion changed to anonymize-in-place (§2.2, §8); retraction given a
  first-class server status, fold semantics, and client hard-delete-on-ack
  (§2.2, §3, §4); `duplicate_of` added to close the rejected-corroborator
  dedupe gap (§2.2, §3, §6); the §2.1 "never wiped by refresh" property
  restated as a MUST-HOLD invariant depending on the non-destructive
  `storeTrail` upsert, with a required regression test; naming and scope claims
  corrected against the item-2 implementation (`AddWaypointSheet`, base36 local
  ids, `mergeCustomWaypoints` has no dedupe yet, honest client-diff scoping in
  §7).
- **v2.0 (2026-07-04):** initial design — decisions for scope, data model,
  sync, backend, identity, moderation, distribution, legal, rollout.
