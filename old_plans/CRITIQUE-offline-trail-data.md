# Critique: Offline Trail Data Plan

This critique examines the plan against the actual codebase architecture and considers mobile use cases.

## Codebase Verification Summary

### Verified as Accurate

| Claim | Verification |
|-------|--------------|
| Trail JSON fetched at runtime | Confirmed: [trail-viewer.ts:415](src/web/trails/trail-viewer.ts#L415) fetches `/data/generated/${trailId}.json` |
| Leaflet 1.9.4 from unpkg CDN | Confirmed: [trail-template.html:8-9](src/web/trails/trail-template.html#L8-L9) with SRI hashes |
| Chart.js 4.4.1 from cdnjs | Confirmed in climate-template.html |
| OpenTopoMap tiles, maxZoom 17 | Confirmed: [trail-viewer.ts:163-166](src/web/trails/trail-viewer.ts#L163-L166) |
| Custom emoji markers (no external images) | Confirmed: [trail-viewer.ts:84-97](src/web/trails/trail-viewer.ts#L84-L97) uses `L.divIcon` |
| No existing SW or manifest | Confirmed: searched entire codebase |
| No external fonts/analytics | Confirmed: only external requests are CDN libs and tiles |

### Architecture Strengths for Offline Support

The codebase is unusually well-suited for offline support:

1. **No server APIs required at runtime** - Trail viewer is purely static after initial load
2. **All processing is client-side** - Elevation profiles, waypoint rendering, exports all happen in browser
3. **No external fonts** - Uses system fonts only
4. **No analytics/tracking** - No third-party scripts to block
5. **Emoji-based markers** - No image assets to cache for map icons

## Critical Issues

### 1. iOS Safari Cache Eviction (Severity: Critical)

**The Problem**: iOS Safari evicts service worker caches after approximately 7 days of non-use, and sometimes sooner. This is catastrophic for the hiking use case where someone might:

1. Download trail data on home wifi
2. Drive to trailhead a week later
3. Find the cache empty with no cellular signal

**What the Plan Gets Wrong**: The storage management section only mentions Chrome's generous quota and `navigator.storage.estimate()`. Neither is relevant to iOS Safari's aggressive eviction.

**Recommended Additions**:

```typescript
// Check cache freshness on load
async function checkCacheHealth(trailId: string): Promise<CacheStatus> {
  const cache = await caches.open('trail-data-v1');
  const response = await cache.match(`/data/generated/${trailId}.json`);

  if (!response) return { status: 'not-cached' };

  const cacheDate = response.headers.get('sw-cache-date');
  const ageInDays = (Date.now() - new Date(cacheDate).getTime()) / (1000 * 60 * 60 * 24);

  if (ageInDays > 5) {
    return { status: 'stale', message: 'Cache may expire soon - refresh recommended' };
  }

  return { status: 'fresh', ageInDays };
}
```

**Also consider**:
- Store critical trail JSON in IndexedDB as a backup (different eviction behavior)
- Prominent warning: "Last saved 6 days ago - iOS may delete this cache"
- Automatic refresh prompt when cache is >5 days old

### 2. Bounding Box vs Corridor Approach (Severity: High)

For long trails like the Heysen (1099 km running roughly north-south), a bounding box approach would download enormous amounts of irrelevant tiles. The plan correctly identifies corridor-based caching, but the implementation details need emphasis.

**Tile Count Comparison for Heysen Trail**:

| Approach | Zoom 8-14 Tiles | Estimated Size |
|----------|-----------------|----------------|
| Bounding box | ~150,000 | ~2+ GB |
| 10 km corridor | ~40,000 | ~600 MB |
| 5 km corridor | ~25,000 | ~350 MB |
| 3 km corridor | ~18,000 | ~250 MB |

The corridor algorithm should:
1. Sample track points (every 500m is sufficient)
2. For each zoom level, convert buffer circles to tile coordinates
3. Use a Set to deduplicate overlapping tiles
4. Return tiles sorted by zoom level (download overview first)

### 3. Download Duration is Impractical (Severity: High)

At 4 requests/second with 4 concurrent connections:
- 25,000 tiles = ~104 minutes
- 40,000 tiles = ~167 minutes

**Problems on Mobile**:
- Browser kills background tabs after ~30 seconds
- User will switch apps (check messages, etc.)
- Phone may sleep, stopping downloads
- No Background Fetch API on iOS

**Required Mitigations** (not optional):

1. **Resumable downloads**: Track progress in IndexedDB, skip already-cached tiles
2. **Visual progress that persists**: Even after tab switch, show accurate progress on return
3. **Smaller default scope**: Consider zoom 8-12 as "quick save" (~5 min) vs 8-14 as "full save" (~20+ min)
4. **Session persistence**: Save download state so it survives browser restart

```typescript
interface DownloadSession {
  trailId: string;
  totalTiles: number;
  completedTiles: number;
  tileList: string[];  // URLs remaining
  startedAt: Date;
  lastUpdatedAt: Date;
}

// Persist to IndexedDB, not just memory
```

### 4. Zoom Level Mismatch (Severity: Medium)

The tile layer sets `maxZoom: 17` but the plan caches only to zoom 14. On mobile, users naturally pinch-to-zoom when looking at trail detail. Zooming past level 14 will show blank/missing tiles.

**Solutions**:

Option A: Dynamic maxZoom
```typescript
// When offline, limit zoom to cached levels
if (!navigator.onLine) {
  tileLayer.options.maxZoom = 14;
  map.setMaxZoom(14);
}
```

Option B: Cache zoom 15 with narrow buffer
```typescript
// Zoom 8-14: 5 km buffer
// Zoom 15: 1 km buffer (much smaller tile count)
const tiles = [
  ...calculateCorridorTiles(track, 8, 14, 5),
  ...calculateCorridorTiles(track, 15, 15, 1),
];
```

Option C: Clear UI communication
```
Offline mode: Map detail limited to zoom level 14
```

### 5. No Cache Status UI (Severity: Medium)

The plan describes downloading tiles but users need answers to:
- "Which trails have I saved?"
- "Is this trail's cache still valid?"
- "How much storage am I using?"
- "How do I delete old cached trails?"

Without this, offline support is a black box. Users won't trust it for real hiking trips.

**Minimum Viable Cache UI**:

```
Saved Trails
─────────────────────────────────────
Heysen Trail          ✓ Ready
  Saved 2 days ago • 145 MB • Zoom 8-14
  [Update] [Delete]

Larapinta Trail       ⚠ Stale
  Saved 6 days ago • 89 MB • Zoom 8-14
  May expire soon on iOS - refresh now
  [Refresh] [Delete]

Storage: 234 MB used of ~500 MB available
─────────────────────────────────────
```

## Minor Issues

### 6. Phase Ordering

The plan puts SW implementation before CDN bundling. This means the SW needs logic to cache CDN URLs that will be removed in the next phase.

**Recommendation**: Do Phase 0 (bundle CDN deps) first. It's low risk and simplifies the SW to only cache local assets.

### 7. Service Worker Build Integration

The plan lists options but doesn't decide. For this project's simplicity:

**Recommendation**: Plain JS in `public/sw.js`. The SW logic is straightforward caching - no need for TypeScript. Manually update the asset list when major changes occur, or inject it at build time with a simple script.

### 8. OpenTopoMap Rate Limiting

The plan guesses at rate limits. Before implementing:

1. Check opentopomap.org/about for current policy
2. Consider adding a configurable tile URL so users could point to alternative sources
3. Consider whether heavy download usage could get the app blocked

## What the Plan Gets Right

1. **Phased approach**: Each phase delivers standalone value
2. **Corridor-based tile selection**: Much more efficient than bounding box
3. **Resumable downloads**: Critical for the tile volume involved
4. **Recognition that markers use emoji**: Correctly identifies no external images needed
5. **Network-first for trail data**: Allows updates while still providing offline fallback
6. **IndexedDB consideration for iOS**: Shows awareness of platform limitations

## Mobile-Specific Recommendations

### Essential for Mobile Launch

1. **Touch-friendly download UI**: Large tap targets, clear progress
2. **Offline indicator**: Show when viewing cached vs live data
3. **Cache freshness warnings**: "Saved 6 days ago" prominently displayed
4. **Graceful tile failures**: Gray placeholder, not broken image icons

### Nice to Have

1. **Wake lock during download**: Prevent screen sleep (Chrome Android only)
2. **Share target**: Register as share target for GPX files
3. **Offline-first architecture**: Check cache before network, not after timeout

### iOS-Specific

1. **Add to Home Screen prompt**: Better PWA experience than Safari tabs
2. **Explicit cache refresh button**: Since auto-refresh may not happen
3. **Smaller default tile scope**: iOS storage limits are tighter
4. **Clear communication**: "iOS may delete cached data after 7 days of not using this app"

## Summary

The plan is solid architecturally but underestimates mobile platform constraints, particularly iOS. The three critical additions needed are:

1. **iOS cache eviction handling** - This will break the core use case if not addressed
2. **Resumable downloads with persistence** - Multi-hour downloads won't survive tab switches
3. **Cache management UI** - Users need visibility into what's saved

With these additions, the offline feature would be genuinely useful for hikers rather than a demo that fails in the field.
