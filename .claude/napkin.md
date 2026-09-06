# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-08-18] Lockfile "in sync" is npm-major-version-dependent — local npm 11 accepts locks that CI's npm 10 rejects**
   Do instead: validate with CI's exact npm: `npx -y npm@10.8.2 ci --dry-run` in both root and mobile/; if stale, regenerate with `npx -y npm@10.8.2 install --package-lock-only`.
2. **[2026-08-24] Dev/preview servers started in the sandboxed Bash shell are NOT reachable from the user's Chrome (they bind [::1] in an isolated netns), and the host's port 4173 is occupied by an unrelated "Resupply" app — Chrome silently shows that app instead**
   Do instead: for browser verification, start `vite **dev**` with `dangerouslyDisableSandbox: true` + `run_in_background` on a non-default port (e.g. `--port 4599 --host 127.0.0.1`). Never `npm run build` just to get a page to look at: `publicDir` is `public/`, which holds ~26 GB of map tiles that `vite build` copies into `dist/` — and `emptyOutDir` wipes the user's existing `dist/` first. Expect the first CDP screenshot after each navigation to time out or capture blank mid-render — retry once or twice before diagnosing; `requestAnimationFrame` also never fires while the MCP tab is inactive, so a page that animates in sits unfinished until you screenshot it once.
3. **[2026-07-29] Jest 29 only for jest-expo; dynamic `import()` fails in tests**
   Do instead: never install Jest 30; use static imports in test files (no `await import(...)` — needs --experimental-vm-modules).
4. **[2026-07-29] Expo CLI invoked from repo root creates a stray `{"expo":{}}` app.json**
   Do instead: always run expo/eas commands from `mobile/`; if a root `app.json` appears, delete it.
5. **[2026-07-29] DB constraint tests flake with `.rejects.toThrow()` on the better-sqlite3 adapter**
   Do instead: use `expectDbRejection` from `mobile/src/db/__tests__/test-helpers.ts`.
6. **[2026-08-20] A debug build only honours the `tracknotes://expo-development-client/?url=…` deep link if the tree it was built from has `expo-dev-client` — otherwise the link is a SILENT NO-OP and the app loads from `debug_http_host` (default 10.0.2.2:8081)**
   Do instead: `expo-dev-client` is a dependency as of issue #32, so just `npx expo run:android` from `mobile/` and the deep link works (scheme `tracknotes://`, not `exp+tracknotes://`). Confirm what is actually installed with `adb shell pm dump com.tracknotes.app | grep -i devlauncher` — no matches means a stale plain-RN build; rebuild rather than hand-writing the `debug_http_host` shared-pref.
7. **[2026-09-03] Node `fetch` dies with "fetch failed ETIMEDOUT" from build scripts while `curl` to the same host works — happy-eyeballs gives each address 250 ms, the IPv4 handshake here takes ~350 ms, and the sandbox's IPv6 route is dead**
   Do instead: `net.setDefaultAutoSelectFamilyAttemptTimeout(3000)` at the top of any script that fetches (see `scripts/fetch-pois.ts`); diagnose with `curl -4` vs `curl -6` and `e.cause.code`. Overpass specifically: query padded bounding boxes per route chunk, never `around:` polylines (the public server 504s "too busy" on those); rotate to `overpass.kumi.systems` / `overpass.private.coffee` on 429/504.
8. **[2026-07-30] Local comments-API E2E without cloud auth**
   Do instead: `wrangler dev` in workers/comments-api (migrate local first), `adb reverse tcp:8787 tcp:8787`, `EXPO_PUBLIC_API_BASE_URL=http://localhost:8787` in mobile/.env.local, restart Metro (EXPO_PUBLIC_* is inlined at bundle time). Airplane mode does NOT cut adb-reverse loopback — simulate offline by killing wrangler dev.
