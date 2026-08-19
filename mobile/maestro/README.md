# Maestro UI flows (Tracknotes)

Local-only end-to-end flows for the Expo dev build. There is **no CI job** — the
Maestro workflow was removed 2026-08-18, so these run against a human-launched
emulator plus a Metro dev server.

## Prerequisites

1. **Emulator running** (Pixel 7 or similar). Claude-spawned emulators do not
   register with adb — the user launches it. Verify:
   ```bash
   adb devices          # must list one device, e.g. emulator-5554
   ```
2. **A dev-client debug build installed** on that emulator (`com.tracknotes.app`),
   built from `mobile/` with:
   ```bash
   npx expo run:android          # builds + installs to the running emulator
   ```
   `expo-dev-client` is a dependency (added 2026-08-20, issue #32), so this
   produces a real dev client that honours the
   `tracknotes://expo-development-client/?url=…` deep link. Expo Go will not work.
3. **Metro running** in a separate terminal (interactive):
   ```bash
   cd mobile && npx expo start --dev-client
   ```
4. **Metro warmed up** — the first bundle takes tens of seconds and will blow
   the launch timeout otherwise (use the port Metro actually bound):
   ```bash
   curl "http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true" -o /dev/null
   ```
5. **`mobile/.env.local` present.** `add-comment-offline.yaml` needs
   `EXPO_PUBLIC_API_BASE_URL` to be **set** (a dead URL is fine — see below);
   with it unset the comments composer is not rendered at all and that flow
   fails at the "Add a note…" step. Restart Metro after changing env vars.

## Running

```bash
# One flow at a time
~/.maestro/bin/maestro test mobile/maestro/app-launch.yaml
~/.maestro/bin/maestro test mobile/maestro/guide-list.yaml
```

**Never run the directory** (`maestro test mobile/maestro/`): `shared/launch-dev.yaml`
is a launcher fragment, not a standalone flow, and would be executed as one.

Screenshots land in the working directory as `<name>.png` (each flow names its
own via `takeScreenshot`). They are throwaway artifacts — delete them after a run
so they don't end up committed.

## The shared launcher

`shared/launch-dev.yaml` is `clearState` followed by the dev-client deep link:

```yaml
- clearState
- openLink: "tracknotes://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081"
```

The deep link tells the dev launcher which Metro to load from, so `clearState`
is safe: it wipes install-level state (downloaded tiles, the SecureStore
session, SQLite rows) and the link re-supplies the bundle URL. Every flow
therefore starts from a genuinely fresh install, and flows that need one
(`guide-list.yaml` asserts every badge reads "Not downloaded";
`add-comment-offline.yaml` wants no device identity) need no external reset.

If Metro is on a port other than 8081, edit the URL in the launcher (percent-
encoded, e.g. `http%3A%2F%2F10.0.2.2%3A8082`).

### If the deep link appears to do nothing

That is the signature of a **plain React Native debug build** — one installed
from a tree without the `expo-dev-client` package (the state of the emulator
before issue #32, fixed 2026-08-20). Such a build ignores the deep link
entirely and loads JS from whatever `debug_http_host` says in its shared
preferences; `clearState` wipes those prefs, so it silently falls back to the
build-time default and may load a **different bundle than the one you are
testing** (symptom: duplicated waypoints or stale data in the guide list). The
fix is to rebuild and reinstall:

```bash
cd mobile && npx expo run:android
```

Confirm the installed app really is a dev client:

```bash
adb shell pm dump com.tracknotes.app | grep -i devlauncher   # must print matches
```

**Sanity check you are on the right bundle** before trusting a run: the guide
list must show each trail exactly once.

### Simulating an unreachable comments API

`add-comment-offline.yaml` needs the comments API to refuse connections. When a
local `wrangler dev` is bridged onto the device with `adb reverse`, drop the
bridge for the run and restore it afterwards:

```bash
adb reverse --remove tcp:8787   # before the flow → NetworkError branch
adb reverse tcp:8787 tcp:8787   # after
```

## Flows

| Flow | Purpose | Verified |
| --- | --- | --- |
| `app-launch.yaml` | Launch → "My Guides" renders. | **Green** — 2026-08-19, Pixel 7 emulator |
| `plan-screen.yaml` | Guide → Plan: inputs card, summary, day splits, water carries. | **Green** — 2026-08-19 |
| `guide-list.yaml` | My Guides lists all six bundled trails, badges read "Not downloaded", list scrolls. | **Green** — 2026-08-19 |
| `view-map.yaml` | Open a guide → map pane chrome (status pill, map key, FABs) mounts and survives pans + recenter. | **Green** — 2026-08-19 |
| `toggle-views.yaml` | Map → Elevation → List segmented switching, plus the List filter chips. | **Green** — 2026-08-19 |
| `waypoint-detail.yaml` | List → waypoint row → detail: name, stats, favorite round-trip, comments area. | **Green** — 2026-08-19 |
| `add-comment-offline.yaml` | Post a comment with the API unreachable; assert the queued/failed affordance. | **Green** — 2026-08-19, took branch A (registration NetworkError → "Try again") |
| `shared/launch-dev.yaml` | Launcher fragment — `clearState` + dev-client deep link. Not standalone. | — |

All seven passed on their first run (2026-08-19) against a plain RN debug client,
with the launcher temporarily reduced to a bare `launchApp`; no selector drift
was found, so no flow YAML needed changes beyond the shared launcher. The
launcher was restored to `clearState` + deep link on 2026-08-20 once the
emulator carried a real `expo-dev-client` build (issue #32) — the flows
themselves are unchanged, but they have not been re-run against it yet.

## Selector conventions

- **No testIDs exist in the app** (checked 2026-08-19: zero `testID` props under
  `mobile/src` and `mobile/app`). Every selector is visible text or an
  `accessibilityLabel`.
- Maestro matches text as a **full-string regex**, hence patterns like
  `"Add a note.*"` (covers both the plain and water-report placeholders) and
  `"Online|Offline maps ready|Updating offline maps…"` for the map status pill.
- Trail names come from `mobile/assets/trails/index.json`; the guide header
  shows `shortName` ("Cape to Cape"), the list shows `name`
  ("Cape to Cape Track").
- Waypoint rows are buttons labelled `Open <waypoint name>`. Cape to Cape's
  km-0 waypoint, "Cape Leeuwin Lighthouse", is always the first row, so flows
  use it and never have to scroll the datasheet.
- Flows prefer Cape to Cape (127 km, the smallest bundled trail) so trail load
  and profile work stay fast.

## Known caveats

- **All three guide panes stay mounted.** `GuideView` hides inactive panes with
  `display: 'none'`, so a hidden pane's text can still show up in the view
  hierarchy. Cross-pane `assertNotVisible` is therefore unreliable and the
  flows only make positive assertions.
- **MapLibre is a native surface.** Nothing inside the map canvas is
  inspectable; map coverage asserts on the React chrome drawn over it (status
  pill, "Map key" legend, FAB accessibility labels).
- **"Offline" in `add-comment-offline.yaml` is not airplane mode.** It relies on
  the comments API being unreachable: `EXPO_PUBLIC_API_BASE_URL` points at
  `localhost`, and inside the emulator `localhost` is the emulator itself (the
  host would be `10.0.2.2`), so requests are refused → `NetworkError`. If you
  have bridged a local worker with `adb reverse tcp:8787 tcp:8787`, remove the
  bridge for this flow (see above). The flow asserts both
  legal outcomes:
  - *no device identity yet* (the default after an install-level reset, which
    wipes the SecureStore session): registration is the one hard network
    dependency in the comment path, so the display-name prompt stays open with
    "Couldn't reach the server…" and a "Try again" button, draft intact — this
    is the branch the 2026-08-19 run took;
  - *already registered*: `submitComment` writes to SQLite and enqueues, so the
    comment renders immediately with the pending indicator "Waiting to send…".
- **Comments UI is in flux** (report + pagination work landed around
  2026-08-19). Flows avoid comment-row action links and assert only on the
  section heading, the composer placeholder, the "Post comment" button, and the
  pending/failure copy.
