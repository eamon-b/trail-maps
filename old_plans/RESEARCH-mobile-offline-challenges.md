# Mobile Offline Functionality: Challenges and Solutions

This document explores the fundamental challenges of providing offline functionality for hiking trail apps on mobile devices, and evaluates different technical approaches.

## The Core Use Case

A hiker wants to:

1. Save trail data (map, waypoints, elevation profile) while on home WiFi
2. Travel to trailhead (potentially days later)
3. View trail data with no cellular signal
4. Navigate along the trail for hours/days
5. Return home and sync any changes

This seems simple but mobile platforms make it surprisingly difficult.

## Challenge 1: iOS Safari Cache Eviction

### The Problem

iOS Safari aggressively evicts web storage to free device space:

| Storage Type | Eviction Behavior |
|--------------|-------------------|
| Service Worker Cache | Evicted after ~7 days of non-use, sometimes sooner |
| IndexedDB | Evicted under storage pressure, ~7 day threshold |
| LocalStorage | 5 MB limit, evicted under pressure |
| Cache API | Same as Service Worker cache |

**"Non-use" means**: The user hasn't visited the website. Simply having the PWA on the home screen doesn't count as use.

### Why This Breaks Hiking Apps

Typical hiking trip timeline:

- **Day -14**: User discovers trail, bookmarks it
- **Day -7**: User downloads trail for offline use
- **Day -3**: User is busy packing, doesn't open app
- **Day 0**: User arrives at trailhead with no signal
- **Result**: Cache has been evicted. App is useless.

### Platform Comparison

| Platform | Cache Persistence | User Control |
|----------|-------------------|--------------|
| iOS Safari | ~7 days, no guarantee | None |
| iOS PWA (Home Screen) | Separate storage, still evicts | None |
| Chrome Android | Persistent if requested | User can grant "persistent storage" |
| Chrome Desktop | Very persistent | User can grant |
| Firefox | Persistent if requested | User can grant |

### Mitigations (PWA)

1. **Dual storage**: Cache API + IndexedDB (different eviction timing)
2. **Cache freshness warnings**: "Saved 5 days ago - refresh recommended"
3. **Prominent refresh prompts**: Alert users before trips
4. **Smaller data sizes**: Less likely to be evicted under storage pressure

**Effectiveness**: Partial. Reduces risk but doesn't eliminate it. A user who forgets to refresh before a trip may still lose data.

## Challenge 2: Background Process Limitations

### The Problem

Mobile browsers have severe restrictions on background execution:

| Scenario | iOS Safari | Chrome Android |
|----------|------------|----------------|
| User switches to another app | Tab suspended in ~30 seconds | Tab suspended in ~5 minutes |
| Screen turns off | Immediate suspension | Immediate suspension |
| Large download in progress | Stops | Stops |
| Service Worker background sync | Not supported | Limited support |
| Background Fetch API | Not supported | Supported (Chrome 74+) |

### Why This Breaks Tile Downloads

For a medium trail (300 km), downloading tiles at a reasonable rate:

- ~20,000 tiles at 4 tiles/second = **83 minutes**

A user cannot realistically keep their phone screen on, with the browser in foreground, for 83 minutes. They will:

- Check a text message (app switches, download stops)
- Phone auto-locks (download stops)
- Get a phone call (download stops)

### Mitigations (PWA)

1. **Resumable downloads**: Persist progress to IndexedDB, resume when user returns
2. **Smaller download scopes**: Offer "quick save" (10 min) vs "full save" (60+ min)
3. **Progress that survives**: Show accurate status on return
4. **Wake Lock API**: Keep screen on during download (Chrome Android only, not iOS)

**Effectiveness**: Moderate. Makes downloads *possible* but user experience is poor. "Please keep this tab open for 83 minutes" is not acceptable UX.

## Challenge 3: Storage Quotas

### Available Storage by Platform

| Platform | Quota | Notes |
|----------|-------|-------|
| Chrome Android | 60% of free space | Can be several GB |
| Chrome Desktop | 60% of free space | Often 10+ GB |
| Safari iOS | ~50 MB typical | Per-origin, varies by device state |
| Safari iOS (PWA) | ~50 MB typical | Separate from Safari, same limits |
| Firefox | 50% of free space | Similar to Chrome |

### Storage Requirements

| Trail | Data | Tiles (z8-14) | Total |
|-------|------|---------------|-------|
| Short (100 km) | ~1 MB | ~40 MB | ~41 MB |
| Medium (300 km) | ~2 MB | ~120 MB | ~122 MB |
| Heysen (1100 km) | ~5 MB | ~300 MB | ~305 MB |

