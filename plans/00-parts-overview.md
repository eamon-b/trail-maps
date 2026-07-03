# Trail Companion App - Parts Overview

This document provides an overview of all implementation parts for the Trail Companion App. Each part has its own detailed file in this directory.

## Version Scope

### v1.0 Scope
Parts 0-4 + 5a form the complete v1.0 release. This delivers:
- Offline trail viewing with GPS tracking
- The "killer feature" multi-day campsite planner
- Custom GPX upload support
- Essential safety features (off-trail alerts, sunrise/sunset)

### v2.0 Scope (Deferred)
Parts 5b, 6, and 7 are explicitly deferred to v2.0:
- **Part 5b**: Track recording, photos, journal, weather (nice-to-have, not differentiating)
- **Part 6**: Community features (requires backend infrastructure)
- **Part 7**: Trip sharing & emergency contacts (optional enhancement)

See [v2-features-overview.md](./v2-features-overview.md) for consolidated v2.0 planning.

---

## Part Summary

| Part | Name | Version | Description | Dependencies |
|------|------|---------|-------------|--------------|
| 0 | Foundation | **v1.0** | MapLibre spike (decision gate), React Native setup, shared libraries, data architecture | None |
| 1 | Design System | **v1.0** | UI components, design tokens, dark mode, interaction patterns | Part 0 |
| 2 | Offline Viewer | **v1.0** | MapLibre, offline tiles (Protomaps), GPS, distance calculations | Part 0 (build with Part 1) |
| 3 | Planning Tools | **v1.0** | Campsite planner, resupply, water carry, measure tool | Parts 0, 1, 2 |
| 4 | Custom Trails | **v1.0** | GPX upload, client-side processing, auto-datasheets | Parts 0, 1, 2, 3 |
| 5a | On-Trail Safety | **v1.0** | Off-trail alerts, sunrise/sunset, today's progress | Parts 0, 1, 2, 3 |
| 5b | On-Trail Extras | **v2.0** | Track recording, photos, journal, weather | Parts 0, 1, 2, 3 |
| 6 | Community | **v2.0** | Backend, user accounts, crowdsourced updates, moderation | Parts 0, 1, 2, 5 |
| 7 | Trip Sharing | **v2.0** | Emergency contacts, plan sharing, progress visibility | Parts 0, 3, 5 |

## Dependency Graph

```
                    v1.0 SCOPE
┌─────────────────────────────────────────────┐
│                                             │
│  Part 0: Foundation                         │
│      │                                      │
│      ▼                                      │
│  Part 1: Design System                      │
│      │                                      │
│      ▼                                      │
│  Part 2: Offline Viewer                     │
│      │                                      │
│      ├──────────────────┐                   │
│      ▼                  ▼                   │
│  Part 3: Planning    Part 5a: On-Trail      │
│      │               Safety                 │
│      ▼                                      │
│  Part 4: Custom Trails                      │
│                                             │
└─────────────────────────────────────────────┘
                       │
                       │ v2.0 SCOPE
                       ▼
┌─────────────────────────────────────────────┐
│                                             │
│  Part 5b: On-Trail Extras                   │
│  Part 6: Community Features                 │
│  Part 7: Trip Sharing                       │
│                                             │
└─────────────────────────────────────────────┘
```

## Recommended Implementation Order

### v1.0 Release

1. **Part 0: Foundation** - Must be first; includes MapLibre spike (decision gate)
2. **Parts 1 + 2: Design System & Offline Viewer** - Build iteratively together
   - Core design tokens and components from Part 1
   - Map integration from Part 2
   - Remaining UI components informed by real data shapes
3. **Part 3: Planning Tools** - The "killer feature" differentiator
4. **Part 4: Custom Trails** - Extends value to any GPX file
5. **Part 5a: On-Trail Safety Features** - Off-trail alerts, sunrise/sunset, today's progress

### v2.0 Release (Deferred)

