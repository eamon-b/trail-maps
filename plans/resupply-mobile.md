# Resupply selection on mobile

Status: planned 2026-09-17; decisions 1 and 2 taken with Eamon 2026-09-18 (PR #77 review) and
marked **[decided]** below. Phase 4 of `plans/resupply-selection.md` (that document, the shared
calculator and the web tab landed with PR #74, `feature/load-cdt-data`, now on `main`). Tracked
as issue #73. **Implemented 2026-09-18 on PR #77** (phases 0 through 4 and the Phase 5 tests,
docs and Maestro update; the emulator pass and screenshots in Phase 5 still want a human with
the device). The phase sections below are kept as the record of what was built and why.

The review also set a rule that outlives this plan, now in CLAUDE.md under "Key Patterns": **the
app informs the hiker's decisions; it never makes them.** Pace, hours per day and every other
figure that says how far or how long is "reasonable" is an input the hiker owns, never a constant
in a UI module. The web plan page's fixed 4 km/h and 8 h/day are the named offender; Phase 0
removes them.

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

1. **[decided] Days per leg come from the hiker's own inputs, on both platforms.** The phone has
   both (`prefs.pace`, `prefs.dailyHours`), so
   `computeResupplyLegs(…, { dailyHours: prefs.dailyHours, baseKmh: PACE_KMH[prefs.pace] })`.
   This replaces `effectiveDailyKm` for resupply; that field stays on `PlanResult` for the
   "Avg/day" summary stat only. The web's hard-coded `RESUPPLY_BASE_KMH = 4` and
   `DEFAULT_RESUPPLY_DAILY_HOURS = 8` are removed, not copied: the web plan page grows the same
   two inputs, and `computeResupplyLegs` stops defaulting either figure (Phase 0). The point of
   the app is not to tell the hiker how far or how long is reasonable; it is to give them the
   numbers they need to decide that themselves.
2. **[decided] The picker is its own modal screen, and a made plan shows everywhere.** Not an
   inline list on the Plan screen: 70 CDT rows in the middle of a `ScrollView` was the untested
   bet, and Eamon called it. `guide/[trailId]/resupply.tsx`, `presentation: 'modal'`, opened from
   the Plan screen's Resupply section (Phase 4a). The Plan screen keeps only the summary row and
   the legs card. In return the selection stops being a plan-screen detail: once the hiker has
   ticked stops, those waypoints are visibly *planned resupply points* on the map, the elevation
   profile, the List pane, the waypoint detail screen and the Hike distance strip (Phase 4d),
   the way a favourite is a favourite on every screen today.
   - "Once a plan is made" is literal: the highlight keys on `prefs.resupplyStops !== undefined`,
     never on the every-option-ticked default. The default still feeds the legs card (a hiker who
     never opens the picker sees a carry between every town, as now), but painting 70 CDT markers
     as "planned" before anyone planned anything would be noise, not information.
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

## Phase 0 — remove the web's hard-coded pace and hours (web, `feature/load-cdt-data`)

This is the fix Eamon asked for in review, and it lands before any mobile work because the
mobile PR builds on the same calculator signature. One commit on `feature/load-cdt-data` (or the
first of the mobile PR if #74 has merged by then).

- **`src/lib/resupply-plan.ts`**: `ComputeResupplyLegsOptions.baseKmh` becomes required and
  `DEFAULT_RESUPPLY_DAILY_HOURS` is deleted. `computeResupplyLegs` throws a `RangeError` on a
  non-finite or non-positive `dailyHours` / `baseKmh` instead of silently substituting 8 and 4:
  a caller without a hiker's figure is a bug, and a fallback is how the constant crept in.
  The `src/lib` tests that relied on the 8 h default pass `dailyHours: 8` explicitly.
- **`src/web/trails/plan-viewer.ts`**: delete `RESUPPLY_BASE_KMH` and the
  `DEFAULT_RESUPPLY_DAILY_HOURS` import and the "the page has no pace inputs" comment. The
  page gets the inputs the phone already has, in the header beside "Start:" (`plan-template.html`
  line 40): a `<select id="plan-pace">` with the three presets (Slow 3 / Average 4 / Fast 5 km/h,
  the same `PACE_KMH` table as `plan-adapters.ts`, lifted to `src/lib/plan-types.ts` so the two
  platforms cannot drift) and an `<input type="number" id="plan-daily-hours" min="1" max="16"
  step="1">`. Both feed `computeResupplyLegs` *and* `computeDays` — the day plan's
  `estimatedHours` currently rides `computeDays`' own `baseKmh = 4` default (plan-viewer.ts
  line 1236), which is the same constant by another route. The `resupplyLegs()` cache key gains
  both values.
- **`src/lib/plan-types.ts` / `plan-state.ts`**: `PlanState.pace?: Pace` and
  `PlanState.dailyHours?: number`. Absent on a plan saved before now = `'average'` and 8, so no
  migration; `isValidPlanState` rejects a non-preset pace or a non-finite hours. Those two
  defaults are the *initial value of an input the hiker can see and change*, which is the
  difference the CLAUDE.md rule draws: a default the hiker sees is fine, a constant they cannot
  reach is not.
- **Tests**: `resupply-tab.test.ts` sets pace/hours through the inputs and checks a leg's days
  moves (a 40 km flat leg: 2 days at Average / 8 h, 1 day at 16 h, 2 days at Slow / 8 h); a
  `resupply-plan.test.ts` case that the calculator throws without `baseKmh`; a `plan-state`
  round trip with and without the two fields.
- **Docs**: `plans/resupply-selection.md` drops "use 4 km/h and 8 h/day" from its web section,
  strikes "Web pace / daily-hours inputs" from its out-of-scope list and answers its open
  question 4 (inputs, yes); CLAUDE.md's plan-page line names the inputs.
- **Not in this phase, same rule**: `computeDays`' and `estimateHikingTime`'s `baseKmh = 4`
  parameter defaults in `src/lib/day-calculator.ts`, `distance-calculator.ts`'s `baseKmh = 4`,
  `waypoint-detail.ts`'s `DEFAULT_PACE_KMH`, and the 15 km dry-stretch / 5-day long-carry /
  680 g-per-day thresholds. Every one is a figure the hiker might reasonably set. They are
  listed in the follow-ups so the sweep is a tracked item, not a surprise in this PR; the two
  the review named are the two that were *fixed in a UI module with no input at all*, which is
  the sharper problem.

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

- `PlanPrefs.resupplyStops?: string[]`. Absent = nothing chosen yet = every option ticked for
  the legs, and *no* highlight anywhere (decision 2).
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
- **`selectResupplyStopIds(trailId)`**: a reactive selector returning `ReadonlySet<string> | null`
  (`null` when no plan has been made), memoised on the stored array the way `selectPrefs` is,
  because the map, profile, list, detail and distance-strip surfaces in 4d all subscribe to it
  from outside the plan screen — the same shape as `selectPaceBaseKmh`, which `DistanceStrip`
  already reads. Everything that highlights reads this and nothing else, so "planned" means one
  thing on every screen.

Tests (`plan-inputs-store.test.ts`): round trip; `undefined` for an entry saved before the field
existed; a stable reference from `selectPrefs` after `setResupplyStops`; a non-string-array
value collapses to `undefined`; `clearTrail` drops it; independence between two trails;
`selectResupplyStopIds` is `null` until the first `setResupplyStops`, a stable `Set` after it,
and `null` again after `clearResupplyStops(trailId)` (the picker's "Reset to all" — distinct
from ticking everything, which stores an explicit full list and *does* highlight).

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

### 4a. The picker: `app/guide/[trailId]/resupply.tsx` + `features/plan/ResupplySelectList.tsx`

A new route in the guide stack, declared in `guide/[trailId]/_layout.tsx` next to `plan` with
`options={{ title: 'Resupply stops', presentation: 'modal' }}` — the root layout's `import`
screen is the existing precedent for a modal route. The Plan screen's Resupply section header
gains a `Choose stops` chip (`Pressable`, `accessibilityRole="button"`, styled like the
"Full trail" reset chip in `PlanInputsCard`) that `router.push`es it. Not a RN `Modal` sheet
like `PoiLayersSheet`: the sheet has no header, no scroll-to-top, no back gesture, and 70 rows
want all three.

The route is thin: it reads `prefs.resupplyStops`, computes `resupplyGroups` the same way the
plan screen does (`listResupplyOptions(trail.waypoints)` in a `useMemo` keyed on the
direction-applied `trail` from `GuideContext`), owns the toggle / all / none / reset handlers,
and renders `ResupplySelectList`. The list is presentational; props: `groups`,
`selectedIds: ReadonlySet<string>`, `section`, `units`, `onToggle(id)`, `onSelectAll()`,
`onSelectNone()`.

Layout, top to bottom:

- **Header row** (sticky, under the navigation header): `12 of 70 stops` count, `All` / `None`
  text chips, and a `Reset` chip that calls `clearResupplyStops` — back to the untouched
  default, which is the only way to turn the highlight off everywhere at once. `All` and `Reset`
  produce the same legs and differ only in whether the trail is "planned"; the chip's caption
  says so (`Reset · clears the plan`).
- **Groups**, in km order, in a `FlatList` (70 rows with an image each; `ScrollView` would mount
  them all). A group with a `label` gets a header line:
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
here the list has the whole screen and is grouped. Revisit if the CDT list is unusable on
device — a modal screen can grow a search field in its header without disturbing the plan.

Tests (`ResupplySelectList.test.tsx`, `react-test-renderer` + the `allText` shim from
`DaySplitList.test.tsx`, theme mocked): the count reads `N of M`; a group header and its
options render; a row carries `accessibilityState.checked`; pressing a row calls `onToggle`
with its id; the subline reads `22.5 km hitch · … · accepts boxes` in km and `14.0 mi hitch`
with `units="mi"`; an out-of-section option shows `outside section`. A small route test
(`resupply-route.test.tsx`, the `plan.tsx` test's mocking of `GuideContext` and the store) that
`All` stores every id, `None` stores `[]`, and `Reset` stores `undefined`.

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

The `Resupply` section becomes: the `Choose stops` chip in its header, then `<ResupplyCard …/>`,
and its subtitle is `resupplySummary` rendered as `N stops · longest carry X / Y days · Z kg
food` (the web's `resupplySummaryText`, lifted into `resupply-display.ts` with the same formatter
injection in 1b, since the phone wants `formatDistance` / `formatFoodWeight`). Summary and card
read the same legs, so they cannot disagree. When no plan has been made the subtitle is prefixed
`Every option · ` so the hiker can tell the default from a plan that happens to tick everything.
The toggle handler lives in the modal route, not here; the plan screen only reads.

The section-guard early return ("Choose a start before the end") stays before all of this.

### 4d. Planned resupply points on every other screen

Decision 2's second half. One flag, read from `selectResupplyStopIds(trailId)` in Phase 2, drawn
the way `favorite` already is on each surface. The set is `null` until a plan is made, and every
surface treats `null` as "nothing is planned" — not as "everything is".

Which waypoint is "planned"? The ticked *option* ids. A ticked town that is 22 km off the route
is a `town` waypoint at the turn-off's km, and its turn-off is a separate `town-access`
waypoint (Te Araroa, the CDT after #74); both carry the flag when either is ticked, resolved once
in `selectResupplyStopIds` by walking `listResupplyOptions`' groups — a turn-off with one ticked
option is a place the hiker's food has to reach, so it is planned too. Keeping that lookup in the
selector means the five surfaces below never learn what a group is.

- **Map** (`map-geojson.ts`, `GuideMap.tsx`): a `plannedResupply` boolean on each waypoint
  feature next to `favorite`; the circle layer's `case` gains a branch — ring in
  `colors.resupplyPlanned` (a new theme token in both themes; not the favourite pink, not a water
  colour), one size up like a favourite. A waypoint that is both favourite and planned shows the
  planned ring (the plan is the rarer, more deliberate signal). No leg polylines, as on the web.
- **Elevation profile** (`ElevationPane.tsx` → `geometry.ts` marker placement): the same set
  passed the way `favoriteIds` is; planned markers get the ring colour and are exempt from the
  zoom-level thinning that hides minor waypoints, so a planned stop is always on the trace.
- **List pane** (`WaypointListPane.tsx`, `list-rows.ts`): a `Resupply` pill on the row, like the
  favourite heart, and a `Planned` entry in the family chips so the list can be reduced to the
  plan (`matchesFamily` gains the case; the chip only renders when the set is non-null).
- **Waypoint detail** (`waypoint/[waypointId].tsx`): a `Planned resupply stop` banner under the
  title, and — because this is where a hiker standing at a trail junction decides — a
  `Plan resupply here` / `Remove from resupply plan` toggle for any resupply-family waypoint,
  calling the same `setResupplyStops` (adding to the current explicit list, or to the full
  default list when none exists, so the first tap from a detail screen makes a plan with every
  other option still ticked). This is also where the access fields go: a line under the
  description, `22.5 km by hitching from Chief Mountain border crossing · accepts boxes`, via
  the lifted `accessSummary`.
- **Hike distance strip** (`DistanceStrip.tsx`, `services/distance-calculator.ts`): the "next
  town" slot becomes "next planned resupply" when a plan exists — `calculateDistancesToWaypoints`
  takes an optional `plannedIds` and, when given, the `town` candidate is the nearest *planned*
  resupply-family waypoint ahead. Label `Resupply` instead of `Town`. With nothing planned ahead
  the slot shows `No planned resupply ahead` rather than falling back to the next unplanned town,
  which would quietly undo the plan on the one screen that matters on the trail.

Tests: `map-geojson.test.ts` flag on / off / null; `GuideMap.test.tsx` planned wins over
favourite; `geometry.test.ts` planned marker survives thinning; a `WaypointListPane` test for the
pill and the `Planned` chip; the detail screen toggle test (first tap from `undefined` stores the
full list plus/minus one id); `distance-calculator.test.ts` for the planned-ahead case and the
empty case.

### 4e. What does not change

- The camp/day plan is untouched by any of this: a planned resupply never adds a day boundary
  (decision carried over from the web).
- Favourites, comments and POIs know nothing about resupply. A POI is never a resupply option.

## Phase 5 — verification and docs

- `cd mobile && npx tsc --noEmit && npx jest && npx expo lint`; root `npm test` (the lifted
  helpers' tests and `resupply-tab.test.ts` after the refactor).
- Web (Phase 0), `npm run dev` → CDT plan page: change pace and hours and watch the Resupply
  tab's days and the Days tab's `~Nh` move together; reload and confirm both persisted; a plan
  saved before the fields existed loads at Average / 8 h.
- Emulator, CDT guide → Plan → `Choose stops`: the modal opens with every row ticked and the
  count `70 of 70`; untick Poncha Springs, close, confirm one Monarch Pass stop either way;
  untick everything between two towns and watch the two legs merge and the ascent add up;
  `None` → the empty-state text; `All` → back to one leg per group; `Reset` → the `Every option`
  subtitle and no highlights; flip direction from the guide and confirm the same names are ticked
  with mirrored km; narrow the section to Colorado and confirm out-of-section rows dim and the
  card only shows Colorado legs; kill and relaunch the app and confirm the selection is back;
  switch units to `mi` and check the sublines and elevation.
- Then the highlights, with a plan of three stops: Map pane shows three ringed markers and no
  others (zoom out, zoom in); Elevation pane shows three ringed ticks at every zoom; List pane's
  `Planned` chip lists exactly those three with the pill, and each row's detail screen shows the
  banner and the `Remove` toggle; tap `Remove` on one and watch the map, profile, list and plan
  legs all update; on the Hike view (mock location via `adb emu geo fix`) the strip reads
  `Resupply` with the km to the next planned stop, and `No planned resupply ahead` past the last
  one; `Reset` in the picker clears every highlight at once.
- Cape to Cape (3 options, no `accessName`) for the no-group-header case; an imported GPX with
  no resupply waypoints for the first empty state and the hidden `Choose stops` chip. Both
  themes; screenshot each via `adb exec-out screencap`.
- `mobile/maestro/plan-screen.yaml`: `tapOn: "Choose stops"`, `assertVisible: "All"`,
  `assertVisible: "Reset"`, back; keep off waypoint names.
- CLAUDE.md: the `plan/` slice line gains `ResupplySelectList.tsx`; the route list gains
  `guide/[trailId]/resupply.tsx`; the "Shared calculators" paragraph names `resupply-plan.ts` and
  `resupply-display.ts`; the mobile "State" note that only pace + daily hours persist becomes
  pace + hours + resupply selection; the `map/`, `guide/` and `elevation/` slice lines mention the
  planned-resupply flag; the Key Patterns rule from the review is already in (this PR).
  `plans/tracknotes-backlog.md` gets a line; `plans/resupply-selection.md`'s status line and
  Phase 4 section point here; issue #73 closes with the PR.

## Sequencing

| # | Work | Files | Depends on |
|---|------|-------|-----------|
| 0 | Web pace + hours inputs; calculator stops defaulting them | `src/lib/resupply-plan.ts`, `plan-types.ts`, `plan-viewer.ts`, `plan-state.ts`, `plan-template.html` | PR #74 |
| 1a | `TrailJson` access fields | `services/trail-assets.ts` | PR #74 |
| 1b | Lift `firstSentence` / `accessSummary` / summary text to `src/lib/resupply-display.ts` | `src/lib`, `plan-viewer.ts` | PR #74 |
| 2 | Store field + actions + guard + `selectResupplyStopIds` + tests | `plan-inputs-store.ts` | — |
| 3 | Adapter: groups, stops, legs, summary + tests | `plan-adapters.ts` | 0, 1a |
| 4a | Modal route + `ResupplySelectList` + tests | `app/guide/[trailId]/resupply.tsx`, `_layout.tsx`, `features/plan/` | 1b, 2, 3 |
| 4b | `ResupplyCard` legs + tests | `features/plan/` | 3 |
| 4c | Plan screen wiring (chip + card) | `app/guide/[trailId]/plan.tsx` | 2, 4a, 4b |
| 4d | Planned highlights: map, profile, list, detail, distance strip | `features/map/`, `elevation/`, `guide/`, `waypoint/[waypointId].tsx`, `services/distance-calculator.ts` | 2 |
| 5 | Emulator pass, Maestro, docs | — | 4c, 4d |

Two PRs. Phase 0 is a web change on `feature/load-cdt-data` (a fix to #74's own code, so it
goes there while #74 is open, as its own commit; after #74 merges it is a small PR on `main`).
The rest is one mobile PR, branched from `feature/load-cdt-data` until PR #74 merges, then
rebased onto `main` (rebase, never merge — the repo is rebase-and-merge only). 2 and 4d can start
today on `main` (4d's flag only needs the selector; a `null` set draws nothing); everything else
needs the calculator and the regenerated assets from #74. 1b touches web code, so run the root
`npm test` before and after it.

## Follow-ups (recorded, not in this PR)

- The rest of the hard-coded-figure sweep the CLAUDE.md rule implies (Phase 0 lists them):
  `baseKmh = 4` parameter defaults in `day-calculator.ts` and `distance-calculator.ts`,
  `DEFAULT_PACE_KMH` in `waypoint-detail.ts`, and the dry-stretch (15 km), long-carry (5 days)
  and food (680 g/day) thresholds — each should be an input the hiker sees, with today's value
  as its initial setting.
- A text filter over the picker, if the CDT proves unusable without one.
- Leg polylines or a per-leg colour band on the map, if the ringed markers alone do not read as a
  plan.
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
- **Highlight noise.** The `null`-until-planned rule keeps the default from painting every CDT
  town, but a hiker who taps `All` in the picker gets exactly that. The `Reset` chip and the
  `Every option` subtitle are the way back; if it still confuses on device, the alternative is to
  make the picker's default *nothing ticked* — a decision the web already took the other way,
  so raise it rather than diverge.
- **Two ids per place.** A ticked off-route town and its on-route turn-off are two waypoints,
  and the selector marks both planned. The distance strip must count the turn-off (that is the
  km the hiker's food has to reach) and never the town itself, or "next resupply in 22 km" would
  be the hitch, not the trail. `calculateDistancesToWaypoints` already resolves resupply-family
  types through `RESUPPLY_TYPES`, which lists the `-access` types one by one; keep it so.
- **Phase 0 lands on someone else's PR.** #74 is open; a commit that changes its calculator
  signature and adds two inputs needs Eamon's nod on that PR, not only here.
