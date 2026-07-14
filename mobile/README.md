# Trail Companion Mobile App

Australian long-distance hiking app built with Expo SDK 54, React Native, and MapLibre.

## Requirements

- Node.js 20+
- For iOS: macOS with Xcode 16+ and iOS Simulator
- For Android: Android Studio with SDK 35+ and an emulator or device
- EAS CLI for cloud builds: `npm install -g eas-cli`

## Setup

```bash
cd mobile
npm install
```

`expo prebuild` is only needed for a local native build. EAS generates the
native project in the cloud, so it is not part of the normal setup or daily
development loop.

## Development

```bash
# From the repository root: start Metro for an installed development client
npm run phone

# Or, from mobile/
npm start
```

Build and install a development client the first time, and again after native
dependencies, Expo plugins, permissions, or app configuration change:

```bash
# Android physical device
cd mobile
npx eas-cli build --profile development --platform android

# iPhone physical device (register it before the first build)
npx eas-cli device:create
npx eas-cli build --profile development-device --platform ios
```

The `development` iOS profile targets the simulator; use
`development-device` for a physical iPhone.

## Testing

```bash
# From the repository root: web + mobile tests, lint, and type checking
npm run check

# Mobile-only commands, from mobile/
npm test
npm run test:watch
npm run typecheck
```

See [TESTING.md](./TESTING.md) for the phone workflow, release checklist, and
troubleshooting steps.

## Project Structure

```
mobile/
  app/                  # Expo Router screens (file-based routing)
    _layout.tsx         # Root layout
    (tabs)/             # Bottom tab navigator
      _layout.tsx       # Tab configuration (Plan/Hike/Contribute)
      plan.tsx          # Plan mode screen
      hike.tsx          # Hike mode screen
      contribute.tsx    # Contribute mode screen
  src/
    db/                 # SQLite database layer
      schema.ts         # Table definitions and migrations
      database.ts       # Database initialization
    services/           # Business logic
      trail-data-service.ts   # Trail and waypoint CRUD
      plan-service.ts         # Hiking plan CRUD
      trail-loader.ts         # Load bundled trail JSON into SQLite
  assets/
    trails/             # Bundled trail data (JSON from build pipeline)
  app.json              # Expo configuration
  metro.config.js       # Metro bundler config (shared lib watchFolders)
  eas.json              # EAS Build profiles
```

## Shared Code

The mobile app imports pure TypeScript modules from `../src/lib/` (the web app's shared library) via Metro `watchFolders`. These modules are safe for React Native:

- `types.ts` — data structures
- `distance.ts` — Haversine distance calculations
- `track-classification.ts` — classify main/alternate/side-trip tracks
- `waypoint-classifier.ts` — classify waypoint types

Modules that use browser APIs (`gpx-parser.ts`, `gpx-optimizer.ts`) are NOT imported — they need React Native adaptations (planned for Part 4).

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `@maplibre/maplibre-react-native` | Offline vector tile maps |
| `expo-sqlite` | Local database for trail data and plans |
| `expo-file-system` | File/cache management |
| `expo-router` | File-based navigation |
