# Trail Companion App - Feature Analysis & Feedback

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

## Your Vision (Summary)

An offline-capable mobile trail companion app — your own extensible FarOut alternative — with current-location tracking, distance/elevation to waypoints, custom GPX upload with auto-generated datasheets, multi-day campsite planning, crowdsourced updates, resupply/water planning, and strong UX throughout.

---

## What You Already Have (Existing Assets)

These are significant — you're not starting from zero:

- **Trail viewer** (`trail-viewer.ts`, 1773 lines): Synchronized map + elevation profile + waypoint table with direction reversal, expand/collapse, variant support
- **Build pipeline** (`build-trails.ts`, 1267 lines): GPX parsing, track classification, waypoint matching (hysteresis-based), variant junction detection, Douglas-Peucker simplification
- **GPX datasheet** (in `gpx-tools`): Full travel plan generation with segment stats, resupply point extraction, CSV export
- **Waypoint classification**: 14 types with emoji icons, multi-source classification (GeoJSON folders, known towns, prefix matching)
- **GPX processing suite** (in `gpx-tools`): Splitter, combiner, optimizer, POI enrichment from OSM, daylight calculator, route comparison
- **Climate data**: Historical monthly temperature/precipitation for locations along trails
- **Shared core libraries**: Distance calculations, GPX parsing, optimization (duplicated across both repos — ripe for consolidation)

---

## Feature-by-Feature Analysis

### 1. Offline Maps & Trails
**Feasibility: High complexity, but well-understood problem**

This is the single hardest technical challenge. Map tiles are large — a full trail corridor at useful zoom levels can be hundreds of MB.

Options:
- **Raster tile caching** (like FarOut does): Download OpenTopoMap tiles for a bounding box at relevant zoom levels. Simple but storage-heavy. A 1000km trail corridor might need 200-500MB of tiles.
- **Vector tiles** (Mapbox/MapLibre): Much smaller downloads (50-100MB for same coverage), style client-side, better zoom flexibility. More complex to set up but the modern approach.
  - This one is my preference
- **Hybrid**: Cache key zoom levels as raster, vector for detail.

The trail data itself (JSON) is tiny by comparison — a few MB per trail even with full-resolution tracks.

**Key decision**: Which map library? Leaflet (current) doesn't handle offline well. MapLibre GL JS (open-source Mapbox fork) has native offline/vector tile support and works in mobile contexts.
    - I am leaning towards using MapLibre GL JS

### 2. Current Location + Distance to Waypoints
**Feasibility: Straightforward**

The Geolocation API works in browsers and PWAs. You'd need:
- Snap user position to nearest track point (you already have proximity search logic)
  - Does this mean I should keep more points on the trail rather try to remove many of them to keep the data to load low (using Douglas-Pecker)?
- Calculate remaining distance/elevation to any selected waypoint (cumulative distance math you already do)
- Background GPS sampling with configurable frequency (battery management)

**Battery concern**: Continuous GPS is power-hungry. Need aggressive sampling strategies — e.g. every 30s while walking, users can reduce it or even turn off background GPS, since the most important time to have GPS is when looking at the map.

### 3. Measure Between Two Points
**Feasibility: Straightforward**

Tap two points on the map or select two waypoints → show along-trail distance, net elevation change, total ascent, total descent between them. The data model already supports this (cumulative stats at each waypoint).

### 4. Multi-Day Campsite Planning
**Feasibility: Medium — UX is the hard part**

The calculation is simple (segment stats between campsites). The UX of making this intuitive is the real challenge:
- Drag-to-reorder campsite selection
- Show per-day stats (distance, ascent, descent) updating live as you adjust. If fitting all of this on one screen is too much, drag campsite pins, tap a button to create a plan which shows the data sheet, and there's a button there to go back into edit mode, or save the plan.
- Highlight selected campsites (or points) on map and elevation profile
- Consider: preset "easy/moderate/hard" day templates (e.g. 15km/20km/25km targets) that auto-select campsites. This is a stretch goal that feels very hard to do well, and is not necessary for the functioning app.

