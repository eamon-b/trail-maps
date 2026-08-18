# Part 1: Design System & UX Foundation

> **⚠ Pre-rebuild document (superseded 2026-08).** Written for the retired three-tab "Trail Companion" app; the Tracknotes rebuild (merged 2026-08-18) replaced that layout, and file paths/features referenced here mostly no longer exist. Kept for historical context. Current sources of truth: `CLAUDE.md` and `plans/tracknotes-backlog.md`.

## Goal
Create a cohesive design system and core UI components that implement the detailed UX specifications from the feature plan. This establishes the visual and interaction patterns that all subsequent parts will use.

## Deliverables

### 1. Design Tokens Architecture

Organize all visual constants in a structured token system:
```
tokens/
  colors.ts      → raw color values (hex/rgb)
  themes.ts      → semantic color mappings per mode × theme combination
  typography.ts  → font families, size scale, weights, line heights
  spacing.ts     → 4/8/12/16/24/32pt scale
  motion.ts      → duration, easing curves, spring configs
```

**Color palette** — each mode has an accent palette:
  - Plan mode: blue accent
  - Hike mode: green accent
  - Contribute mode: orange accent

Each accent must define these semantic tokens: `accent`, `accentSubtle`, `accentMuted`, `accentOnDark`, `accentOnLight`.

**Four theme variants** — define a complete color token table across:
  | Token | Light | Dark | OLED Dark | Night Red |
  |-------|-------|------|-----------|-----------|
  | `background` | white | #1C1C1E | #000000 | #1A0000 |
  | `surface` (cards) | #F2F2F7 | #2C2C2E | #1C1C1E | #2A0A0A |
  | `textPrimary` | #000000 | #FFFFFF | #FFFFFF | #FF6B6B |
  | `textSecondary` | #666666 | #ABABAB | #ABABAB | #CC5555 |
  | `accent` (per mode) | mode color | lightened variant | lightened variant | red-shifted variant |
  | `border` | #E5E5EA | #38383A | #2C2C2E | #3A1A1A |
  | `alertGreen` | #34C759 | #30D158 | #30D158 | #FF4444 (red-shifted) |
  | `alertAmber` | #FF9500 | #FFD60A | #FFD60A | #FF6B3A |
  | `alertRed` | #FF3B30 | #FF453A | #FF453A | #FF2020 |

Night Red mode red-shifts all mode accent colors to preserve night vision. The map view also needs a dark/desaturated style — coordinate with Part 2.

**Dark mode behavior:**
  - Automatic (follow system preference) / manual toggle
  - OLED-friendly true black option for battery savings
  - Red-shifted night mode option (independent toggle, not tied to system dark mode)
  - Persist user preference in AsyncStorage

**Typography scale** optimized for outdoor readability:
  - `displayLarge`: primary distance numbers — dynamic sizing, minimum effective size ~22pt
  - `displaySmall`: secondary stats (elevation, time)
  - `titleLarge`: section headers (NEXT CAMPSITE, TODAY)
  - `titleSmall`: card labels
  - `body`: descriptions and detail text — legible in bright sunlight
  - `caption`: timestamps, secondary info
  - All sizes use relative units; respect system accessibility text scaling (`allowFontScaling`)
  - Validate actual rendered sizes at 390pt device width before finalizing

**Spacing** — 4pt base grid: 4 / 8 / 12 / 16 / 24 / 32

**Icons** — leverage existing 14 waypoint type emojis, add navigation icons (re-center, compass, expand/collapse)

### 2. Core Component Library

**Required libraries** (install via `npx expo install`):
- `react-native-reanimated` — performant animations, required by bottom sheet and gesture interactions
- `react-native-gesture-handler` — gesture system for swipes, long-press, drag
- `@gorhom/bottom-sheet` — battle-tested bottom sheet with snap points, gesture integration

**Mode Selector** — collapsible top bar:
  - Default state: thin colored stripe (8pt height) showing current mode color
  - Tap the stripe to expand into a full segmented control for switching modes
  - Color of the stripe provides ambient mode awareness without taking space
  - Expanding/collapsing uses a 200ms ease-out animation
  - When expanded, tapping a mode switches instantly and collapses the bar

**Tab Bar** — icon + text labels (not icon-only), mode-specific tabs:
  - Plan: Overview | Waypoints | Day Plan | Resupply
  - Hike: Dashboard | Map | Waypoints
  - Contribute: Notes | Upload

