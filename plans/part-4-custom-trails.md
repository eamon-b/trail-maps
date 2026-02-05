# Part 4: Custom Trail Support

## Goal
Enable users to upload their own GPX files and have them processed into fully-featured trails with waypoints, datasheets, and all the same functionality as built-in trails.

## Deliverables

### 1. GPX Upload Interface
- File picker for GPX files (device storage, cloud drives)
- Drag-and-drop support where applicable
- URL import option (fetch GPX from web)
- Upload progress indicator

### 2. Client-Side GPX Processing
Port the existing build pipeline to work at runtime in React Native:

**GPX Parsing (React Native)**
- Use `fast-xml-parser` for XML parsing (React Native has no DOMParser)
- Adapt `gpx-parser.ts` to work with JSON-based parsing output
- Extract tracks, waypoints, elevation data
- Handle common GPX variations and malformed files
- Clear error messages for invalid files
- **File size limit:** 50MB max (larger files may crash on mobile)

**Track Processing (MVP)**
- Douglas-Peucker simplification (configurable detail level)
- **MVP simplification:** Treat all tracks as main route initially
- Direction detection and normalization
- Gap handling and track segment merging
- *Deferred to v2:* Track classification (main/alternate/side-trip), variant junction detection

**Waypoint Processing**
- Waypoint matching to track (hysteresis-based snapping)
- Waypoint classification (14 types)
- Distance/elevation calculation for each waypoint

**Performance Considerations**
- Run processing on background thread (react-native-background-actions)
- Show progress feedback: "Parsing GPX...", "Analyzing elevation...", "Matching waypoints..."
- Target: processing completes in <30s for files under 10MB

### 3. Auto-Generated Datasheet
- Full travel plan generation from processed GPX
- Segment statistics between waypoints
- Cumulative distance and elevation
- Resupply point extraction
- Export options (view in app, share, CSV)

### 4. Custom Trail Storage
- Save processed custom trails to local storage
- Trail metadata editing (name, description)
- Delete/manage custom trails
- Custom trails appear in trail list alongside built-in trails

### 5. Custom Trail Features
Custom trails should support all the same features as built-in trails:
- Offline map tile downloading for trail corridor
- Distance/elevation to waypoints
- Campsite planner
- Measure tool
- Direction reversal

### 6. Error Handling & User Feedback
- Graceful handling of:
  - Missing elevation data (offer to fetch from elevation API, or continue without)
  - Clearly wrong elevation (spike detection and smoothing)
  - Invalid coordinates (out of valid lat/lon range)
  - Duplicate points
  - Track gaps
  - No waypoints (trail still usable, just no POI markers)
  - File too large (>50MB)
- User-friendly error messages
- Suggestions for fixing common issues
- Preview before final import

### 7. OSM POI Enrichment (DEFERRED - v2)
*Not included in initial implementation. Focus on processing user-provided waypoints well first.*

Future enhancement:
- If GPX has minimal waypoints, offer to enrich from OpenStreetMap
- Query OSM Overpass API for POIs near track
- Add water sources, shelters, road crossings automatically
- User can accept/reject suggested waypoints

## Success Criteria
- Can upload any reasonable GPX file and view it as a trail
- Processing completes in <30s for files under 10MB
- Memory usage doesn't crash app on older devices
- Custom trails have working datasheets
- Can plan multi-day trips on custom trails
- Malformed GPX files produce helpful error messages
- Custom trails persist across app restarts
- Tested with GPX exports from Gaia, AllTrails, Strava, Garmin

## Dependencies
- Part 0: Foundation & Project Setup (shared library with GPX processing)
- Part 1: Design System & UX Foundation
- Part 2: Offline Trail Viewer (map display)
- Part 3: Planning Tools (for campsite planner on custom trails)

## Notes
- This does NOT need to work offline for v1 (processing can require connectivity)
- Focus on the 80% use case: reasonably well-formed GPX from popular apps
- The existing `build-trails.ts` and `gpx-tools` are the reference implementations
- Consider processing feedback UI (progress bar, "Analyzing elevation...", etc.)

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] All affected files identified
- [x] Steps in the right order
- [x] Missing dependencies identified
- [x] Edge cases considered (Section 6)
- [ ] Testing strategy
- [ ] Simpler alternatives considered

### Existing Code Validation

The plan correctly identifies the existing processing pipeline. Verified assets:
- `scripts/build-trails.ts` (1197 lines) - full pipeline
- `src/lib/gpx-parser.ts` - GPX parsing
- `src/lib/gpx-optimizer.ts` - Douglas-Peucker
- `src/lib/track-classification.ts` - main/alternate/side-trip
- `src/lib/waypoint-classifier.ts` - 14 waypoint types

These are well-tested and can be ported to client-side.

### Issues Found

1. **JSDOM replacement is non-trivial**
   The plan notes replacing JSDOM with DOMParser, but:
   - React Native doesn't have DOMParser either
   - Need a React Native XML parser (e.g., `fast-xml-parser`)
   - This is more work than implied

   **Add to Section 2:**
   ```
   **React Native XML parsing:**
   - Use fast-xml-parser or similar (no DOM APIs in RN)
   - Adapt gpx-parser.ts to use JSON-based parsing
   - Test with same GPX files as build-trails.ts
   ```

2. **Performance concerns not addressed**
   Processing a large GPX on a mobile device could be slow. Consider:
   - Web Worker equivalent (React Native doesn't have Web Workers)
   - Processing in background thread
   - Progress feedback for long operations
   - Set reasonable file size limits (e.g., 50MB max)

3. **Missing: Coordinate projection handling**
   Section 6 mentions "wrong projections" as an error case, but GPX is always WGS84. The real issue is:
   - Tracks with no elevation (use elevation API to fill?)
   - Tracks with clearly wrong elevation (outliers)
   - Mixed units or invalid coordinates

4. **OSM POI Enrichment (Section 7) - scope creep warning**
   This is marked "Optional Enhancement" but could easily become mandatory if users expect it. Either:
   - Commit to it as part of this phase
   - Explicitly defer to a later enhancement

   **Recommendation:** Defer. Focus on processing user-provided waypoints well first.

### Suggested Simplification

For MVP, consider a simpler flow:
1. Upload GPX
2. Show preview with auto-detected waypoints
3. User confirms or edits
4. Save as custom trail

Skip:
- OSM enrichment
- Track classification (treat all as main track)
- Variant junction detection

These can be added later. The core value is viewing your GPX with distance/elevation stats.

### Testing Strategy Needed

This part needs explicit test coverage:
- Test with GPX files from Gaia, AllTrails, Strava, Garmin
- Test with malformed GPX (missing elevation, huge files, etc.)
- Performance benchmarks on target devices

### Success Criteria Additions
- Processing time < 30s for files under 10MB
- Memory usage doesn't crash app on older devices
- Clear error messages for all failure modes
