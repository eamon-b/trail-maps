# Tracknotes

Maps, elevation profiles, waypoint datasheets and trip planning for long-distance hiking trails. Tracknotes comes in two forms:

- **The website** ([tracknotes.info](https://tracknotes.info)), a static site for researching and planning a walk at a desk.
- **The app**, an offline-first Android/iOS app (Expo / React Native) for carrying the same guide on the trail.

Both run on the same trail data and the same planning code, so a plan made in the browser works out the same days, water carries and resupply legs on the phone.

The app informs the hiker's decisions and never makes them. Pace, hours per day and distance targets are always the hiker's own inputs. Nothing assumes what a "reasonable" day is.

![Larapinta Trail on the website: map, elevation profile and waypoint datasheet](docs/screenshots/web-trail.jpg)

## Trails

20 curated trails in four countries, from day walks to thru-hikes:

| Country | Trails |
| --- | --- |
| 🇦🇺 Australia | Australian Alps Walking Track, Bibbulmun Track, Cape to Cape Track, Grampians Peaks Trail, Great North Walk, Great Ocean Walk, Great South West Walk, Heysen Trail, Hume and Hovell Track, Kep Track, Larapinta Trail, Overland Track, Six Foot Track, South Coast Track, The Coast Track, Thorsborne Trail, Three Capes Track |
| 🇳🇿 New Zealand | Te Araroa |
| 🇯🇵 Japan | Shikoku Henro (Temples 1–23) |
| 🇳🇵 Nepal | Everest Three Passes from Jiri |
| 🇺🇸 United States | Continental Divide Trail |

Anyone can also import their own GPX file, and hikers can share routes with each other as **community routes**.

## The website

### Find a trail

![Landing page with search, length filters and trails grouped by country and state](docs/screenshots/web-home.jpg)

- Search by name, country or state. Filter by length (day walk, multi-day, long trail) and sort the results.
- Trails are grouped by country and state, with Featured, Community routes and My trails (your own imports) alongside.
- Light and dark themes.

### Explore a trail

- **Topographic map** with the main route, alternates, side trips and alternative trail ends, plus typed waypoint icons (water, camp, hut, town, hazard and more).
- **Elevation profile** linked to the map.
- **Waypoint datasheet** showing each place's elevation, the leg distance, ascent and descent from the place before, and running totals. Filter it to water sources or food & resupply, and the legs are recalculated between the rows you can see. Off-route places show how far off the trail they are, and how far is actually walked to reach them, calculated over OpenStreetMap paths.
- **OpenStreetMap points of interest** along the corridor (water, camping, resupply, food, transport, emergency), shown separately from the curated waypoints so you can judge them yourself.
- **Reverse direction** (e.g. NOBO/SOBO) with every figure recalculated.
- **Download** the datasheet as CSV or the track as GPX.

### Plan the walk

![Plan page: ranked suggestions for the next six days, previewed on the map with numbered day flags](docs/screenshots/web-plan.jpg)

- **Day planner**: tick overnight stops, or have the page **suggest the next few days** from your pace and hours per day (or from distance, climb and hours ranges). It ranks several alternatives and previews each on the map before you apply one.
- Start date, rest days, nights per stop, notes and a "booked" flag. Dates follow from the nights you set.
- **Alternates**: take a trail's alternate route and the plan is measured along it.
- **Resupply planning**: choose resupply towns and see each leg's distance, climb, days and food weight. The walk or hitch into town is included.
- **Water carries**: the distance between water sources, with dry stretches flagged.
- **Sync and share**: link the browser to the phone app to sync plans both ways, or share a read-only link to a plan.

### Check the weather

![Historical climate table for Alice Springs: monthly min/max temperature, rainfall and rainy days](docs/screenshots/web-climate.jpg)

30 years of monthly climate data (temperatures, rainfall, rainy days) for several locations along each trail, with the best months highlighted.

### Bring your own route

- **Import a GPX file** in the browser. It is cleaned up (elevation spikes, waypoint types guessed from names) and saved locally, then gets the same map, datasheet and planner as a curated trail. [How your file is processed](docs/gpx-import.md).
- **Missing elevation** can be filled in from a terrain model.
- **Export for Tracknotes** hands an imported trail and its plan over to the phone.
- **Share with the community**: publish a route (CC0). Automated checks and a review run before it is listed. Other hikers can view it, save it and report it.

## The Tracknotes app

The phone half of the project, made for using a guide on the trail with no signal.

The app on the Shikoku Henro, in dark mode:

<p align="center">
  <img src="docs/screenshots/app-guides.jpg" width="190" alt="My Guides, with the trail being hiked pinned at the top" />
  <img src="docs/screenshots/app-map.jpg" width="190" alt="Offline topo map with contours, the route, an alternate and waypoint icons" />
  <img src="docs/screenshots/app-elevation.jpg" width="190" alt="Elevation profile zoomed to a 30 km window, with waypoint markers" />
  <img src="docs/screenshots/app-plan.jpg" width="190" alt="Planner stops list: overnight options with leg distance, climb, off-trail distance and nearby services" />
</p>
<p align="center">
  <img src="docs/screenshots/app-today.jpg" width="190" alt="Today screen: the day's waypoints and OpenStreetMap places with distance and climb" />
  <img src="docs/screenshots/app-waypoint.jpg" width="190" alt="Waypoint detail with description, the days either side if you stop here, and comments" />
  <img src="docs/screenshots/app-add-waypoint.jpg" width="190" alt="Adding a hiker waypoint, kept private or shared with everyone" />
</p>

- **Offline maps**: download topographic map packs, with contour lines, for each trail. The map follows the system light/dark theme, with a night topo style in dark mode.
- **Map | Elevation | List**: three views of the guide, one tap apart. The elevation profile can be pinched to zoom distance and height separately.
- **GPS position on the trail**: your km along the route, distance off trail, and what's next (water, camp, resupply) with ETAs at your own pace.
- **Day planner**: the same plan as the website (days, stops, alternates, resupply legs, water carries), plus a **Today** screen listing today's waypoints with the distance and climb between each one.
- **Waypoint details**: descriptions, links, an "off the route" distance, "Stop here" / "Plan resupply here", and **comments and photos** from other hikers that are saved offline and sent once you have signal.
- **Hiker waypoints**: long-press the map to add a place. Keep it private, or share it with everyone on that trail (the spring the guide is missing, a new shop).
- **OpenStreetMap points of interest** on the map, in the list and in the planner, controlled by one filter.
- **Import** GPX files or `.tracknotes.json` handoffs from the website, and open shared plans from a link.
- **Community routes** appear next to the curated guides.
- **Trail data updates over the air**: corrected trail data downloads in the background without needing a new app release.

## Where the data comes from

- **Curated trails** come from guidebooks' GPX files and official sources, or are built from open data: Great Trails Victoria (CC BY 4.0), the Tasmanian LIST (CC BY 3.0 AU) and OpenStreetMap route relations (ODbL). Each trail page credits its source, and so does the app (tap the credit in the corner of the map).
- **Te Araroa** is built in the companion [te-araroa-data](https://github.com/eamon-b/te-araroa-data) repo: trail data © Te Araroa Trust, hut and campsite data © NZ Department of Conservation (CC BY 4.0), resupply coordinates © OpenStreetMap contributors (ODbL).
- **CDT**: centreline © Continental Divide Trail Coalition (CC BY).
- **Elevation** comes from Copernicus GLO-30 (produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved), and so do the contour lines in the app icon: Mt Sonder on the Larapinta Trail. **Points of interest** and walk-in paths come from OpenStreetMap. **Climate** is 30-year historical data from the [Open-Meteo](https://open-meteo.com/) historical weather API (CC BY 4.0).
- **Maps**: OpenTopoMap on the website. On the app, OpenFreeMap (© OpenMapTiles, © OpenStreetMap contributors) online, offline packs cut from the Protomaps basemap (© OpenStreetMap contributors), and self-hosted contour tiles from Copernicus GLO-30 (Cloudflare R2 + Workers).

## Repository layout

| Path | What it is |
| --- | --- |
| `src/lib/` | Shared TypeScript used by the website, the app, the build and the API: GPX parsing and ingestion, distance/elevation maths, day planner, resupply and water calculators |
| `src/web/` | The website (Vite + Leaflet + Chart.js) |
| `mobile/` | Tracknotes (Expo SDK 58, React Native, MapLibre, Skia, SQLite) |
| `data/trails/` | Source data for each trail: GPX, `trail.json`, climate, POIs, walk-in routes, curated descriptions |
| `scripts/` | Build pipeline: trail JSON, mobile assets, climate/POI/elevation fetchers, map tile and contour builds |
| `workers/` | Cloudflare Workers: the comments/plans/community API (D1 + R2) and the contour tile server |
| `docs/`, `plans/` | Runbooks, the GPX import spec and design specs |

## Getting started

Requires Node 22+.

```bash
npm install
npm run sync:te-araroa   # copy the Te Araroa route out of its package
npm run build:trails     # build public/data/generated/*.json and the trail pages
npm run dev              # http://localhost:5173
```

```bash
npm test                 # Vitest
npm run lint
npm run build            # full production build
```

The app:

```bash
cd mobile
npm install
npm test                 # Jest
npm run typecheck
npx expo start --dev-client   # needs a development build (MapLibre uses native code)
```

See [`CLAUDE.md`](CLAUDE.md) for the project's conventions, [`docs/architecture/build-scripts.md`](docs/architecture/build-scripts.md) for every build script, [`docs/architecture/`](docs/architecture/) for the full architecture, and [`docs/mobile-test-build.md`](docs/mobile-test-build.md) for building an installable test APK.
