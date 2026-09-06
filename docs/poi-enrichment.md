# OpenStreetMap POI enrichment

`npm run fetch:pois` pulls points of interest from OpenStreetMap along each
trail and writes them to `data/trails/<trail>/pois.json`. The build
(`npm run build:trails`) appends the reviewed entries to that trail's
waypoints. The curated waypoints (GPX, CalTopo, CSV) are never changed; OSM
can only add rows, and only where nothing curated already covers the spot.

## Workflow

```bash
npm run build:trails            # the fetch reads the built route + curated waypoints
npm run fetch:pois              # all trails; or: npm run fetch:pois -- heysen larapinta
# review data/trails/<trail>/pois.json — strike entries by adding their osmId to `rejected`
npm run build:trails            # applies pois.json; appends new ids to data/waypoint-ids.json
npm run build:mobile-trails     # if the mobile bundle should pick them up too
git add data/trails/*/pois.json data/waypoint-ids.json
```

`--offline` re-runs classification and merging from the last raw Overpass
responses (cached under `node_modules/.cache/trail-maps-pois/`), so rule
changes in `scripts/lib/poi-enrichment.ts` can be iterated without re-querying.

## What gets fetched

The rules live in `OSM_RULES` in `scripts/lib/poi-enrichment.ts`. Each maps a
tag combination to one of our waypoint types, with a maximum distance from the
track and whether an unnamed element is acceptable:

| OSM tags | Type | Radius | Unnamed ok |
| --- | --- | --- | --- |
| `amenity=drinking_water`, `man_made=water_tap/water_well`, `natural=spring` | `water` | 300 m | yes |
| `man_made=water_tank` | `water-tank` | 300 m | yes |
| `tourism=wilderness_hut/alpine_hut` | `hut` | 300 m | yes |
| `amenity=shelter` with a name or a hiker `shelter_type` (basic_hut, lean_to, weather_shelter, rock_shelter) | `hut` | 300 m | see left |
| `tourism=camp_site` | `campsite` | 300 m | yes |
| `tourism=caravan_site` | `caravan-park` | 1 km | no |
| `tourism=hotel/motel/hostel` (not `guest_house`/`chalet`: holiday rentals) | `accommodation` | 1 km | no |
| `shop=supermarket` | `resupply` | 2 km | no |
| `shop=convenience/general/grocery/greengrocer`, `amenity=post_office` | `resupply` | 1.5 km | no |
| `amenity=fuel` | `resupply` | 1 km | no |
| `amenity=cafe/restaurant/fast_food/pub`, `shop=bakery` | `food` | 500 m | no |
| `place=town/village` | `town` | 2.5 km | no |
| `highway=trailhead` | `trailhead` | 300 m | yes |
| `tourism=viewpoint` | `poi` | 150 m | no |
| `tourism=picnic_site` | `poi` | 200 m | no |
| `information=visitor_centre` | `poi` | 1.5 km | no |
| `amenity=hospital` | `poi` | 2 km | no |
| `amenity=pharmacy`, `railway=station/halt`, `amenity=ferry_terminal` | `poi` | 1 km | no |

Anything tagged `drinking_water=no` is dropped. Nodes, ways and relations are
all fetched (`out center`), since shops, campgrounds and huts are often mapped
as building outlines rather than points.

The route (plus alternates and side trips) is simplified and cut into chunks
of about 120 vertices; each chunk's bounding box, padded by the widest rule
radius (2.5 km), becomes one Overpass bbox query (a few boxes per request,
with small side-trip boxes folded into the main route's). Bbox queries answer
from Overpass's index in seconds, whereas `around:` polyline queries over a
long corridor time out on the public server. The over-fetch is then trimmed by
the exact per-rule distance below. Requests retry with backoff and fall over
to public mirrors (`overpass.kumi.systems`, `overpass.private.coffee`); set
`OVERPASS_ENDPOINT` to pin one instance.

Distance from the track is the exact distance to the nearest point on the
full-resolution route or any alternate/side trip, not to the nearest vertex.
Entries beyond the trail's `waypointMaxDistance` (500 m by default) become
off-trail waypoints in the build, exactly like a curated waypoint would.

## How duplicates are avoided

An OSM candidate is dropped when a curated waypoint

- of the same **family** is within the family's radius — water 250 m, shelter
  (campsite/hut) 600 m (curated campsite markers often sit on the track at the
  turn-off while OSM maps the shelter up the spur), lodging 300 m, food 150 m,
  resupply shops 150 m, town 3 km, and 200 m for other types with an identical
  type; or
- has the **same name** within 1.5 km — case/punctuation-insensitive, `Mt` =
  `Mount`, and ignoring generic words, so "Long Point" covers "Long Point
  Campsite"; or
- sits within 60 m of another OSM row of the same family that one of the rules
  above already rejected (the hut mapped beside a covered campsite).

Shops and cafes near a curated *town* waypoint are kept on purpose: the town
marker says a town exists, the shop says where the food is.

OSM elements that duplicate each other (same name and family within 300 m, or
unnamed same-type within 60 m) collapse to the one nearest the track. A
candidate the main route passes twice is skipped, because the build refuses a
waypoint that fans into two rows with one id.

Trail towns are then thinned: within any 1 km, at most 3 `food` rows, 3
lodging rows, 4 resupply rows and 3 of each other kind (lookouts, pharmacies…)
survive, admitted supermarkets-first and then nearest-to-track. Water, huts,
campsites and towns are never capped.

The merge runs again at build time, so a curated waypoint added after the last
fetch still wins over its OSM twin without re-fetching.

## Output shape

Every OSM waypoint carries `source: "osm"` in the generated JSON and a
description that ends with the ODbL attribution and the element's URL
(`https://www.openstreetmap.org/node/…`), so a reviewer can jump to the source
and a UI can attribute OpenStreetMap where the data is shown. The `rejected`
list in `pois.json` survives re-fetches; entries themselves are regenerated
and should not be hand-edited.

Stable ids come from the usual registry (`data/waypoint-ids.json`), minted
from type + coordinates, so a re-fetch that moves an element by less than
100 m keeps its id and any comments attached to it.

## Licensing

OSM data is ODbL. The generated trail JSON therefore contains ODbL-licensed
rows alongside our own CC0 waypoint data; attribution ships inside each row's
description, and any page or screen that lists waypoints should credit
"© OpenStreetMap contributors" as well.