**Bottom Sheet** — uses `@gorhom/bottom-sheet`:
  - Three snap points: peek (25% screen), half (50%), full (90%)
  - Grabber handle: 36×5pt rounded bar, centered at top
  - Background: dimmed overlay, tappable to dismiss
  - No stacking — opening a new sheet replaces the current one
  - Content is scrollable within the sheet
  - Mode selector stripe and tab bar remain visible underneath
  - Respects safe areas (notch, Dynamic Island, home indicator)

**Cards** — waypoint cards, day cards, stat cards:
  - Each card must define four states: **normal**, **loading** (skeleton placeholder), **empty** (no data available), **degraded** (stale data with timestamp)
  - Example degraded state: "Last known: 12.4 km (no GPS — showing distance from km 245)"

**Progress Bars** — trail progress, day progress

**Lists** — waypoint lists with emoji icons, scrollable with highlighting

**Stat Displays** — distance/elevation pairs, countdown formats

### 3. Hike Dashboard Layout
Implement the glanceable dashboard. Designed for 390pt minimum width (iPhone 15).

**Above the fold** (visible without scrolling):
```
┌─────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ HIKE ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← mode stripe (green, tap to expand)
├─────────────────────────────────────────┤
│  BIBBULMUN TRACK  SOBO     km 245 / 982 │
│  ████████████░░░░░░                     │  ← trail progress
├─────────────────────────────────────────┤
│  NEXT CAMPSITE                          │
│  Mumballup Camp           12.4 km +310m │  ← full-width, large text
├─────────────────────────────────────────┤
│  NEXT WATER                             │
│  Murray River                   3.1 km  │  ← full-width, large text
├────────────────────┬────────────────────┤
│  NEXT TOWN         │  NEXT SHELTER      │
│  Balingup          │  Harris Dam Hut    │  ← 2-col grid, smaller text
│  34.7 km  +820m    │  8.2 km            │
└────────────────────┴────────────────────┘
```

**Below the fold** (scroll to reveal):
```
├─────────────────────────────────────────┤
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
└─────────────────────────────────────────┘
```

**Layout rationale:**
- Next Campsite and Next Water are the two highest-priority questions hikers ask (per information hierarchy). Full-width cards give room for `displayLarge` text readable at arm's length.
- Next Town and Next Shelter are secondary — smaller 2-column grid with `displaySmall` text.
- TODAY section can collapse for hikers without a rigid day plan (tap to expand/collapse).
- Validate this layout renders correctly at 390pt width with actual font sizes during implementation.

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
- Warning states (long day, low water, etc.)

**Gesture behavior** (uses `react-native-gesture-handler` + `react-native-reanimated`):
- Drag reorder is initiated **only** from the `[≡]` handle — not the entire card (otherwise list scrolling breaks)
- `[≡]` `[↑]` `[↓]` buttons are each minimum 44×44pt touch targets — total 132pt, roughly 1/3 card width
- Swipe-to-remove: swipe left past 40% of card width to trigger; snap-back animation if threshold not met
- After swipe-to-remove, show an **undo toast** (3 seconds) — accidental removes on trail would be infuriating
- All gesture interactions use `react-native-reanimated` worklets for 60fps performance on the UI thread

### 5. Alert Banner Components
Visual components for status and alert display (logic implemented in Part 5):
- **Location status bar** with color states:
  - Green (`alertGreen`): on-trail state
  - Neutral/gray (`textSecondary`): drifting state
  - Amber (`alertAmber`): warning state
  - Red (`alertRed`): off-trail state
  - All alert colors must meet WCAG AA contrast (4.5:1) against their backgrounds in every theme variant (Light, Dark, OLED, Night Red)
- **Alert banner**: Slide-down from top, 250ms spring animation (damping: 15, stiffness: 150)
- **Haptic patterns** (define patterns, Part 5 triggers them):
  - On-trail: none
  - Drifting: none
  - Warning: single light tap (`Haptics.impactAsync(ImpactFeedbackStyle.Light)`)
  - Off-trail: medium impact (`Haptics.impactAsync(ImpactFeedbackStyle.Medium)`), repeats once after 2s
- Components accept state as props; Part 5 implements the detection logic

### 6. Motion & Interaction Patterns

