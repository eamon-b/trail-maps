# P2 Plan — UI Overhaul & Structural Health (from the Field Usability Review)

> **Source:** `docs/field-usability-review.md` §3, §4 and roadmap items 13–18.
> **Theme:** the design system exists and is good — this phase *enforces* it everywhere,
> consolidates duplicated chrome, redesigns the hidden Plan-mode editing verbs, and pays the
> structural debt (god screens, duplicate map screens) that will otherwise tax every P1 feature.
> **Ordering relative to P1:** Workstream 1 (tokens + primitives) should land **before or
> alongside PR A of P1** — every new P1 surface should be built on the enforced primitives
> rather than migrated later. The rest of P2 can proceed in parallel with P1.

---

## Goals

- Zero raw color literals in component styles; every color theme-resolved (Night Red and
  OLED correct everywhere, not just in the 7 components that opt in today).
- Every tappable surface ≥44 pt; hike-mode primary actions ≥56 pt; large-text users don't
  get clipped rows.
- One `ScreenHeader`, one `Card`, one haptics vocabulary — used everywhere.
- Plan-mode day editing is discoverable: labeled actions, not secret gestures.
- One map-picking screen, no 1,000-line screens, batteries respected, maps zoomable one-handed.

## Current state (verified in the review)

- Tokens/theme: solid core (`src/tokens/{colors,typography,spacing,motion,themes}.ts`,
  `ThemeContext` with light/dark/oled/nightRed + high-contrast + reduce-motion).
- Violations: hardcoded colors in `_layout.tsx:65,108-124`; `#c00` at `settings.tsx:251`,
  `[planId].tsx:887`, `create.tsx:177`; pin literals `section-map.tsx:164-174` vs theme colors
  in `map.tsx:134`; invisible-on-dark borders `rgba(0,0,0,0.08)`/`#0001` in `plan.tsx`,
  `ResupplyList`, `WaterCarryList`, `ClimateOverview`. (P0 already themed WaterCountdown,
  ClimateCard, AlertBanner.)
- High contrast honored by only 7 components; ignored by plan cards, StopSelector,
  SectionSelector, AlertBanner, UndoToast, AppBottomSheet, ProgressBar, both map screens.
- Touch targets: `touchTarget.min / 2` fixed in P0; no shared pressable primitive enforcing
  the floor, so regressions are one `styles.` entry away.
- No `maxFontSizeMultiplier` anywhere; fixed-height rows + `numberOfLines` clip at large OS
  text sizes; field data set in 12 pt `caption`.
- Duplicated chrome: Back/title/spacer header copy-pasted across `create.tsx`, `[planId].tsx`,
  `map.tsx`, `section-map.tsx`, `settings.tsx`; `Card` re-implemented inline throughout Plan.
- Haptics only in hike mode (`haptics.ts` consumed solely by `hike.tsx`).
- Plan editing verbs: FAB (add), `↑`/`↓` icon buttons (merge/split — read as reorder,
  `DayPlanCard.tsx:213-222`), swipe-left (remove), 500 ms long-press (relocate). Water/resupply
  only on the Overview tab while Days is the default (`[planId].tsx:92, 686-687`). Start date
  is a regex-validated `YYYY-MM-DD` TextInput (`create.tsx:161-180`).
- Two near-identical map-picker screens (`plan/map.tsx`, `plan/section-map.tsx`) with a
  fragile dynamic-param return contract (`section-map.tsx:208-218`).
- God screens: `[planId].tsx` 1,176 lines; `plan.tsx` 718 lines.
- Tracking: always `Accuracy.High`/30 s/10 m (`location-service.ts:79-84,171-181`); no battery
  awareness. No offline-readiness signal on the hike screen. No map zoom buttons. Letter-circle
  tab icons (`(tabs)/_layout.tsx:88-102`). No waypoint clustering. GPX `<rte>` flattened into
  the main track (`gpx-processor.ts:318-323`).

## Key design decisions

1. **Semantic tokens over palette access.** Add a semantic layer to `themes.ts`:
   `danger`, `dangerText`, `success`, `info`, plus domain ramps `waterOk/waterLow/waterCritical`
   and `tempCold/tempMild/tempHot` — each with light/dark/oled/nightRed resolutions. Components
   import semantics only; the raw `palette` becomes module-private to the tokens directory.
2. **Enforce by lint, not review.** ESLint `no-restricted-syntax` rules (scoped to
   `mobile/src` + `mobile/app`) banning hex/rgb(a) literals and `fontSize:` numbers inside
   `StyleSheet.create` / style objects, with `eslint-disable` requiring a justification comment.
   Landing this rule is the *first* step of Workstream 1 (with existing violations grandfathered
   via a burn-down list committed alongside, so the rule is on from day one for new code).
