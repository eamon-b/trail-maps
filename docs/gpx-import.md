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

A waypoint's **type** (the icon and how the plan treats it) comes from, in
order:

1. the GPX `<type>` element, taken as-is — the types the guide understands
   are `campsite`, `hut`, `water`, `water-tank`, `town`, `resupply`,
   `accommodation`, `trailhead`, `caravan-park`, `road-crossing`,
   `side-trip`, `mountain`, `beach`, `food`, `inlet-crossing`, `poi` and
   `endpoint`;
2. a prefix on the name, which is then stripped — `C:` campsite, `H:` hut,
   `W:` water, `WT:` water tank, `T:` town, `TH:` trailhead, `CP:` caravan
   park, `ST:` side trip, `M:` mountain, `F:` food, `IC:` inlet crossing,
   `S:`/`E:` start/end point (a space after the letter works too:
   `C Long Gully`);
3. a well-known town name;
4. otherwise "point of interest".

Towns and resupply points are what the plan calculator uses for resupply
legs; water and water-tank points drive the water-carry distances; campsites
and huts are the candidate overnight stops.

### 9. Identity

- The trail id is `u_` followed by a hash of the file's contents, so
  importing the same file twice updates the existing guide instead of adding
  a duplicate. Changing anything in the file makes a new guide.
- Waypoint ids are minted locally (`uw_…`) and never sent to the comments
  service; imported trails have no shared comments.

## Reading the "Worth knowing" notes

| Note | Meaning | What you can do |
| --- | --- | --- |
| *…m gap between "A" and "B"* | Two main-route legs don't meet | Fine if the gap is a ferry/road transfer; otherwise fix the recording or add the missing leg |
| *No elevation data in this file* | No `<ele>` values | Use **Fetch elevation**, or export the file with elevation |
| *Elevation looks noisy* | Ascent was cleaned (see step 6) | Nothing needed; the cleaned figure is the one shown |
| *The route doubles back on itself* | An out-and-back inside the main route | Leave it if it's the walk; otherwise make it a `Side trip:` track |
| *N waypoints off trail* | Further than 500 m from the route | Move them closer, or accept they're map-only |

## Preparing a good file

- One `<trk>` for the whole walk, or one per day/leg — both work.
- Name side trips and alternates so they are recognised (`Side trip: …`,
  `Alt: …`).
- Put useful waypoints in the file with a type prefix (`C:`, `W:`, `T:`…) so
  the plan calculator can use them.
- Keep the route walking in the direction you want km 0 to be; the guide can
  be reversed on screen, but the file's first point is the start.
- Include `<ele>`, preferably from a DEM-corrected export rather than a
  barometer, for the best ascent figures.
