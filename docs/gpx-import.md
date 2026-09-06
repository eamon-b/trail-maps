# Importing your own GPX

Tracknotes (the web upload page and the mobile "＋" button) turns a GPX file
into a trail guide: a map, an elevation profile, a waypoint list and a plan
calculator. This page explains exactly what the importer does with your file,
so you can prepare GPX that works well and understand the "Worth knowing"
notes it shows after an upload.

The same code runs in the browser, on the phone and in the project's own build,
so a file imports identically everywhere.

## What goes in

- A `.gpx` file (GPX 1.0 or 1.1). Up to 50 MB on the web, 20 MB on mobile,
  and at most 100,000 track points in total.
- `.tracknotes.json` files exported from the web "Export for Tracknotes"
  button are also accepted on mobile; they skip the pipeline below and load
  as already-built trails.

Nothing is uploaded to a server. The file is processed on your device and the
result is stored locally (IndexedDB in the browser, the app's documents
directory on mobile). The one optional network call is elevation backfill
(below).

## Step by step

### 1. Tracks and waypoints are read

- Every `<trk>` becomes a track; its `<trkseg>`s are joined end to end.
- If the file has no `<trk>` at all, all `<rte>` points are used as a single
  track called "Route".
- Every `<wpt>` becomes a waypoint. Its `<name>`, `<desc>` and `<type>` are
  kept.
- Coordinates are parsed strictly: a point with a malformed `lat`/`lon` makes
  the import fail rather than plotting at 0,0.

### 2. The trail is named

In order of preference: the name you type on the import screen, then
`<metadata><name>`, then the first track's `<name>`, then "Imported trail".

### 3. Tracks are classified by name

Each track's name is matched (case-insensitively) against these patterns:

| Name contains… | Becomes |
| --- | --- |
| `Alt` (as a word), `Alternative`, `Detour`, `Reroute` | an **alternate route** |
| `ST:` (at the start), `Spur`, `Side Trip` | a **side trip** |
| anything else | part of the **main route** |

So a file with `Day 1`, `Day 2`, `Day 3`, `Side trip: Summit` and
`Alt: High route` produces a three-leg main route, one side trip and one
alternate.

Alternates and side trips are drawn on the map and listed as variants. They
are matched to the main route at both ends (within 500 m) so the guide can
show where they leave and rejoin; waypoints within 200 m of a variant are
attributed to it.

### 4. Main-route tracks are chained into one line

If more than one track is classified as main route, they are joined by
geography, not file order: starting from the first track, the importer
repeatedly appends whichever remaining track has an end closest to the
current end, reversing tracks where that closes the gap. A gap of more than
100 m between two legs is reported ("…m gap between "Day 2" and "Day 3"") —
the route is still built, with a straight line across the gap.

**Gotcha:** two tracks that overlap or run parallel (say a recorded track
*and* a planned one) will both be treated as main route and chained into a
route that walks the trail twice. Delete one, or name it as a side trip or
alternate.

### 5. Big tracks are thinned

Tracks over 5,000 points are simplified (Douglas–Peucker, keeping the shape)
down to about 5,000 before anything else is computed, so distances, the
profile and waypoint positions all agree. A second, lighter copy of around
3,000 points is made for drawing the map. The report says "simplified" when
this happened; distances are unaffected in practice.

### 6. Elevation is cleaned

