# Plan: Offline Trail Data Support (PWA)

## Goal

Enable trail viewer pages to work fully offline, allowing hikers to save trail data and maps before heading into areas without cellular coverage.

## Current Architecture Analysis

### Runtime Dependencies

The trail viewer ([trail-viewer.ts](src/web/trails/trail-viewer.ts)) currently requires network access for:

1. **CDN Libraries**
   - Leaflet 1.9.4 from unpkg (~40 KB gzipped)
   - Chart.js 4.4.1 from cdnjs (~65 KB gzipped) - climate pages only

2. **Map Tiles**
   - OpenTopoMap tiles from `https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png`
   - Max zoom: 17 (configured in trail-viewer.ts:163)
   - Typical tile size: 10-20 KB each

3. **Trail Data JSON**
   - Fetched from `/data/generated/{trailId}.json`
   - Contains: track points, waypoints, alternates, side trips, climate data
   - Size varies: 500 KB - 5 MB depending on trail length

### What Already Works Offline

Once loaded, these work without network:
- All UI rendering and interactions
- Elevation profile (Chart.js renders to canvas client-side)
- Waypoint tables and filtering
- Direction reversal (NOBO/SOBO)
- GPX/CSV export functionality
- All TypeScript application logic

### Current State

- No service worker exists
- No PWA manifest exists
- No offline fallback UI
- Markers use emoji via `L.divIcon` (no external icon images needed)
- No external fonts, analytics, or tracking scripts

## Estimated Tile Storage Requirements

Using corridor-based caching (5 km buffer around track) rather than bounding box. Bounding box approach would be 2-5x larger for long trails.

| Trail | Length | Zoom 8-14 (corridor) | Zoom 8-15 (corridor) |
|-------|--------|----------------------|----------------------|
| Short (~100 km) | ~20-40 MB | ~60-100 MB |
| Medium (~300 km) | ~60-120 MB | ~150-300 MB |
| Heysen (1099 km) | ~150-300 MB | ~400-800 MB |

**Corridor vs Bounding Box for Heysen (1099 km north-south trail)**:
| Approach | Zoom 8-14 Tiles | Estimated Size |
|----------|-----------------|----------------|
| Bounding box | ~150,000 | ~2+ GB |
| 5 km corridor | ~25,000 | ~350 MB |
| 3 km corridor | ~18,000 | ~250 MB |

## Implementation Plan

### Phase 0: Bundle CDN Dependencies (Do First)

**Rationale**: Simplifies service worker by eliminating CDN caching logic entirely. Low risk, should be done before SW work.

**Changes**:

1. Install Leaflet and Chart.js as npm dependencies:
   ```bash
   npm install leaflet chart.js
   ```

2. Update [trail-template.html](src/web/trails/trail-template.html):
   - Remove CDN `<script>` and `<link>` tags for Leaflet
   - Import Leaflet CSS in trail-viewer.ts or via Vite

3. Update [trail-viewer.ts](src/web/trails/trail-viewer.ts):
   ```typescript
   import L from 'leaflet';
   import 'leaflet/dist/leaflet.css';
   ```

4. Update climate-template.html similarly for Chart.js

5. Verify Vite bundles and tree-shakes correctly

**Risk**: Low. Standard npm bundling.

### Phase 1: Basic PWA Infrastructure

**Goal**: App shell caches so the page loads offline (map tiles still require network).

**Files to Create**:

1. `public/manifest.json`:
   ```json
   {
     "name": "GPX Trail Viewer",
     "short_name": "Trails",
     "start_url": "/",
     "display": "standalone",
     "background_color": "#ffffff",
     "theme_color": "#2d5a27",
     "icons": [
       { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
       { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" }
     ]
   }
   ```

2. `public/sw.js` (plain JS - decision made for simplicity):
   ```javascript
   const CACHE_NAME = 'gpx-tools-v1';
   const APP_SHELL = [
     '/',
     '/styles.css',
     // Vite-generated bundles - inject at build time or maintain manually
   ];

   self.addEventListener('install', (event) => {
     event.waitUntil(
       caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL))
     );
   });

   self.addEventListener('fetch', (event) => {
     // Network-first for trail data JSON (may update)
     // Cache-first for app shell and bundled assets
     // Special handling for tile requests (Phase 3)
   });
   ```

3. Update HTML templates to:
   - Add `<link rel="manifest" href="/manifest.json">`
   - Add iOS meta tags:
     ```html
     <meta name="apple-mobile-web-app-capable" content="yes">
     <meta name="apple-mobile-web-app-status-bar-style" content="default">
     <link rel="apple-touch-icon" href="/icons/icon-192.png">
     ```
   - Register service worker on load

**Caching Strategy**:
- **App shell**: Cache on install, serve cache-first
- **Trail JSON**: Network-first with cache fallback
- **Vite assets**: Cache-first (content-hashed filenames)

