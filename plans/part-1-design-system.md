# Part 1: Design System & UX Foundation

## Goal
Create a cohesive design system and core UI components that implement the detailed UX specifications from the feature plan. This establishes the visual and interaction patterns that all subsequent parts will use.

## Deliverables

### 1. Design System Foundation
- Color palette for each mode:
  - Plan mode: blue accent colors
  - Hike mode: green accent colors
  - Contribute mode: orange accent colors
- **Dark mode support:**
  - Light/dark variants of all mode colors
  - OLED-friendly true black option for battery savings
  - Automatic (follow system preference) / manual toggle
  - Red-shifted night mode option for preserving night vision
- Typography scale optimized for outdoor readability:
  - Large distance numbers using dynamic sizing (scalable, not fixed pt)
  - Body text legible in bright sunlight
  - Respect system accessibility text scaling
- Spacing and layout grid system
- Icon set (leverage existing 14 waypoint type emojis, add navigation icons)

### 2. Core Component Library
- **Mode Selector**: Persistent segmented control at screen top
- **Tab Bar**: Icon + text labels (not icon-only), mode-specific tabs
- **Bottom Sheet**: Slide-up detail views that preserve context
  - Swipe-down to dismiss
  - Mode selector and tab bar visible underneath
- **Cards**: Waypoint cards, day cards, stat cards
- **Progress Bars**: Trail progress, day progress
- **Lists**: Waypoint lists with emoji icons, scrollable with highlighting
- **Stat Displays**: Distance/elevation pairs, countdown formats

### 3. Hike Dashboard Layout
Implement the glanceable dashboard wireframe:
```
┌─────────────────────────────────────────┐
│  Plan   [ HIKE ]   Contribute           │
├─────────────────────────────────────────┤
│  TRAIL NAME  DIRECTION     km X / Y     │
│  ████████████░░░░░░                     │
├────────────────────┬────────────────────┤
│  NEXT CAMPSITE     │  NEXT WATER        │
│  Name              │  Name              │
│  X.X km  +Xm       │  X.X km            │
├────────────────────┼────────────────────┤
│  NEXT TOWN         │  NEXT SHELTER      │
│  Name              │  Name              │
│  X.X km  +Xm       │  X.X km            │
├────────────────────┴────────────────────┤
│  TODAY                                  │
│  Start → End                            │
│  X.X km  +Xm/-Xm                        │
│  Done: X.X km (X%) █████░░░░░           │
├─────────────────────────────────────────┤
│  UPCOMING                               │
│  (Next 3 waypoints with emoji icons)    │
└─────────────────────────────────────────┘
```

### 4. Day Plan Card Component
```
┌─────────────────────────────────────────┐
│  DAY X — Date                           │
│  Start → End                            │
│  X.X km  +Xm/-Xm  ~Xh                   │
│  💧 X water sources                     │
│  ⚠️ Warnings (if any)                   │
│                             [≡] [↑] [↓] │
└─────────────────────────────────────────┘
```
- Merge day (↑), split day (↓), drag handle (≡) interactions
- Swipe-to-remove gesture
- Warning states (long day, low water, etc.)

### 5. Alert Banner Components
Visual components for status and alert display (logic implemented in Part 5):
- **Location status bar** with color states:
  - Green: on-trail state
  - Neutral/gray: drifting state
  - Amber: warning state
  - Red: off-trail state
- **Alert banner**: Slide-down animation from top of screen
- **Haptic patterns**: Define vibration patterns for each alert level
- Components accept state as props; Part 5 implements the detection logic

### 6. Interaction Patterns
- **No horizontal swipe between tabs**: All navigation via deliberate taps
- **focusedWaypoint state**: Cross-view synchronization
  - Selecting waypoint in any view updates all other views
- **Progressive disclosure layers**:
  - Glance: visible without scrolling
  - Scroll: additional detail
  - One tap: bottom sheet with full details
  - Tab switch: full dedicated view

### 7. Accessibility
- Touch targets minimum 44x44pt
- High contrast mode support
- Screen reader labels
- Support for larger text sizes

### 8. Component Development Workflow
- Set up component playground (Storybook for React Native or similar)
- Define component documentation standards
- Establish visual regression testing approach
- Create component catalog with usage examples

## Success Criteria
- Component library with all core components documented in Storybook
- Dashboard layout renders correctly with mock data
- Mode switching changes color scheme throughout app
- Dark mode works correctly across all components
- Bottom sheets slide up/down smoothly, preserve context
- All interaction patterns implemented and testable
- Accessibility audit passes for all components

## Dependencies
- Part 0: Foundation & Project Setup

## Notes
- Components should be built with real data interfaces in mind (from Part 0 data models)
- Map and elevation profile components are handled in Part 2, not here
- This part defines the "look and feel" that makes the app feel polished
- **Build iteratively alongside Part 2** - some components need real data context

---

## Review Notes

**Reviewed: 2026-02-05**

### Checklist Assessment
- [x] All affected files identified
- [x] Steps in the right order
- [ ] Edge cases considered (outdoor readability needs testing)
- [ ] Testing strategy sufficient

### Issues Found

1. **Off-Trail Alert System is misplaced**
   Section 5 (Off-Trail Alert System) belongs in Part 5 (On-Trail Features), not Part 1. The design system should define the visual components (alert banners, color states), but the alert logic and GPS integration belongs elsewhere.

   **Suggested fix:** Rename to "Alert Banner Components" and focus on:
   - Visual states (green/amber/red bars)
   - Banner animations (slide down)
   - Haptic patterns (define, don't implement)

   Move the actual off-trail detection logic description to Part 5.

2. **Missing: Dark mode**
   Critical for:
   - Night hiking (preserve night vision)
   - Battery savings on OLED screens
   - User preference

   Add to Section 1 (Design System Foundation):
   - Light/dark mode color variants for each mode (Plan/Hike/Contribute)
   - System preference detection
   - Manual toggle

3. **Missing: Component testing approach**
   - Storybook or similar for component development?
   - Snapshot tests?
   - This should be established early

4. **Typography concerns**
   - "24pt bold readable at arm's length" needs device testing
   - Consider using rem/dynamic units rather than fixed pt sizes
   - Account for user accessibility text scaling

5. **Hike Dashboard Layout - consider simplification**
   The wireframe shows a lot of information. For MVP, consider:
   - Which cards are essential vs nice-to-have?
   - Can "TODAY" section be collapsed by default for hikers without a rigid plan?

### Suggested Additions

**Add to Section 1:**
```
- Dark mode support:
  - Dark variants of all mode colors
  - OLED-friendly true black option
  - Automatic (system) / manual toggle
```

**Add new section:**
```
### 8. Component Development Workflow
- Set up component playground (Storybook Native or similar)
- Define component documentation standards
- Establish visual regression testing approach
```

### Dependencies Concern
This part depends only on Part 0, but some components (like the location bar states, waypoint cards with real data) will be hard to build without understanding the actual data shapes from Part 2. Consider building this iteratively alongside Part 2.
