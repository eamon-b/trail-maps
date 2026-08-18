# Tracknotes Backlog

Living list of known follow-ups for the FarOut-clone rebuild (merged to `main` 2026-08-18).
Master plan: `~/.claude/plans/i-want-to-start-melodic-reddy.md`. Update this file as items land or emerge.

## Required before any App Store / Play Store release
- [ ] **Report/flag endpoint + UI** — `POST /v1/comments/:id/report` and a report button on comments. Apple requires a report mechanism for UGC apps.
- [ ] **Account deletion** — endpoint + settings action (Apple UGC requirement).
- [ ] **Privacy policy + D1 data-residency check** — Oceania location hint is best-effort; re-verify before public claims (`plans/part-6b-crowdsourcing-design.md` §8 has the APP analysis).

## Product features (planned phases)
- [x] **Phase 6 — check-in sharing (share-sheet half)**: shipped — `src/features/share/{check-in.ts,use-check-in-share.ts,ShareIconButton.tsx}`. Backend check-ins remain a follow-up.
- [x] **Phase 7 — custom route builder**: shipped — `src/features/routes/`, `src/db/routes-repo.ts`, `app/guide/[trailId]/routes.tsx` (route drawing on the map pane, saved-routes screen).
- [x] **Phase 8 — planner heritage**: shipped — live plan calculator at `app/guide/[trailId]/plan.tsx` over `src/features/plan/` + `@lib` calculators (see `PLAN-hours-based-planning.md`, incl. post-review fixes).
- [ ] **Aggregated water-status chip** — client-side freshness ranking over cached reports (weight `exp(-age_days/30)`, 120-day window) shown on water waypoints in list/map.
- [x] **Display-name rename UI** — done: Settings → Account shows the current display name with an inline editor (`src/features/settings/DisplayNameSection.tsx`) calling `identity-store.rename` → `PATCH /v1/me`; client-side trim/length check mirrors the server's 40-char limit, network failures render inline and keep the previous name. Anonymous devices get an explanatory row instead (registration still happens on first post, never from Settings).
- [ ] **Waypoint descriptions enrichment** — bundled data has almost none; serve curated descriptions from the backend over the comment sync channel rather than authoring into `public/data/`.

## Design divergences awaiting Eamon's review
- [ ] **Header glyph vs overflow menu (Phases 7 + 8)** — the master plan specifies an *overflow-menu "Plan" entry*; instead both Phase 7 (Routes ⋔) and Phase 8 (Plan ▤) shipped as always-visible inline header glyphs, making four header actions (⋔ ▤ ⤓ ⚙) beside the guide title. Consistent with each other but divergent from the plan, and React Navigation truncates the *title*, not the buttons, so long guide names (e.g. "Hume & Hovell") get squeezed on narrow screens. Decide: keep the four glyphs, or fold Routes + Plan (and maybe Downloads) into a single ⋯ overflow menu.

## Verification gaps
- [ ] **Offline tile download E2E** — untested end-to-end. Add `EXPO_PUBLIC_TILE_BASE_URL` to `mobile/.env.local`, download Cape to Cape, verify the `mbtiles://` offline style renders in airplane mode (the map remount on style-source flip is tested in Jest only).
- [ ] **Dark theme visual QA** — themes are WCAG-checked arithmetically but never eyeballed on device.
- [ ] **iOS smoke test** — all E2E tooling is Android; run an EAS iOS build and hand-check before any TestFlight.

## Data quality
- [x] **Duplicate waypoint IDs in larapinta.json** — RESOLVED 2026-08-07. Not a registry-matching bug: the Mt Sonder summit out-and-back was folded into the single "Main Route" trkseg, so `enrichWaypoints` (one row per proximity episode) matched the three Redbank waypoints twice and fanned one source waypoint into two rows sharing an id. Fixed by lifting the spur into a side trip via new opt-in `extractSpurs` config (`src/lib/track-spurs.ts`), reversing the Larapinta track so km 0 is Alice Springs (new `reverseTrack` config — the existing "Westbound" label was inverted), and adding a duplicate-id build invariant in `processTrail` so the fan-out can never ship again. Larapinta is now 215.8 km with 58 unique on-trail waypoints; `data/waypoint-ids.json` unchanged (ids are minted from lat/lon, so reversal is a no-op for them).
- [ ] **Near-duplicate waypoint dedupe** — AAWT has pairs like "Talbot Hut Site" twice ~100 m apart (source-data trait, predates rebuild). Larapinta has the same shape: `WT:`/`C:` pairs at one site, e.g. "Rocky Bar Gap" (`w_7d1c866d` + `w_09fe6506`, ~22 m apart, both km 205.2) and "Rocky Gully" (`w_409f844e` + `w_5b17238e`, both km 111.0) — two distinct source `<wpt>`s with distinct ids, so no duplicate-key warning, but they render as adjacent identical-looking rows. Dedupe in `scripts/build-trails.ts`; mind the waypoint-ID registry (retired IDs keep their comments).

## Tech debt / infra
- [ ] **Photo-upload idempotency server-side** — the client drain mutex prevents double-uploads, but the POST itself appends blindly; an idempotency key (e.g. content hash per comment) would be defense in depth.
- [ ] **MapLibre RN + Expo SDK upgrade** — pinned at the proven 10.4.x / SDK 54 combo; upgrade deliberately as its own task.
- [ ] **Custom domain for workers** — `*.workers.dev` URLs are baked into shipped builds (same trade-off as the contour worker); a custom domain decouples them.
- [ ] **Comment-feed pagination UI** — the per-waypoint feed endpoint paginates; the detail screen currently renders the full cached set (fine at hobby scale).
- [ ] **Maestro coverage** — local-only now (the `maestro-e2e` CI workflow was removed 2026-08-18; flows run against the local emulator). Two flows exist: `app-launch.yaml`, `plan-screen.yaml` (+ `shared/launch-dev.yaml` launcher). Port guide-list / view-map / toggle-views / waypoint-detail / add-comment-offline flows from the old suite's patterns if coverage is wanted.