### Phase 2: Trail Data Pre-caching with iOS Resilience

**Goal**: Allow users to explicitly save trail data for offline use, with resilience against iOS cache eviction.

**The iOS Problem**: Safari evicts service worker caches after ~7 days of non-use. A hiker who saves data a week before their trip may find it gone at the trailhead.

**Solution**: Dual storage - Cache API for fast access, IndexedDB as backup.

**Implementation** (`src/lib/offline-storage.ts`):

```typescript
import { openDB, DBSchema } from 'idb';

interface TrailCacheDB extends DBSchema {
  trails: {
    key: string;
    value: {
      trailId: string;
      data: TrailData;
      savedAt: Date;
      version: number;
    };
  };
  downloadSessions: {
    key: string;
    value: DownloadSession;
  };
}

const db = await openDB<TrailCacheDB>('trail-cache', 1, {
  upgrade(db) {
    db.createObjectStore('trails', { keyPath: 'trailId' });
    db.createObjectStore('downloadSessions', { keyPath: 'trailId' });
  },
});

export async function saveTrailOffline(trailId: string, data: TrailData) {
  // Save to both Cache API and IndexedDB
  const cache = await caches.open('trail-data-v1');
  await cache.put(
    `/data/generated/${trailId}.json`,
    new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'sw-cache-date': new Date().toISOString(),
      },
    })
  );

  // IndexedDB backup (survives longer on iOS)
  await db.put('trails', {
    trailId,
    data,
    savedAt: new Date(),
    version: 1,
  });
}

export async function loadTrailOffline(trailId: string): Promise<TrailData | null> {
  // Try Cache API first (faster)
  const cache = await caches.open('trail-data-v1');
  const cached = await cache.match(`/data/generated/${trailId}.json`);
  if (cached) {
    return cached.json();
  }

  // Fall back to IndexedDB
  const stored = await db.get('trails', trailId);
  return stored?.data ?? null;
}

export async function getCacheHealth(trailId: string): Promise<CacheStatus> {
  const stored = await db.get('trails', trailId);
  if (!stored) return { status: 'not-cached' };

  const ageInDays = (Date.now() - stored.savedAt.getTime()) / (1000 * 60 * 60 * 24);

  if (ageInDays > 5) {
    return {
      status: 'stale',
      ageInDays,
      message: 'Cache may expire soon on iOS - refresh recommended',
    };
  }

  return { status: 'fresh', ageInDays };
}
```

**UI Addition** (in trail-viewer.ts):

```typescript
async function renderOfflineButton(trailId: string) {
  const health = await getCacheHealth(trailId);

  if (health.status === 'not-cached') {
    // Show "Save for Offline" button
  } else if (health.status === 'stale') {
    // Show warning with refresh button
    // "Saved 6 days ago - iOS may delete this. Refresh now?"
  } else {
    // Show "Saved for offline" indicator with age
    // "Saved 2 days ago" with option to refresh/delete
  }
}
```

### Phase 3: Map Tile Caching

**Goal**: Download map tiles for offline viewing along the trail corridor.

#### Option A: Runtime Tile Downloads (Traditional Approach)

**Tile Calculation** (`src/lib/tile-calculator.ts`):

```typescript
interface TileBounds {
  tiles: Array<{ z: number; x: number; y: number }>;
  estimatedSize: number;
  tileCount: number;
}

export function calculateCorridorTiles(
  trackPoints: Array<{ lat: number; lon: number }>,
  minZoom: number,
  maxZoom: number,
  bufferKm: number
): TileBounds {
  const tiles = new Set<string>();

  // Sample track points (every 500m is sufficient)
  const sampledPoints = sampleTrackPoints(trackPoints, 500);

  for (let z = minZoom; z <= maxZoom; z++) {
    for (const point of sampledPoints) {
      // Get all tiles within bufferKm of this point at zoom z
      const nearbyTiles = getTilesInRadius(point, bufferKm, z);
      nearbyTiles.forEach(t => tiles.add(`${z}/${t.x}/${t.y}`));
    }
  }

  return {
    tiles: Array.from(tiles).map(parseTileKey),
    estimatedSize: tiles.size * 15000, // ~15 KB average
    tileCount: tiles.size,
  };
}
```

**Download with Resumability and Session Persistence**:

