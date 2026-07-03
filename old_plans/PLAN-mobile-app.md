# Trail Maps Mobile App - High-Level Plan & Feature Review

## Your Feature Review

### Strong features - build around these

1. **Distance/gain from current location to selected point** - This is the core "on-trail" feature that makes a mobile app worth building. FarOut does this well; you can do it better with clearer presentation.

2. **Campsite selection with auto daily stats** - This is the "trip planner" and is genuinely differentiated. FarOut doesn't let you drag-and-drop reorder days easily. This could be a standout feature. The UX is: tap campsites on the map or datasheet, see daily summaries auto-update, drag to reorder.

3. **Custom GPX import** - Critical for extensibility. You already have the processing logic in `gpx-tools`. This lets people use the app for any trail, not just your curated ones.

4. **Measure between two arbitrary points** - Useful for planning. Implementation: tap-and-hold to drop measurement pins on the trail line, show distance/elevation between them.

5. **Water carry distances** - This is a natural extension of your waypoint type system. You already classify `water` and `water-tank` types. The app can auto-calculate distances between consecutive water sources along the trail.

6. **Resupply planning** - You already detect resupply-relevant waypoints (towns, grocery keywords). A tool that shows distances between resupply points with estimated food-carry days would be very useful.

### Features to reconsider or phase carefully

7. **Crowd-sourcing (add/remove/update points, comments)** - This is a major undertaking that requires a backend, moderation, user accounts, conflict resolution, and trust systems. I'd recommend deferring this to Phase 5+ and instead focusing on making the curated data excellent. Crowd-sourcing done poorly (stale/incorrect data with no moderation) is worse than no crowd-sourcing. Consider starting with a simpler "submit feedback" flow that goes to you.

### Suggested additions

8. **"You are here" on elevation profile** - Show current position as a marker on the elevation chart. This gives immediate visual context: "I'm at the bottom of this valley, there's a big climb ahead."

9. **Nearby waypoints by type** - "Show me the nearest water source" sorted by distance from current position. Filtered by type (water, campsite, town, etc.). Extremely useful in the field.

10. **Progress tracking** - "You're at km 234 of 981 (24%)" with a simple progress bar. Optionally track historical progress across days.

11. **Sunrise/sunset for current position** - Show daylight hours for the trail location. Useful for planning when to stop hiking. Your climate data already has location coordinates - pair with a solar calculation.

---

## Web vs Mobile Timing - Recommendation

**Do both in parallel, but field-test the web app ASAP.**

### Why not wait for web maturity:
- The data model is already stable (track points, enriched waypoints, variants, climate). More web features won't change this.
- Mobile has fundamentally different architecture (native maps, offline storage, GPS) - web work doesn't inform it.
- Your `src/lib/` code transfers directly to React Native.

### Why field-test the web app first (or concurrently):
- You're pre-field-testing. The web app is a fast iteration loop for validating information design.
- Your TODO.md has data model bugs (side trip elevation reporting, variant column alignment) that should be fixed before encoding the same data in mobile.
- Opening the web app on your phone at a trailhead (even with cell signal) will reveal: Is the waypoint taxonomy right? Is segment vs total distance useful? Are descriptions complete? Is the direction reversal confusing?

### Concrete recommendation:
1. Fix the known bugs in TODO.md (these affect data quality for both web and mobile)
2. Go on a day hike with the web app loaded on your phone
3. Start the React Native project scaffold now
4. Let web field-testing and mobile development inform each other

---

## Architecture Decisions

### Map: MapLibre Native + PMTiles (vector tiles)

**Important consideration**: Your web app uses OpenTopoMap (raster PNG tiles). For mobile, **vector tiles** are strongly preferred:
- 5-10x smaller download size (vector data vs pre-rendered images)
- Smooth rotation and tilting (native feel)
- Dynamic styling (day/night mode, highlight trail)
- Retina display support without extra tiles
- Text remains crisp at all zoom levels

**Recommended approach**:
- Use `@maplibre/maplibre-react-native` for the map component
- Use **Protomaps** basemap tiles (free, open-source, PMTiles format, has outdoor/topo styles)
- Host PMTiles files on a CDN (Cloudflare R2, S3, etc.)
- User downloads single PMTiles file per trail region to device storage
- MapLibre reads directly from the local file

**PMTiles tile source options** (in order of preference):
1. **Protomaps basemap** - Free OpenStreetMap-derived vector tiles, available as PMTiles. Apply a topo-esque style. Smallest size, best mobile experience.
2. **OpenFreeMap** - Free vector tiles, similar to above
3. **Self-rendered from OSM** - Use tilemaker to render your own tiles from OpenStreetMap data for Australia. More work but full control. You'd need to recreate the topographic styling that OpenTopoMap gives you for free (contours, hill shading, land cover colors)

### Data Storage

| Data | Storage | Why |
|------|---------|-----|
| Trail JSON (waypoints, track) | SQLite via `expo-sqlite` | Structured queries, fast lookups |
| PMTiles files | Device filesystem | Large binary files, accessed by MapLibre |
| User preferences | AsyncStorage | Simple key-value |
| Trip plans / itineraries | SQLite | Relational data (days, stops) |
| Custom GPX files | Device filesystem + SQLite metadata | Binary file + parsed metadata |

### Navigation Structure

See trail-app-features.md for a detailed description.

### Shared Code