- If no point has a usable `<ele>`, the profile is flat and day estimates are
  distance-only. The import screen offers to **fetch elevation** from
  [Open-Elevation](https://open-elevation.com/); only the track's coordinates
  (up to 2,000 samples, interpolated between) are sent.
- If elevation is present, single-point spikes of more than 50 m are removed,
  a 7-point moving average is applied, and climbs under 3 m are ignored when
  totalling ascent. Barometric recordings routinely inflate ascent 2–3×
  without this; if the raw total was more than 1.5× the cleaned one the
  report says the elevation "looks noisy".

### 7. The route is checked for doubling back

The importer looks for stretches where the main route retraces itself for
2 km or more and reports them: "The route doubles back on itself for 5.2 km
at the end of the route". This is **advice, not a problem** — a walk into town
and back out is a legitimate part of many trails, so nothing is changed
automatically. Those kilometres do count twice in the trail length, and any
waypoint on the retraced stretch appears twice in the list (the second copy
gets a distinct id).

If the section is really a side trip, move those points into their own
`<trk>` named `Side trip: …` and re-import; step 3 will then lift it off the
main route.

### 8. Waypoints are placed on the route

Each waypoint is snapped to the nearest point of the main route. Waypoints
within 500 m of the route get a km position and show in the list and on the
profile; anything further away is kept as "off-trail" (on the map, not in the
distance list). The report gives both counts.

### 9. Waypoints are given a type

A waypoint's **type** is the whole reason the guide can plan: it decides the
icon, whether the point counts as water, and whether it counts as a place to
buy food. The types the guide understands are `campsite`, `hut`, `water`,
`water-tank`, `town`, `resupply`, `food`, `accommodation`, `caravan-park`,
`trailhead`, `road-crossing`, `inlet-crossing`, `side-trip`, `mountain`,
`beach`, `endpoint`, `poi`, and `waypoint` for "not categorised".

The type is decided by the first of these that produces an answer:

1. **The GPX `<type>` element**, taken as-is and never overridden. If your
   file says `<type>campsite</type>`, that is the type — including a word of
   your own the guide has never heard of, which is kept verbatim and shown
   with a tidied-up label.
2. **A prefix on the name**, which is then *stripped from the name*:

   | Prefix | Type | Prefix | Type |
   | --- | --- | --- | --- |
   | `C:` | campsite | `TH:` | trailhead |
   | `W:` | water | `CP:` | caravan park |
   | `WT:` | water tank | `IC:` | inlet crossing |
   | `H:` | hut | `ST:` | side trip |
   | `T:` | town | `M:` | mountain |
   | `F:` | food | `S:` / `E:` | start / end point |

   A space works instead of the colon (`C Long Gully`), and road crossings
   are the space form only: `R Bogong High Plains Rd`. The delimiter is
   required, which is why `Campsite Area` and `Eastern Access` are left
   alone rather than being read as `C`- and `E`-prefixed.
3. **A built-in list of Australian trail towns** (Alice Springs, Walhalla,
   Pemberton, Quorn and about two dozen others) → `town`. This outranks
   prefixes, so `Mt Hotham` is a town rather than a mountain.
4. **Words anywhere in the name** — see below. *Imported files only.*
5. Otherwise the waypoint is left **not categorised**, rather than guessed at.

#### Types guessed from the name

Most GPX files in the wild use none of the conventions above: they just have
names like `Wallaby Creek Campsite` or `Coles Supermarket`. So for a file you
import, the guide reads the name for these words. (Trails built into the app
skip this step — their waypoints are already categorised by hand, and guessing
would only add noise.)

| Words in the name | Type |
| --- | --- |
| caravan park, holiday park, tourist park | caravan park |
| road crossing, highway crossing, hwy crossing | road crossing |
| side trip | side trip |
| inlet crossing | inlet crossing |
| water tank, rainwater, tank water | water tank |
| drinking water, potable water, water source, water point, water tap, water pump, water trough, waterhole, soak, bore, trough, tap | water |
| campsite, camp site, campground, camping area, camping ground, tentsite, tent site, bush camp, free camp | campsite |
| hut, shelter, refuge | hut |
| hotel, motel, hostel, lodge, B&B, bed and breakfast, guesthouse, backpackers, cabin, resort, pub, tavern | accommodation |
| general store, corner store, village store, store, post office, food drop, food cache, food parcel, supermarket, grocery, roadhouse, bakery, takeaway, kiosk, cafe, deli, IGA, Foodland, Coles, Woolworths | food |
| resupply | resupply |
| trailhead, trail head, track head, car park, carpark, parking | trailhead |
| summit, trig point, trig, peak, Mt, Mount | mountain |
| lookout, viewpoint, waterfall, rest area, picnic area, picnic table, toilet | point of interest |
| beach | beach |
| trail start, trail end, route end, end point, terminus, start, finish | start / end point |

Whole words only, plurals included, so `Huts` matches and `Hutchinson` does
not; earlier rows win, so `Caravan Park` is not read as parking and
`Side trip: Mt Ossa` is a side trip rather than a mountain. **The name itself
is never changed** by this step — only a prefix is ever stripped.

Some words are deliberately *not* used, because in Australian place names they
mean the wrong thing far too often: bare `creek`, `river`, `spring`, `dam` and
`well` are not read as water (Falls Creek is a town, Spring Gully is a road),
bare `camp` is not read as a campsite (Camp Road), and a town is never guessed
from its name, because inventing a resupply would quietly shorten how much
food the plan tells you to carry. A `pub` is filed as accommodation rather
than food for the same reason: accommodation never counts towards resupply, so
a guess can never make a food carry look shorter than it is.

The import report tells you how many waypoints were typed this way and how
many are still uncategorised.

#### Fixing a category

Guessing from words is never going to be right every time, so on an imported
trail's page you can set the category yourself: open a waypoint's row in the
waypoint list and choose from the **Category** menu. The change is saved with
the trail and is picked up by the plan calculator, the map icon and the
water/food filters. Trails built into the app are read-only.

#### What the types are used for

- **Town, food and resupply points** are the resupply stops: the plan
  calculator measures food carries between them, and the waypoint list can be
  filtered down to just these to read the leg distances off directly.
- **Water and water tank** points drive the water-carry distances and the
  water filter.
- **Campsites and huts** are the candidate overnight stops when the plan
  splits the walk into days.
- **Accommodation and caravan parks** are shown but deliberately *not*
  counted as resupply — a bed is not a shop.

Common words other people's files use are understood as aliases here even
though the guide never writes them itself: a waypoint typed `spring`,
`creek`, `tap` or `bore` counts as water, and one typed `supermarket`,
`store`, `roadhouse` or `post-office` counts as resupply.

### 10. Identity

- The trail id is `u_` followed by a hash of the file's contents, so
  importing the same file twice updates the existing guide instead of adding
  a duplicate. Changing anything in the file makes a new guide.
- Waypoint ids are minted locally (`uw_…`) and never sent to the comments
  service; imported trails have no shared comments.

## Points of interest (optional)

Waypoints come from your file. **Points of interest** come from
[OpenStreetMap](https://www.openstreetmap.org/), and they are opt-in: on an
imported trail's page, **Find points of interest** searches a 2 km-wide corridor
along the whole route — the main line plus every alternate and side trip — for
water, campsites, shops and other resupply, transport, and emergency services.

- The search runs **from your browser straight to OpenStreetMap's Overpass API**.
  Nothing is uploaded to us, but the shape of your route does leave your device:
  the query is the route corridor. This is the only step besides elevation
  backfill that touches the network.
- A long trail is split into several queries, sent one at a time a couple of
  seconds apart because that is what the free Overpass servers ask for. A route
  of a few hundred kilometres takes a minute or two. Progress shows which area
  is being fetched, and **Cancel** stops it — nothing is saved until it finishes.
- If some areas fail (a busy server, a dropped connection) the results from the
  rest are still kept, and a note tells you the coverage is partial. Searching
  again retries.
- Results are **stored with the trail in this browser**, like everything else
  about an import, and are included when you export the trail for the mobile
  app.

Points of interest are kept **separate from your waypoints**. They are shown on
the map, never merged into the waypoint list, and never counted by the plan
calculator — an OSM tap is not a water source you have checked. Nothing about
your file is changed by the search, and **Remove points of interest** deletes
them again in a click. If a point turns out to matter, add it to your GPX as a
proper waypoint and re-import.

Point-of-interest data is © OpenStreetMap contributors and is used under the
[Open Database License](https://opendatacommons.org/licenses/odbl/); the
attribution is shown on the trail page whenever POIs are loaded.

## Reading the "Worth knowing" notes

| Note | Meaning | What you can do |
| --- | --- | --- |
| *…m gap between "A" and "B"* | Two main-route legs don't meet | Fine if the gap is a ferry/road transfer; otherwise fix the recording or add the missing leg |
| *No elevation data in this file* | No `<ele>` values | Use **Fetch elevation**, or export the file with elevation |
| *Elevation looks noisy* | Ascent was cleaned (see step 6) | Nothing needed; the cleaned figure is the one shown |
| *The route doubles back on itself* | An out-and-back inside the main route | Leave it if it's the walk; otherwise make it a `Side trip:` track |
| *N waypoints off trail* | Further than 500 m from the route | Move them closer, or accept they're map-only |

Alongside these notes the report counts **categorised from their names** and
**not categorised** — how many waypoints were typed from their words in
[step 9](#9-waypoints-are-given-a-type), and how many are still uncategorised
and worth [setting by hand](#fixing-a-category).

## Preparing a good file

- One `<trk>` for the whole walk, or one per day/leg — both work.
- Name side trips and alternates so they are recognised (`Side trip: …`,
  `Alt: …`).
- Put useful waypoints in the file, and give each one a category the importer
  can see, so the plan calculator can use it. Any of these works: a `<type>`
  element, a prefix on the name (`C:`, `W:`, `T:`…), or simply a descriptive
  name — `Wallaby Creek Campsite` and `Water tank at the shelter` are both
  categorised correctly on their words alone. Water sources and food stops are
  the two that change the plan, so they are the two worth getting right.
- Anything the importer could not categorise is listed in the report, and you
  can set its category from the trail page afterwards — no need to edit the
  file and import again.
- Keep the route walking in the direction you want km 0 to be; the guide can
  be reversed on screen, but the file's first point is the start.
- Include `<ele>`, preferably from a DEM-corrected export rather than a
  barometer, for the best ascent figures.
