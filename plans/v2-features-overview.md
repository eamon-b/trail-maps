# Trail Companion App - v2.0 Features Overview

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

This document consolidates all features deferred to v2.0, providing a roadmap for post-launch development.

## Why These Features Are Deferred

The v1.0 release focuses on the **core differentiating value**: the multi-day campsite planner and offline trail viewing. Features deferred to v2.0 fall into these categories:

| Category | Features | Reason |
|----------|----------|--------|
| **Existing solutions** | Track recording, photos, journal, weather | Watches, camera apps, weather apps already do this well |
| **Backend required** | Community features, trip sharing | Significant infrastructure and operational overhead |
| **Scope risk** | OSM POI enrichment | Complexity vs value; focus on user-provided waypoints first |

---

## v2.0 Feature Summary

### Part 5b: On-Trail Extras
**Source:** [part-5-on-trail-features.md](./part-5-on-trail-features.md)

| Feature | Description | Complexity | Notes |
|---------|-------------|------------|-------|
| Track Recording | Record actual hike as GPX | Medium | iOS "Always" location permission required |
| Navigation Bearing | Bearing/distance to next waypoint | Low | Useful when trail is unclear |
| Photo Waypoints | Geo-tagged photos at trail positions | Medium | Storage/sync complexity |
| Journal/Notes | Per-day or per-position notes | Low | Users have notes apps |
| Real-Time Weather | Current conditions and forecasts | Medium | Open-Meteo integration; users have weather apps |

**Key consideration:** Track recording requires iOS "Always" location permission, which Apple scrutinizes heavily. Plan for App Store review justification.

---

### Part 6: Community Features
**Source:** [part-6-community-features.md](./part-6-community-features.md)

| Feature | Description | Complexity | Notes |
|---------|-------------|------------|-------|
| User Accounts | Authentication, profiles | Medium | Supabase or Firebase recommended |
| Trail Condition Reports | Crowdsourced closures, hazards | Medium | Requires moderation |
| Waypoint Updates | User corrections and additions | Medium | Requires moderation |
| Comments on Waypoints | Tips, reviews, warnings | Low | Spam prevention needed |
| Photo Contributions | User-uploaded trail photos | Medium | Storage costs, moderation |
| Campsite Ratings | Star ratings and reviews | Low | Helpful for planning |
| Moderation System | Approve/reject workflow | High | Operational overhead |

**Phased implementation recommended:**
1. Phase 6a: Feedback via email (no backend)
2. Phase 6b: Simple backend with condition reports
3. Phase 6c: Full community features

---

### Part 7: Trip Sharing
**Source:** [part-7-trip-sharing.md](./part-7-trip-sharing.md)

| Feature | Description | Complexity | Notes |
|---------|-------------|------------|-------|
| Emergency Contacts | Store contact information | Low | Local storage only |
| Trip Plan Sharing | Share itinerary via email/SMS/PDF | Low | Could be v1.x feature |
| Progress Visibility | Contacts see hiker's location | High | Backend required |
| "I'm Here" Pings | Manual location sharing | Medium | Privacy-conscious design |
| Check-in Reminders | Notifications to send updates | Low | Local notifications |
| Overdue Alerts | Notify contacts if check-in missed | High | False positive risk |

**Note:** Basic plan export (PDF/text) could be added to v1.x as lightweight feature without backend.

---

### Part 4 Deferred: OSM POI Enrichment
**Source:** [part-4-custom-trails.md](./part-4-custom-trails.md)

| Feature | Description | Complexity | Notes |
|---------|-------------|------------|-------|
| OSM POI Enrichment | Auto-add water sources, shelters from OpenStreetMap | Medium | Complexity vs value for v1.0 |

**Rationale:** Focus on processing user-provided waypoints well first. If users have minimal waypoints, they can add them manually or we can add OSM enrichment later.

---

## Implementation Priority for v2.0

### High Priority (v2.1)
1. **Track Recording** - Most requested feature for hiking apps
2. **Basic Trip Plan Export** - PDF export of day plan (no backend)
3. **Photo Waypoints** - Visual documentation of hikes

### Medium Priority (v2.2)
4. **Community Phase 6a** - Email-based feedback (no backend)
5. **Real-Time Weather** - Open-Meteo integration
6. **Navigation Bearing** - Helpful for unclear trails

### Lower Priority (v2.3+)
7. **Community Phase 6b/6c** - Full backend and moderation
8. **Trip Sharing with Progress** - Backend for location sharing
9. **OSM POI Enrichment** - Auto-add waypoints from OSM

---

## Technical Considerations for v2.0

### Backend Infrastructure
If implementing Parts 6 and 7, consider shared backend:
- **Recommended:** Supabase (PostgreSQL, auth, storage, realtime)
- **Alternative:** Firebase (if vendor lock-in acceptable)
- **Custom:** Only if data residency is critical

### iOS App Store Considerations
- Track recording (Part 5b) requires "Always" location permission
- Prepare justification for App Store review
- Consider "Record while app open" as simpler initial implementation

### Battery Life
All Part 5b features impact battery life:
- Track recording: continuous GPS
- Weather: network requests
- Photos: camera + storage

Design with power consumption in mind.

---

## Success Metrics for v2.0

Before implementing v2.0 features, establish:
1. **User demand signals** from v1.0 feedback
2. **Resource availability** for backend maintenance
3. **Moderation capacity** for community features

Don't build features users haven't asked for.