This is a killer feature if done well — it's the core planning workflow for thru-hikers and most apps do it poorly.

### 5. Custom GPX Upload
**Feasibility: High — you've built the pipeline**

The `gpx-tools` repo already does GPX parsing, waypoint detection, datasheet generation, and optimization. The `trail-maps` build pipeline adds track classification, waypoint matching, and variant detection.

The challenge is making this work **client-side at runtime** rather than at build time. Currently `build-trails.ts` uses JSDOM for XML parsing — in a browser/app context you'd use the native DOMParser instead. The core algorithms (distance, simplification, waypoint matching) are already pure functions that work anywhere.

_NOTE_: this does not have to be an offline feature (that would be a strong bonus but is not necessary). It would still be a strong feature to upload the GPX file for your upcoming hike at home, which creates the data needed and loads it into your app.

### 6. Crowdsourced Updates
**Feasibility: High complexity — requires backend infrastructure**

This is a fundamental architecture shift. Currently everything is static. Crowdsourcing needs:
- **User accounts / authentication**
- **Database** for user-submitted waypoints, comments, corrections
- **Moderation system** (spam, incorrect data, conflicts)
- **Conflict resolution** (two users edit same waypoint)
- **Versioning/audit trail** (who changed what, rollback capability)
- **Offline sync** (user adds waypoint offline → syncs when connected)

This is essentially building a small social platform. Consider whether this is a v1 or v2 feature.

**Lighter alternative for v1**: Allow users to submit corrections/additions via a simple form that creates GitHub issues or a moderated queue, rather than live collaborative editing.

Response - yes this is a fundamental change, I agree it is not necessary for v1, but I would like to keep the option open. Perhaps the lighter alternative of users submitting corrections/additions is the way to go, that combined with the ability for users to post comments is 90% of what I'm looking for here.

### 7. Resupply Planning
**Feasibility: Medium**

Needs:
- Know which waypoints have resupply options (towns, stores — your classifier already identifies these)
- Calculate distances between resupply points
- Help the user calculate days of food needed
- Show mail drop / parcel service options
- Account for town detours (off-trail distance to actual store)

This pairs naturally with the campsite planner — "I need to resupply by day X, which town is nearest?"

### 8. Water Carry Distances
**Feasibility: Medium**

Needs:
- Reliable water source data (seasonal availability is the hard part)
- Distance between water sources along trail
- Notify about long dry stretches
- POI enrichment from OSM (you already have this in gpx-tools) could help for custom trails
- User reports on water source status (ties into crowdsourcing)

The data quality problem is real — water sources dry up seasonally, and a map showing a dry creek as a water source is dangerous.

---

## What's Missing From Your Feature List

### Critical for a trail app:

1. **Platform decision** — React Native

2. **Offline-first data architecture** — How does the app work with no signal for days? Need local-first database (e.g. SQLite via wa-sqlite, or IndexedDB) that syncs when connected. This affects every feature.

3. **Off-trail / wrong-turn alerts** — If you're tracking location, alert when the user strays more than X meters from the trail. This is a safety feature FarOut users rely on heavily.
   - yes, this might need some more thinking and testing, false positives here are quite annoying.

4. **Safety features** — Emergency contact sharing, "I'm here" location pings when desired, trip plan logging (expected itinerary vs actual progress). In remote Australian bush, this matters.
   - good addition, also ability to manually send an "I'm here" message could be good, rather than constantly polling

5. **Real-time weather** — Historical climate is useful for planning, but on-trail you want actual forecasts. BOM API integration for Australian trails, or Open-Meteo for international.
   - yes, great addition, very useful

6. **Trail conditions / closures** — Fire closures, flood damage, fallen trees. Could be crowdsourced or official data (many Australian trail organizations publish closures).
    - this could be hard to do

