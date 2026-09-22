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
  API (`https://api.contour-map-tiles.net`), the contour tile server and the offline tile
  bucket. A test build therefore talks to **production** data and syncs to the real account of
  whichever device installs it. To point a test build somewhere else, edit those values in
  `eas.json` before building — `.env.local` is only read by Metro, never by EAS.
- The version is `expo.version` in `app.json` (`0.1.0`) and the Android `versionCode` is `1`
  (unset in `app.json`, so `eas` uses its default). Neither is bumped automatically: test builds
  can reuse them freely, but a store upload needs a higher `versionCode` each time — see "Full
  release".

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
- **`The field "cli.appVersionSource" is not set`** — a warning; the build still uses the
  `app.json` version. Setting `"cli": { "appVersionSource": "local" }` in `eas.json` silences
  it without changing behaviour; `"remote"` would hand version management to EAS.
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
   npx wrangler d1 migrations list farout-comments --remote   # what would apply
   npm run migrate:remote && npm run deploy
   curl https://api.contour-map-tiles.net/health              # {"ok":true}
   ```

2. **Site.** Vercel builds `main` on push. `VITE_API_BASE_URL=https://api.contour-map-tiles.net`
   is set on the Vercel project (Production and Preview, added 2026-09-22); without it the
   planner is local-only. To confirm a deploy carries it, fetch `my-plan.html`, follow its
   `plan-viewer-*.js` asset and grep for `api.contour-map-tiles.net`.

3. **App, store build.** Bump `expo.version` and set a higher `android.versionCode` in
   `mobile/app.json` (Play rejects a reused `versionCode`; the first upload used `1`), then:

   ```bash
   cd mobile && npx eas-cli@latest build --non-interactive --profile production --platform android
   ```

   The `.aab` it produces is uploaded through Play Console (or `eas submit`, not yet set up).
   iOS is not set up yet — see "Things that go wrong".