3. **Three primitives close most gaps at once:** `PressableRow` (min-height floor,
   `field` size variant = 56 pt, built-in haptic hook, accessibility props),
   `ScreenHeader` (back/title/right-slot, safe-area aware), and universal `Card` adoption.
   High-contrast and font-scaling handling live *inside* these primitives, which is how
   coverage becomes complete without 30 per-component patches.
4. **Font scaling: clamp, don't disable.** Global `maxFontSizeMultiplier={1.4}` via a
   wrapper `Text`/default-props setup; replace fixed row heights with `minHeight` + padding
   so 1.4× text grows rows instead of clipping. Field-critical numbers (water countdown,
   distances, TODAY stats currently 12 pt) move up to ≥14 pt via new `bodySmall`/`dataSmall`
   type tokens. A full "field mode" type-scale toggle is deferred — clamped OS scaling plus
   the 14 pt floor covers the need with far less surface area.
5. **Plan editing verbs become a labeled menu; gestures stay as shortcuts.** Each
   `DayPlanCard` gets a `⋯` button → `AppBottomSheet` action list: *Split day…*, *Merge with
   previous*, *Move stop…*, *Remove stop* (destructive style). Swipe-to-remove and long-press
   keep working, but a first-touch tooltip/coach-mark is no longer needed because everything
   is reachable through the visible menu. The `↑`/`↓` icon buttons are removed.
6. **One `MapPointPicker` screen.** Merge `plan/map.tsx` and `plan/section-map.tsx` into one
   screen parameterized by mode (`single | range | relocate`), with a typed return contract
   (a `pickerRequestId` param + one well-known result param shape) replacing the dynamic-key
   contract at `section-map.tsx:208-218`. P1's crosshair mode (create/move waypoint) reuses
   this screen's interaction.
7. **God screens split by extraction, not rewrite.** `[planId].tsx` keeps routing/state
   ownership but extracts: `usePlanEditor` hook (load/persist/undo/split/merge),
   `PlanDaysTab`, `PlanOverviewTab`, `PlanClimateTab` components, and a `PlanSheets` host.
   `plan.tsx` extracts `TrailCard`, `useTileDownloads`, and a `TrailListScreen` shell.
   Rule: no behavior changes in the extraction commits; tests pass unchanged before any
   redesign lands on top.
8. **Battery-aware tracking as a tier, not magic.** `location-service` gains named profiles:
   `standard` (today's High/30 s/10 m) and `saver` (Balanced/120 s/25 m). Selection: settings
   row (Auto / Standard / Saver), where Auto = saver below 30 % battery via `expo-battery`
   (the one new native dep in P2 — batched with the P1 PR A rebuild if timelines allow,
   otherwise its own rebuild). The active profile is shown in the hike screen's status line
   so degraded fix cadence is never mysterious.
9. **Offline readiness = one honest line.** Hike screen row: "Offline maps ✓ (base +
   contours)" / "No offline maps for this trail — Download" (links into the existing
   Plan-tab download flow relocated behind a shared hook). Overview and the map viewer's
   toolbar get the same download affordance (`tile-service` already exposes everything
   needed; this is pure surfacing).
10. **GPX alternates preserved.** `gpx-processor` stops folding `<rte>` into the main track:
    routes and secondary `<trk>`s become `alternates` (the renderer already draws them —
    orange dashed, `TrailMap.tsx:220-227`). Import preview gains a per-track include/exclude
    checklist. Tap-to-sketch route legs build on P1's route builder (straight-line legs
    already exist there) — sketching is *additive geometry on a route*, not a new editor.

---

## Workstreams

### WS1 — Design-system enforcement (roadmap 13; do first)

1. Semantic tokens + nightRed/oled resolutions (decision 1); migrate the P0-themed components
   onto the semantic names.