7. **Navigation bearing** — Not turn-by-turn, but "next waypoint is 2.3km at bearing 247 (WSW)". Simple but valuable when the trail is unclear.
   - I am not clear how knowing the bearing is useful.

### Nice to have but often overlooked:

8. **Track recording** — Record your actual hike as a GPX track. Compare planned vs actual. Share with others.

9. **Photo waypoints** — Take a photo, automatically geo-tag it and associate with trail position. Great for trip reports and crowdsourced trail condition updates.

10. **Sunrise/sunset at current position** — You already have daylight calculation in gpx-tools. Show "sunset in 2h47m" so hikers know when to start looking for camp.

11. **Import/export interop** — Import from Gaia GPS, AllTrails, CalTopo. Export to those formats. Don't lock users in.

12. **Multi-section planning** — Support section hiking (just doing km 200-450), not only thru-hiking. This is a great idea and would really improve the UX for section hikers if you could just ask for the map and datasheet to show a section.

13. **Pack/food weight calculator** — Pairs with resupply planning. "You're carrying 5 days of food at 650g/day = 3.25kg food weight."

14. **Journal/notes** — Per-day notes tied to trail position. This could be usefuly for planning, or journaling (although journaling is _not_ a core aim of this app).

15. **Shared trip plans** — Share your plan with someone at home who can see your progress (when you have signal). Peace of mind for family. This is a solid enhancement.

Response - these are all great ideas for features that should be implemented.

---

## How Features Fit Together as a Coherent App

The features cluster into three natural modes:

### Mode 1: Plan (before the hike)
- Browse/search trails or upload custom GPX
- View map, elevation profile, waypoint datasheet
- Multi-day campsite planner with per-day stats
- Resupply planning with food carry calculations
- Water carry distance notifications
- Climate/weather overview for dates
- Download trail for offline use
- Share plan with emergency contact

_NOTE_: the campsite resupply and water carry planner are also designed to be used on trail, so mobile friendly UX is very important, as well as having the ability to store multiple plans (since plans often change).

### Mode 2: Hike (on trail, mostly offline)
- Current location on map with track
- Distance/elevation to next waypoint (and selected waypoints)
- Off-trail alert
- Bearing to next point
- Today's plan: distance remaining, elevation, next campsite (if desired, make it easy for users not to have a set plan for today)
- Water source countdown
- Sunrise/sunset timer
- Record actual track
- Photo waypoints
- Journal notes

### Mode 3: Contribute (when connected)
- Report trail conditions
- Add/update water sources
- Correct waypoint positions
- Add comments to waypoints
- Submit photos
- Rate campsites

This three-mode structure also maps to a clean UX: tab bar or swipe between Plan/Hike/Contribute views.

---

## UX & Interaction Design

### Navigation Architecture: No Hidden Menus, No Ambiguity

The core principle: **the user should always know where they are and how to reach every other view.**

**Top: Mode selector** — A persistent segmented control at the top of every screen. Three segments: Plan (blue) / Hike (green) / Contribute (orange). The active mode tints the entire accent color scheme, providing ambient awareness even from peripheral vision. This never moves, never scrolls away.

**Bottom: Tab bar** — Within each mode, a standard bottom tab bar with icon + text labels (not icon-only). Tabs vary per mode:
- **Plan**: Overview | Waypoints | Day Plan | Resupply
- **Hike**: Dashboard | Map | Waypoints
- **Contribute**: Notes | Upload

**No horizontal swipe between tabs.** This prevents the exact confusion you described — accidental swipes that land you on an unknown screen. Every navigation is a deliberate tap.

**No deep nesting.** Detail views (waypoint details, measurement results, campsite info) appear as **bottom sheets** that slide up over the current view. The mode selector and tab bar remain visible underneath. Swipe down to dismiss. You never lose your place.

### The Hike Dashboard — Glanceable Information

This is the screen hikers see 90% of the time on-trail. Designed for dirty hands, bright sun, tired eyes.