```typescript
interface DownloadSession {
  trailId: string;
  totalTiles: number;
  completedTiles: string[]; // URLs already downloaded
  remainingTiles: string[]; // URLs still needed
  startedAt: Date;
  lastUpdatedAt: Date;
  status: 'in-progress' | 'paused' | 'completed' | 'failed';
}

async function downloadTiles(
  trailId: string,
  tiles: Tile[],
  onProgress: (session: DownloadSession) => void
) {
  // Load or create session
  let session = await db.get('downloadSessions', trailId);
  if (!session) {
    session = {
      trailId,
      totalTiles: tiles.length,
      completedTiles: [],
      remainingTiles: tiles.map(tileUrl),
      startedAt: new Date(),
      lastUpdatedAt: new Date(),
      status: 'in-progress',
    };
    await db.put('downloadSessions', session);
  }

  const cache = await caches.open('map-tiles-v1');
  const CONCURRENCY = 4;
  const DELAY_MS = 250; // ~4 req/sec total

  while (session.remainingTiles.length > 0 && session.status === 'in-progress') {
    const batch = session.remainingTiles.slice(0, CONCURRENCY);

    await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await fetch(url);
          await cache.put(url, response);
          session.completedTiles.push(url);
          session.remainingTiles = session.remainingTiles.filter(u => u !== url);
        } catch (e) {
          // Keep in remaining for retry
          console.warn(`Failed to fetch tile: ${url}`);
        }
      })
    );

    // Persist progress (survives tab close/app switch)
    session.lastUpdatedAt = new Date();
    await db.put('downloadSessions', session);
    onProgress(session);

    await sleep(DELAY_MS);
  }

  session.status = 'completed';
  await db.put('downloadSessions', session);
}

// Resume on page load
async function checkAndResumeDownload(trailId: string) {
  const session = await db.get('downloadSessions', trailId);
  if (session?.status === 'in-progress') {
    // Offer to resume: "Download interrupted. 2,340 of 6,800 tiles saved. Resume?"
  }
}
```

**Dynamic maxZoom for Offline Mode**:

```typescript
function setupOfflineMapBehavior(map: L.Map, tileLayer: L.TileLayer) {
  const maxCachedZoom = 14; // Or detect from cached tiles

  window.addEventListener('online', () => {
    tileLayer.options.maxZoom = 17;
    map.setMaxZoom(17);
  });

  window.addEventListener('offline', () => {
    tileLayer.options.maxZoom = maxCachedZoom;
    map.setMaxZoom(maxCachedZoom);
    if (map.getZoom() > maxCachedZoom) {
      map.setZoom(maxCachedZoom);
    }
    showNotification(`Offline mode: Map detail limited to zoom ${maxCachedZoom}`);
  });
}
```

**Progress UI**:
```
Saving Heysen Trail for offline...
[████████████░░░░░░░░] 2,340 / 6,800 tiles (34%)
Estimated size: 45 MB of ~130 MB

[Pause] [Cancel]

Note: You can leave this page - download will resume when you return.
```

#### Option B: Build-Time Tile Packaging (PMTiles)

**The Problem with Runtime Downloads**:
- 25,000+ tiles = hours of download time
- Mobile browsers kill background tabs
- iOS has no Background Fetch API
- Rate limiting concerns with OpenTopoMap

**PMTiles Solution**:

PMTiles is a cloud-optimized format that packages map tiles into a single file with an index that allows fetching only the tiles you need via HTTP range requests.

**How it works**:

1. **At build time**: Generate a PMTiles file for each trail containing corridor tiles
2. **At runtime**: User downloads single PMTiles file (e.g., `heysen-tiles.pmtiles` ~150 MB)
3. **Viewing**: protomaps-leaflet reads tiles directly from the local file

**Build-time generation** (`scripts/generate-trail-tiles.ts`):

```typescript
import { PMTiles } from 'pmtiles';

async function generateTrailTiles(trailId: string, config: TrailConfig) {
  const track = loadTrackPoints(trailId);
  const corridorBbox = calculateCorridorBbox(track, 5); // 5 km buffer

  // Use tippecanoe or similar to extract tiles from source
  // Or fetch from OpenTopoMap and package (respecting usage policy)

  // Output: public/data/tiles/{trailId}.pmtiles
}
```

**Runtime usage**:

```typescript
import { PMTiles, Protocol } from 'pmtiles';

// Register protocol for Leaflet
const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

// Load from cached file or network
const tiles = new PMTiles('/data/tiles/heysen.pmtiles');

// For offline: save entire file to IndexedDB or Cache API
async function saveTrailTilesOffline(trailId: string) {
  const response = await fetch(`/data/tiles/${trailId}.pmtiles`);
  const blob = await response.blob();
  await db.put('tilePacks', { trailId, blob, savedAt: new Date() });
}
```

**Advantages of PMTiles**:
- Single HTTP request (or single file to cache)
- Resumable with standard HTTP range requests
- No rate limiting concerns (your own hosted files)
- Much simpler offline logic

**Disadvantages**:
- Requires build-time tile generation infrastructure
- Need to source tiles (self-render or pre-fetch with permission)
- Larger upfront storage (entire pack vs on-demand tiles)

**Recommendation**: Start with Option A for MVP, consider PMTiles for v2 if download reliability is poor.

