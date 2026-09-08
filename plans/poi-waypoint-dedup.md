# POI ↔ waypoint deduplication

OSM POIs and curated GPX waypoints frequently describe the same physical place.
Rather than dropping the duplicate POI, flag it and let the UI collapse it, so
the OSM detail stays available and the decision stays reviewable.

Status: implemented on `feat/osm-pois` (PR #63) — `src/lib/poi-dedup.ts`, wired
into `scripts/build-trails.ts`, the web viewer, the imported-trail flow and the
handoff validator. Written against the six trails fetched on 2026-09-08.

## The problem, measured

Across the four trails with reviewed POI data, **87 of 1155 POIs (7.5%) duplicate
a waypoint that is already on the trail**:

| Trail | duplicates | of total | |
|---|---|---|---|
| bibbulmun | 47 | 552 | 8.5% |
| hume-and-hovell | 23 | 426 | 5.4% |
| larapinta | 13 | 137 | 9.5% |
| cape_to_cape | 4 | 40 | 10.0% |

**84 of the 87 are `camping`.** That is not a coincidence: the curated GPX for
these trails was built around campsites, and OSM maps the same campsites. The
remaining three are two `restaurant` and one `resupply`.

Typical pairs, all of them the same physical place:

```
   5 m  POI[camping] Buddong Hut Camp Site    -> WP[campsite] Buddong hut
  11 m  POI[camping] Rocky Gully Camp Site    -> WP[campsite] Rocky Gully
   1 m  POI[camping] Ball Creek Campsite      -> WP[campsite] Ball Creek Campsite
  74 m  POI[restaurant] Standley Chasm Kiosk  -> WP[food]     Kiosk: Standley Chasm
```

Left alone, the viewer draws two markers a few metres apart and the datasheet
carries two rows for one campsite.

## Decision: annotate, do not delete

A matched POI is **kept in `pois`, flagged, and hidden by default in the UI**.
The three alternatives were considered and rejected:

- **Merge the POI's tags into the waypoint.** Violates the invariant this branch
  is built on — POIs never become waypoints, carry no `data/waypoint-ids.json`
  id, and never enter the registry. It would also make waypoint content depend
  on an external service that changes under us.
- **Drop the POI at build time.** Silent and lossy. The OSM record often carries
  what the curated waypoint lacks — `website`, `opening_hours`, `operator`,
  `capacity`, `fee`. Better to suppress the marker and keep the payload.
- **Hand-list them in `rejected`.** Wrong concept. `rejected` means "we never
  want this"; a duplicate means "we already have this from a better source".
  Conflating them makes a re-fetch unable to tell the two apart, and it is
  manual work that scales with every future fetch.

## The matching rule

A POI is a duplicate of a waypoint when **all four** hold:

1. **Distance ≤ 250 m** (great-circle, POI to waypoint).
2. **Category compatible** with the waypoint's type:
   | POI category | waypoint types |
   |---|---|
   | `camping` | `campsite`, `caravan-park`, `hut`, `shelter`, `camp` |
   | `water` | `water`, `water-tank`, `tank`, `spring`, `water-source` |
   | `resupply` | `resupply`, `food`, `shop` |
   | `restaurant` | `food`, `resupply` |
   | `emergency` | `emergency`, `hospital` |
   | `transport` | *(none — see guard 3)* |
3. **Name score ≥ 0.90**, where both names are reduced to token sets by
   lowercasing, stripping a curator prefix (`R:`, `C?`, `CLOSED C -`, `Kiosk:`),
   dropping any ` - Suffix` tail, and removing generic words (`campsite`,
   `campground`, `camp`, `site`, `shelter`, `hut`, `caravan`, `park`, `holiday`,
   `rest`, `area`, `reserve`, `trackhead`, `trailhead`, `walk`, `in`, `group`,
   `the`, `kiosk`, `closed`, `np`, `national`). Score is 1.0 if either token set
   contains the other, else `max(Jaccard, SequenceMatcher ratio)`.
4. **The POI has a name** after that reduction.

Plain string similarity is not enough: `Finke River Campground` vs `Finke River`
scores 0.67 raw and 1.00 once "campground" is dropped.

### Guards, each earned from a false positive

- **`town` waypoints are never dedup targets.** This was the big one. `BP
  Pemberton`, `Walpole IGA Pioneer Store` and `Premier Hotel Albany` all contain
  their town's name and were collapsing into the `town` waypoints `Pemberton`,
  `Walpole` and `Albany`. A town is an area, not a facility; every shop inside it
  carries its name. Excluding `town` removed 16 false positives from Bibbulmun
  alone.
- **Unnamed POIs are never duplicates.** Cape to Cape has nameless water taps
  23–80 m from campsite waypoints. Those are *complementary* — the waypoint does
  not tell you there is a tap. Requiring a name is what protects them.
- **`transport` is excluded entirely.** No waypoint type corresponds, and bus
  stop names encode direction by word order, which token-set matching destroys
  (see the POI↔POI section).

## Where it runs

A new `src/lib/poi-dedup.ts`, exporting a pure
`markDuplicatePois(pois, waypoints): TrailPOI[]`, following the existing
`src/lib/trail-pois.ts` precedent so web, build and mobile share one
implementation:

- `scripts/build-trails.ts` calls it after `readTrailPOIsForBuild`, where both
  arrays are already in hand, and writes the flag into the generated JSON.
- `src/lib/gpx-import.ts` / `src/web/poi-enrich.ts` call it for imported trails,
  whose waypoints come from the user's own GPX.
- Mobile inherits the flag through the bundled asset and the `.tracknotes.json`
  handoff — no separate logic.

**`pois.json` is not touched.** It stays the pure fetch record plus the
hand-edited `rejected` list. The flag is derived, belongs to the build, and must
be recomputed whenever either side changes — waypoint ids are registry-pinned but
waypoint *positions* are not.

## Data shape

On the generated JSON's POI entries only:

```ts
interface TrailPOI {
  // ...existing fields
  /** Set when this POI duplicates a curated waypoint; the waypoint's stable id. */
  duplicateOf?: string;
  /** Metres between the two, for review and for the UI to explain the match. */
  duplicateDistanceM?: number;
}
```

`build-trails.ts` prints a summary line per trail (`47 POIs flagged as duplicates
of curated waypoints`) so the count is visible in build output without diffing
generated JSON.

## UI behaviour

- **Map**: flagged POIs draw no marker. The curated waypoint is the one true
  marker for that place.
- **Datasheet**: no interleaved row. Leg maths is unaffected either way, since
  POI rows never participate in it.
- **Waypoint detail**: where a flagged POI carries fields the waypoint lacks
  (`website`, `opening_hours`, `phone`, `operator`), surface them on the waypoint
  it duplicates, attributed to OSM. This is the payoff for annotating rather than
  deleting, and it can land in a later pass.
- **Category toggles**: flagged POIs stay out of the visible counts, so
  "camping (13)" means 13 markers.

## Phase 2 (optional): OSM duplicating itself

Separately from waypoints, OSM maps one place twice: 46 pairs in Bibbulmun, 29 in
Hume & Hovell — `Mount Clare hut` + `Mount Clare campsite`, `Ampol` + `Ampol
Foodary`, `Browns Creek Campsite` twice.

This axis needs an **order-sensitive** comparison, unlike the waypoint axis. Most
candidate pairs are bus stops where word order carries the meaning: `Canning Rd
After Recreation Rd` and `Recreation Rd After Canning Rd` are opposite sides of
one intersection — two genuinely different stops that token-set matching wrongly
equates. Either compare ordered, or exclude `transport` here too.

Lower value than phase 1 and independent of it. Recommend deferring.

## Known limitation: many-to-many clusters

On the Larapinta the relationship is not 1:1. "Ormiston Gorge" is 2 POIs against
4 waypoints — `campsite`, `trailhead`, `resupply` (`R: Ormiston Gorge`) and
`food` (`Kiosk: Ormiston Gorge`) — which are facets of one place rather than
repeats of each other. Pairwise flagging handles this acceptably (each POI takes
its best compatible waypoint and stops), but a cluster-aware model would describe
it better. Not proposed here.

## Test plan

- Unit tests for `markDuplicatePois`: the four rule clauses, each guard
  (`town` excluded, unnamed exempt, `transport` excluded), and the name
  reduction (prefix stripping, suffix tails, generic words).
- Fixtures drawn from the real pairs above, including the false positives, so a
  regression that re-collapses `BP Pemberton` into `Pemberton` fails the suite.
- A build-level assertion that flagging changes only the new fields — every other
  byte of `public/data/generated/*.json` stays identical, per the repo's standing
  rule on generated output.
- Expected counts on the bundled trails, as reported by `npm run build:trails`:

  | trail | flagged | of |
  |---|---|---|
  | bibbulmun | 47 | 552 |
  | heysen | 39 | 558 (partial fetch) |
  | hume-and-hovell | 23 | 426 |
  | larapinta | 13 | 137 |
  | cape_to_cape | 4 | 40 |
  | aawt | 4 | 24 (partial fetch) |

  Heysen and AAWT will move once their fetches are completed against a rested
  Overpass endpoint.
