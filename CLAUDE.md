# CLAUDE.md

**Tracknotes** ([tracknotes.info](https://tracknotes.info)) is a static TypeScript web app (Vite, Leaflet) for long-distance hiking trails — Australia, plus Te Araroa (NZ), the CDT (US), Shikoku (Japan) and the Everest Three Passes (Nepal) — with maps, elevation profiles, waypoints and trip planning. `mobile/` is the Tracknotes app, its Expo/React Native companion (its own notes: `mobile/CLAUDE.md`). Both are called Tracknotes in anything a user sees; "Trail Maps" is the retired name (the ids still carrying it: `docs/architecture/web-ui.md`). Trail data is processed at build time into JSON; the only servers are optional Cloudflare Workers in `workers/` (comments API, contour tiles). `@lib` maps to `src/lib/`.

## Commands

```bash
npm run dev            # Vite dev server (port 5173)
npm test               # Vitest (web, scripts, src/lib)
npm run lint           # ESLint (src/ and scripts/)
npm run format         # Prettier over code and JSON, whole repo (CI runs format:check)
npm run check          # Web tests + lint, then mobile tests + typecheck + lint
npx tsc --noEmit       # Typecheck (CI runs it)
npm run sync:te-araroa && npm run build:trails && npm run build:mobile-trails   # Rebuild trail data (CI checks it is committed)
```

Every other script (`fetch:*`, `build:tiles`, `upload:*`, `publish:trail-data`, …) is in `package.json` and documented in `docs/architecture/build-scripts.md`. Scripts that publish (`upload:*`, `publish:trail-data`) write to production R2 or the live API — don't run them unless asked.

## Git and PRs

- **Rebase and merge only.** A branch must never contain a merge commit: to pick up `main` or resolve conflicts, `git rebase origin/main` and push with `--force-with-lease`. Never `git merge main` into a branch.
- **Reviewing PRs:** post the findings on GitHub as a `COMMENT` review on each PR (summary, findings ranked most serious first with `file:line` and the failure scenario, verdict) as well as summarising in chat. Don't ask first. Flag conflicts between open PRs touching the same files, and say when a PR has a merge conflict and so no CI run. On a re-review, say which earlier points are addressed.

## Where the detail lives

Read the note for the area you are changing before changing it, and update that note (not this file) when behaviour changes:

- `docs/architecture/core-library.md` — `src/lib/`: GPX parsing, `trail-ingest`, waypoint taxonomy, route breaks, plan editor, day/resupply/water calculators
- `docs/architecture/build-scripts.md` — `scripts/`: trail builds, contours, POIs/access fetches, tile packs, publishing
- `docs/architecture/web-ui.md` — `src/web/`: landing, trail viewer, plan page, upload/import, community, admin
- `docs/architecture/trail-data.md` — `data/trails/<dir>/` files, waypoint-id registry, open-data trails, `public/data/generated/`
- `docs/architecture/workers.md` — `workers/comments-api/`, `workers/contour-tiles/`
- `docs/architecture/mobile.md` — Tracknotes architecture and source layout

Runbooks: `docs/` (`gpx-import.md`, `trail-data-updates.md`, `mobile-test-build.md`, `world-contours-remote-build.md`). Plans: `plans/`. Read `docs/privacy-policy.md`, `docs/data-residency.md` and `docs/content-legal-posture.md` before changing what the comments API or community routes store.

## Hard rules

Each is explained where it lives; they are listed here because breaking one is silent.

- **One ingestion pipeline.** `scripts/build-trails.ts` and `importGpx` both call `@lib/trail-ingest` `buildTrail`. A change to `trail-ingest.ts` must leave `public/data/generated/*.json` byte-identical unless intended. Keep `docs/gpx-import.md` in step with import behaviour.
- **Commit rebuilt data.** CI rebuilds the trail data and fails if the committed output differs: commit the rebuilt files with any change to the build or the source data.
- **`src/lib` is platform-neutral and RN-safe.** No jsdom (its adapter is `scripts/lib/xml-adapter-jsdom.ts`), no `DOMParser` or `crypto` assumptions. The shared calculators are the single implementation for web and mobile — never fork one into a platform.
- **Waypoint ids are stable.** Changing a bundled waypoint's `type` re-keys it in `data/waypoint-ids.json` and orphans server-side comments: migrate the registry entries in the same commit, and check the build's id-minting warnings first.
- **A `water-access` turn-off is never water.** `RESUPPLY_TYPES` lists the `-access` types one by one; use `baseWaypointType()` for type-keyed maps.
- **Te Araroa is not curated here.** Its GPX comes from the `te-araroa-data` package (`npm run sync:te-araroa`); fix it upstream, never by hand.
- **Open-data trails' waypoints were reviewed by hand.** Diff against the committed GPX before regenerating one.
- **POIs are never waypoints.** They stay out of `waypoints`, `data/waypoint-ids.json` and the plan calculators.
- **Escape everything user-supplied on the web** with `escapeHtml`; every POI link goes through `safeHttpUrl`/`safeTelUrl`.
- **Route breaks:** anything that draws or climbs the route must respect `track.breaks` (`@lib/route-breaks`, `routeBreakStarts`).
- **Stored plan km are NOBO-absolute** (main-route km, or an alternate's own km); always pass the stored plan to `planFromRoute`.
- **The app informs the hiker's decisions; it never makes them.** Pace, hours per day, and judgement thresholds ("long carry", "dry stretch", food grams/day — `PlanThresholds` in `plan-types.ts`) are hiker inputs, never constants in a UI module. A default is fine only as the visible, editable initial value of an input; shared calculators require the figure rather than substituting one. These inputs are kept per device (web `PlanUiPrefs`, mobile `plan-inputs-store`), not in the synced `PlanDocument`.
- **Deploying the comments API:** a merged change to `workers/comments-api/` is not live until someone runs `npm run migrate:remote && npm run deploy` there, from `main`. Shipped app builds call it, so deploy right after the merge and run the route probes in `docs/mobile-test-build.md` ("Full release", step 1) — `/health` answers while a new route 404s.

## Testing

Vitest with jsdom; tests are colocated (`*.test.ts`). The `tile-pipeline` mbtiles suites need the `sqlite3` CLI: skipped locally without it, but they fail in CI. The comments-api worker has its own suite: `cd workers/comments-api && npm ci && npm test`. Mobile tests are Jest — see `mobile/CLAUDE.md`.