### Phase 4: Cache Management UI

**Goal**: Let users see and manage cached trails with full visibility.

**Location**: `/offline-manager.html` with modal access from trail viewer.

**UI Design**:

```
┌─────────────────────────────────────────────────────────────┐
│  Offline Trail Manager                                       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Storage: 234 MB used of ~500 MB available                  │
│  [████████░░░░░░░░░░░░] 47%                                 │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Heysen Trail                                    ✓ Ready    │
│  ├─ Trail data: 2.3 MB                                      │
│  ├─ Map tiles: 142 MB (zoom 8-14)                          │
│  └─ Saved 2 days ago                                        │
│  [Update] [Delete]                                          │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Larapinta Trail                                ⚠ Stale     │
│  ├─ Trail data: 1.8 MB                                      │
│  ├─ Map tiles: 89 MB (zoom 8-14)                           │
│  └─ Saved 6 days ago                                        │
│  ⚠ May expire soon on iOS - refresh recommended            │
│  [Refresh Now] [Delete]                                     │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Bibbulmun Track                           ⏳ Downloading    │
│  ├─ Trail data: ✓ Saved                                     │
│  ├─ Map tiles: 34% (2,340 / 6,800)                         │
│  └─ Started 12 minutes ago                                  │
│  [Pause] [Cancel]                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Features**:
- List of saved trails with status indicators
- Per-trail storage breakdown (data vs tiles)
- Cache age with iOS eviction warnings
- Download progress for in-progress saves
- Pause/resume/cancel controls
- Delete individual trails
- "Refresh all stale" bulk action
- Storage quota indicator

### Phase 5: Offline Mode Indicator

**Goal**: Clear visual indication when viewing cached vs live data.

**Implementation**:

```typescript
function setupOfflineIndicator() {
  const indicator = document.createElement('div');
  indicator.className = 'offline-indicator';
  document.body.appendChild(indicator);

  function updateIndicator() {
    if (!navigator.onLine) {
      indicator.innerHTML = '📡 Offline - Viewing cached data';
      indicator.classList.add('visible');
    } else {
      indicator.classList.remove('visible');
    }
  }

  window.addEventListener('online', updateIndicator);
  window.addEventListener('offline', updateIndicator);
  updateIndicator();
}
```

**CSS**:
```css
.offline-indicator {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  background: #f59e0b;
  color: white;
  text-align: center;
  padding: 0.5rem;
  transform: translateY(-100%);
  transition: transform 0.3s;
  z-index: 9999;
}

.offline-indicator.visible {
  transform: translateY(0);
}
```

## File Structure

```
public/
  manifest.json          # PWA manifest
  sw.js                  # Service worker (plain JS)
  icons/
    icon-192.png
    icon-512.png

src/
  lib/
    tile-calculator.ts   # Corridor tile calculation
    offline-storage.ts   # Cache management with IndexedDB
  web/
    trails/
      trail-viewer.ts    # Add offline save UI
    offline-manager.html # Cache management page
    offline-manager.ts

# If using PMTiles (Phase 3 Option B):
scripts/
  generate-trail-tiles.ts
public/
  data/
    tiles/
      {trailId}.pmtiles
```

## Dependencies to Add

```json
{
  "dependencies": {
    "leaflet": "^1.9.4",
    "chart.js": "^4.4.1",
    "idb": "^8.0.0"
  }
}
```

Optional for PMTiles:
```json
{
  "dependencies": {
    "pmtiles": "^3.0.0",
    "protomaps-leaflet": "^4.0.0"
  }
}
```

## Success Criteria

1. Trail page loads and displays cached data with airplane mode enabled
2. Map tiles render for the trail corridor at zoom 8-14
3. User can see which trails are saved and their cache status
4. Download can be paused/resumed without losing progress (survives tab close)
5. Works on Chrome Android, Safari iOS, and desktop browsers
6. iOS users see clear warnings about cache expiration
7. Cache size stays within estimated bounds

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| iOS cache eviction | High | High | IndexedDB backup, cache age warnings, prominent refresh prompts |
| OpenTopoMap rate limiting | Medium | Medium | Conservative rate limits, resumable downloads, consider PMTiles |
| Large tile downloads fail | Medium | High | Resumable downloads with IndexedDB persistence |
| User zooms past cached tiles | Medium | Low | Dynamic maxZoom when offline |
| Download interrupted by tab switch | High | Medium | Persist progress to IndexedDB, offer resume on return |

## Open Questions

1. Should we support multiple tile providers (let user choose)?
2. Should we offer "quick save" (zoom 8-12, ~5 min) vs "full save" (zoom 8-14, ~20 min)?
3. How to handle trail data updates for cached trails?
4. Is PMTiles worth the build complexity for v1?
5. Should we auto-refresh stale caches when online, or always require explicit action?