2. ESLint literal bans + violation burn-down list (decision 2).
3. Burn down: `_layout.tsx` loading/error screens, `#c00` sites, `section-map.tsx` pins
   (converges with WS3's picker merge), transparent-border sites → `colors.border`.
4. `PressableRow` primitive (decision 3) and migration of every row/button currently
   hand-rolling min-heights; tab bar gets real glyph icons (roadmap 17's quick win — swap
   the "P/H/C" letter circles for icon components, tokenized colors).
5. High-contrast + font-scaling behavior inside the primitives (decisions 3–4); type-scale
   bump for field data.
6. Haptics vocabulary in `haptics.ts` (`selection`, `success`, `warning`, `error`) consumed
   by `PressableRow`/sheets/toasts — Plan mode gets haptics for free via the primitives.

**Tests:** token resolution snapshots per theme variant; lint rule fixture tests; primitive
a11y/measurement tests (min sizes, multiplier clamp).

### WS2 — Chrome consolidation (roadmap 14)

1. `ScreenHeader` component; adopt in `create.tsx`, `[planId].tsx`, both map screens (then
   the merged picker), `settings.tsx`, `measure.tsx`, `import/index.tsx`.
2. `Card` adoption across Plan surfaces (delete the inline shadow/radius/border recipes in
   `plan.tsx:575-584` etc.); Card is the single place high-contrast borders resolve.
3. Settings polish: real `Switch` components instead of text `✓` (`settings.tsx:147,236`),
   grouped with the same Card.

### WS3 — Plan-mode interaction redesign (roadmap 15 + 16a)

1. Day-card `⋯` action menu (decision 5); remove `↑`/`↓`; keep swipe/long-press as shortcuts.
2. Water/resupply strip on the Days tab: compact per-day badges (water-source count exists on
   cards already; add carry distance + resupply flags sourced from the same calculators the
   Overview lists use) with tap-through to the full lists.
3. Native date picker for start date (`@react-native-community/datetimepicker` via
   `npx expo install` — batch with whichever rebuild happens first per decision 8's note).
4. `MapPointPicker` merge with typed return contract (decision 6).

**Tests:** action-menu behaviors mirror the old gesture handlers 1:1 (reuse existing
split/merge/remove tests); picker contract round-trip for all three modes.

### WS4 — Structural refactors (roadmap 16b; gate: WS3's picker merge done)

1. `[planId].tsx` extraction (decision 7) — mechanical commits, snapshot-stable.
2. `plan.tsx` extraction (`TrailCard`, `useTileDownloads` hook shared with the offline-
   readiness surfaces in WS5).
3. Delete `plan/map.tsx` + `plan/section-map.tsx` once `MapPointPicker` covers all callers.

### WS5 — Map & tracking field upgrades (roadmap 17 + 18)

1. Battery-aware tracking profiles + settings + status-line disclosure (decision 8).
2. Offline-readiness line on hike screen; download affordances on overview + map toolbar
   (decision 9, reusing WS4's `useTileDownloads`).
3. Map zoom buttons (+/− in the `trail/[id].tsx` toolbar; MapLibre camera zoom ± 1 with
   animation, honoring reduce-motion) — one-handed/gloved essential.
4. Waypoint clustering above a density threshold (MapLibre `cluster` on the waypoint
   ShapeSource, expanding on tap; labels already gate at zoom ≥11).
5. GPX alternates preserved on import + preview include/exclude (decision 10).
6. Tap-to-sketch legs on the P1 route builder (decision 10; only after P1 PR D ships).

**Tests:** profile switch restarts tracking with new options (existing pref-flip test pattern
at `useLocation.ts:223-229`); clustering on/off thresholds; `gpx-processor` alternates fixtures
(multi-trk, rte-only, mixed files).

---

## Sequencing summary

```
WS1 (tokens/lint/primitives)  ──►  everything else builds on it
WS2 (chrome)                  ──►  parallel with WS3 after WS1
WS3 (plan interactions)       ──►  WS4 gated on picker merge
WS5 (map/tracking)            ──►  independent; item 6 gated on P1-D
```

Suggested PR slicing: WS1 as two PRs (tokens+lint, then primitives+burn-down), WS2 one PR,
WS3 two PRs (day-menu+strip+datepicker, picker-merge), WS4 two mechanical PRs, WS5 three PRs
(tracking+offline, map UX, GPX alternates+sketch). Every PR: `npx tsc --noEmit`, `npx jest`,
`npx expo lint`; native-dep PRs additionally prebuild + dev build per CLAUDE.md.

## Risks

- **Lint-rule fatigue:** banning literals with a big grandfather list can rot. Mitigation: the
  burn-down list is committed with owners per file and WS1.3 clears the worst offenders
  immediately.
- **Extraction regressions (WS4):** mitigated by the no-behavior-change rule and by landing
  after WS3 stabilizes the interactions being moved.
- **Battery profile trust:** hikers must never discover the app silently downgraded fix
  cadence — the status-line disclosure in decision 8 is a requirement.
- **Clustering vs field glanceability:** clustering must never hide the *next* water/campsite
  at hiking zooms — cluster only above zoom-out thresholds where individual waypoints are
  already unreadable.