6. **Part 5b: On-Trail Extras** - Track recording, photos, journal, weather
7. **Part 6: Community Features** - Major scope increase (backend required)
8. **Part 7: Trip Sharing** - Emergency contacts, progress visibility

## v1.0 Release Milestone

The complete v1.0 release consists of **Parts 0-4 + 5a**:
- Working React Native app with offline capability
- Offline trail viewing with GPS tracking
- **Multi-day campsite planner** (the killer feature)
- Resupply and water carry planning
- Custom GPX upload with auto-generated datasheets
- Off-trail safety alerts
- Sunrise/sunset timer
- Today's progress tracking

This delivers the core differentiating value. Features explicitly **NOT in v1.0**:
- Track recording (use your watch/phone's built-in recorder)
- Photo waypoints (use your camera app)
- Journal/notes (use your notes app)
- Real-time weather (use weather apps)
- Community features (no backend infrastructure)
- Trip sharing with emergency contacts

## Part Files

### v1.0 Parts
- [Part 0: Foundation](./part-0-foundation.md)
- [Part 0b: Testing Strategy](./part-0b-testing-strategy.md) - Cross-cutting testing infrastructure
- [Part 1: Design System](./part-1-design-system.md)
- [Part 2: Offline Viewer](./part-2-offline-viewer.md)
- [Part 3: Planning Tools](./part-3-planning-tools.md)
- [Part 4: Custom Trails](./part-4-custom-trails.md)
- [Part 5: On-Trail Features](./part-5-on-trail-features.md) (5a is v1.0, 5b is v2.0)

### v2.0 Parts
- [Part 6: Community Features](./part-6-community-features.md)
- [Part 7: Trip Sharing](./part-7-trip-sharing.md)
- [v2 Features Overview](./v2-features-overview.md) - Consolidated v2.0 planning

## Original Feature Plan

See [trail-app-features.md](./trail-app-features.md) for the original comprehensive feature analysis that these parts are derived from.

## Key Risks (v1.0)

1. **Offline map tiles** - Largest technical challenge (Part 2)
2. **Scope creep** - Each part is substantial; ruthless prioritization needed
3. **Data quality for custom trails** - User GPX files will be messy (Part 4)
4. **Battery life** - GPS + maps + screen drain batteries fast (Parts 2, 5a)
5. **React Native + MapLibre integration** - Needs early spike to validate offline tile capabilities (Part 0)
6. **App store approval** - iOS has strict requirements for location-based apps

**Note:** iOS background location risk (Part 5b track recording) is deferred to v2.0, reducing v1.0 App Store approval complexity.

---

## Review Notes

**Reviewed: 2026-02-05**

### Overall Assessment
This is a well-structured, comprehensive plan that correctly identifies the MVP scope (Parts 0-3) and progressively adds complexity. The dependency graph is sound and the phasing is pragmatic.

### Strengths
- Clear separation of concerns between parts
- Realistic about complexity (Part 6 community features correctly flagged as major scope increase)
- MVP definition is achievable and delivers core value
- Leverages existing codebase assets effectively

### Key Concerns

1. **Parts 0 and 1 ordering may need adjustment**: The dependency graph shows Part 1 (Design System) depending only on Part 0, but in practice, building UI components without map/location context (Part 2) may lead to rework. Consider building Part 1 incrementally alongside Part 2.

2. **~~Missing: Testing strategy across parts~~**: ✅ Addressed in [Part 0b: Testing Strategy](./part-0b-testing-strategy.md)

3. **Missing: Performance benchmarks**: No success criteria for app size, startup time, or memory usage—important for a mobile app used in low-resource situations.

4. **Risk: React Native + MapLibre**: MapLibre GL JS is mentioned, but React Native requires `react-native-maplibre-gl` which has different capabilities. This needs validation in Part 0 as a spike.

### Suggested Additions to Key Risks

5. **React Native MapLibre integration** - Needs early spike to validate offline tile capabilities work as expected on both iOS and Android
6. **App store approval** - iOS especially has strict requirements for location-based apps and offline map data storage
