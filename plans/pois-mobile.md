# OSM points of interest on mobile

PR #63 (`feat/osm-pois`) fetches OpenStreetMap POIs for the six bundled trails,
shows them on the web trail pages, lets an imported trail search for its own,
and carries them in the `.tracknotes.json` handoff. What it does **not** do is
show them in Tracknotes: `scripts/build-mobile-trails.ts` strips `pois` from the
bundled assets, and the app has no POI surface, so a handoff file that arrives
with 400 POIs imports fine and then shows none of them.

This plan closes that gap. Status: **implemented** on
`claude/osm-points-mobile-app-o76w0c` (PR #67) on top of `feat/osm-pois`; the
on-phone Overpass search in the last section is still a follow-up.

## Decisions already taken

Settled with Eamon on 2026-09-09, so the phases below do not re-open them:

| Question | Decision |
|---|---|
| Bundled trails | **Ship POIs in the bundled assets, with slimmed tags.** Offline-first app; ~280 KB across six trails. |
| Surfaces | **Map, List pane, a POI detail screen, and ticks on the elevation profile.** |
| Controls | **A "layers" control on the map opens a sheet: master switch + six category toggles with counts. On by default.** One global filter state, persisted in the settings store — the mobile twin of the web's `localStorage` state. |
| On-phone Overpass search for a GPX imported on the device | **Follow-up PR.** This PR leaves the store able to take POIs later and writes the plan (last section). |

## Invariants carried over from the web work

These are the rules `feat/osm-pois` was built on. Every phase below has to
leave them true on the phone too.

- **POIs never become waypoints.** They are a separate array, carry no
  `data/waypoint-ids.json` id, never reach the comments API, never enter
  `trail.waypoints`. On mobile that additionally means: not in the plan
  calculators (`plan-adapters.ts` reads `trail.waypoints` only — unchanged), not
  in the GPS "what's next" strip (`DistanceStrip` reads `orderedWaypoints` —
  unchanged), not favouritable, no comments, no water-status reports.
- **A POI marker must never be mistaken for a curated waypoint.** Distinct badge
  treatment on the map, an "OSM" badge on every row and screen, attribution
  wherever POI data is shown.
- **Flagged duplicates (`duplicateOf`) are hidden**, never drawn and never
  listed. They stay in the data for their OSM detail.
- **An absent `pois` means "never fetched"**, not "found nothing". A trail with
  no `pois` key shows no POI control at all.
- **Every string in a POI is untrusted.** React Native text is not an injection
  surface the way `innerHTML` is, but URLs are: `website`/`phone` tags go through
  the same scheme checks the web uses before `Linking.openURL`.

## Measured payload

From `data/trails/*/pois.json` after the build's noise + rejected passes, as of
the 2026-09-09 fetches. "Slim" keeps only the tag keys the UI reads (below) and
rounds coordinates to 5 dp / distances to 0.1 km, matching `truncateWaypoint`.

| Trail | POIs shipped | full tags | slim tags | asset today |
|---|---:|---:|---:|---:|
| bibbulmun | 444 | 149 KB | ~90 KB | 496 KB |
| heysen | 459 | 152 KB | ~92 KB | 706 KB |
| hume-and-hovell | 281 | 92 KB | ~56 KB | 433 KB |
| aawt | 213 | 63 KB | ~42 KB | 721 KB |
| larapinta | 125 | 36 KB | ~25 KB | 502 KB |
| cape_to_cape | 40 | 12 KB | ~8 KB | 359 KB |
| **total** | **1562** | **504 KB** | **~310 KB** | 3.2 MB |

So roughly +10% on the bundled trail data. Acceptable; slimming is what keeps
Heysen's asset under 800 KB.

## Phase 1 — data: bundled assets and the shared helpers

### 1a. `scripts/build-mobile-trails.ts` ships `pois`

Replace the `delete trailWithoutPois.pois` with a `slimPoi()` pass:

- keep `id`, `type`, `category`, `name`, `duplicateOf`; round `lat`/`lon` to 6 dp
  (same as waypoints), `distanceAlongTrail` to 0.1 km, `distanceFromTrail` to
  0.01 km;
- drop `duplicateDistanceM` — a review aid, meaningless on the phone;
- keep only these tag keys: the primary feature tag that
  `summarisePoiTags` shows (`amenity`, `shop`, `tourism`, `natural`, `man_made`,
  `emergency`, `highway`, `healthcare`, `leisure` — first match only) plus
  `description`, `opening_hours`, `drinking_water`, `water_source`, `fee`,
  `access`, `capacity`, `operator`, `ele`, `phone`, `contact:phone`, `website`,
  `contact:website`, `url`. Export the list from the shared module below so
  the build and the UI cannot disagree about what is worth keeping.

Noise (`@lib/poi-noise`) and duplicate flagging (`@lib/poi-dedup`) have already
run in `build-trails.ts`; the mobile build reads their output and does neither
again. Slimming after those passes is what makes it safe to drop `highway` and
`shelter_type` from the shipped tags.

Print the per-trail POI count and size delta in the build log next to the point
counts. Add a Vitest case (`scripts/build-mobile-trails.test.ts` is new) that a
POI with twenty tags comes out with only the allowed ones and that `pois` is
omitted, not `[]`, for a trail without one.

**Build gate:** rerun `npm run build:trails && npm run build:mobile-trails` and
`diff -r` `mobile/assets/trails` against a copy taken before — the only change
allowed is the new `pois` key (and `dataVersion`). `data/waypoint-ids.json` must
not move.

### 1b. Lift the pure POI helpers into `src/lib`

`src/web/trails/trail-pois-ui.ts` is half markup and half platform-neutral
logic. The neutral half moves to a new **`src/lib/poi-display.ts`** and the web
file re-exports it, so the phone and the page share one definition of:

- `POI_CATEGORIES`, `POI_CATEGORY_LABELS`, `isPoiCategory`, `poiCategoryLabel`
- `poiDisplayName`, `poiOsmUrl`, `formatOffTrail`
- `summarisePoiTags` → `PoiTagLine[]` (+ the `safeHttpUrl` / `safeTelUrl`
  guards; `POI_DISPLAY_TAG_KEYS` exported for 1a)
- `PoiFilterState`, `defaultPoiFilterState`, `normalisePoiFilterState`
- `countPoisByCategory`, `visiblePois`, `mirrorPoiDistances`,
  `interleavePoisByDistance`
- `poiRouteKey(poi)` → `` `${type}-${id}` `` and `parsePoiRouteKey` — the
  `/`-free form a route param can carry (see Phase 4). `poiKey` keeps its
  `type/id` form for data.

Left behind in the web file: `POI_CATEGORY_ICONS` (emoji — the map on the phone
uses PNG glyphs), the `*Html` builders, `localStorage` load/save. Its tests move
with the functions; `trail-pois-ui.test.ts` keeps the markup cases.

Also add `mirrorPoiDistances` to the *reverse* path once, in
`@lib/trail-reverse` (`createReversedTrail` mirrors `pois` when present) so the
web viewer's special case and the mobile `resolveGuideTrail` both go away.
Because `createReversedTrail` is shared with the plan viewer, this needs one
test in `trail-reverse.test.ts` and a check that the web's `getReversedTrail`
no longer double-mirrors.

### 1c. Types on the app's read side

`mobile/src/services/trail-assets.ts` — add `pois?: TrailPOI[]` to `TrailJson`
(import the type from `@lib/trail-types`). Nothing else changes: bundled and
imported trails both flow through `loadTrail`, and `parseHandoffJson` already
validates and passes `pois` through.

### 1d. Filter state in the settings store

`mobile/src/state/settings-store.ts` gains `poiFilter: PoiFilterState` (default
`defaultPoiFilterState()`), `setPoiEnabled`, `setPoiCategory`, persisted via
`partialize` and run through `normalisePoiFilterState` in a `merge`, so a
future category never crashes an old persisted blob. A `selectVisiblePois(trail)`
hook in `features/guide/use-visible-pois.ts` composes the store state with the
guide's trail and is the one place the map, list and profile read from.

## Phase 2 — map layer and the layers sheet

### 2a. Glyphs

`scripts/build-map-icons.mjs` gains three glyphs: `restaurant` (fork and knife),
`transport` (a bus front; the survivors of the bus-stop filter are rail stations
and a ferry, but the bus reads as "public transport" at 13 px), `emergency`
(a cross). `water`, `campsite`, `resupply` are reused. Add the three to
`WAYPOINT_ICON_NAMES`, `WAYPOINT_ICON_IMAGES` and a `poiIconName(category)` in
`waypoint-icons.ts`; the existing parity test (every name has a PNG, GuideMap
registers every name) covers them.

*Risk:* the rasteriser is ImageMagick + librsvg, which this build box does not
have. Fallback: render with `@resvg/resvg-js` through `npx` (prebuilt binaries,
no system deps) — add it as an opt-in path in the script rather than a new
devDependency, or generate the three PNGs on Eamon's machine.

### 2b. GeoJSON and layers

`map-geojson.ts`: `buildPoiCollection(pois, colorForCategory)` → features with
top-level `id = poiRouteKey`, properties `{ id, name, category, color, icon }`.
No clustering.

`GuideMap.tsx`: a new `guide-pois` source declared **before** `guide-waypoints`
(native tap resolution picks the highest source, so a waypoint on top of a POI
wins the tap). Three layers:

- `guide-pois-circles`: radius 7 (vs 9), fill = category colour at low alpha
  over the badge white, ring = category colour at 1.5 px. Smaller, tinted, thin
  ring — read as "lead", not "waypoint". `minzoom: 11` — at overview zooms 459
  Heysen POIs are noise, and no clustering means they simply do not draw.
- `guide-pois-icons`: `iconImage: ['get','icon']`, same icon size, overlap on.
- `guide-pois-labels`: `minzoom: 13`, `textOptional`, lower priority than
  waypoint labels (`symbolSortKey`).

Category colours: a `poiColor(category, colors)` in `elevation/waypoint-category.ts`
mapping water→`waypointWater`, camping→`waypointCamp`, resupply/restaurant→
`waypointTown`, transport→`waypointJunction`, emergency→`waypointHazard`. No new
theme tokens; the ring/fill treatment carries the "this is OSM" signal.

New prop `pois?: MapPoi[]` and `onPoiTap?: (routeKey: string) => void`; the
handler stops propagation like the others. `MapPane` passes
`useVisiblePois(trail)` and routes taps to the detail screen (Phase 4).

### 2c. Layers sheet

`features/map/LayersButton.tsx` + `PoiLayersSheet.tsx` (`@gorhom/bottom-sheet`,
already a dependency). A ◫ button in the FAB stack, only rendered when
`trail.pois` exists. Sheet content: "Points of interest (OpenStreetMap)" master
switch; six rows with glyph, label, count (from `countPoisByCategory`, so
duplicates are excluded and "Camping · 13" means 13 markers), disabled at 0;
the same one-line "uncurated, shown so you can judge it" note and the
attribution the web control carries. Writes straight to the settings store.

Hidden while the variant info card or the route builder bar is up (same trade
`TrackLegend` makes). `TrackLegend` gets a "Points of interest" row when POIs
are visible.

## Phase 3 — List pane

`WaypointListPane` currently renders `Waypoint[]`. It becomes a list of
`ListRow = { kind: 'waypoint', ... } | { kind: 'poi', poi }` built with
`interleavePoisByDistance(orderedWaypoints, visiblePois, w => w.totalDistance)`.

- Family chips: `water` → water POIs; `camp` → camping; `town` → resupply +
  restaurant; `shelter`, `favorites` → none; `all` → all visible. Put the
  mapping in `waypoint-filters.ts` (`poiCategoriesForFamily`) with tests.
- `PoiRow`: an "OSM" pill where the type label sits, category label, name (or
  "Unnamed water"), off-trail distance in the meta column instead of elevation,
  and the same signed distance-from-me the waypoint rows show (from
  `distanceAlongTrail`). Tap → POI detail.
- `keyExtractor`, `scrollToMe` (`currentIndex` finds the first row whose km ≥
  current), and `focusFromItems` / `firstIndexInFocus` all need a `kmOf(row)`
  instead of `totalDistance` — small refactor in `guide-focus.ts`, tested.
- A one-line footer "Rows marked OSM are OpenStreetMap points of interest ·
  © OpenStreetMap contributors" when any POI row is present.

## Phase 4 — POI detail screen

New route `app/guide/[trailId]/poi/[poiKey].tsx`, with `poiKey` in the
`type-id` form (a `/` in a route param is a path separator). Resolves the POI
from `useGuide().trail.pois` by `parsePoiRouteKey`; "not found" state mirrors
the waypoint screen's.

Content, top to bottom: name, category glyph + label + "OpenStreetMap" pill; km
along the trail and off-trail distance, plus signed distance-from-me and ETA
when there is a fix (reuse `formatSignedDistance` / `estimateEtaMinutes`); the
`summarisePoiTags` lines as a definition list, with `website` and `phone` lines
tappable through `Linking.openURL` only when the shared guards returned an
`href`; "Open in OpenStreetMap" (`poiOsmUrl`) and "Open in Maps" (`geo:` on
Android, `maps:` on iOS via `Platform.select`); the "Uncurated OSM data — the
trail's own waypoints are the checked ones" note; attribution.

Explicitly **absent**: favorite heart, comments, water status, check-in share.
No SQLite read and no network request happen on this screen.

## Phase 5 — elevation profile ticks

`ElevationPane` appends POIs to the `waypoints` prop it hands `ElevationProfile`,
tagged so the marker resolver can tell them apart: extend `ProfileWaypoint` with
`kind?: 'waypoint' | 'poi'`. A POI has no elevation, so sample the track:
`findNearestByDistance(displayPoints, distanceAlongTrail)` from
`@lib/track-geometry`, done once per trail in a memo.

Markers: radius 3, stroke-only ring in the category colour (waypoints are filled
dots of radius 4) — the marker resolver already takes a per-item
`{ color, radius }`, so it gains `fill: boolean`. Only drawn when the POI layer
is enabled, and only when the visible window is narrower than 60 km — a full
Bibbulmun profile with 444 hollow rings is unreadable. Tap → POI detail (the
existing hit-test returns the id; `kind` decides the route).

## Phase 6 — direction, duplicates payoff, imports

- **Direction**: covered by 1b (`createReversedTrail` mirrors POI km). A test on
  `resolveGuideTrail` asserts a POI at km 3 of a 130 km trail reads km 127
  reversed and that `distanceFromTrail` is untouched.
- **Duplicates payoff** (the reason `poi-dedup` flags rather than drops): on the
  waypoint detail screen, when some `pois[].duplicateOf === waypoint.id`, show a
  collapsed "From OpenStreetMap" section with that POI's `summarisePoiTags`
  lines and an "Open in OpenStreetMap" link. Pure lookup helper
  `duplicatePoisFor(trail, waypointId)` in `features/guide/waypoint-detail.ts`,
  tested. Small, and the only place a hidden POI is ever visible.
- **Imports**: `parseHandoffJson` already passes POIs through; the import review
  screen (`app/import.tsx`) shows "N points of interest (OpenStreetMap)" when the
  trail has them, and for a GPX import a one-line hint: "Points of interest can
  be added by exporting from the web app" — until the follow-up lands.
  `saveImportedTrail` slims tags with the same `slimPoi` helper (moved to
  `@lib/poi-display` so the build script and the store share it) so a handoff
  with full tags does not sit on disk at twice the size it needs.

## Phase 7 — docs and verification

- `CLAUDE.md`: mobile section (`pois` now bundled; `poi-display` in the shared
  list; the new route and feature files), drop the two "no POI UI yet" sentences
  (`pois.json` bullet, `build-mobile-trails.ts` comment).
- `docs/gpx-import.md` "Points of interest" section: "…included when you export
  the trail for the mobile app, **where they appear on the map, list and
  profile**."
- `plans/poi-waypoint-dedup.md` status line: mobile inherits the flag and shows
  the payoff section.

Tests, all new or extended:

| Where | What |
|---|---|
| `src/lib/poi-display.test.ts` (Vitest) | moved helper tests + `poiRouteKey` round trip + `slimPoi` whitelist |
| `src/lib/trail-reverse.test.ts` | POI km mirrored, cross-track untouched, absent stays absent |
| `scripts/build-mobile-trails.test.ts` | slim output, `pois` omitted when absent |
| `mobile … state/__tests__/settings-store.test.ts` (Jest) | filter persisted; unknown persisted category ignored |
| `map/__tests__/map-geojson.test.ts` | POI collection ids/props; duplicates excluded upstream by `visiblePois` |
| `map/__tests__/GuideMap.test.tsx` | POI source declared before waypoints; `minzoom`; tap → `onPoiTap`; no source when `pois` absent |
| `map/__tests__/waypoint-icons.test.ts` | three new glyphs registered |
| `guide/__tests__/waypoint-filters.test.ts` | family → POI category mapping |
| `guide/__tests__/WaypointListPane.pois.test.tsx` | interleave order, OSM pill, chip filtering, footer |
| `guide/__tests__/guide-focus.test.ts` | mixed rows `kmOf` |
| `guide/__tests__/waypoint-detail.test.ts` | `duplicatePoisFor` |
| `elevation/__tests__/…` | POI markers hollow, hidden when window > 60 km |
| `features/import/__tests__/import-gpx.test.ts` | handoff POI count in report; slimmed on save |

Manual on the emulator (Metro + dev client, per CLAUDE.md): open Heysen → Map:
no POIs at overview, tinted markers from z11, labels from z13; layers sheet
toggles a category and the count matches the markers; List: OSM rows between
waypoints, Water chip shows only water POIs, scroll-to-me lands; Elevation:
hollow ticks only when zoomed in; tap a POI marker/row/tick → detail; open a
`website` link; flip direction and confirm a POI near the start reads near the
end; import a `.tracknotes.json` exported from the web with POIs and repeat;
dark mode for every surface. Then `npx tsc --noEmit`, `npx jest`, `npx expo
lint` in `mobile/`, `npm test` + `npm run lint` at root, and the Phase 1 build
gate.

Order of work: 1 → 2 → 3 → 4 → 5 → 6 → 7. Phases 3, 4 and 5 are independent of
each other once 1 and 2 are in, and are the natural split for parallel
subagents.

## Follow-up (separate PR): searching from the phone

For a GPX imported on the device there is no web page to press "Find points of
interest" on. The sketch, so this PR's store shape does not have to change later:

- Add `gpx-tools` to `mobile/package.json` (git dependency; the root already
  pins `#main`). Verify Metro resolves `gpx-tools/lib/osm-poi`,
  `overpass-client`, `poi-enrichment` — they are plain TS with no Node imports,
  but this is the unverified step.
- Port `src/web/poi-enrich.ts` to `features/import/poi-enrich.ts`: same
  corridor query, same 2 km radius, same `buildRouteScale`/`toTrailPOIs`,
  then `dropNoisePois` + `markDuplicatePois` + `slimPoi`, then
  `saveImportedTrail` (file first, row second — the existing ordering). Progress
  and cancel on a small screen reached from the guide header; wifi-only by
  default (`expo-network`), since a Bibbulmun search is ~30 Overpass queries.
- Needs the endpoint fallback list and the Overpass etiquette note the web has,
  plus a "remove points of interest" action.

## Risks

- **Icon toolchain** (2a) — see the fallback there.
- **Bundle growth** is the one irreversible cost; slimming and the measured
  table above are the mitigation.
- **Tap ambiguity** where a POI and a waypoint sit a few metres apart: the
  duplicate flag already removes the common case (84 of 87 measured pairs are
  campsites), and source order gives the waypoint the tap for the rest.
- **List pane refactor** touches focus hand-off and scroll-to-me, which are the
  subtle parts of that pane — hence the dedicated `guide-focus` tests before
  the UI change.