```
┌─────────────────────────────────────────┐
│  Plan   [ HIKE ]   Contribute           │  ← green tint
├─────────────────────────────────────────┤
│  BIBBULMUN TRACK  SOBO     km 245 / 982 │
│  ████████████░░░░░░                     │  ← progress bar
├────────────────────┬────────────────────┤
│  NEXT CAMPSITE     │  NEXT WATER        │
│  Mumballup Camp    │  Murray River      │
│  12.4 km  +310m    │  3.1 km            │
├────────────────────┼────────────────────┤
│  NEXT TOWN         │  NEXT SHELTER      │
│  Balingup          │  Harris Dam Hut    │
│  34.7 km  +820m    │  8.2 km            │
├────────────────────┴────────────────────┤
│  TODAY (Day 12 of 42)                   │
│  Murray Camp → Mumballup Camp           │
│  22.4 km  +640m/-520m  ~6h 30m         │
│  Done: 10.0 km (45%) █████░░░░░        │
├─────────────────────────────────────────┤
│  UPCOMING                               │
│   3.1 km  💧 Murray River               │
│   5.8 km  🛣️ Road Crossing R412         │
│  12.4 km  ⛺ Mumballup Campsite         │
│                     [See all waypoints]  │
├─────────────────────────────────────────┤
│  [ Dashboard ]   [ Map ]   [ Waypoints ]│
└─────────────────────────────────────────┘
```

**Design rules:**
- Distance numbers use 24pt bold — readable at arm's length
- Four "next" cards answer the four questions hikers constantly ask: How far to camp? Water? Town? Shelter?
- Today's plan shows progress against the day plan you built in Plan mode
- Upcoming list shows next 3 waypoints of any type with emoji icons (reusing the existing 14-type classification)
- Tapping any card opens a bottom sheet with full details, mini elevation profile for that segment, and "Show on Map"

### Hike Map View

Full-screen map with GPS blue dot. Map auto-follows your position by default. If you pan manually, auto-follow pauses and a "Re-center" button appears.

**Location bar** at the bottom of the map:
- On trail (< 50m): "On trail — km 245.3" (green)
- Drifting (50-200m): shows distance, no alert
- Warning (200-500m): amber bar, single haptic pulse
- Off trail (> 500m): red banner slides down from top — "523m from trail. Bearing 247° (WSW) to nearest point." Persists until dismissed or back within 200m.

No audible alarm by default — hikers don't want their phone screaming in the bush. Optional in settings.

**Elevation profile** is a pull-up drawer from the bottom edge of the map. Pull up to reveal a 120px contextual profile showing the section currently visible on the map. Syncs with map panning. Tap on profile to pan map to that location (reusing your existing map↔elevation sync from trail-viewer.ts).

### Campsite Planner — The Killer Feature

Lives in Plan > Day Plan tab. Two entry points:

**"Auto-Plan"**: Input your daily distance target (e.g., 20 km/day). Algorithm selects campsites closest to that target from the full campsite list. Presents a complete itinerary you can then edit.
    - This is an extension feature that is not required for v1

**"Add Campsites"**: Opens a bottom sheet listing all campsite/hut/accommodation waypoints in order. Checkboxes to select stops. Search bar to filter.

Once campsites are selected, the Day Plan shows **day cards**:

```
┌─────────────────────────────────────────┐
│  DAY 3 — 17 Apr                         │
│  Helena Camp → Chadoora Camp            │
│  26.3 km  +890m/-750m  ~8h             │
│  💧 4 water sources                     │
│  ⚠️ Long day (exceeds 25 km target)     │
│                             [≡] [↑] [↓] │
└─────────────────────────────────────────┘
```

**Editing:**
- `[↑]` merges this day with the previous (removes the boundary campsite)
- `[↓]` splits this day by inserting an intermediate campsite (popup shows available options)
- `[≡]` long-press to drag-reorder
- Swipe left to remove a stop entirely
- All stats update instantly on every change

