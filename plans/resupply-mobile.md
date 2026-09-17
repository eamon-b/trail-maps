# Resupply selection on mobile

Status: planned 2026-09-17. Phase 4 of `plans/resupply-selection.md` (that document, the shared
calculator and the web tab all arrive with PR #74, `feature/load-cdt-data`). Tracked as issue #73.
Nothing here is implemented yet.

## What the web shipped, and what the phone has

On the web plan page (`src/web/trails/plan-viewer.ts`, PR #74) a resupply is a *choice*: a third
left-panel tab lists every resupply option the trail offers, grouped by the turn-off you leave the
route at (Salida and Poncha Springs are one hitch from Monarch Pass), each with a checkbox. The
ticked options become the stops of a resupply plan and the right-hand datasheet shows the legs
between them: distance, ascent, descent, Naismith hours, estimated days, food weight, and the
camp-plan day you arrive on. The selection persists as a list of waypoint ids in
`PlanState.resupplyStops`; absent means every option ticked.

The phone's Plan screen (`mobile/app/guide/[trailId]/plan.tsx`) still shows the pre-selection
picture: `plan-adapters.ts` passes `trail.waypoints` straight into `analyzeResupplyForSection`, so
`ResupplyCard` renders a carry between *every* resupply-family waypoint. On the CDT that is 70
stops and a carry between two towns reached by the same hitch. The card also has no ascent or
descent, and its days come from the realised km/day of the camp split rather than from the leg's
own terrain.

Everything the phone needs from the data side is already there:

- `src/lib/resupply-plan.ts` is platform-neutral. `listResupplyOptions` → `resolveResupplyStops`
  → `computeResupplyLegs` → `summariseResupplyLegs` take structural types, so `TrailJson` and its
  waypoints pass straight in (as `computeDays` already does via the `PlanTrail` cast).
- `mobile/assets/trails/cdt.json` and `te_araroa.json` (regenerated on the PR #74 branch) carry
  `offTrailKm` / `accessMode` / `acceptsBoxes` / `accessName` on 80 CDT waypoints, and the on-trail
  turn-offs are typed `town-access` / `resupply-access` / `food-access`. Every bundled waypoint has
  a stable `id`; imported ones have `uw_…` ids from `gpx-import` or the handoff parser.
- `computeResupplyLegs` reads `cumAscent` / `cumDescent` through `calculateElevationBetween`, so on
  the thinned mobile track each leg's climb is the full-resolution figure and costs O(log n), not
  a walk of the points. There is nothing to cache.
- `waypoint-icons.ts` falls back through `baseWaypointType`, so a `town-access` marker already
  draws as a town. `isAccessWaypoint` already keeps turn-offs out of `overnightWaypoints`.

## Decisions carried over from the web (not reopened here)

- **Default is every option ticked.** A hiker who never opens the list sees what they see today.
- **Selection is an explicit list of waypoint ids**, per trail. Unknown ids are dropped silently
  when resolving, and pruned the first time the hiker changes the selection.
- **Ticking two options at one turn-off is one stop**, named "Salida / Poncha Springs".
- **Independent of the camp plan.** Ticking a resupply never adds a day boundary. Legs report
  arrival day from the camp plan when one exists, and that is the whole coupling.
- **Selection stays per platform.** The `.tracknotes.json` handoff carries a trail, not a plan.
- **Ids survive a direction flip** (`trail-reverse` spreads waypoint objects), so nothing is
  converted on reversal; only the km shown beside each option changes.

## Decisions to take for the phone

1. **Days per leg come from the hiker's own inputs.** The web has no pace input and fixes 4 km/h and
   8 h/day. The phone has both (`prefs.pace`, `prefs.dailyHours`), so
   `computeResupplyLegs(…, { dailyHours: prefs.dailyHours, baseKmh: PACE_KMH[prefs.pace] })`.
   This replaces `effectiveDailyKm` for resupply; that field stays on `PlanResult` for the
   "Avg/day" summary stat only.
2. **The list lives on the Plan screen, collapsed by default.** The issue sketch puts a
   `ResupplySelectList` under a "Resupply stops" header above the card. On the CDT that is 70 rows
   in the middle of a `ScrollView`, between the inputs and the day splits. Recommendation: a
   header row that always shows (`12 of 70 stops · All · None`) with a chevron; the grouped list
   expands beneath it. Collapsed is the state on every open. If it feels cramped on device, the
   fallback is a `Modal` sheet in the style of `PoiLayersSheet`, but a sheet hides the list from
   the legs it changes, so try inline first.
3. **Checkbox, not Switch.** `Pressable` with `accessibilityRole="checkbox"` and
   `accessibilityState={{ checked }}` — a new idiom in the app (nothing uses it yet). A `Switch`
   reads as a setting; this is a pick. Draw the box with theme tokens (`colors.accent` filled +
   `colors.accentText` tick when checked, `colors.border` ring when not); no icon library.
4. **Persistence goes in `plan-inputs-store`,** beside pace and hours, because it is exactly the
   kind of direction-independent per-trail preference that store exists for. Not the settings
   store (global) and not SQLite (nothing else about the plan is there).
5. **`ResupplyCard` becomes the legs card.** Same component, fed `ResupplyLeg[]` instead of
   `{gap, food}` pairs; gains ascent / descent and the arrival day. The "Long carry" badge stays
   the calculator's `isLong`.

## Phase 1 — types and the shared bits

### 1a. `TrailJson` waypoints learn the access fields

`mobile/src/services/trail-assets.ts`: `waypoints` element type `extends WaypointAccess` (from
`@lib/types`). The JSON already carries the fields; the type just stops hiding them from the UI.
No runtime change.

### 1b. Lift the two display helpers out of `plan-viewer.ts`

`firstSentence` (with `isAbbreviationDot` and `NON_TERMINAL_ABBREVIATIONS`) and `accessSummary`
are module-private in `src/web/trails/plan-viewer.ts` on the PR #74 branch. The phone needs the
same subline. Move them to `src/lib/resupply-display.ts` (the `poi-display.ts` pattern: the
platform-neutral half of showing a thing), export both, make the web import them, and move the
"does not cut the description short at a dotted abbreviation" expectation into a `src/lib` test so
it is not only reachable through the jsdom tab test.

`accessSummary` on the web is metric-only. The lifted version takes a formatter:
`accessSummary(option, formatKm: (km: number) => string)`. The web passes
`km => `${km.toFixed(1)} km``; the phone passes `km => formatDistance(km, units)`. The words
("hitch", "shuttle", "off trail", "on trail") stay in one place.

This is a refactor of web code that has not merged yet. Do it as the first commit of the mobile
PR, based on `feature/load-cdt-data` (or on `main` once PR #74 lands), and keep `plan-viewer.ts`
behaviour byte-for-byte: `resupply-tab.test.ts` covers it.

## Phase 2 — persistence: `plan-inputs-store.ts`

- `PlanPrefs.resupplyStops?: string[]`. Absent = nothing chosen yet = every option ticked.
  `DEFAULT_PREFS` does not mention it, so `selectPrefs`'s field-by-field merge leaves it
  `undefined` for every entry persisted before now. That is the correct default with no
  migration.
- `setResupplyStops(trailId, ids: string[])`. Stores a fresh array (spread into a fresh entry, so
  the `WeakMap` memo in `selectPrefs` misses and recomputes — same mechanism as `setPace`).
- `migratePlanInputs` keeps guaranteeing only the map shape, as its comment says. Add one guard
  in `selectPrefs`'s merge: if the stored `resupplyStops` is not an array of strings, drop it to
  `undefined`. That is where a hand-edited or corrupt blob is scrubbed, mirroring the web's
  `isValidPlanState`. Bumping `version` to 2 is not needed for an optional field; leave it at 1
  unless the guard is put in `migrate` instead, in which case bump it so the migrate runs.
- `clearTrail` already forgets the whole entry, so deleting an imported trail drops its selection
  for free (`imported-trail-store.ts:151`).

Tests (`plan-inputs-store.test.ts`): round trip; `undefined` for an entry saved before the field
existed; a stable reference from `selectPrefs` after `setResupplyStops`; a non-string-array
value collapses to `undefined`; `clearTrail` drops it; independence between two trails.

## Phase 3 — adapters: `plan-adapters.ts`

`PlanInputs` gains `resupplyStops?: readonly string[]`. `PlanResult` changes shape:

```ts
export interface PlanResult {
  section: SectionConfig;
  targetHours: number;
  effectiveDailyKm: number;          // still drives the "Avg/day" stat
  days: PlanDay[];
  resupplyGroups: ResupplyOptionGroup[];   // every option, grouped — the list
  resupplyStops: ResupplyStop[];           // what the selection resolves to
  resupplyLegs: ResupplyLeg[];             // the card
  resupplySummary: ResupplySummary;        // the header row's "N stops · longest …"
  water: WaterCarryAnalysis;
  topWaterCarries: WaterGap[];
}
```

`resupply` (`ResupplyAnalysis`) and `foodCarries` go; `ResupplyCard` was their only reader. The
`analyzeResupplyForSection` import goes with them (the module stays in `src/lib` for the web
trail page's datasheet legs).

In `computePlan`:

```ts
const resupplyGroups = listResupplyOptions(trail.waypoints);
const resupplyStops = resolveResupplyStops(resupplyGroups, inputs.resupplyStops);
const resupplyLegs = computeResupplyLegs(planTrail, resupplyStops, {
  dailyHours: targetH,
  baseKmh,
  section,
  days,            // ComputedDay[] — PlanDay extends it
});
const resupplySummary = summariseResupplyLegs(resupplyLegs);
```

Two details:

- **Groups are direction-applied.** `trail` here is the guide's direction-applied trail, so the
  groups come out in walking order with active-direction km, and the same ids either way. Nothing
  else to do on a flip — the screen's `useMemo` already keys on `trail`.
- **Section scoping is the calculator's.** `computeResupplyLegs` drops stops outside
  `[section.startKm, section.endKm]` and bounds the first and last legs to the section, exactly as
  `analyzeResupplyForSection` did. The *list* still shows every option on the trail (the hiker
  sections later; the choice is trail-wide), but options outside the current section render
  dimmed with an "outside section" caption so the list and the card agree about why a ticked town
  produces no leg.

Also export `allResupplyOptionIds(groups)` (flat map) — the "All" action and the pruning step in
the toggle both need it, and the web has the same helper privately.

Tests (`plan-adapters.test.ts`): default selection yields one stop per group and a leg per
boundary over `syntheticTrail()` (add a second town 0.05 km from Townsville with an `accessName`
to make a group); an explicit selection dropping the town merges the two legs and the merged
distance/ascent are the hand-computed sums; two ticks in one group → one stop with the joined
name; `[]` → no legs and `hasData: false`; days come from `dailyHours` and the pace (a 40 km flat
leg at 4 km/h and 8 h/day is 2 days; at 3 km/h it is 2 days still, at 16 h/day it is 1); the
section drops an out-of-range stop; the real CDT asset has ≥60 options in fewer groups and the
Monarch Pass group resolves to one stop (mirror of the `src/lib` regression, run against the
bundled asset the phone actually ships).

## Phase 4 — UI

### 4a. `features/plan/ResupplySelectList.tsx`

Props: `groups`, `selectedIds: ReadonlySet<string>`, `section`, `units`, `onToggle(id)`,
`onSelectAll()`, `onSelectNone()`. Presentational; the screen owns the state.

Layout, top to bottom:

- **Header row** (always visible): `Resupply stops` title, `12 of 70` count, `All` / `None` text
  chips (`Pressable`, `accessibilityRole="button"`, styled like the "Full trail" reset chip in
  `PlanInputsCard`), and a chevron `Pressable` (`accessibilityRole="button"`,
  `accessibilityState={{ expanded }}`, label "Show resupply stops" / "Hide resupply stops").
- **Groups** (when expanded), in km order. A group with a `label` gets a header line:
  `⤴ Monarch Pass (US 50) · 3101.1 km` in `typography.caption` / `colors.textSecondary`. A group
  without one is just its single row.
- **Option row**: the checkbox, the waypoint glyph (`WAYPOINT_ICON_IMAGES[waypointIconName(option.type)]` from
  `features/map/` — `waypointIconName` already resolves `town-access` to the town image), the
  name (`typography.titleSmall`, `numberOfLines={1}`), the km right-aligned in tabular figures,
  and a subline: `accessSummary(option, km => formatDistance(km, units))`, then
  `firstSentence(description)`, then `accepts boxes`, joined with ` · `, `numberOfLines={2}`.
  The whole row is the `Pressable` (`accessibilityRole="checkbox"`, `accessibilityLabel` =
  the name, `accessibilityState={{ checked }}`), minimum height `touchTarget.min`.
- Rows outside the current section: `opacity` down, caption `outside section` in place of the km.

No text filter in v1: the web's filter box exists because 70 rows in a 220 px panel need one;
here the list is collapsed by default and grouped, and a filter means a keyboard on the plan
screen. Revisit if the CDT list is unusable on device.

Tests (`ResupplySelectList.test.tsx`, `react-test-renderer` + the `allText` shim from
`DaySplitList.test.tsx`, theme mocked): the count reads `N of M`; collapsed shows no option
names; expanded shows a group header and its options; a row carries
`accessibilityState.checked`; pressing a row calls `onToggle` with its id; the subline reads
`22.5 km hitch · … · accepts boxes` in km and `14.0 mi hitch` with `units="mi"`; an
out-of-section option shows `outside section`.

### 4b. `ResupplyCard.tsx` shows legs

Props become `{ legs: ResupplyLeg[]; hasOptions: boolean; units: Units }`. Per leg:

```
Trail Start → Salida / Poncha Springs                     [Long carry]
148.2 km · +5,120 m / −4,870 m · ≈ 6 days · 4.1 kg food
Arrive Day 7
```

Elevation through `formatElevation` in `@lib/format-distance` (feet under `mi`). The arrive line
only when `leg.arrival` is set. Empty states, in this order: no options on the trail → "No towns
or resupply points on this trail."; options but nothing ticked → "No resupply stops ticked. Tick
the ones you plan to use above."; options ticked but none in the section → "No ticked resupply
stops in this section." (`hasOptions` and `legs.length` tell the three apart, with the
out-of-section case read off `resupplyStops.length > 0`, so pass `stopCount` too or fold the
message choice into the screen.)

Tests: update `plan-adapters.test.ts` expectations that read `plan.foodCarries` /
`plan.resupply`; add a small `ResupplyCard.test.tsx` for the three empty states and the
ascent/descent + arrival lines.

### 4c. `plan.tsx` wiring

```tsx
const setResupplyStops = usePlanInputsStore((s) => s.setResupplyStops);
const inputs: PlanInputs = { …, resupplyStops: prefs.resupplyStops };
const plan = useMemo(() => computePlan(trail, inputs), [trail, …, prefs.resupplyStops]);

const selectedIds = useMemo(
  () => new Set(prefs.resupplyStops ?? allResupplyOptionIds(plan.resupplyGroups)),
  [prefs.resupplyStops, plan.resupplyGroups],
);
const toggle = (id: string) => {
  const next = new Set(selectedIds);
  next.has(id) ? next.delete(id) : next.add(id);
  // Always store an explicit list, in trail order, pruned to ids the trail has.
  setResupplyStops(trailId, allResupplyOptionIds(plan.resupplyGroups).filter((i) => next.has(i)));
};
```

The `Resupply` section becomes: `<ResupplySelectList …/>` then `<ResupplyCard …/>`, and its
subtitle is `resupplySummary` rendered as `N stops · longest carry X / Y days · Z kg food` (the
web's `resupplySummaryText`, lifted into `resupply-display.ts` with the same formatter injection
in 1b, since the phone wants `formatDistance` / `formatFoodWeight`). Summary and card read the
same legs, so they cannot disagree.

Expanded/collapsed is local `useState(false)`; it is not a preference.

The section-guard early return ("Choose a start before the end") stays before all of this.

### 4d. What does not change

- Map, elevation profile and List pane: no resupply-selection surface in v1. The web only
  emphasises ticked markers while its tab is open; the phone's plan is its own screen, so there is
  no equivalent moment. Recorded below as a follow-up.
- The Hike view's "next town" strip (`services/distance-calculator.ts`) keeps counting every
  resupply-family waypoint. "Next *planned* resupply" is a different question and a follow-up.
- Waypoint detail screen: the four access fields are not shown yet. Cheap to add as a line under
  the description ("22.5 km by hitching from Chief Mountain border crossing · accepts boxes") and
  it uses the same `accessSummary`; do it in this PR if there is time, otherwise the follow-up
  list.

## Phase 5 — verification and docs

- `cd mobile && npx tsc --noEmit && npx jest && npx expo lint`; root `npm test` (the lifted
  helpers' tests and `resupply-tab.test.ts` after the refactor).
- Emulator, CDT guide → Plan: expand the list, untick Poncha Springs, confirm one Monarch Pass stop
  either way; untick everything between two towns and watch the two legs merge and the ascent add
  up; `None` → the empty-state text; `All` → back to one leg per group; flip direction from the
  guide and confirm the same names are ticked with mirrored km; narrow the section to
  Colorado and confirm out-of-section rows dim and the card only shows Colorado legs; kill and
  relaunch the app and confirm the selection is back; switch units to `mi` and check the
  sublines and elevation. Cape to Cape (3 options, no `accessName`) for the no-group-header case;
  an imported GPX with no resupply waypoints for the first empty state. Both themes; screenshot
  each via `adb exec-out screencap`.
- `mobile/maestro/plan-screen.yaml`: add `assertVisible: "Resupply stops"` and a tap on the
  chevron by its accessibility label followed by `assertVisible: "All"`; keep off waypoint names.
- CLAUDE.md: the `plan/` slice line gains `ResupplySelectList.tsx`; the "Shared calculators"
  paragraph names `resupply-plan.ts` and `resupply-display.ts`; the mobile "State" note that only
  pace + daily hours persist becomes pace + hours + resupply selection. `plans/tracknotes-backlog.md`
  gets a line; `plans/resupply-selection.md`'s status line and Phase 4 section point here; issue
  #73 closes with the PR.

## Sequencing

| # | Work | Files | Depends on |
|---|------|-------|-----------|
| 1a | `TrailJson` access fields | `services/trail-assets.ts` | PR #74 |
| 1b | Lift `firstSentence` / `accessSummary` / summary text to `src/lib/resupply-display.ts` | `src/lib`, `plan-viewer.ts` | PR #74 |
| 2 | Store field + action + guard + tests | `plan-inputs-store.ts` | — |
| 3 | Adapter: groups, stops, legs, summary + tests | `plan-adapters.ts` | 1a |
| 4a | `ResupplySelectList` + tests | `features/plan/` | 1b, 3 |
| 4b | `ResupplyCard` legs + tests | `features/plan/` | 3 |
| 4c | Screen wiring | `app/guide/[trailId]/plan.tsx` | 2, 4a, 4b |
| 5 | Emulator pass, Maestro, docs | — | 4c |

One PR, branched from `feature/load-cdt-data` until PR #74 merges, then rebased onto `main`
(rebase, never merge — the repo is rebase-and-merge only). 2 can start today on `main`; everything
else needs the calculator and the regenerated assets from #74. 1b touches web code, so run the
root `npm test` before and after it.

## Follow-ups (recorded, not in this PR)

- Ticked stops on the map pane and as profile markers, and "next planned resupply" in the Hike
  distance strip — all three want the selection outside the plan screen, which means a selector
  on the store other features import (`selectResupplyStops(trailId)`) and a decision about what
  the strip shows when the hiker has ticked nothing ahead.
- Access fields on the waypoint detail screen, if not done in 4d.
- A text filter over the list, if the CDT proves unusable without one.
- Carrying the selection in the `.tracknotes.json` handoff (it would need the handoff to carry a
  plan, which it does not).
- Everything `plans/resupply-selection.md` lists as out of scope: zero days at a ticked stop,
  alternates implied by a town choice, per-option days off.

## Risks

- **Base branch.** The calculator, the types and the regenerated assets are all on an open PR.
  Building on it and rebasing later is the plan; if #74 changes shape in review (a rename in
  `resupply-plan.ts`, say) this PR follows it.
- **Selector reference stability.** `prefs.resupplyStops` is a new array on every `set`, which is
  what the `WeakMap` memo expects, but the `selectedIds` `Set` in the screen must be memoised on
  it, or every render builds a new `Set` and every row re-renders. The store test for a stable
  `selectPrefs` reference guards the store half; a render-count assertion in the list test guards
  the other.
- **Stale ids.** An id saved against an older bundled build is ignored when resolving and pruned
  on the next toggle, never on load, so a hiker who never touches the list after an app update
  keeps a selection that silently omits a renamed town. Acceptable: the web made the same call,
  and a renamed waypoint is a registry churn the data rules already forbid.
- **List length on the CDT.** 70 rows inline is the untested bet in decision 2. The sheet fallback
  is one component swap because the list is presentational.
