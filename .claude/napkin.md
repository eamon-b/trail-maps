# Napkin Runbook

## Curation Rules
- Re-prioritize on every read.
- Keep recurring, high-value notes only.
- Max 10 items per category.
- Each item includes date + "Do instead".

## Execution & Validation (Highest Priority)
1. **[2026-08-18] Lockfile "in sync" is npm-major-version-dependent — local npm 11 accepts locks that CI's npm 10 rejects**
   Do instead: validate with CI's exact npm: `npx -y npm@10.8.2 ci --dry-run` in both root and mobile/; if stale, regenerate with `npx -y npm@10.8.2 install --package-lock-only`.
2. **[2026-07-29] `expo lint` serves stale results from its own cache**
   Do instead: cache lives at `mobile/.expo/cache/eslint` (rm may be permission-blocked); `touch` the affected file to invalidate its entry, or verify with `npx eslint <path> --no-cache`.
3. **[2026-07-29] Jest 29 only for jest-expo; dynamic `import()` fails in tests**
   Do instead: never install Jest 30; use static imports in test files (no `await import(...)` — needs --experimental-vm-modules).
4. **[2026-07-29] Expo CLI invoked from repo root creates a stray `{"expo":{}}` app.json**
   Do instead: always run expo/eas commands from `mobile/`; if a root `app.json` appears, delete it.
5. **[2026-07-29] DB constraint tests flake with `.rejects.toThrow()` on the better-sqlite3 adapter**
   Do instead: use `expectDbRejection` from `mobile/src/db/__tests__/test-helpers.ts`.
6. **[2026-08-19] The installed Android debug client is a plain RN build (no expo-dev-client) — the `tracknotes://expo-development-client/?url=…` deep link is a SILENT NO-OP; the app always loads from `debug_http_host` (default 10.0.2.2:8081)**
   Do instead: to point it at another Metro, write the pref (`/data/data/com.tracknotes.app/shared_prefs/com.tracknotes.app_preferences.xml`, key `debug_http_host`) and relaunch — recipe in `mobile/maestro/README.md`; note `pm clear` deletes the whole shared_prefs dir (mkdir -p before restoring). Root fix tracked in issue #32; once expo-dev-client is installed the deep link (scheme `tracknotes://`, not `exp+tracknotes://`) works as documented.
7. **[2026-07-30] Hermes has no crypto.getRandomValues without the expo-crypto native module**
   Do instead: for secure randomness use `globalThis.expo.uuidv4` (native, always present via expo-modules-core) as the RN path — see mobile/src/api/uuid.ts; never Math.random.
8. **[2026-07-30] Local comments-API E2E without cloud auth**
   Do instead: `wrangler dev` in workers/comments-api (migrate local first), `adb reverse tcp:8787 tcp:8787`, `EXPO_PUBLIC_API_BASE_URL=http://localhost:8787` in mobile/.env.local, restart Metro (EXPO_PUBLIC_* is inlined at bundle time). Airplane mode does NOT cut adb-reverse loopback — simulate offline by killing wrangler dev.
9. **[2026-08-19] Fresh worktrees have no mobile/node_modules, and symlinking the main checkout's copy breaks when the branch adds deps (e.g. expo-secure-store) — every Jest suite then fails at jest.setup.js module resolution**
   Do instead: run a real `npm ci --legacy-peer-deps` in the worktree's mobile/ (and `npm ci` in workers/comments-api if testing the worker); never symlink or install into the shared checkout's node_modules. (Emulator note lives in user memory: user must launch the AVD; Claude-spawned ones can't register with adb.)
10. **[2026-08-07] Dev client ANRs ("failed to complete startup") when launched against a cold Metro bundle**
   Do instead: warm the bundle first — `curl "http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true"` (the plain `/index.bundle` path 404s; that's normal for expo-router) — then launch. Related: hot reload can't be trusted for zustand store module edits (Fast Refresh doesn't re-seat an already-created store) — force-stop + relaunch before verifying them on device.

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

## User Directives
1. **[2026-07-29] Use Opus subagents regularly**
   Do instead: delegate well-scoped implementation chunks to parallel `model: "opus"` Agent calls; keep orchestration/integration in the main session.
2. **[2026-07-29] Tracknotes rebuild plan is the source of truth**
   Do instead: follow `/home/eamon/.claude/plans/i-want-to-start-melodic-reddy.md` (FarOut UX clone, phased); old `plans/part-6b-crowdsourcing-design.md` is superseded for comments.
