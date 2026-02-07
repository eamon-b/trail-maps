# Part 2: Offline Trail Viewer

## Goal
Build the core trail viewing experience with offline-capable maps, GPS location tracking, and distance/elevation calculations to waypoints. This is the foundation of the "Hike" mode functionality.

## Development Tracks

Sections 1-3 and 7-8 (map, tiles, waypoints, elevation profile) can be developed in parallel with Sections 4-6 (GPS, auto-follow, distance calculations). This allows faster iteration on each track.

**Track A (Map & Profile):** Sections 1, 2, 3, 7, 8
**Track B (GPS & Location):** Sections 4, 5, 6
**Integration:** Section 9 (Trail Browsing) ties both tracks together.

## Deliverables

### 1. MapLibre GL Integration
- Configure MapLibre React Native with the topographic style from the tile pipeline
- Load custom topo style.json compositing base map, contour, and hillshade sources
- Implement smooth pan/zoom interactions
- Trail polyline rendering with direction indicators
- Online fallback to MapTiler Cloud when tiles are not downloaded (see tile pipeline Phase 1)

### 2. Offline Map Tiles (App-Side)

The tile generation pipeline (corridor extraction, contour generation, hillshade, base map extraction) is handled by the **Topo Tile Pipeline** plan. This section covers the app-side download, caching, and management of the generated MBTiles packages.

- Download MBTiles packages (base + contours + hillshade) to `FileSystem.documentDirectory`
  - Uses persistent storage, not cache directory (avoids iOS cache eviction)
  - Three files per trail, sizes per tile pipeline estimates (35-210 MB per trail)
- Download progress UI with size estimates from tile manifest
- Resume interrupted downloads (track per-file completion)
- Handle full storage gracefully (check available space before download, warn user)
- Storage management UI (view downloaded trails with sizes, delete old data)
- Load local MBTiles via `mbtiles://` protocol in MapLibre style

### 3. Offline Asset Management
- Bundle static assets (icons, fonts, base styles) with app binary
- Bundle PBF font glyphs (Open Sans Regular + Bold, ~2-5 MB) for offline text rendering
- Trail data versioning for update checking
- "Last updated" timestamps for cached trail data
- Background download option for large tile sets

### 4. GPS Location Tracking
- React Native geolocation integration (react-native-geolocation-service)
- Blue dot current position on map with accuracy circle
- Configurable sampling frequency (battery management)
  - Active: every 30s while walking
  - Background: reduced frequency
  - Manual: GPS only when app is foregrounded
- **GPS accuracy handling:**
  - Display accuracy circle when accuracy >20m
  - Degrade km position confidence when accuracy >50m
  - Show "Low GPS accuracy" indicator when accuracy >100m
- Snap user position to nearest track point
  - Prefer "forward" direction when equidistant from multiple track points
  - Use recent movement direction to resolve ambiguity
- Calculate current km position along trail
- **Graceful degradation without GPS permission:**
  - App remains fully functional for planning
  - Clear messaging about what requires location access

### 5. Map Auto-Follow Behavior
- Auto-follow user position by default
- Pause auto-follow when user pans manually
- "Re-center" floating button to resume auto-follow
- Smart zoom level based on speed/context

### 6. Distance/Elevation to Waypoints
- Real-time calculation from current position to:
  - Next campsite
  - Next water source
  - Next town
  - Next shelter
  - Any selected waypoint
- Display cumulative distance and net elevation change
- Integrate with Hike Dashboard "NEXT" cards from Part 1

### 7. Waypoint Display on Map
- Waypoint markers with emoji icons (14 types)
- Tap waypoint to open bottom sheet with details:
  - Name, type, description
  - Distance from current position
  - Elevation
  - "Show on elevation profile" button

### 8. Elevation Profile Integration
- Pull-up drawer from bottom of map view
- Contextual profile showing currently visible map section
- Bidirectional sync:
  - Pan map → profile updates visible range
  - Tap profile → map pans to location
- Current position marker on profile
- Waypoint markers on profile

**Functions to port from `src/web/trails/trail-viewer.ts`:**

| Function group | Source functions | What to port |
|---------------|----------------|-------------|
| Elevation profile rendering | `drawElevationProfile` (line 963) | Chart drawing logic, axis scaling (`getMinMax`, `niceAxisTicks`) |
| Map ↔ profile sync | `setupElevationHover` (line 869), `showElevationHover`, `hideElevationHover` | Bidirectional hover/tap coordination between map and profile |
| Waypoint interaction | `handleTableRowClick` (line 429), `drawWaypointMarkers` (line 319) | Tap-to-highlight, marker placement logic |
| Direction reversal | `createReversedTrail` (line 1502), `reverseTrackPoints`, `reverseWaypoints`, `reverseAlternates`, `transformSideTrips` | Full trail direction reversal with waypoint distance recalculation |
| Variant tracks | `drawAlternates` (line 282), `drawSideTrips` (line 295), `findVariantByKey` (line 547) | Alternate route and side trip rendering and selection |
| Nearest point lookup | `findNearestByDistance` (line 196) | Binary search for nearest track point by distance |

Note: These functions use Leaflet and DOM APIs. The logic (calculations, data transformations) ports directly; the rendering must be reimplemented for React Native / MapLibre.

### 9. Trail Browsing
- Trail list/index view
- Trail overview (map, stats, description)
- Download trail for offline button
- Direction toggle (NOBO/SOBO equivalent)

## Success Criteria
- Map displays trail with current GPS location
- Full offline functionality after downloading trail
- Distance to next campsite/water/town updates in real-time
- Elevation profile syncs with map view
- Battery-conscious GPS sampling works
- Tile packages can be downloaded and managed (35-210 MB per trail)
- App remains responsive with 500MB cached tiles
- GPS battery usage measured and documented
- Works gracefully with GPS accuracy up to 100m
- App fully functional for planning without GPS permission

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation
- **Topo Tile Pipeline** (`plans/topo-tile-pipeline.md`): At minimum Phase 1 (MapTiler Cloud) must be complete to begin Track A. Phase 2 (custom pipeline) must produce tiles for at least one trail (bibbulmun) before Section 2 (app-side tile management) can be fully implemented.

## Notes
- Start with a single trail (Bibbulmun) for all testing
- Battery life testing on actual devices is critical
- The map ↔ elevation sync logic from `trail-viewer.ts` is a key asset to port (see Section 8 table)
- Tile hosting strategy (CDN, S3 + CloudFront, etc.) needs a decision before the download UI can be finalized — tiles are too large for typical static hosting