**Integration**: Tapping "Show on map" in a day card switches to Overview tab, zooms to that day's segment, highlights it on both map and elevation profile.

### Context Preservation Across Views

The app maintains a `focusedWaypoint` state. When you interact with any waypoint in any view:
- Switch to Map → map pans to that waypoint with popup open
- Switch to Waypoints → list scrolls to and highlights that row
- Switch to Day Plan → highlights the day containing that waypoint

This reuses the same pattern already in your `trail-viewer.ts` (`handleTableRowClick` → `scrollToTableRow` → `map.setView`).

### Measure Tool

Two entry methods:
1. **From waypoint list**: Tap a waypoint → bottom sheet → "Measure from here" → tap another waypoint
2. **From map**: Long-press on trail to drop a pin → "Measure from here" → tap another point

Result panel shows: distance, elevation gain/loss, mini elevation profile for that segment, waypoints between the two points. "Swap direction" button flips ascent/descent.

### Progressive Disclosure Layers

| Layer | What's visible | How to access |
|-------|---------------|---------------|
| **Glance** | Distance to next camp/water/town, current km, progress bar | Visible on Dashboard without scrolling |
| **Scroll** | Upcoming waypoints, today's plan details | Scroll Dashboard |
| **One tap** | Full waypoint details, segment elevation profile, coordinates | Tap any card → bottom sheet |
| **Tab switch** | Full waypoint list, complete day plan, resupply table, full-screen map | Tap bottom tab |

### Information Hierarchy (On-Trail Priority)

1. Distance to next campsite/destination ("Will I make it today?")
2. Distance to next water ("Should I fill up here?")
3. Current position on trail ("Where am I?")
4. Off-trail warning ("Am I still on the right track?")
5. Today's progress ("How much further?")

Everything else is secondary — available within one tap but not competing for attention.

---

## Architecture Considerations

Decided to go with React Native.

### Data architecture:
- **IndexedDB** for offline trail data, cached map tiles, user data
- **Service Worker** for offline page/asset caching
- **Background Sync API** for queuing crowdsource submissions until connected
- **Optional backend** (Supabase, Firebase, or custom): user auth, crowdsourced data, shared plans

### Shared library consolidation:
- Extract `distance.ts`, `gpx-parser.ts`, `gpx-optimizer.ts`, `types.ts` into a shared package
- Both `gpx-tools` and `trail-maps` (and the new app) consume from it
- Avoids the current code duplication

---

## Suggested Phasing

### Phase 1: Offline trail viewer
- Service worker + offline caching
- MapLibre GL with downloadable vector tiles
- Current location on map
- Distance/elevation to next waypoint
- Existing trail data browsable offline

### Phase 2: Planning tools
- Multi-day campsite planner
- Resupply distance calculator
- Water carry distances
- Measure between points

### Phase 3: Custom trails
- Upload GPX in-app
- Auto-process (waypoint matching, datasheet generation)
- View custom trail with same features as built-in trails

### Phase 4: On-trail features
- Off-trail alerts
- Track recording
- Bearing to next waypoint
- Sunrise/sunset
- Photo waypoints

### Phase 5: Community features
- User accounts
- Crowdsourced waypoint updates
- Trail condition reports
- Comments and photos
- Moderation system

---

## Key Risks

1. **Offline map tiles**: The biggest technical risk. Map tile storage, download management, and keeping maps current is complex. Consider using an existing solution (MapTiler, Protomaps) rather than building from scratch.

2. **Scope creep**: This is a big vision. The difference between "trail viewer that works offline" and "full FarOut competitor with crowdsourcing" is enormous. Ruthless phasing is essential.

3. **Data quality for custom trails**: Your pipeline works well for curated trails. User-uploaded GPX files will be messy — missing elevation, wrong projections, duplicate points, gaps. Need robust error handling and user feedback.

4. **Battery life**: GPS + map rendering + screen-on drains batteries fast. Hikers carry limited power. This needs to be a first-class design concern, not an afterthought.