**Problem**: On iOS Safari, even a short trail's tiles (~40 MB) approach the practical storage limit.

### Mitigations (PWA)

1. **Aggressive tile corridor** (3 km buffer instead of 5 km): 30-40% reduction
2. **Lower zoom ceiling** (max 12 instead of 14): 75% reduction
3. **On-demand caching**: Only cache tiles user actually views
4. **Clear communication**: Show storage impact before download

**Effectiveness**: Partial. Can fit short trails on iOS. Long trails are impractical.

## Challenge 4: No Reliable Offline Detection

### The Problem

`navigator.onLine` is unreliable:

- Returns `true` when connected to WiFi with no internet
- Returns `true` when connected to cellular with no data service
- Doesn't reflect actual ability to reach your server

### Why This Matters

The app can't reliably know when to:

- Switch to cached data
- Show "offline mode" indicator
- Skip network requests that will timeout

### Mitigations

1. **Timeout-based detection**: If fetch fails after 3 seconds, assume offline
2. **Hybrid approach**: Use `navigator.onLine` as hint, verify with actual request
3. **Offline-first architecture**: Always try cache first, network second

## Challenge 5: PWA Installation Friction

### The Problem

Users must:

1. Visit website in Safari/Chrome
2. Understand that "Add to Home Screen" exists
3. Navigate to share menu or browser menu
4. Find and tap "Add to Home Screen"
5. Confirm installation

Compare to native app:

1. Open App Store / Play Store
2. Search
3. Tap "Install"

### User Expectations

When users see "Download for offline", they expect:

- A button that does something immediately
- Visual progress indicator
- Data that persists reliably
- An "app" in their app drawer

PWAs on iOS deliver:

- A workflow that requires leaving the page
- No progress indicator for "installation"
- Data that may disappear
- A home screen shortcut that looks like an app but isn't

### Effectiveness

PWA installation is a poor experience on iOS. Many users never figure it out.

---

## Solution Spectrum

Given these challenges, here are the available approaches:

### Option 1: PWA Only (Current Plan)

**What it is**: Enhance the web app with service worker caching, IndexedDB backup, and cache management UI.

**Pros**:

- No new codebase
- Single deployment
- Works on all platforms
- No app store approval process
- Immediate updates

**Cons**:

- iOS cache eviction is unavoidable
- Long downloads are impractical
- Storage limits on iOS
- Poor installation UX on iOS
- No background processing

**Best for**: Users who primarily access on desktop, or Android users who install PWA. Acceptable for short trails on iOS with frequent refresh.

**Estimated effort**: 2-4 weeks for full implementation

### Option 2: PWA + Build-Time Tile Packaging (PMTiles)

**What it is**: Pre-package map tiles at build time into PMTiles files. Users download a single large file instead of thousands of tiles.

**How PMTiles works**:

PMTiles is a single-file archive format for map tiles. It contains:

- All tiles for a region/corridor, pre-rendered
- An index allowing random access to any tile
- Support for HTTP range requests (fetch only needed tiles)

**Workflow**:

1. Build process generates `heysen.pmtiles` (~150 MB) covering trail corridor
2. User clicks "Download for offline"
3. Browser fetches single file (resumable with range requests)
4. File stored in Cache API or IndexedDB
5. Leaflet/MapLibre reads tiles directly from local file

**Pros**:

- Single HTTP request (standard download, resumable)
- Much faster than tile-by-tile fetching
- No rate limiting concerns (your own files)
- Works with standard browser download manager
- User can see download progress natively

**Cons**:

- Requires build-time tile generation infrastructure
- Need source for tiles (render from OSM data, or pre-fetch with permission)
- Larger download than strictly necessary (whole corridor vs on-demand)
- Same iOS cache eviction issues
- Same iOS storage limits

**Best for**: Improving download experience while staying PWA-only. Doesn't solve iOS reliability issues.

**Estimated effort**: 3-5 weeks (includes tile generation pipeline)

### Option 3: Capacitor Wrapper (Hybrid App)

**What it is**: Wrap the existing web app in a native container using Capacitor (or Cordova). Ship to App Store and Play Store.

**How Capacitor works**:

```
┌─────────────────────────────────────┐
│         Native App Shell            │
│  ┌───────────────────────────────┐  │
│  │        WebView                │  │
│  │  ┌─────────────────────────┐  │  │
│  │  │   Your Web App          │  │  │
│  │  │   (unchanged HTML/JS)   │  │  │
│  │  └─────────────────────────┘  │  │
│  └───────────────────────────────┘  │
│                                     │
│  Native Plugins:                    │
│  - Filesystem (persistent storage)  │
│  - Background fetch                 │
│  - SQLite database                  │
│  └─────────────────────────────────┘
```

