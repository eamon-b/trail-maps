# Day planner

Status: planned 2026-09-20 on `claude/day-planner-feature-plan-nhcadj`; the open questions were
answered the same day and rows 1-4c of the sequencing table were implemented on that branch the
same day. Reviewed 2026-09-21 (four review passes, one per layer) on
`claude/pr77-maze-review-secrets-emvjvy`, which rebased the work onto `main` — where the
resupply-selection feature (#77) had landed in the meantime — reconciled the two (see "Where the
hiker's inputs live" below) and fixed the review findings. Row 5, deploy, was run 2026-09-21
from `main` at `90dec99` (recipe under "Deploy" at the end of this file): migration
`0004_plans_devices.sql` applied to the remote D1 and the worker deployed (version
`079ac798`, `/health` ok); the production Android build finished on EAS (build
`43180486-a902-4ae9-a9bc-1eb210d91da9`, an `.aab` for store distribution, 0.1.0 build 1, native
fingerprint unchanged from the August dev client). Still open: `VITE_API_BASE_URL` on the Vercel
project (no Vercel token in the build container — until it is set the live site is local-only),
and the iOS build, which `--non-interactive` refuses until the distribution certificate has been
validated with an interactive Apple sign-in. Note that **the app cannot ship as an EAS Update**
(expo-updates is not installed and `app.json` has no `updates`/`runtimeVersion`), so the phone
side needs an `eas build`. Decisions taken with Eamon are marked **[decided]**; the former open
questions are recorded as decisions at the end.

## Why

The Buen Camino app's stage planner is the model. You walk down a list of places, tap one to
make it tonight's stop, tap it again to unmake it, and every day's distance, ascent and descent
updates as you go. Each place shows what it has (a bed, a shop, a bus) so you can pick a stop
that suits, add a note ("rang ahead, 2 beds"), and the plan follows you from phone to phone via
an account and can be shared with the people you are walking with.

This repo has two planners that each hold half of that. The web plan page is the tap-to-toggle
list with persistence, but any waypoint is a stop, there is no notion of a bed or a rest day, and
the plan lives in one browser's `localStorage`. The phone's Plan screen has the overnight
semantics (it snaps to camps and huts) but generates the split itself, cannot be edited one stop
at a time, and forgets everything but pace and hours when you leave the screen. Nothing moves a
plan between the two.

The feature: one plan document per trail per user, edited by toggling stops on either platform,
with nights, notes and a booked flag per stop, dates that account for rest days, services at each
candidate stop from the OSM data already bundled, synced through the comments API, and readable
by anyone you send a link to.

## What exists today (findings)

- **Shared calculator** (`src/lib/day-calculator.ts`): `computeDays(trail, stops, startDate,
  section, baseKmh)` :277 already yields per-day start/end, distance, ascent, descent, Naismith
  hours, water count and an ISO date when `startDate` is set. Dates are `startDate + i` days
  :325-331 — no rest days. `addStop`/`removeStop` :239/:253 exist but neither UI calls them.
  `PlanStopInput.customLocation` :39-44 is declared and never produced.
- **Plan types** (`src/lib/plan-types.ts`): `PlanState {name, startDate, stops: StopData[],
  direction?, resupplyStops?}` :42 is the only persisted shape; `StopData {km, waypointName}`
  :13 is km-keyed, NOBO-absolute (`src/lib/plan-direction.ts:1-19` is the km-space contract).
  The header :1-7 says the shape is kept JSON-safe so it can one day travel by URL or QR.
- **Web plan page** (`src/web/trails/plan-viewer.ts`, `plan-template.html`, duplicated by hand
  as `src/web/my-plan.html`): Days / Stops / Resupply tabs, map with one polyline per day
  :487-537, elevation canvas with stop dashes :543-666, day cards :706, datasheet :941. The
  Stops tab (`renderStopList` :815-854) lists every waypoint; `toggleStop` :1090 splices
  `planState.stops` and calls `scheduleSave` :1164 (800 ms debounce to `localStorage`
  `trail-plan-<trailId>`, `plan-state.ts:10`). One plan per trail, no ids on stops, no POIs
  (the page's local `Trail` interface :49-69 does not even declare `pois`, though the JSON it
  fetches :379-387 carries them). Desktop only: `plan-template.html:28-31` gates at 900 px. Works
  for imported GPX via `my-plan.ts:46-68`.
- **Mobile Plan screen** (`mobile/app/guide/[trailId]/plan.tsx`, `mobile/src/features/plan/`):
  section steppers, daily hours, pace; `generateDayStops` (`plan-adapters.ts:233-290`) splits
  in hours space and snaps to `overnightWaypoints` :138-149 — camp/shelter category tokens,
  turn-offs excluded (`elevation/waypoint-category.ts:23-56`: `campsite`, `camp`, `campground`,
  `shelter`, `hut`, `accommodation`, `caravan-park`). No dates, no map on the screen, no
  override of any boundary. Only `{dailyHours, pace}` persist (`plan-inputs-store.ts`,
  `tracknotes:plan-inputs`, `version: 1`). The header "Plan" action is
  `guide/[trailId]/_layout.tsx:59-63`; waypoint detail
  (`guide/[trailId]/waypoint/[waypointId].tsx`) has the favorite heart :279-281 as the model for
  a per-waypoint toggle.
- **Server** (`workers/comments-api/`): Cloudflare Worker at `api.contour-map-tiles.net`, D1
  (`farout-comments`) + R2 photos, hand-rolled router `src/index.ts`, migrations `0001`-`0003`.
  Identity is an anonymous device token: `POST /v1/devices` mints it, `users.token_hash` stores
  its SHA-256, one token per user (`src/auth.ts:41-91`). Every comment *read* is public; writes
  are bearer-authed. Delta sync is `?since=` + keyset cursor + tombstones + `syncedAt`
  (`src/comments.ts:280-349`). `ALLOWED_TRAILS` (`src/validation.ts:20-29`) is held equal to the
  bundled trail list by `scripts/server-trail-allowlist.test.ts`. Admin is a DB flag.
- **Mobile sync** (`mobile/src/sync/comment-sync.ts`): generic pieces are `api/client.ts`
  (`apiRequest`, `NetworkError` vs `ApiError`), `api/auth.ts` (session in `expo-secure-store`),
  `db/outbox-repo.ts` (`kind`, `payload_json`, backoff, `OutboxKind` union :19), `sync-events.ts`,
  `connectivity.ts` (`runSync` = drain then pull, on mount / reconnect / foreground). The drain
  itself :311-467 is a hard-coded `if kind === …` chain behind a module-global single-flight
  guard :289-290 — a second entity must go through the same drain. `pullTrail` :201-263 passes
  no token (comments are public). Account deletion purges local rows in
  `features/settings/account-deletion.ts:29-32`. `sync_state` is keyed by `trail_id` with one
  high-water column per channel (`db/schema.ts:67-71`, :132-134).
- **Web identity**: none. `src/web` never calls the API; no `VITE_*` env, no token storage. CORS
  on the worker is already `*` with `Authorization` allowed (`src/http.ts:18-23`), so a browser
  can talk to it today.
- **POIs**: `ProcessedTrail.pois` (`src/lib/trail-types.ts:291-341`) with `distanceAlongTrail`
  on the waypoint km scale; `@lib/poi-display` has `visiblePois`, `interleavePoisByDistance`,
  `summarisePoiTags`, `OSM_ATTRIBUTION`. Present for AAWT, Hume & Hovell, Bibbulmun, Cape to
  Cape, Heysen, Larapinta; **absent for CDT and Te Araroa** (no `pois.json` yet). Mobile reads
  them through `features/guide/use-visible-pois.ts`.
- **Recorded wishes**: `TODO.md:29` ("select campsites for next few days … edit and move points
  one at a time and auto update stats"); `plans/resupply-selection.md:350-358` lists zero days,
  days off and stop markers on the profile as out of scope, and :328-329 says "carrying the plan
  across is a later feature" — this plan supersedes that sentence.

## Decisions

- **[decided] Both platforms together, one shared editor.** The stop-toggle, night, date and
  services logic lives in `src/lib`; web and mobile are thin views over it.
- **[decided] Tap to toggle, no generated stages.** No curated "standard stages" per trail and no
  automatic split written into the plan. You select and deselect places; days, distance, ascent
  and descent update live. (Whether the phone's existing generator survives as an explicit
  "Suggest stops" button is open question 1.)
- **[decided] Per-day figures: distance, ascent, descent.** Estimated hours stay where they
  already are (web day cards at 4 km/h, phone at the chosen pace); no new pace inputs on web.
- **[decided] Server-backed sync via the comments API.** Plans are a new private resource on
  the existing worker, same device identity, same offline-first outbox on the phone.
- **[decided] Browser links to the phone's identity by a short code.** The phone mints a
  short-lived link code; the browser exchanges it for a token of the same user. No email, no
  password. QR is a convenience on top of the code, not the mechanism.
- **[decided] Private, plus a read-only share link.** A plan is visible only to its user unless
  a share id has been minted for it; the share page is read-only and a phone can import a copy.
- **[decided] v1 scope includes** start date and rest days (nights per stop), services at each
  stop from OSM POIs, and a note plus booked flag per stop. **One plan per trail per user**
  (multiple named plans were offered and not chosen).
- **[decided] Suggest, never generate.** The phone's hours-and-pace splitter survives only as
  an explicit "Suggest stops" button that fills an *empty* stop list you then edit. It never
  runs on its own, never on open, never after an edit.
- **[decided] Rest days are nights at a stop.** "Stay two nights in Salida" is `nights: 2` on
  that stop; there are no free-floating zero-day entries.
- **[decided] Services radius is 1 km** along the trail either side of the stop, with no extra
  cap on `distanceFromTrail`.
- **[decided] Linked-browser tokens last 180 days**, rolling from `last_seen_at`.
- **[decided] The share page shows the owner's display name.**
- **[decided] No silent toggles on the web map.** Clicking a waypoint marker opens a popup with
  a "Stop here" / "Remove stop" button; the click itself no longer toggles the stop
  (`plan-viewer.ts:478`). The Resupply-tab marker click keeps its tick behaviour.
- **[decided]** plans for imported trails (`u_` ids) stay local, exactly as comments do;
  conflicts are last-writer-wins by server `updatedAt`, as for comments; a browser's token lives
  in `localStorage` but is a separate, revocable, expiring token rather than the phone's; the
  Stops list defaults to overnight candidates with an "All waypoints" switch.
- **[decided 2026-09-21] Where the hiker's inputs live.** After the rebase onto #77 the web
  `PlanState` carried `pace`/`dailyHours` and the phone kept its resupply selection device-local
  in `plan-inputs-store`, while this feature made `PlanDocument` the one synced shape. Resolved
  as: **pace and hours are per device** (web: `PlanUiPrefs` under `trail-plan-ui-<id>`, migrated
  out of the legacy `PlanState`; phone: `plan-inputs-store`), because a shared plan should not
  say how fast its author walks and the phone already kept its own; **the resupply selection is
  in the document** (`PlanDocument.resupplyStops`, edited through `setResupplyStops` in
  `plan-editor.ts` on both platforms), because it is part of the plan and the web had already
  put it there. The phone reads a legacy `plan-inputs-store` selection only while the document
  has none.

## Data contract — the plan document

One JSON document is the wire shape, the SQLite row's `document_json`, the `localStorage` value
and the share payload. It supersedes `PlanState`; `plan-types.ts` keeps `PlanState` only for the
one-off `localStorage` migration.

```ts
// src/lib/plan-types.ts
export interface PlanStop {
  waypointId?: string;   // registry id (`data/waypoint-ids.json`) or `uw_…` for an import;
                         // absent only for a legacy km-only stop that matched nothing
  km: number;            // NOBO-absolute km, the key when waypointId is absent and the
                         // display position always (plan-direction.ts contract unchanged)
  name: string;
  nights: number;        // >= 1; 2 = one rest day here
  note?: string;         // <= 500 chars
  booked?: boolean;
}

export interface PlanDocument {
  id: string;            // client-minted uuid v4 = idempotency key, as for comments
  trailId: string;
  name: string;          // <= 80
  direction: PlanDirection;
  startDate: string | null;   // ISO date
  stops: PlanStop[];          // sorted by km, trail start/end implicit, <= 500
  resupplyStops?: string[];   // unchanged from resupply-selection
  updatedAt: string;          // server clock on the copy that came from the server
  version: 1;
}
```

Rules:
- Two stops never share a `waypointId`; two stops never share a km within `KM_EPSILON`.
- `nights` extends the date cascade: day n's date is `startDate` plus the sum of `nights` of
  every stop before it. A `ComputedDay` gains `restDays: number` (nights − 1 at its end) so a
  card can say "2 nights at Salida"; the walking days themselves are unchanged.
- The whole document must be ≤ 64 KB serialised (server-enforced), so notes are short and
  nothing per-stop is ever a photo or a POI copy.
- Imported trails: `trailId` is the `u_` id, `waypointId` the `uw_` id. The document is
  identical; only the sync gate differs.

## Shared editor (Phase 1) — `src/lib/plan-editor.ts`

Pure functions over `PlanDocument`, no DOM, no RN. Both UIs call these and re-render.

```ts
export function toggleStop(plan, waypoint: {id?, km, name}): PlanDocument;   // add or remove
export function setNights(plan, stopKey, nights): PlanDocument;             // clamp 1..14
export function setStopNote(plan, stopKey, note): PlanDocument;             // trim, cap 500
export function setStopBooked(plan, stopKey, booked): PlanDocument;
export function setStartDate(plan, iso | null): PlanDocument;
export function setDirection(plan, dir): PlanDocument;                      // km stay NOBO
export function findStop(plan, waypoint): PlanStop | undefined;            // id, else km ± eps
export function migratePlanState(state: PlanState, trail): PlanDocument;    // localStorage → v1
export function newPlan(trailId, name, direction): PlanDocument;
export function overnightCandidates(waypoints): PlanWaypoint[];             // moved from mobile
export function computePlanDays(trail, plan, baseKmh): ComputedDay[];       // wraps computeDays
                                                                            // with nights → dates
export function servicesAtStop(stop, pois, radiusKm = 1): StopServices;     // see below
```

- `overnightCandidates` moves the phone's `overnightWaypoints` (`plan-adapters.ts:138-149`)
  into `src/lib` over the taxonomy in `waypoint-taxonomy.ts` (camp, hut, shelter,
  accommodation, caravan-park, town; never an `-access` turn-off — you cannot sleep at one). The
  mobile adapter re-exports it so the snapper keeps its behaviour.
- `servicesAtStop` returns `{camping, lodging, shop, food, water, transport}` booleans plus the
  POIs behind them, from POIs with `|distanceAlongTrail − stop.km| ≤ radiusKm`, **reading
  `duplicateOf` entries too** (the curated waypoint hides them from the map, but their OSM
  `website`/`opening_hours` is exactly what a stop card wants — see
  `features/guide/waypoint-detail.ts:132-133`). A trail with `pois === undefined` returns
  `undefined`, and the UI says "No OSM data for this trail", never "no services" (CDT and Te
  Araroa).
- `migratePlanState` resolves each legacy km to a waypoint id by `KM_EPSILON` match, sets
  `nights: 1`, and mints an id. It runs once on the web when a `trail-plan-<id>` key is found
  and no document exists.

Tests (`src/lib/plan-editor.test.ts`): toggle adds sorted and removes by id, then by km when the
id is absent; nights cascade dates and `restDays`; a SOBO toggle stores NOBO km; migration of a
real saved `PlanState` fixture; services within the radius including a `duplicateOf` POI;
`undefined` for a trail without POIs; document size guard.

## Server (Phase 2) — `workers/comments-api/`

### Migration `0004_plans_devices.sql`

```sql
CREATE TABLE plans (
  id TEXT PRIMARY KEY,                 -- client uuid v4
  user_id TEXT NOT NULL REFERENCES users(id),
  trail_id TEXT NOT NULL,
  document_json TEXT NOT NULL,         -- PlanDocument, <= 64 KB
  share_id TEXT UNIQUE,                -- NULL until shared; 22-char url-safe random
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX idx_plans_user_trail_live ON plans(user_id, trail_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_plans_sync ON plans(user_id, updated_at, id);

CREATE TABLE device_tokens (           -- replaces users.token_hash as the auth lookup
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('primary', 'linked')),
  label TEXT,                          -- "Chrome on macOS", set by the linking browser
  created_at TEXT NOT NULL, last_seen_at TEXT, expires_at TEXT, revoked_at TEXT
);
INSERT INTO device_tokens SELECT token_hash, id, 'primary', NULL, created_at, last_seen_at, NULL, NULL FROM users;

CREATE TABLE link_codes (
  code TEXT PRIMARY KEY,               -- 8 chars, no 0/O/1/I, 10 min TTL, single use
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT
);
```

`users.token_hash` stays for one release so a rollback is possible, then a `0005` drops it.
`auth.ts:64-91` looks up `device_tokens` instead, rejecting `revoked_at` / expired rows; the
`last_seen_at` touch moves to the token row.

### Routes (all under `/v1`, same envelope, same `HttpError` idiom)

| Route | Auth | Notes |
|---|---|---|
| `GET /plans?since=&cursor=&limit=` | user | Delta sync of **this user's** plans, tombstones included, keyset `(updated_at, id)`, `syncedAt` — the comments pattern with a `WHERE user_id = ?` |
| `PUT /plans/:id` | user | Full replace. Body = `PlanDocument` minus `updatedAt`. Validates trail against `ALLOWED_TRAILS` (a `u_` id is 400 `trail_not_allowed`, so a bug in the client gate can never leak an import), 500 stops, 64 KB, ids match the path. Replay by owner → 200; another user's id → 409 `id_conflict`; a second live plan for the same trail → 409 `plan_exists` with `{existingId}` |
| `DELETE /plans/:id` | user | Soft delete + `updated_at` bump (tombstone) |
| `POST /plans/:id/share` | user | Mints `share_id` if absent → `{shareId, url}` |
| `DELETE /plans/:id/share` | user | Revokes (sets NULL) |
| `GET /shared/plans/:shareId` | public | `{document, trailId, ownerDisplayName}` read-only, `Cache-Control: no-store`; 404 for revoked or deleted |
| `POST /link-codes` | user | Phone side. `{code, expiresAt}`; at most 5 live codes per user |
| `POST /devices/link` | none | `{code, label}` → `RegisterDeviceResponse` shape (`userId, token, displayName`), token `kind='linked'`, `expires_at` 180 days; code single-use; 404 `code_invalid` for unknown, expired or used; 10 attempts per IP per hour |
| `GET /me/devices` | user | List of tokens (kind, label, created, last seen) without hashes |
| `DELETE /me/devices/:tokenHashPrefix` | user | Revoke a linked token; a primary token cannot be revoked here (that is `DELETE /me`) |

Rate limits as constants beside the others: 240 plan PUTs per user per day (each toggle is a
debounced PUT, not each keystroke).

`deleteMe` (`devices.ts:88`) also soft-deletes the user's plans and revokes every token.
Wire types go in `src/lib/comments-api-types.ts` ("PLAIN TYPES ONLY" still holds): `PlanSyncEntry
| PlanTombstone`, `PlansSyncResponse`, `PutPlanRequest`, `SharePlanResponse`, `SharedPlanResponse`,
`LinkCodeResponse`, `LinkDeviceRequest`, `DeviceTokenSummary`.

Tests (`test/plans.test.ts`, `test/link.test.ts`, helpers in `test/helpers.ts`): put/list/delete
round trip; another user cannot read or replace it; `plan_exists`; tombstone in delta; share id
readable without auth and 404 after revoke; link code exchanges once, then 404; linked token
authenticates a PUT and stops after revoke; `u_` trail rejected; 64 KB rejected.

## Web (Phase 3)

Files: `src/web/trails/plan-viewer.ts`, `plan-template.html`, `my-plan.html`, `plan-state.ts`,
new `src/web/api/` (client, identity, plans), `vite.config.ts`, `styles.css`.

### Prerequisite: one copy of the plan markup

`my-plan.html` is a hand copy of `plan-template.html`. Every section below would be written
twice. First step: move the `#plan-shell` body into `src/web/trails/plan-shell.html` and have
`build-trails.ts:475-497` and the Vite HTML plugin (next to `gpx-import-doc`) inline it into
both. No behaviour change; diff of `site/` is only whitespace.

### Stops tab

- Defaults to `overnightCandidates`; a "Show all waypoints" switch (persisted in the document?
  no — a `localStorage` UI pref) lists everything as today.
- Each row: tick, name, km, and a services strip from `servicesAtStop` (⛺ 🛏 🛒 🍽 💧 🚌 as
  small mono glyphs with `title`s, greyed when absent; "OSM" pill and `OSM_ATTRIBUTION` in the
  tab footer). A ticked row expands to a nights stepper, a note field and a "Booked" tick.
- `toggleStop` :1090 becomes a call to the editor and a `scheduleSave`.

### Map

A waypoint marker click opens a Leaflet popup (name, km, services strip) with one button:
"Stop here" or "Remove stop". The former click-to-toggle at `plan-viewer.ts:478` goes; the
Resupply-tab behaviour of that click is unchanged.

### Days tab and datasheet

- Day card gains the date (already) and "+1 rest day at X" when `restDays > 0`; a rest day is
  not a day card of its own.
- The stop's note and booked state show in the day card footer and the datasheet row.

### Header: identity and sync

- New "Sync" button beside the save status. Not linked → a dialog: "On your phone open Settings
  → Link a browser and enter the code here" with an 8-char input and a label prefilled from the
  UA. Linked → the display name, "Syncing"/"Synced HH:MM"/"Offline", and "Unlink this browser"
  (revokes the token via `DELETE /me/devices/…` and clears it).
- Token in `localStorage` `tracknotes.webSession` (`{userId, token, displayName, expiresAt}`).
  This is the weaker posture of the two platforms and is why the token is a separate `linked`
  token with an expiry the phone can see and revoke.
- `VITE_API_BASE_URL` (Vite's `import.meta.env`, `envPrefix` default) in `vite.config.ts`;
  absent → the button is hidden and the page behaves as today.
- Share: "Share" button mints the link and copies it; the share page is
  `src/web/shared-plan.html` (`?s=<shareId>`), which loads the trail JSON as `plan.html` does,
  renders the same shell read-only (stops tab hidden, header shows "Shared by <name>"), and
  offers "Open in Tracknotes" (`tracknotes://plan/<shareId>`) and "Copy to my plans" when linked.

### State and persistence

- `plan-state.ts` stores a `PlanDocument` under `trail-plan-doc-<trailId>` and keeps the old key
  only to migrate it. Save flow: editor → `localStorage` (as today, instant) → if linked and the
  trail is server-known → debounced `PUT` → on 200 store `updatedAt`; on `plan_exists` adopt the
  server id and re-`PUT`; on `NetworkError` show "Offline, will retry" and retry on `online`
  and on the next edit. On page load when linked: `GET /plans?since=` for this trail; a server
  copy newer than local replaces it (last-writer-wins, same as comments).
- Imported trails (`my-plan.html`): everything above except the sync arm; the Sync button reads
  "Imported trails stay on this device".

### Tests

`plan-state.test.ts` (document round trip + legacy migration); `src/web/trails/plan-stops.test.ts`
booting `initPlanViewer` in jsdom the way `resupply-tab.test.ts` was planned (fake timers for the
800 ms debounce, one boot per file): toggling a candidate adds a day card, nights change the
following dates, the services strip reflects a fixture POI, the "all waypoints" switch, a
mocked `fetch` sees exactly one `PUT` after a burst of toggles, and a 409 `plan_exists` adopts
the id. Manual: both themes, Heysen (POIs) and CDT (no POIs), `my-plan.html`.

## Mobile (Phase 4)

Files: `mobile/app/guide/[trailId]/plan.tsx`, `mobile/src/features/plan/*`, `db/schema.ts`
(v5), new `db/plans-repo.ts`, `state/plans-store.ts`, `api/plans.ts`, `api/link.ts`,
`sync/comment-sync.ts`, `sync/connectivity.ts`, `features/settings/*`, waypoint detail,
`features/map/GuideMap.tsx`, `features/elevation/ElevationProfile.tsx`.

### Storage and sync

- Schema v5: `plans (id PK, trail_id, document_json, updated_at, source CHECK ('local','server'),
  deleted_at)` plus `sync_state` row `trail_id = '__plans__'` carrying `plans_synced_at` (plans
  are user-scoped, not trail-scoped; the sentinel keeps the per-channel-column precedent rather
  than adding a table). `OutboxKind` gains `'plan' | 'plan-delete'`.
- `plans-repo.ts`: get by trail, upsert local, upsert server (LWW on `updated_at`), tombstone.
- `api/plans.ts` mirrors `api/comments.ts` (`ApiContext`, auto-paginating `listPlans`,
  `putPlan`, `deletePlan`, `sharePlan`). `api/link.ts`: `createLinkCode`, `listDevices`,
  `revokeDevice`.
- `comment-sync.ts`: `pullPlans(ctx with token)` called from `runSync` after `pullTrail` in a
  swallowed try/catch like `pullTrailMeta`; two new branches in `drainOutboxNow`; `submitPlan`
  choke point with `assertServerTrail` (an import's plan is written to SQLite with
  `source='local'` and never enqueued). `purgeLocalAccountData` deletes `plans`.
- `plans-store.ts` (zustand over the repo, the `favorites-store` idiom): `byTrail`, `hydrate`,
  `apply(trailId, editorFn)` which writes SQLite, enqueues and emits.

### Plan screen

- Top: plan name (inline editor, the `DisplayNameSection` idiom), start date, direction is the
  guide's. Date input: `@react-native-community/datetimepicker` via `npx expo install` — native,
  so a new dev build; the Plan screen must degrade to a "YYYY-MM-DD" text field if the module
  is absent so the Jest suite and the web-less path stay green.
- Days: `DaySplitList` re-fed from `computePlanDays`; card gains the date and a "rest day" line.
- Stops: a section listing `overnightCandidates` with the `accessibilityRole="checkbox"` rows
  planned for the resupply list, an "All waypoints" switch, and a services strip from
  `servicesAtStop` (icons from `features/map` POI category set). Tapping toggles through the
  store. A ticked row expands to nights stepper, note, booked.
- Inputs card: daily hours and pace stay (they drive ETA text); the generator becomes a
  "Suggest stops" button, enabled only while the stop list is empty, that fills it once. Nothing
  ever regenerates the list on its own.
- Summary strip: days, total, average per walking day.

### Waypoint detail

A "Stop here" toggle beside the favorite heart (:279-281), backed by `plans-store`; when on,
the nights / note / booked controls appear under it.

### Map and elevation

Stops get a ring on the waypoint marker and the day boundaries a tick on the profile, both fed
from the store; the drawing is the last slice and can ship after the rest.

### Settings

"Linked browsers": a "Link a browser" button showing the code large with its countdown (QR of
`https://<site>/link?code=…` beneath it once `react-native-qrcode-svg` is worth a native dep —
not in v1), and the device list with "Remove" per linked token.

### Share import

`tracknotes://plan/<shareId>` and the same path on the site: fetch `GET /shared/plans/:id`,
show the days read-only, "Save as my plan" copies it into `plans` (new id, this user).

Tests: `plans-repo.test.ts`, `plans-store.test.ts` (reference stability as `plan-inputs-store`),
drain branches in `comment-sync.test.ts` (a `plan` item is PUT with the token, a `NetworkError`
stops the drain, `plan_exists` adopts the id), `DaySplitList` with rest days, the stops section
with `react-test-renderer`, the "Stop here" toggle. Maestro: `plan-stops.yaml` (guide → Plan →
tick two stops → two day cards).

## Sequencing and delegation

| # | Work | Where | Depends on |
|---|------|-------|-----------|
| 1 | Plan document + editor + tests, `overnightCandidates` moved to `src/lib` | `src/lib` | — |
| 2a | Worker: `plans` table, routes, validation, wire types, tests | `workers/comments-api` | 1 (types) |
| 2b | Worker: `device_tokens`, link codes, `/devices/link`, `/me/devices`, auth lookup, tests | `workers/comments-api` | — |
| 3a | Web: single plan shell (no behaviour change) | `src/web` | — |
| 3b | Web: stops tab (candidates, services, nights/note/booked), day cards, document storage + migration | `src/web` | 1, 3a |
| 3c | Web: API client, link dialog, sync arm, share page | `src/web` | 2a, 2b, 3b |
| 4a | Mobile: schema v5, repo, store, Plan screen, waypoint toggle | `mobile/` | 1 |
| 4b | Mobile: sync branches, `pullPlans`, settings linking, share import | `mobile/` | 2a, 2b, 4a |
| 4c | Mobile: map ring + profile ticks | `mobile/` | 4a |
| 5 | Deploy: `migrate:remote`, `deploy`; `VITE_API_BASE_URL` on the site; `eas build` (no EAS Update is configured) — see "Deploy" below | ops | 2, 4 |

1, 2b and 3a have no dependencies and can run as three parallel subagents on the branch (no file
overlap). 2a and 4a start once 1's types are on the branch; 3b once 3a is. 3c and 4b close the
loop. Each row is a PR-sized slice; the worker must be deployed (5) before 3c or 4b ship to
users, and the web can ship 3b alone since without `VITE_API_BASE_URL` it is local-only.

Subagent brief must include: edit `.ts`/`.json` via Bash, not the Edit tool (the global prettier
hook rewrites whole files); `ALLOWED_TRAILS` stays equal to the bundled index; `src/lib` stays
RN-safe (no DOM, no Node); `comments-api-types.ts` stays plain types; rebase, never merge.

## Out of scope (recorded so they are not lost)

- Multiple named plans per trail (offered, not chosen). The schema's unique index is the one
  line to drop if it comes back.
- Shared editing between hikers; the share link is read-only and "copy to mine".
- Accommodation data beyond OSM: beds, prices, seasons, a booking flow. `booked` is a hand tick.
- Fetching POIs for CDT and Te Araroa (a separate `fetch:pois` run; the planner degrades).
- A phone-width web planner (the 900 px gate stays; the phone app is the phone experience).
- Zero days at the trail start or before day 1; per-day time-of-day.
- A QR in v1; a camera-scan link flow; email accounts.
- Exporting a plan as GPX/ICS/PDF.
- Merging concurrent edits from two devices (last-writer-wins, as for comments).

## Open questions, answered 2026-09-20

All six were answered as assumed and are now decisions above: the generator stays as an explicit
"Suggest stops" button and is never automatic; the services radius is 1 km along the trail; a
linked browser token lives 180 days, rolling; rest days are nights at a stop; the share page
shows the owner's display name; the web map marker gets a "Stop here" popup and the silent
toggle is removed.

## Deploy

Everything below needs credentials the build container does not hold: a Cloudflare API token
(Workers Scripts + D1 edit; Workers Routes + DNS edit on the `contour-map-tiles.net` zone for
the custom domain) and account id for `wrangler`, an Expo access token for `eas`, and either the
Vercel dashboard or a Vercel token for the site variable.

1. **Worker, migration first.** `cd workers/comments-api && npm run migrate:remote && npm run deploy`.
   The migration must land before the worker because `auth.ts` joins `device_tokens` on every
   authenticated request; the other order 500s every request until the table exists. A phone
   that registers in the gap between the two commands gets a `users` row and no `device_tokens`
   row; `auth.ts` now self-heals that on its first request, so no second backfill is needed.
   `SITE_BASE` in `wrangler.toml` is the deployed site (`https://trail-maps.vercel.app`, verified
   2026-09-21) and is baked into every share link. Smoke: `curl https://api.contour-map-tiles.net/health`.
2. **Site.** Set `VITE_API_BASE_URL=https://api.contour-map-tiles.net` on the Vercel project
   (Production and Preview) and redeploy; without it the planner is local-only and the Sync/Share
   controls are removed. Vite's `envDir` is `src/web`, so a repo-root `.env` is ignored — set it
   in the host, not a file. The site can ship before the worker (local-only) but Sync needs 1.
3. **App.** A new binary: `cd mobile && eas build --non-interactive --profile production --platform android`
   (and iOS, which may need an interactive Apple sign-in the first time). EAS Update is not an
   option until `expo-updates` is installed and `app.json` carries `updates` + `runtimeVersion` —
   itself a native change and a new build. Nothing in this feature changed native code, so a
   development client already installed keeps working against Metro.

