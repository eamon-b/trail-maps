# Part 5: On-Trail Features

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

## Goal
Add the features that make the app most useful while actively hiking.

## Version Scope

| Section | Features | Version | Rationale |
|---------|----------|---------|-----------|
| **Part 5a** | Off-trail alerts, Sunrise/sunset, Today's progress | **v1.0** | Safety-critical, differentiating, low complexity |
| **Part 5b** | Track recording, Navigation bearing, Photos, Journal, Weather | **v2.0** | Nice-to-have; existing solutions available (watches, camera apps, weather apps) |

---

## Part 5a: On-Trail Safety Features (v1.0)

These features are included in v1.0 because they are safety-critical and differentiate the app.

### 1. Off-Trail Alerts (v1.0)
Implement the tiered alert system (uses visual components from Part 1):
- **On trail (< 50m)**: Green location bar, "On trail — km X.X"
- **Drifting (50-200m)**: Neutral bar showing distance from trail
- **Warning (200-500m)**: Amber bar, single haptic pulse
- **Off trail (> 500m)**: Red banner slides down, shows bearing to nearest trail point

**User-configurable options:**
- Enable/disable alerts entirely
- Adjust distance thresholds (presets: Tight/Normal/Loose)
- Enable/disable haptic feedback
- Optional audible alert (off by default)
- **"Snooze" button**: Temporarily disable for 15/30/60 minutes (for known detours)

Minimize false positives:
- Debounce alerts (require sustained deviation, not momentary GPS drift)
- Account for GPS accuracy (suppress alerts when accuracy is low)
- Smart handling of trail variants and side trips (don't alert on known alternates)

### 2. Sunrise/Sunset Timer (v1.0)
Port daylight calculation from `gpx-tools`:
- Show current sunrise/sunset times for position
- "Sunset in Xh Xm" countdown
- "Sunrise at HH:MM" for morning starts
- Update as position changes along trail
- Handle southern hemisphere (Australia) correctly
- Account for daylight saving time changes during hike
- Consider civil/nautical twilight options

### 3. Today's Progress View (v1.0)
Enhanced today view in Hike mode:
- Current plan for today (if set in Part 3)
- Distance remaining to day's destination
- Progress bar for day
- Estimated arrival time
- Waypoints remaining today
- "No plan" mode for flexible hikers
- **WaterCountdown component** (already built in `mobile/src/components/WaterCountdown.tsx`) — integrate as "Next water: X.X km" indicator with color-coded urgency

---

## Part 5b: On-Trail Extras (v2.0 - DEFERRED)

**These features are deferred to v2.0.** They are nice-to-have but not essential for v1.0:
- **Track recording**: Watches and phones already have excellent track recording. Not differentiating.
- **Photo waypoints**: Users have camera apps. Storage/sync complexity.
- **Journal/notes**: Users have notes apps. Not differentiating.
- **Real-time weather**: Weather apps exist. Climate data for planning is sufficient.
- **Navigation bearing**: Lower priority, can be added later.

### Engineering Note for v2.0
When implementing Part 5b, be aware of:
- iOS "Always" location permission requirements for background track recording
- App Store scrutiny for location-based features
- Battery life impact of continuous GPS recording
- Photo storage and sync complexity

---

### 1. Track Recording (v2.0)
- Record actual hiking track as GPX
- **iOS considerations:**
  - Requires "Always" location permission for true background recording
  - Apple scrutinizes apps requesting this—prepare justification
  - Consider "Record while app open" as initial implementation
  - Plan for App Store review requirements
- Configurable recording interval (balance detail vs battery)
- Pause/resume recording
- Auto-recovery if phone restarts or app crashes mid-hike
- View recorded track overlaid on planned route
- Compare planned vs actual (deviation analysis)
- Export recorded track as GPX
- Share with others

### 2. Navigation Bearing (v2.0)
- Show bearing to next waypoint or selected point
- Format: "Next waypoint is 2.3km at bearing 247° (WSW)"
- Compass visualization (optional)
- Useful when trail is unclear or markers missing
- Helps confirm you're heading the right direction

### 3. Photo Waypoints (v2.0)
- Take photo from within app
- Auto geo-tag with current GPS position
- Associate with trail position (km marker)
- Add caption/notes
- View photos on map at their locations
- Photo gallery for trip
- **Storage considerations:**
  - Compress photos to reasonable size
  - Storage quota management with cleanup options
  - Local storage only (no cloud sync in v1)
- Optionally contribute to community (Part 6)

### 4. Journal/Notes (v2.0)
- Per-day or per-position notes
- Quick entry interface (one tap to start typing)
- Notes tied to trail position and/or date
- View notes on map or in chronological list
- Search notes
- Export notes

### 5. Real-Time Weather (v2.0)
Integrate weather API for current conditions and forecasts:
- **Open-Meteo as primary** (free, no API key required, works internationally)
- *Note: BOM has no public API; do not rely on it*

Display:
- Current conditions at position
- Forecast for next few days
- Severe weather alerts
- Weather icon in status area
- Detailed view with hourly forecast

Caching:
- Cache aggressively (weather updates hourly at most)
- Cache last weather fetch for offline viewing
- Show "Last updated X hours ago" when offline
- Graceful "Weather unavailable" when offline with no cache

## Success Criteria

### v1.0 (Part 5a)
- Off-trail alerts work reliably without excessive false positives
- Sunrise/sunset times are accurate for current position
- Today's progress view shows accurate plan vs actual status
- All features work with minimal battery impact

### v2.0 (Part 5b)
- Track recording works in background for full hiking day
- Photos are correctly geo-tagged and viewable on map
- Weather shows current conditions when online

## Dependencies
- Part 0: Foundation & Project Setup
- Part 1: Design System & UX Foundation
- Part 2: Offline Trail Viewer (GPS, map)
- Part 3: Planning Tools (today's plan integration)

## Notes
- Battery life is a critical concern for all these features
- Background tracking needs careful testing on both iOS and Android
- Off-trail alert thresholds may need tuning based on real-world testing
- Weather API may have rate limits to consider