**What you get**:

- App Store distribution (users expect and trust)
- Native filesystem access (truly persistent storage)
- Background download capability
- SQLite for large data (no eviction)
- Push notifications
- No Safari storage limits

**Code changes required**:

```typescript
// Before (web only)
await caches.open('tiles').put(url, response);

// After (Capacitor)
import { Filesystem, Directory } from '@capacitor/filesystem';

await Filesystem.writeFile({
  path: `tiles/${z}/${x}/${y}.png`,
  data: base64Data,
  directory: Directory.Data, // Persistent, never evicted
});
```

**Pros**:

- Minimal web code changes (mostly storage layer abstraction)
- Keeps existing UI and logic
- True persistent storage
- Background downloads work
- App store distribution
- Single codebase for web + mobile

**Cons**:

- Need Apple Developer account ($99/year)
- Need Google Play Developer account ($25 one-time)
- App store review process (1-7 days)
- Must maintain native project files (Xcode/Android Studio)
- WebView performance slightly worse than native
- Some iOS WebView limitations remain

**Best for**: Getting reliable offline support with minimal code rewrite. Good middle ground.

**Estimated effort**: 2-3 weeks to wrap and deploy, plus ongoing maintenance

### Option 4: React Native (Full Rewrite)

**What it is**: Rebuild the app from scratch using React Native, with native UI components and full platform API access.

**Architecture**:

```
┌─────────────────────────────────────┐
│         React Native App            │
│                                     │
│  JavaScript Business Logic          │
│  ├── Trail data processing          │
│  ├── Elevation calculations         │ ← Can reuse existing TS
│  └── Waypoint filtering             │
│                                     │
│  Native UI Components               │
│  ├── react-native-maps              │ ← Native MapKit/Google Maps
│  ├── react-native-charts            │ ← Native charts
│  └── Native list views              │
│                                     │
│  Native Storage                     │
│  ├── react-native-fs (filesystem)   │
│  ├── react-native-sqlite            │
│  └── AsyncStorage                   │
│                                     │
│  Native Capabilities                │
│  ├── Background fetch               │
│  ├── GPS/Location                   │
│  └── Offline maps (native SDKs)     │
└─────────────────────────────────────┘
```

**What you get**:

- Native performance (60 fps scrolling, smooth maps)
- Full platform API access
- True background downloads
- Native map SDKs with built-in offline support
- No WebView limitations
- Better App Store optimization

**Native Offline Map Options**:

1. **Mapbox SDK** (react-native-mapbox-gl)
   - Built-in offline region downloads
   - Handles tile management automatically
   - Clear API: `offlineManager.createPack(region, options)`
   - Cost: Free for limited usage, paid for high volume

2. **Google Maps SDK** (react-native-maps)
   - Offline caching is automatic for viewed areas
   - No explicit offline download API
   - Free with usage limits

3. **MapLibre Native** (Open source Mapbox fork)
   - Same offline capabilities as Mapbox
   - Fully open source, no usage fees
   - Slightly less documentation

**Example offline map code (Mapbox)**:

```typescript
import MapboxGL from '@react-native-mapbox-gl/maps';

async function downloadTrailRegion(trailId: string, bounds: [number, number, number, number]) {
  const progressListener = (pack, status) => {
    console.log(`Download progress: ${status.percentage}%`);
  };

  await MapboxGL.offlineManager.createPack(
    {
      name: trailId,
      styleURL: 'mapbox://styles/mapbox/outdoors-v11',
      bounds: [[bounds[0], bounds[1]], [bounds[2], bounds[3]]],
      minZoom: 8,
      maxZoom: 14,
    },
    progressListener
  );
}

// Later: list downloaded regions
const packs = await MapboxGL.offlineManager.getPacks();

// Delete a region
await MapboxGL.offlineManager.deletePack(trailId);
```

**Code that can be reused from current codebase**:

| Module | Reusability |
|--------|-------------|
| `gpx-parser.ts` | 100% - Pure TypeScript |
| `distance.ts` | 100% - Pure math |
| `gpx-optimizer.ts` | 100% - Pure TypeScript |
| `daylight.ts` | 100% - Pure TypeScript |
| Trail data JSON structure | 100% - Same format |
| `trail-viewer.ts` | 0% - DOM-specific |
| HTML templates | 0% - Web-specific |
| Leaflet map code | 0% - Need native map SDK |

**Pros**:

- Native performance and feel
- Offline maps "just work" with native SDKs
- Background downloads work properly
- No cache eviction issues
- GPS/location tracking for navigation
- Best long-term solution for a serious hiking app