9. **[2026-08-19] Fresh worktrees have no mobile/node_modules, and symlinking the main checkout's copy breaks when the branch adds deps (e.g. expo-secure-store) — every Jest suite then fails at jest.setup.js module resolution**
   Do instead: run a real `npm ci --legacy-peer-deps` in the worktree's mobile/ (and `npm ci` in workers/comments-api if testing the worker); never symlink or install into the shared checkout's node_modules. (Emulator note lives in user memory: user must launch the AVD; Claude-spawned ones can't register with adb.)
10. **[2026-08-21] Emulator restarts roll back to the last quick-boot snapshot — app data (downloaded packs, `/data/local/tmp` pushes, granted permissions) from the session vanishes; qemu also dies intermittently mid-`am force-stop`**
   Do instead: relaunch with `emulator -avd Pixel_7` as a background Bash task, `adb wait-for-device`, re-`adb reverse` every port (Metro, 8787), re-push and re-download before continuing. Prefer leave-and-re-enter-guide over force-stop to re-run style resolution. Cold-Metro ANR note: warm the bundle with `curl "http://localhost:<port>/.expo/.virtual-metro-entry.bundle?platform=android&dev=true"` before launching; Fast Refresh can't re-seat zustand stores — relaunch to verify them.

## Domain Behavior Guardrails
1. **[2026-07-29] Waypoint IDs are registry-pinned — never regenerate them ad hoc**
   Do instead: `data/waypoint-ids.json` is append-only and committed with every trail-data change; IDs flow from `scripts/build-trails.ts` → generated JSON → `build-mobile-trails` automatically. A rebuild must produce zero registry diff; ambiguity throws on purpose.
2. **[2026-07-29] Tracknotes has no `trails` SQLite table**
   Do instead: trail content comes from `src/services/trail-loader.ts` (`listTrails`/`getTrailJson`); the `guides` table holds only per-guide state (direction, tiles_downloaded, comment sync).
3. **[2026-07-29] comments-api trail allowlist must match bundled trails**
   Do instead: when adding a trail, update `ALLOWED_TRAILS` in `workers/comments-api/src/validation.ts`.
4. **[2026-07-29] Resolve MapLibre style objects before mounting the map**
   Do instead: await `getOnlineMapStyle()` / `tileManager.getOfflineStyle()` and pass the object; don't hand MapLibre a URL then swap.
5. **[2026-07-29] Design tokens are lint-enforced**
   Do instead: no raw hex colors or numeric font sizes in `src/**`/`app/**` styles; go through `useTheme().colors` and `typography`; raw palette is import-restricted to `src/tokens`.

6. **[2026-08-19] The contour tileset is public — treat the archive as an API**
   Do instead: it is published on contour-map-tiles.net (apex = docs via Pages `aus-contour-tiles`, `data.` = the R2 bucket, `tiles.` = the Worker). Bucket CORS (GET/HEAD, `etag`/`content-range` exposed) must stay on, and layer/attribute changes (`contour`, `elevation`, `is_index`) break external consumers. Worker edge caching only works off `*.workers.dev`, so measure it on `tiles.`.
7. **[2026-08-19] Filter `is_index` through `to-number`, always**
   Do instead: it is the string `"0"`/`"1"` in the tiles, and MapLibre `==` is type-strict — comparing to `1` matches nothing and fails silently (every contour at one weight, no labels). Copy filters from `scripts/topo-style.json`, and verify with `queryRenderedFeatures({layers:['contour-index']}).length > 0`, never a screenshot alone.
8. **[2026-08-22] `src/lib/trail-ingest.ts` is the single GPX→trail pipeline for the build, web imports and mobile imports — any edit can silently change `public/data/generated/*.json` (gitignored, so git won't show it)**
   Do instead: before touching `trail-ingest`/`gpx-parser`/`track-simplify`, run `npm run build:trails && npm run build:mobile-trails` and copy `public/data/generated` + `mobile/assets/trails` aside; after, `diff -r` both (only `dataVersion` may differ) and `git diff data/waypoint-ids.json` must be empty. Imported ids are `u_<base36>`/`uw_<base36>` and are path-validated — never loosen `IMPORTED_ID_PATTERN` (ids become file names under `Paths.document/trails/`).

## User Directives
1. **[2026-07-29] Use Opus subagents regularly**
   Do instead: delegate well-scoped implementation chunks to parallel `model: "opus"` Agent calls; keep orchestration/integration in the main session.
2. **[2026-07-29] Tracknotes rebuild plan is the source of truth**
   Do instead: follow `/home/eamon/.claude/plans/i-want-to-start-melodic-reddy.md` (FarOut UX clone, phased).
