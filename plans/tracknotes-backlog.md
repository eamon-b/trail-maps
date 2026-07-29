# Tracknotes Backlog

Living list of known follow-ups for the FarOut-clone rebuild (branch `rebuild/farout-clone`).
Master plan: `~/.claude/plans/i-want-to-start-melodic-reddy.md`. Update this file as items land or emerge.

## Required before any App Store / Play Store release
- [ ] **Report/flag endpoint + UI** — `POST /v1/comments/:id/report` and a report button on comments. Apple requires a report mechanism for UGC apps.
- [ ] **Account deletion** — endpoint + settings action (Apple UGC requirement).
- [ ] **Privacy policy + D1 data-residency check** — Oceania location hint is best-effort; re-verify before public claims (`plans/part-6b-crowdsourcing-design.md` §8 has the APP analysis).

## Product features (planned phases)
- [ ] **Phase 6 — check-in sharing**: OS share sheet with position + km + message first; backend check-ins later.
- [ ] **Phase 7 — custom route builder**: reintroduce routes/route_legs (old schema migrations 7–8 DDL), route drawing on GuideMap, route overlay on profile.
- [ ] **Phase 8 — planner heritage**: day/resupply/water-carry planners (`@lib` calculators) redesigned into the guide IA.
- [ ] **Aggregated water-status chip** — client-side freshness ranking over cached reports (weight `exp(-age_days/30)`, 120-day window) shown on water waypoints in list/map.
- [ ] **Display-name rename UI** — `PATCH /v1/me` exists; add the settings field.
- [ ] **Waypoint descriptions enrichment** — bundled data has almost none; serve curated descriptions from the backend over the comment sync channel rather than authoring into `public/data/`.

## Verification gaps
- [ ] **Offline tile download E2E** — untested end-to-end. Add `EXPO_PUBLIC_TILE_BASE_URL` to `mobile/.env.local`, download Cape to Cape, verify the `mbtiles://` offline style renders in airplane mode (the map remount on style-source flip is tested in Jest only).
- [ ] **Dark theme visual QA** — themes are WCAG-checked arithmetically but never eyeballed on device.
- [ ] **iOS smoke test** — all E2E tooling is Android; run an EAS iOS build and hand-check before any TestFlight.

## Data quality
- [ ] **Near-duplicate waypoint dedupe** — AAWT has pairs like "Talbot Hut Site" twice ~100 m apart (source-data trait, predates rebuild). Dedupe in `scripts/build-trails.ts`; mind the waypoint-ID registry (retired IDs keep their comments).

## Tech debt / infra
- [ ] **MapLibre RN + Expo SDK upgrade** — pinned at the proven 10.4.x / SDK 54 combo; upgrade deliberately as its own task.
- [ ] **Custom domain for workers** — `*.workers.dev` URLs are baked into shipped builds (same trade-off as the contour worker); a custom domain decouples them.
- [ ] **Comment-feed pagination UI** — the per-waypoint feed endpoint paginates; the detail screen currently renders the full cached set (fine at hobby scale).
- [ ] **Maestro coverage** — only `app-launch.yaml` exists post-rebuild; port guide-list / view-map / toggle-views / waypoint-detail / add-comment-offline flows from the old suite's patterns.
