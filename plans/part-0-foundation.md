# Part 0: Foundation & Project Setup

## Goal
Establish the technical foundation for the Trail Companion app, including React Native project setup, shared library extraction, core data architecture, and basic app scaffolding.

## Deliverables

### 0. Technical Spike: MapLibre Offline Validation (Do First)
**This is a decision gate - complete before committing to full implementation.**
- Create minimal React Native app with react-native-maplibre-gl
- Test offline vector tile caching on iOS and Android
- Download tiles for Bibbulmun Track corridor as test case
- Measure tile storage size at zoom levels 10-16
- Document any limitations, performance issues, or blockers
- **Decision point:** Proceed with React Native, or reconsider PWA approach

### 1. Development Environment Setup
- Document required tooling versions:
  - Node.js version
  - Xcode version and iOS SDK
  - Android Studio version and SDK levels
  - React Native CLI version
- Create setup script or checklist for new developers
- Verify builds on both iOS simulator and Android emulator

### 2. React Native Project Initialization
- Create new React Native project with TypeScript
- Configure build tooling (Metro bundler, development environment)
- Set up iOS and Android targets
- Configure ESLint/Prettier to match existing codebase standards

### 3. Shared Library Extraction
- Create shared package in `packages/trail-core` directory using npm workspaces
- Extract shared modules from `gpx-tools` and `trail-maps`:
  - `distance.ts` - Haversine distance calculations
  - `gpx-parser.ts` - GPX file parsing (adapt for React Native, see Part 4)
  - `gpx-optimizer.ts` - Douglas-Peucker track simplification
  - `types.ts` - Core TypeScript interfaces
  - `waypoint-classifier.ts` - Waypoint type classification
  - `track-classification.ts` - Main/alternate/side-trip classification
- Ensure both existing repos (`gpx-tools`, `trail-maps`) can consume from the shared package
- Add unit tests for extracted modules

### 4. Core Data Architecture
- Set up offline-first data layer using SQLite:
  - Use `react-native-sqlite-storage` (or `expo-sqlite` if using Expo)
  - Data models for trails, waypoints, user plans, cached tiles
- Define sync strategy for when connectivity is available
- Plan storage schema:
  ```
  trails: id, name, metadata_json, created_at, updated_at
  waypoints: id, trail_id, name, type, lat, lon, ele, km_position
  plans: id, trail_id, name, direction, start_date, section_json, stops_json
  cached_tiles: id, trail_id, zoom, x, y, data_blob, cached_at
  ```

### 5. App Shell & Navigation
- Implement three-mode navigation structure (Plan / Hike / Contribute)
- Create persistent mode selector at top of screen
- Set up tab bar navigation within each mode (placeholder screens)
- Establish color scheme switching based on active mode:
  - Plan: blue accent
  - Hike: green accent
  - Contribute: orange accent

### 6. Trail Data Integration
- Port existing processed trail JSON data structure
- Create data loading layer to read trail data from local storage
- Implement trail index and individual trail retrieval

## Success Criteria
- **MapLibre spike complete** with documented findings and go/no-go decision
- Development environment documented and reproducible
- Running React Native app on iOS and Android simulators
- Shared library package working in monorepo structure
- Basic navigation between all three modes and their tabs
- Trail data loads from SQLite storage
- Offline data persistence verified

## Dependencies
- None (this is the foundation)

## Notes
- This part focuses on infrastructure, not features
- No map rendering or GPS yet - those come in Part 2
- UX/visual design comes in Part 1

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] All affected files identified
- [x] Steps in the right order
- [ ] Missing dependencies or prerequisites (see below)
- [ ] Edge cases considered
- [ ] Testing strategy sufficient (needs expansion)
- [ ] Simpler alternatives considered

### Issues Found

1. **Missing: React Native + MapLibre spike**
   Add a deliverable to validate MapLibre GL works with React Native for offline vector tiles. This is the highest-risk technical decision and should be validated BEFORE committing to the React Native path.

   **Add to Deliverables:**
   ```
   ### 0. Technical Spike: MapLibre Offline Validation
   - Create minimal React Native app with react-native-maplibre-gl
   - Test offline vector tile caching on iOS and Android
   - Measure tile storage size for a sample trail corridor
   - Document any limitations or issues
   - Decision gate: proceed with React Native or reconsider PWA
   ```

2. **Shared Library Extraction - Missing details**
   - Where will the shared package live? Monorepo? Separate npm package?
   - How will versioning work between consumers?
   - Suggest: Start with a local package in a `packages/` directory using npm workspaces

3. **SQLite vs IndexedDB decision needs criteria**
   - SQLite via `react-native-sqlite-storage` is likely better for React Native
   - IndexedDB is web-only; won't work in React Native
   - Remove IndexedDB mention since this is a React Native app

4. **Missing: Development environment setup instructions**
   - Xcode version requirements
   - Android Studio / SDK requirements
   - Node version
   - This affects all subsequent parts

### Suggested Edits to Deliverables

**Modify Section 4 (Core Data Architecture):**
Change from:
> Set up offline-first data layer:
>   - SQLite (via wa-sqlite) or IndexedDB for local storage

To:
> Set up offline-first data layer:
>   - SQLite via react-native-sqlite-storage for local storage
>   - Consider expo-sqlite if using Expo

**Add to Success Criteria:**
- MapLibre offline spike demonstrates viable path forward
- Development environment documented for iOS and Android

### Risks Specific to This Part
- If MapLibre spike fails, entire React Native approach may need reconsideration
- Shared library extraction could delay Part 0 significantly—consider deferring to after MVP