**Navigation rules:**
- **No horizontal swipe between tabs**: All navigation via deliberate taps
- **Android back button**: Dismisses bottom sheet if open → otherwise navigates back in tab history → otherwise no-op (don't exit app accidentally)

**focusedWaypoint state** — cross-view synchronization:
  - Selecting waypoint in any view updates all other views
  - Switch to Map → map pans to that waypoint with popup open
  - Switch to Waypoints → list scrolls to and highlights that row
  - Switch to Day Plan → highlights the day containing that waypoint

**Progressive disclosure layers:**
  - Glance: visible without scrolling (above the fold)
  - Scroll: additional detail (TODAY, UPCOMING)
  - One tap: bottom sheet with full details
  - Tab switch: full dedicated view

**Standard motion tokens** (defined in `tokens/motion.ts`):
  | Name | Duration | Easing | Use case |
  |------|----------|--------|----------|
  | `tap` | 100ms | ease-out | Button press feedback |
  | `sheetOpen` | 300ms | spring (damping: 20, stiffness: 200) | Bottom sheet open/close |
  | `slideIn` | 250ms | ease-out | Alert banners, toasts |
  | `modeSwitch` | 200ms | ease-in-out | Mode bar expand/collapse, color transitions |
  | `cardReorder` | 200ms | spring (damping: 18, stiffness: 180) | Drag reorder settle |

- All animations must respect `AccessibilityInfo.isReduceMotionEnabled()` — when enabled, skip animations and show final state immediately
- Haptic feedback fires at the start of the animation, not the end

### 7. Empty, Loading & Degraded States

Every data-displaying component must define these states alongside its normal rendering:

- **Loading**: Skeleton placeholder (animated shimmer) while data loads. No spinners on the dashboard — skeletons preserve layout stability.
- **Empty**: Meaningful message when no data exists. E.g., "No day plan set — tap Plan to create one" (not a blank card).
- **Degraded / No GPS**: Components show last-known data with a staleness indicator when GPS is unavailable.
  - Dashboard cards: Show absolute km position instead of relative distance. "km 245 → Mumballup Camp (12.4 km)" rather than "12.4 km away"
  - Location status bar: Gray "No GPS" state
  - Stale timestamps: "Updated 3 min ago" / "Last known position"

### 8. Accessibility

**Touch targets:**
- Minimum 44×44pt for all interactive elements
- Day Plan card action buttons (`[≡]` `[↑]` `[↓]`) must each be 44×44pt — verify this fits within card width

**Visual accessibility:**
- All alert color states (green/amber/red) must meet WCAG AA contrast ratio (4.5:1) in all four themes
- High contrast mode: increase border widths, use solid backgrounds instead of subtle tints
- Never rely on color alone — alert states also use icons/text labels (e.g., "On trail" / "Off trail")

**Motion accessibility:**
- Respect `AccessibilityInfo.isReduceMotionEnabled()` — disable animations, show final states immediately
- Bottom sheets snap to positions without spring physics when reduce motion is enabled

**Screen readers:**
- All interactive elements have `accessibilityLabel` and `accessibilityRole`
- Dashboard cards announce distance and waypoint name (e.g., "Next campsite: Mumballup Camp, 12.4 kilometers, 310 meters elevation gain")
- Mode selector announces current mode on focus

**Text scaling:**
- Support Dynamic Type / system text scaling up to 200%
- Dashboard layout must reflow gracefully at large text sizes (cards may stack vertically)
- Test with accessibility text scaling on both iOS and Android

**Situational impairment** (the primary accessibility concern for this app):
- Wet hands, gloves, bright sun, fatigue, one hand on a trekking pole
- Verified by: testing all core flows one-handed, in bright outdoor light, with accessibility text size enabled

### 9. Platform Differences

Acknowledge and handle iOS vs Android differences:
- **Safe areas**: Handle notch, Dynamic Island (iOS), camera cutouts (Android), home indicator, and Android navigation bar. Use `react-native-safe-area-context`.
- **Status bar**: Translucent on iOS, colored on Android. Style per-mode.
- **Bottom sheet physics**: iOS expects rubber-band bounce; Android expects Material-style damped settle. `@gorhom/bottom-sheet` handles this, but verify feel on both platforms.
- **Back button (Android)**: Dismiss bottom sheet → navigate back → no-op (defined in Section 6).
- **Font rendering**: iOS and Android render the same font sizes slightly differently. Verify typography scale on both.

### 10. Component Development Workflow

**Approach: Expo Router dev catalog** — a `/(dev)/components` route group in the app:
- Available in development builds only (excluded from production via route groups)
- Zero additional tooling — uses the same Expo Router navigation as the app
- Each component gets a screen showing its variants, states, and theme options
- Accessible via a "Dev" tab that only appears in `__DEV__` mode

**Component catalog structure:**
```
app/(dev)/
  _layout.tsx          → simple stack navigator
  index.tsx            → component list
  cards.tsx            → card variants (normal, loading, empty, degraded)
  bottom-sheet.tsx     → sheet snap points, content types
  mode-selector.tsx    → expand/collapse, all three modes
  alerts.tsx           → all alert states and colors
  day-plan-card.tsx    → gestures, swipe, drag
  typography.tsx       → full type scale at various text sizes
  colors.tsx           → all tokens across all four themes
```

**Testing:**
- Snapshot tests for component structure (`react-native-testing-library`)
- Visual verification via dev catalog on device (not automated screenshots)
- Interaction tests for gestures (swipe thresholds, drag handles)

## Success Criteria
- Design tokens defined for all four themes (Light, Dark, OLED Dark, Night Red) × three modes
- Component dev catalog accessible in dev builds with all components exercisable
- Dashboard layout renders correctly with mock data **at 390pt width** with actual font sizes
- Mode switching (via collapsible top bar) changes color scheme throughout app
- Dark mode and night red mode work correctly across all components
- Bottom sheets (`@gorhom/bottom-sheet`) snap to three positions, dismiss on backdrop tap, respect safe areas
- All card components render normal, loading, empty, and degraded states
- Day plan card gestures work: drag from handle, swipe-to-remove with undo toast
- All animations respect `isReduceMotionEnabled`
- All alert color states meet WCAG AA contrast in every theme
- Touch targets verified at 44×44pt minimum
- Tested one-handed on both iOS and Android devices/simulators

## Dependencies
- Part 0: Foundation & Project Setup

## Notes
- Components should be built with real data interfaces in mind (from Part 0 data models)
- Map and elevation profile components are handled in Part 2, not here
- This part defines the "look and feel" that makes the app feel polished
- **Build iteratively alongside Part 2** — some components need real data context
- Night Red mode needs a corresponding dark map style in Part 2 — a blinding white map would defeat the purpose

---

## Review History

### Review 1 — 2026-02-05

Identified and incorporated: off-trail alert system misplacement, missing dark mode, missing component testing approach, typography sizing concerns, dashboard information density concerns. All items addressed in the current plan.

### Review 2 — 2026-02-07

**Checklist Assessment:**
- [x] All affected files identified
- [x] Steps in the right order
- [x] Edge cases considered (empty/loading/degraded states, gesture conflicts, platform differences)
- [x] Testing strategy sufficient (dev catalog + snapshot tests + device testing)
- [x] Concrete library choices made

**Changes made:**
1. Replaced color palette with full **design tokens architecture** including semantic token table across four themes (Light, Dark, OLED Dark, Night Red)
2. **Mode selector** changed from persistent top segmented control to **collapsible top bar** (thin colored stripe, tap to expand) for better one-handed reachability
3. **Dashboard layout** revised: top two priority cards (Next Campsite, Next Water) are full-width with large text; secondary cards (Next Town, Next Shelter) in 2-column grid; TODAY section below the fold and collapsible
4. **Bottom sheet** fully specified: three snap points, grabber handle, no stacking, backdrop dismiss, using `@gorhom/bottom-sheet`
5. **Motion tokens** added: standard durations and easing curves for all transitions, respect for reduce-motion accessibility
6. **Day Plan card gestures** specified: drag only from handle, swipe threshold, undo toast
7. **Alert colors** tied to theme tokens with WCAG AA contrast requirement
8. **Haptic patterns** defined with specific feedback styles per alert level
9. Added **Section 7: Empty/Loading/Degraded States** — every card defines four visual states
10. **Accessibility** expanded: situational impairment (wet hands, gloves, sun), contrast ratios, motion accessibility, screen reader labels, text scaling to 200%
11. Added **Section 9: Platform Differences** — safe areas, status bar, back button, font rendering
12. **Component dev workflow** specified as Expo Router `/(dev)` catalog with concrete file structure
13. Added concrete library requirements: `react-native-reanimated`, `react-native-gesture-handler`, `@gorhom/bottom-sheet`
14. **Success criteria** updated to be measurable and specific

**Remaining considerations for implementation:**
- The exact color hex values in the token table are starting points — they need visual validation on actual devices in outdoor light
- Night Red mode's red-shifting of mode accent colors needs design iteration (blue→red, green→red, orange→red could all look too similar)
- Coordinate with Part 2 on dark/night map tile styles