**Cons**:

- Significant rewrite effort (UI layer is new)
- Two deployment targets (iOS + Android)
- Need to learn React Native
- More complex development setup
- May need to maintain web version separately

**Best for**: Building a "real" hiking app with the best possible mobile experience. Worth it if the app is a long-term project with serious hiking users.

**Estimated effort**: 6-10 weeks for MVP, ongoing maintenance

### Option 5: Flutter (Alternative Full Rewrite)

**What it is**: Similar to React Native but using Dart language and Flutter framework.

**Compared to React Native**:

| Aspect | React Native | Flutter |
|--------|--------------|---------|
| Language | JavaScript/TypeScript | Dart |
| Code reuse from web | Good (logic layer) | Minimal (new language) |
| Map libraries | Mature (Mapbox, etc.) | Good (flutter_map, mapbox_gl) |
| Performance | Good | Excellent |
| Developer experience | Familiar if you know JS | Learning curve for Dart |
| Hot reload | Yes | Yes (faster) |
| Community size | Larger | Growing fast |

**Pros over React Native**:

- Consistent UI across platforms (custom rendering)
- Faster performance
- Better animation support

**Cons vs React Native**:

- Must learn Dart (can't reuse JS/TS knowledge)
- Less code reuse from existing web app
- Smaller ecosystem of packages

**Best for**: Teams starting fresh without JS/web background, or prioritizing performance.

**Estimated effort**: 8-12 weeks (steeper learning curve)

---

## Comparison Matrix

| Requirement | PWA | PWA+PMTiles | Capacitor | React Native |
|-------------|-----|-------------|-----------|--------------|
| Works on desktop | ✅ | ✅ | ❌ | ❌ |
| Works on Android | ✅ | ✅ | ✅ | ✅ |
| Works on iOS | ⚠️ | ⚠️ | ✅ | ✅ |
| Reliable offline (iOS) | ❌ | ❌ | ✅ | ✅ |
| Fast tile downloads | ❌ | ✅ | ✅ | ✅ |
| Background downloads | ❌ | ❌ | ✅ | ✅ |
| App Store distribution | ❌ | ❌ | ✅ | ✅ |
| Code reuse from current | 100% | 100% | 95% | 60% |
| Development effort | Low | Medium | Medium | High |
| Ongoing maintenance | Low | Low | Medium | Medium |
| Native map experience | ❌ | ❌ | ⚠️ | ✅ |

Legend: ✅ = Good, ⚠️ = Partial/Issues, ❌ = Not supported

---

## Recommendation

### For Immediate Improvement

**Implement PWA (Option 1)** with the following scope:

1. Bundle CDN dependencies
2. Add service worker for app shell caching
3. Add IndexedDB backup for trail data
4. Add cache management UI with freshness warnings
5. Skip tile caching for v1 (maps require network)

This provides:

- Desktop users get full offline support
- Android users get good offline support
- iOS users get offline trail data (not maps) with clear warnings

**Effort**: 2-3 weeks

### For Serious Mobile Users

**Add Capacitor wrapper (Option 3)** after PWA is working:

1. Wrap existing web app with Capacitor
2. Replace Cache API with native filesystem for tiles
3. Add background download support
4. Ship to App Store and Play Store

This provides:

- Reliable offline for all platforms
- App Store distribution (user trust)
- Minimal code changes

**Effort**: 2-3 weeks additional

### For Long-Term Product

**Consider React Native (Option 4)** if:

- The app becomes a primary product (not just a tool)
- Users want navigation features (GPS tracking on trail)
- Performance on mobile becomes a priority
- You want to leverage native map SDK offline features

**Effort**: 6-10 weeks, but better long-term investment

---

## Appendix: Technical Deep Dives

### A. How PMTiles Works

PMTiles is a single-file archive for map tiles created by Protomaps.

**File structure**:

```
┌─────────────────────────────────────┐
│ Header (127 bytes)                  │
│ - Version, tile type, compression   │
│ - Bounds, center, zoom range        │
├─────────────────────────────────────┤
│ Root Directory                      │
│ - Index of tile locations           │
├─────────────────────────────────────┤
│ Leaf Directories (optional)         │
│ - Additional index for large files  │
├─────────────────────────────────────┤
│ Tile Data                           │
│ - Compressed tile bytes             │
│ - Deduplicated (ocean tiles stored  │
│   once, referenced multiple times)  │
└─────────────────────────────────────┘
```

**Reading tiles**:

```typescript
import { PMTiles } from 'pmtiles';

// Can read from URL with range requests, or from local blob
const archive = new PMTiles('https://example.com/trail.pmtiles');

// Get a single tile
const tile = await archive.getZxy(12, 1234, 2345);
// Returns: { data: ArrayBuffer }
```

**Generating PMTiles**:

Option 1: From existing tiles (fetch and package)

```bash
# Using pmtiles CLI
pmtiles convert tiles/{z}/{x}/{y}.png output.pmtiles
```

Option 2: Render from vector data

```bash
# Using tilemaker to render OSM data
tilemaker --input australia.osm.pbf --output australia.mbtiles --config hiking.json

# Convert to PMTiles
pmtiles convert australia.mbtiles australia.pmtiles
```

Option 3: Extract from hosted PMTiles

```bash
# Extract a bounding box from a larger archive
pmtiles extract planet.pmtiles heysen.pmtiles --bbox=138.2,-35.9,139.1,-34.5
```

### B. Capacitor Storage APIs

**Filesystem Plugin**:

```typescript
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// Write a file (persistent, never evicted)
await Filesystem.writeFile({
  path: 'trails/heysen.json',
  data: JSON.stringify(trailData),
  directory: Directory.Data,
  encoding: Encoding.UTF8,
});

// Read a file
const result = await Filesystem.readFile({
  path: 'trails/heysen.json',
  directory: Directory.Data,
  encoding: Encoding.UTF8,
});
const data = JSON.parse(result.data);

// Write binary (tiles)
await Filesystem.writeFile({
  path: 'tiles/12/1234/2345.png',
  data: base64EncodedPng,
  directory: Directory.Data,
});

// List files
const files = await Filesystem.readdir({
  path: 'tiles/12/1234',
  directory: Directory.Data,
});
```

**SQLite Plugin** (for large datasets):

```typescript
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';

const sqlite = new SQLiteConnection(CapacitorSQLite);
const db = await sqlite.createConnection('trails', false, 'no-encryption', 1);
await db.open();

// Store tiles as blobs
await db.execute(`
  CREATE TABLE IF NOT EXISTS tiles (
    z INTEGER,
    x INTEGER,
    y INTEGER,
    data BLOB,
    PRIMARY KEY (z, x, y)
  )
`);

// Insert tile
await db.run(
  'INSERT OR REPLACE INTO tiles (z, x, y, data) VALUES (?, ?, ?, ?)',
  [12, 1234, 2345, tileBlob]
);

// Retrieve tile
const result = await db.query(
  'SELECT data FROM tiles WHERE z = ? AND x = ? AND y = ?',
  [12, 1234, 2345]
);
```

### C. React Native Offline Maps with MapLibre

```typescript
import MapLibreGL from '@maplibre/maplibre-react-native';

// Component
function TrailMap({ trail }) {
  useEffect(() => {
    // Download offline region
    MapLibreGL.offlineManager.createPack(
      {
        name: trail.id,
        styleURL: 'https://tiles.example.com/style.json',
        bounds: trail.bounds,
        minZoom: 8,
        maxZoom: 14,
      },
      (pack, status) => {
        if (status.percentage === 100) {
          console.log('Download complete');
        }
      },
      (pack, error) => {
        console.error('Download error:', error);
      }
    );
  }, [trail.id]);

  return (
    <MapLibreGL.MapView style={{ flex: 1 }}>
      <MapLibreGL.Camera
        centerCoordinate={trail.center}
        zoomLevel={10}
      />
      <MapLibreGL.ShapeSource id="trail" shape={trail.geojson}>
        <MapLibreGL.LineLayer
          id="trailLine"
          style={{ lineColor: '#ff0000', lineWidth: 3 }}
        />
      </MapLibreGL.ShapeSource>
    </MapLibreGL.MapView>
  );
}
```

### D. iOS Cache Eviction Technical Details

iOS uses a "last used" eviction policy for web content:

1. **WebKit decides**: No developer control over eviction
2. **Triggers**: Low disk space, 7 days unused, OS updates
3. **Order**: Least recently used origins evicted first
4. **Scope**: Per-origin (your whole site, not individual caches)

**What counts as "use"**:

- User visits any page on your origin in Safari ✅
- User opens PWA from home screen ✅
- Service worker runs in background ❌
- Push notification received ❌

**Storage inspection** (Safari Web Inspector):

1. Open Safari > Develop > [Device] > [Website]
2. Go to Storage tab
3. See Cache Storage, IndexedDB, Local Storage sizes
4. Note: Cannot see when eviction will occur

**Testing eviction** (difficult):

- Fill device storage with large files
- Wait 7+ days without visiting site
- Change device date forward (may trigger)
- No reliable programmatic simulation
