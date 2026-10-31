# Tracknotes — Test Build Runbook

How to get an installable Android build of the Tracknotes app (`mobile/`) onto a phone or
emulator for testing, without a store release. Everything here was run end to end on
2026-09-22 from a fresh clone. The release story (worker, site, store build) is under "Full
release" at the end.

## What you need

| Thing | Where it comes from |
| --- | --- |
| `EXPO_TOKEN` in the environment | An Expo access token for the `eamonb123` account (expo.dev → Account settings → Access tokens). Set as an env var; `eas` reads it and never prompts. Without it, `npx eas-cli login` interactively once instead. |
| Node 22 + the mobile deps | `cd mobile && npm ci` — `eas` resolves `app.json` through the project's own `expo` package, so the install has to exist even though the compile happens in the cloud. |
| Android signing | Already on EAS ("Build Credentials 5VV8EkbWj9"); nothing to supply. Every profile signs with it, so any build upgrades over any other install of `com.tracknotes.app`. |

No Android SDK, Java or Xcode is needed locally: EAS compiles in the cloud and hands back an
artifact URL.

## Make the APK

```bash
cd mobile
npm ci
npx eas-cli@latest build --non-interactive --profile preview --platform android
```

- `preview` is the test profile: a standalone release-mode app (no Metro, no dev menu) built
  as an **`.apk`**, which is what a phone can install directly. `production` builds an
  **`.aab`** that only Play Console can consume; `development` builds the dev client, which is
  useless without a running Metro.
- The command blocks for ~20-25 minutes (queue + build). Add `--no-wait` to return
  immediately and poll instead:

  ```bash
  npx eas-cli@latest build:list --platform android --limit 3 --non-interactive
  npx eas-cli@latest build:view <build-id> --json | grep -E '"status"|applicationArchiveUrl'
  ```

- The build bakes in the `env` block of `eas.json`'s `base` profile: the deployed comments/plans
  API (`https://api.tracknotes.info`), the contour tile server and the offline tile
  bucket. A test build therefore talks to **production** data and syncs to the real account of
  whichever device installs it. To point a test build somewhere else, edit those values in
  `eas.json` before building — `.env.local` is only read by Metro, never by EAS.
