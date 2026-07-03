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
npx expo prebuild       # Generate native projects from config
```

## Development

```bash
# Start Metro dev server (interactive — needs a human)
npx expo start --dev-client

# Build a development client (first time or after native dependency changes)
eas build --profile development --platform ios
eas build --profile development --platform android
```

## Testing

```bash
npm test                # Run all Jest tests
npm run test:watch      # Watch mode
npm run typecheck       # TypeScript type checking
```

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
