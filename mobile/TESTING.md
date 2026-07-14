# Mobile Testing

Use three testing loops instead of relying on a local emulator:

1. Run the fast automated checks while developing.
2. Push a draft pull request so GitHub runs the Android Maestro flows.
3. Use a physical phone for native behaviour and a focused pre-release check.

## Daily workflow

From the repository root, run all web and mobile tests, lint, and type checking:

```bash
npm run check
```

Start Metro for an already-installed development client:

```bash
npm run phone
```

Open Trail Companion on the phone and use the QR code shown by Expo. The phone
and development machine normally need to be on the same network.

For an Android phone connected over USB with USB debugging enabled:

```bash
npm run phone:android:usb
```

When Expo is ready, press `a` in its terminal to open the app on the connected
device. The script forwards Metro's port over USB, so it does not depend on the
local Wi-Fi route.

## Install the development client

A development client contains the native modules this app uses. Install it
once, then reuse it for normal TypeScript, JavaScript, style, and asset changes.

### Android phone

```bash
cd mobile
npm ci
npx eas-cli build --profile development --platform android
```

Install the APK from the EAS build page, then return to the repository root and
run `npm run phone`.

### iPhone

The `development` EAS profile targets the iOS simulator. For a physical iPhone:

```bash
cd mobile
npm ci
npx eas-cli device:create
npx eas-cli build --profile development-device --platform ios
```

Registering the device is normally required only once. Install the build using
the EAS link and then run `npm run phone` from the repository root.

### When a new development build is required

Rebuild after changing any of these:

- Expo SDK or React Native version
- Native dependencies
- Expo plugins
- Native permissions
- `app.json` or native build properties

Do not rebuild for ordinary application code, component, style, or bundled-data
changes. Metro sends those changes to the installed development client.

## Pull-request checks

Open a draft pull request early and push changes regularly. GitHub runs:

- Vitest web tests and lint
- Jest mobile unit, component, and SQLite integration tests
- Mobile TypeScript and lint checks
- Android Maestro end-to-end flows when files under `mobile/` change

CI only sees committed and pushed files. Run `npm run check` before pushing to
catch changes that exist only in the working tree.

## Focused phone smoke test

Run this after a substantial mobile change and before merging a release:

- [ ] Launch the app and confirm the trail list loads without an error.
- [ ] Open a trail, open its map, and pan, zoom, and select a waypoint.
- [ ] Create or edit a plan and confirm it survives an app restart.
- [ ] Add a custom waypoint, edit it, delete it, and test Undo.
- [ ] Download offline maps, enable airplane mode, restart the app, and reopen the map.
- [ ] Grant location permission, start a hike, and confirm position and distance update.
- [ ] Lock the phone briefly, reopen the app, and confirm background tracking continued.
- [ ] Stop tracking and confirm the location/background indicator clears.
- [ ] Import or export a GPX file and exercise the native share or file picker.
- [ ] Check light, dark, and high-contrast themes on one map and one data-heavy screen.

The custom-waypoint and mark-location Maestro flows are currently quarantined,
so give those two workflows particular attention during the phone check.

## Field test for location or offline changes

For releases that affect GPS, background execution, maps, storage, or battery:

- [ ] Download everything required before leaving network coverage.
- [ ] Walk a short known route with the screen both on and locked.
- [ ] Compare the recorded position and distance with the known route.
- [ ] Use airplane mode for part of the walk.
- [ ] Force-close and reopen the app while still offline.
- [ ] Note battery percentage at the start and end.
- [ ] Confirm the app recovers after location services or connectivity are toggled.

## Standalone release check

A development client depends on Metro. Before a release, install a standalone
preview build and repeat the focused smoke test without the development server:

```bash
cd mobile
npx eas-cli build --profile preview --platform android
# or: npx eas-cli build --profile preview --platform ios
```

## Troubleshooting

If the phone cannot connect to Metro:

1. Confirm the development build, rather than Expo Go, is installed.
2. Confirm Metro was started from this repository with `npm run phone`.
3. Put both devices on the same network, disabling a VPN temporarily if needed.
4. On Android, connect USB debugging and use `npm run phone:android:usb`.

If the app reports a missing native module, its installed development client is
older than the native dependencies. Create and install a fresh development
build; restarting Metro cannot add native modules to an existing client.
