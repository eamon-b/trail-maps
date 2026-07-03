# Part 4c: Custom Trail Feature Parity

## Goal
Ensure custom trails support the same features as built-in trails: datasheets, offline maps, campsite planner, measure tool, and direction reversal.

After Part 4b, custom trails can be imported and viewed on the map. This part closes the gap so they're first-class citizens in the app.

## Dependencies
- Part 4a: GPX Processing Engine
- Part 4b: Import UI & Custom Trail Storage
- Part 2: Offline Trail Viewer (map display, offline tile infrastructure)
- Part 3: Planning Tools (campsite planner, day calculator)

## Deliverables

### 1. Auto-Generated Datasheet
Generate a travel-plan-style datasheet from processed custom trail data:
- Section-by-section breakdown between waypoints
- Per-section: distance, elevation gain/loss, estimated time
- Cumulative distance and elevation columns
- Resupply point extraction (waypoints classified as "town" or "resupply")
- Summary stats: total distance, total ascent/descent, number of days (at configurable pace)
- View in app using the same datasheet component as built-in trails
- Share as text / export as CSV

### 2. Offline Map Tiles
Enable downloading map tiles for the custom trail corridor:
- Calculate bounding box / corridor from track geometry (existing tile infrastructure from Part 2)
- Use the same tile download pipeline as built-in trails
- Estimate download size before starting
- Download progress indicator
- Storage management: show tile size per custom trail, allow deleting tiles independently

### 3. Campsite Planner
Make the campsite planner work with custom trails:
- Day calculator uses custom trail distance/elevation data
- Campsite suggestions based on waypoints classified as "campsite" or "shelter"
- If no campsites in GPX, planner works with distance-only mode (camp at X km intervals)
- Resupply planning using "town" waypoints

### 4. Measure Tool
- Distance measurement between any two points on custom trail
- Elevation profile for selected segment
- Same interaction as built-in trails (tap start/end points)

### 5. Direction Reversal
- Reverse the custom trail direction (swap start/end)
- Recalculate all cumulative distances and elevations
- Update waypoint km positions
- Persist reversed state (or re-reverse to restore original)

### 6. Elevation Profile
- Full elevation profile display using existing `ElevationProfileDrawer`
- Interactive: tap to see elevation at point, distance from start
- Handle custom trails with missing elevation data gracefully (show distance-only profile or "no elevation data" message)

## Testing Strategy

### Unit Tests
- Datasheet generation: verify stats match manual calculation for test trails
- Direction reversal: verify distances recalculate correctly
- Tile corridor calculation: verify bounding box is reasonable

### Integration Tests
- Import a GPX → generate datasheet → verify all sections present
- Import a GPX → download offline tiles → go offline → verify map loads
- Import a GPX → open campsite planner → verify day suggestions

### Maestro UI Tests
- `custom-trail-datasheet.yaml`: Import trail, open datasheet, verify sections
- `custom-trail-offline.yaml`: Import trail, download tiles, verify offline usage
- `custom-trail-planner.yaml`: Import trail, open campsite planner, create a plan

## Success Criteria
- Custom trails have working datasheets with accurate stats
- Can download offline tiles for any custom trail corridor
- Campsite planner produces reasonable day plans for custom trails
- Measure tool works on custom trails
- Can reverse a custom trail and all stats update correctly
- Features work the same whether the trail is built-in or custom

## Notes
- Most of these features should "just work" if Part 4b stores custom trails in the same data structures as built-in trails. The main work is verifying and fixing any gaps.
- The datasheet is the highest-value feature here — it's the main reason users import GPX files (to get distance/elevation breakdowns they can plan from).
- Offline tiles for custom trails could use significant storage. Consider warning users about download size and providing per-trail tile management.
- OSM POI Enrichment remains deferred to v2. If a custom trail has no waypoints, features that depend on waypoints (campsite planner, resupply planning) will have limited utility but should still be accessible with distance-based fallbacks.