- **Check the worker is current first.** A build that calls a route the deployed worker lacks
  gets 404s: shared-waypoint shares stay queued, but shared-waypoint deletes and reports are
  discarded as if they had succeeded (`mobile/src/sync/comment-sync.ts`), and deploying later
  does not bring them back. Shared waypoints shipped this way (#141). Before any build, with the
  setup from step 1 of "Full release" (`npm ci` in `workers/comments-api/` and the Cloudflare
  credentials), check that `npx wrangler d1 migrations list DB --remote` lists
  nothing to apply and that every probe in that step answers. If not, deploy `main` per that
  step. Never deploy the worker from an unmerged branch for a test build: test builds use the
  production API, so that would ship unreviewed worker code to every installed app.
- The version is `expo.version` in `app.json` (`0.1.0`). The Android `versionCode` is kept by
  EAS, not `app.json` (`cli.appVersionSource: "remote"` in `eas.json`; the first build after the
  switch seeds it from the local value, `1`). Test builds reuse the current `versionCode`; each `production` build bumps
  it (`autoIncrement`), since Play rejects a reused one — see "Full release".
  `npx eas-cli@latest build:version:get -p android` shows the current value.

### From CI

`.github/workflows/mobile-build.yml` runs the mobile tests and typecheck, then the same command,
waiting for the build to finish (about 25 minutes, mostly EAS's queue). It is manual
only, so nothing builds on push: Actions → *Mobile build* → *Run workflow*, with a choice of
branch and profile (`preview` by default). This works from the GitHub mobile app too.

It needs an `EXPO_TOKEN` repository secret (Settings → Secrets and variables → Actions). The
run fails if the tests fail (no build is started) or the EAS build errors or is canceled, and
its summary links the build page and, once finished, the install file.

## Install it

When the build finishes, `build:view` (or the build page at
`https://expo.dev/accounts/eamonb123/projects/tracknotes/builds/<build-id>`) gives an
`applicationArchiveUrl`. Artifacts expire 30 days after the build.

**On a phone:** open the build page on the phone and tap *Install*, or send the artifact URL
to the phone and open it. Android asks to allow installs from the browser the first time.

**On the emulator / a USB-connected phone:**

```bash
curl -L -o /tmp/tracknotes.apk '<applicationArchiveUrl>'
adb install -r /tmp/tracknotes.apk
adb shell am start -n com.tracknotes.app/.MainActivity
```

`-r` replaces whatever `com.tracknotes.app` is already there — including the dev client, so
reinstall the dev build (`eas build --profile development --platform android`) when you go back
to Metro work. App data (SQLite plans, comments outbox, downloaded tiles) survives the swap
because the package name and signing key are the same.

## Things that go wrong

- **`Distribution Certificate is not validated for non-interactive builds`** — iOS only. The
  first iOS build has to be run interactively (`eas build --profile preview --platform ios`
  without `--non-interactive`) with an Apple sign-in so EAS can validate the certificate;
  after that, non-interactive works. Android never needs this.
- **`app.json is missing ios.infoPlist.ITSAppUsesNonExemptEncryption`** — a warning from the
  iOS path; harmless for Android.
- **The build picks up uncommitted changes.** `eas` uploads the working tree (minus
  `.gitignore`/`.easignore`), not `HEAD`, and records `HEAD`'s hash as `gitCommitHash`. Commit
  first if the recorded commit is meant to match what was built.
- **No EAS Update / OTA.** `expo-updates` is not installed and `app.json` has no
  `updates`/`runtimeVersion`, so every change — JS included — reaches a phone only through a
  new build. (Installing `expo-updates` is itself a native change and would need a new build.)

## Full release

The three pieces ship independently; the app is last because it is the only one that cannot
be rolled forward without a reinstall. The detailed rationale is under "Deploy" in
`plans/day-planner.md`.

1. **Comments/plans worker** (`workers/comments-api/`), migration first, with
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the environment:

   ```bash
   cd workers/comments-api && npm ci
   npx wrangler d1 migrations list DB --remote   # what would apply
   npm run migrate:remote && npm run deploy
   curl https://api.tracknotes.info/health              # {"ok":true}
   ```

   `/health` answers even while a new route 404s, so also probe a route from each migration
   that added routes; each must answer 200, not 404:

   ```bash
   curl -sf -o /dev/null https://api.tracknotes.info/v1/community/routes          # 0005/0006
   curl -sf -o /dev/null https://api.tracknotes.info/v1/trails/heysen/waypoints   # 0007
   ```

   A route that needs a token answers 401 once deployed, and 404 before:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://api.contour-map-tiles.net/v1/me/comments   # 401 (personal export)
   ```

   Add a line here whenever a new migration adds routes. Deploy (from `main`) after every merge
   that changes `workers/comments-api/`, not only at release, then run these probes.

2. **Site.** Vercel builds `main` on push. `VITE_API_BASE_URL=https://api.tracknotes.info`
   is set on the Vercel project (Production and Preview, added 2026-09-22, moved from
   `api.contour-map-tiles.net` 2026-10-31); without it the
   planner is local-only. To confirm a deploy carries it, fetch `my-plan.html`, follow its
   `plan-viewer-*.js` asset and grep for `api.tracknotes.info`.

3. **App, store build.** Release checklist gate (the rest of the store checklist is issue
   #31): before building, the comments API's remote migrations are all applied
   (`npx wrangler d1 migrations list DB --remote` lists nothing to apply) and
   the worker is deployed from `main`, with every probe in step 1 answering 200. A build
   that ships ahead of its worker loses writes to routes that 404 (#141).

   Bump `expo.version` in `mobile/app.json`; the `versionCode` is bumped
   by EAS on every `production` build (the first upload used `1`). Then run (or use the
   *Mobile build* workflow with the `production` profile):

   ```bash
   cd mobile && npx eas-cli@latest build --non-interactive --profile production --platform android
   ```

   The `.aab` it produces is uploaded through Play Console (or `eas submit`, not yet set up).
   iOS is not set up yet — see "Things that go wrong".

   **Release notes for the first build after #228.** Since the Australia contour archive was
   retired, the worker's `contours` source serves Copernicus GLO-30, so installed builds from
   before #228 now draw GLO-30 contours on Australian trails while their credits screen
   (`CONTOURS_LINE`) still says "SRTM (NASA) in Australia". No code can change a shipped build
   (no OTA), and the line still carries the full Copernicus notice, so the licence is met; the
   wording is only out of date until hikers update. Say so in the store release notes, e.g.
   "Contour lines in Australia now come from the Copernicus GLO-30 elevation model, as
   everywhere else; the map credits say so." The current `credits.ts` names only GLO-30.