These modules from `src/lib/` transfer directly to React Native:
- `distance.ts` - Haversine calculations
- `gpx-optimizer.ts` - Douglas-Peucker simplification
- `track-classification.ts` - Classify track types
- `waypoint-classifier.ts` - Classify waypoint types
- `types.ts` - TypeScript interfaces

These do NOT transfer (DOM-specific):
- `trail-viewer.ts` - Entirely DOM/Leaflet dependent
- HTML templates - Web-specific

### Project Structure

Monorepo in this same repository:

```
trail-maps/
  packages/
    shared/           # Extracted from src/lib/ - pure TS
      distance.ts
      gpx-optimizer.ts
      track-classification.ts
      waypoint-classifier.ts
      types.ts
    web/              # Current web app (moved)
    mobile/           # New React Native app
  data/trails/        # Shared trail data source
  scripts/            # Build scripts (serve both web + mobile)
```

Alternatively, keep the current structure and just add an `app/` directory at the root for the React Native project, importing from `src/lib/` directly. Simpler to start.

---

## Phased Implementation

### Phase 0: Web Stabilization & Field Testing
- Fix known bugs from TODO.md (side trip elevation, variant columns, etc.)
- Test on mobile browser at a trailhead
- Validate waypoint taxonomy and data completeness

### Phase 1: React Native Scaffold
- Initialize project (Expo with dev client, or bare React Native)
- Set up navigation (React Navigation, bottom tabs)
- Integrate shared TypeScript modules
- Set up SQLite for offline data
- Basic trail list screen loading from bundled JSON

### Phase 2: Core Trail Viewer
- MapLibre integration with trail polyline, waypoint markers
- Elevation profile component (react-native-svg or react-native-skia)
- Waypoint datasheet (FlatList with expandable rows)
- Trail stats display (distance, elevation, points)
- Direction reversal (reuse existing logic)

### Phase 3: Offline Maps
- PMTiles download manager (download per-trail files to device storage)
- MapLibre configured to read from local PMTiles
- Download progress UI with pause/resume
- Storage management (list downloaded trails, sizes, delete)

### Phase 4: Location-Aware Features
- Current location on map with heading indicator
- "Distance/gain to selected waypoint" from current position
- Nearby waypoints by type ("nearest water")
- "You are here" on elevation profile
- Measure between two points on trail

### Phase 5: Trip Planner
- Select campsites/stops to define daily itinerary
- Auto-calculate daily stats (distance, ascent, descent)
- Drag to reorder stops, auto-recalculate
- Water carry distances (auto from waypoint types)
- Resupply planning tool

### Phase 6: Custom Trails
- GPX file import (share sheet + file picker)
- Process imported GPX using shared lib (classify waypoints, enrich with distances)
- Create trail pages from custom data
- Datasheet generation

### Phase 7: Community Features (future)
- Backend service (Supabase recommended - free tier, Postgres, auth, realtime)
- User accounts
- Submit waypoint corrections/additions
- Comments and trail condition reports
- Moderation workflow

---

## Key UX Principles (addressing your pain points with other apps)

1. **Always know where you are in the app** - Bottom tabs are persistent and obvious. No hidden hamburger menus for primary navigation.

2. **Map and datasheet are linked** - Tap a waypoint in the table, it highlights on the map (and vice versa). These are two views of the same data, not separate features.

3. **Bottom sheet for quick info** - On the map view, a persistent bottom sheet shows the nearest/selected waypoint. Swipe up for full detail. This avoids mode-switching.

4. **One-tap answers** - "How far to the next water?" should be answerable in one tap from any screen. Consider a floating action button or quick-access menu.

5. **Offline confidence** - Make it unambiguous whether the trail is downloaded. Green checkmark on the trail card. "Ready for offline use" vs "Download required". Never let someone think they have offline data when they don't.

---

## Technology Stack (Decided)

| Component | Technology | Notes |
|-----------|-----------|-------|
| Framework | **Expo (managed with dev client)** | Cloud builds via EAS, OTA updates, simpler setup |
| Navigation | React Navigation 7 | Bottom tabs + stack navigators |
| Map | @maplibre/maplibre-react-native | Free, open-source, offline support |
| Tiles | **PMTiles (Protomaps vector basemap)** | Vector tiles, topo-style, single-file download |
| Charts | react-native-skia or Victory Native | Elevation profile |
| Database | expo-sqlite | Structured trail data, itineraries |
| File storage | expo-file-system | PMTiles files, custom GPX |
| State | Zustand | Lightweight, TypeScript-friendly |
| Shared logic | src/lib/ modules | Pure TS, works in RN |
| Location | expo-location | GPS tracking, heading |

### Why Expo over bare React Native
- All key libraries (MapLibre, SQLite, filesystem, location) have Expo support
- EAS Build handles iOS/Android builds in the cloud - no local Xcode/Android Studio required for production
- EAS Update allows pushing JS changes without App Store review
- Dev client allows using native modules while keeping Expo managed workflow
- Can eject to bare workflow later if needed (rare)

### Decided: Vector tiles (Protomaps)
- Accepted: vector tiles won't look identical to OpenTopoMap but provide better mobile experience
- 5-10x smaller downloads, smooth zoom/rotation, dynamic styling
- Protomaps basemap with outdoor/topo style

### MVP Scope: Phases 1-5
- Full trail viewer + offline maps + location features + trip planner
- This is ambitious but captures the core value proposition
- Can release incrementally (TestFlight/internal testing) as each phase completes
