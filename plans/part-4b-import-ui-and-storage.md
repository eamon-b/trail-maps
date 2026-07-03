# Part 4b: Import UI & Custom Trail Storage

## Goal
Provide the user-facing interface for importing GPX files and managing custom trails. This connects the processing engine (Part 4a) to the app's UI and persistence layer.

## Dependencies
- Part 4a: GPX Processing Engine (provides `processGpx()`)
- Part 1: Design System & UX Foundation (design tokens, components)
- Part 2: Offline Trail Viewer (map display for preview)

## Deliverables

### 1. GPX File Picker
- File picker using `expo-document-picker` for GPX files
  - Device storage
  - Cloud drives (iCloud, Google Drive — handled by OS file picker)
- URL import option: paste a URL, app fetches the GPX
- Validate file before processing:
  - Check file extension (.gpx)
  - Check file size (<50MB)
  - Quick-check first bytes for XML declaration

### 2. Processing Progress UI
- Modal/sheet that shows processing stages:
  - "Parsing GPX..." → "Analyzing track..." → "Matching waypoints..." → "Done"
- Progress bar driven by `onProgress` callback from Part 4a
- Cancel button (aborts background processing)
- Error display if processing fails, with actionable message from Part 4a

### 3. Import Preview
Before saving, show the user what was extracted:
- Trail on map (use existing `TrailMap` component)
- Basic stats: distance, elevation gain/loss, number of waypoints
- List of detected waypoints with types
- List of warnings/issues from processing (e.g., "No elevation data found", "2 track gaps detected")
- "Import" and "Cancel" buttons
- Trail name field (pre-filled from GPX metadata, editable)

### 4. Custom Trail Storage

**SQLite Schema Extension**
Add to existing schema or create new table:
- `custom_trails` table: id, name, description, created_at, updated_at, source_filename, processing_warnings
- `custom_trail_tracks` table: trail_id, track_points (JSON blob or separate points table)
- `custom_trail_waypoints` table: trail_id, name, type, lat, lon, elevation, km_from_start, description

Or alternatively, extend the existing `trails` and `waypoints` tables with an `is_custom` flag — evaluate which approach fits the existing schema better.

**Storage Operations**
- Save processed trail to SQLite
- Store simplified track geometry for map display
- Store full-resolution track for elevation profile
- Load custom trail by ID (same interface as built-in trails)
- Delete custom trail (with confirmation)
- Update trail metadata (name, description)

### 5. Custom Trails in Trail List
- Custom trails appear in the Plan tab trail list alongside built-in trails
- Visual indicator distinguishing custom from built-in (e.g., small badge or different section)
- "Import Trail" button/card at top or bottom of trail list
- Custom trails sorted by most recently imported
- Swipe-to-delete or long-press menu for management

### 6. Trail Management
- Edit trail name and description after import
- Delete custom trail (confirmation dialog, removes all associated data)
- Re-import: option to re-process from original GPX (if file still available)
- Storage usage indicator (how much space custom trails use)

### 7. Error Handling & User Feedback
User-facing error handling (complements Part 4a's processing errors):
- File picker errors (permission denied, file not found)
- Network errors for URL import
- Processing errors displayed with plain-language explanations
- Suggestions for common issues:
  - "This file has no track data. Make sure you're exporting tracks, not just waypoints."
  - "This file is very large (45MB). Processing may take a minute."
  - "No elevation data found. Distance stats will still work, but elevation profiles won't be available."
- Toast/snackbar for successful import

## Testing Strategy

### Unit Tests
- SQLite storage: save, load, delete, update operations
- Schema migration (if extending existing tables)
- Trail list integration: custom trails appear correctly

### Integration Tests
- Full flow: pick file → process → preview → save → appears in list → open → displays correctly
- Error flows: invalid file, cancelled processing, storage full

### Maestro UI Tests
- `import-gpx-flow.yaml`: Pick a test GPX file, verify processing screen, verify preview, complete import
- `manage-custom-trail.yaml`: Open custom trail, edit name, delete trail
- `import-error-flow.yaml`: Try importing an invalid file, verify error message

## Success Criteria
- Can import a GPX file in under 3 taps (pick file → preview → import)
- Custom trails persist across app restarts
- Custom trails appear in trail list and open the same way as built-in trails
- Deleting a custom trail fully cleans up all associated data
- Processing errors produce helpful, non-technical messages
- Import flow feels responsive (progress feedback, no frozen screens)

## Notes
- The import flow does NOT need to work offline for v1 (URL import needs network; file picker works offline)
- Focus on the happy path first: well-formed GPX from popular apps
- The preview screen is important — users need to verify the import looks right before committing
- Consider whether custom trails should use the exact same data structures as built-in trails or have their own. Using the same structures means all existing viewers/tools work automatically; using different structures allows for custom-trail-specific features but requires more adaptation.
