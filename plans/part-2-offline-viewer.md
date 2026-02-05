# Part 2: Offline Trail Viewer

## Goal
Build the core trail viewing experience with offline-capable maps, GPS location tracking, and distance/elevation calculations to waypoints. This is the foundation of the "Hike" mode functionality.

## Deliverables

### 1. MapLibre GL Integration
- Replace Leaflet with MapLibre GL JS for React Native
- Configure topographic map style (similar to OpenTopoMap aesthetic)
- Implement smooth pan/zoom interactions
- Trail polyline rendering with direction indicators

### 2. Offline Map Tiles
- **Tile provider decision** (choose one):
  - **Protomaps (Recommended)**: PMTiles format, self-hostable, free, good for offline
  - MapTiler: Commercial, excellent quality, costs at scale
  - OpenMapTiles: Self-host, requires infrastructure setup
- Vector tile downloading and caching system
- Trail corridor bounding box calculation for tile selection
- **Tile size estimation per trail:**
  - Calculate tile count at zoom levels 10-16 for trail corridor
  - Target: <500MB per major trail (1000km)
  - Measure actual storage on device after caching
- Download progress UI with size estimates
- Storage management (view cached trails, delete old data)
- Resume interrupted downloads
- Handle full storage gracefully (warn before download starts)

### 3. Offline Asset Management
- Bundle static assets (icons, fonts, base styles) with app binary
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
- Bidirectional sync (port logic from `trail-viewer.ts`):
  - Pan map → profile updates
  - Tap profile → map pans to location
- Current position marker on profile
- Waypoint markers on profile

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
- 500MB+ of map tiles can be downloaded and managed
- App remains responsive with 500MB cached tiles
- GPS battery usage measured and documented
- Works gracefully with GPS accuracy up to 100m
- App fully functional for planning without GPS permission

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation

## Notes
- This is the single hardest technical challenge (offline maps)
- Consider starting with a single trail (e.g., Bibbulmun) for testing
- Battery life testing on actual devices is critical
- The map ↔ elevation sync logic from `trail-viewer.ts` is a key asset to port

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] All affected files identified
- [ ] Steps in the right order (reorder suggested)
- [x] Dependencies identified
- [ ] Edge cases considered (see below)
- [ ] Testing strategy sufficient

### Critical Issues

1. **Service Worker section (Section 3) doesn't apply to React Native**
   Service Workers are a web technology. React Native apps don't use them.

   **Remove or replace with:**
   ```
   ### 3. Offline Asset Management
   - Bundle static assets with app binary
   - Implement app update mechanism
   - Version trail data for update checking
   - "Last updated" timestamps for cached data
   ```

2. **Vector tile provider decision is missing**
   The plan mentions MapTiler/Protomaps but doesn't specify which to use. This needs a decision:
   - **MapTiler**: Commercial, excellent quality, has costs at scale
   - **Protomaps**: Self-hostable PMTiles format, free, smaller ecosystem
   - **OpenMapTiles**: Self-host, requires setup

   **Add decision criteria and recommendation to Section 2.**

3. **Tile download size estimates**
   Success criteria mentions "500MB+ of map tiles" but no estimation methodology.

   **Add to Section 2:**
   - Calculate tile count for Bibbulmun corridor at zoom levels 10-16
   - Measure actual storage after caching
   - Define acceptable size limits per trail

### Suggested Reordering

Current order has GPS (Section 4) after offline maps (Section 2), but GPS can be developed independently. Suggest parallel development:

**Track A (Map):** Sections 1, 2, 7, 8
**Track B (GPS/Location):** Sections 4, 5, 6

This allows faster iteration on each track.

### Missing Edge Cases

1. **GPS accuracy handling**
   - What happens when GPS accuracy is poor (>50m)?
   - Display accuracy circle on map?
   - Degrade "km position" confidence indicator?

2. **Track snapping ambiguity**
   - What if user is equidistant from two track sections (e.g., trail doubles back)?
   - Need algorithm to prefer "forward" direction based on recent movement

3. **Map tile download failures**
   - Partial download recovery
   - Resume interrupted downloads
   - Handle full storage gracefully

4. **No GPS permission**
   - App should still be useful for planning without location access
   - Clear messaging about limited functionality

### Existing Code Assets

The plan correctly identifies `trail-viewer.ts` (1781 lines) as a key asset. Specific functions to port:
- Map ↔ elevation profile synchronization
- Waypoint highlighting/selection
- Direction reversal logic
- Variant track handling

**Recommendation:** Document specific functions to port before starting this part.

### Suggested Success Criteria Additions
- App remains responsive with 500MB cached tiles
- GPS battery usage measured and documented
- Works with GPS accuracy up to 100m
- Graceful degradation without GPS permissions
