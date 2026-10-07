/**
 * Build the Shikoku Henro (Temples 1–23) GPX from a CalTopo GeoJSON export.
 *
 * The source map ("Shikoku 88 temples - full") covers the whole island: one
 * purple line, "88 Temple Pilgrimage", for the walked section from Temple 1 at
 * Naruto to Temple 23 at Hiwasa, red henro-michi fragments elsewhere, and
 * marker folders for temples, Henro Houses, other accommodation, onsen,
 * campgrounds and rest areas. This script keeps the purple line and every
 * marker within CORRIDOR_METERS of it, gives each marker an explicit GPX
 * `<type>` from its folder, and writes `data/trails/shikoku/shikoku-t1-t23.gpx`.
 *
 * The export is not committed (most of it is outside the section, and its
 * GeoJSON in the trail directory would be read by build-trails.ts as a
 * category source keyed by folder names it does not know). Re-run this after
 * re-exporting the map to pick up new markers.
 *
 * Temples 3–9 have no markers on the source map; their positions come from
 * OpenStreetMap (`amenity=place_of_worship`, the "第NN番札所" temple nodes).
 *
 * Usage: tsx scripts/process-shikoku-caltopo.ts <caltopo-export.json> [output.gpx]
 *        tsx scripts/process-shikoku-caltopo.ts --reapply [shikoku.gpx]
 *
 * Places the map lacks, closures and corrected descriptions live in
 * CURATED_WAYPOINTS / CLOSED_MARKERS / DESCRIPTION_OVERRIDES below and are
 * applied on every run; `--reapply` applies them to the committed GPX alone.
 *
 * The map has only the one walked line. Alternates are kept in
 * scripts/data/ (ALTERNATES below) and written after it as extra `<trk>`s
 * whose "Alternative:" names the build classifies as alternates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { haversineDistance } from '../src/lib/distance.js';
import { generateGpx, parseGpx } from '../src/lib/gpx-parser.js';
import { jsdomXmlAdapter } from './lib/xml-adapter-jsdom.js';
import type { GpxPoint, GpxWaypoint } from '../src/lib/types.js';

const TRACK_TITLE = '88 Temple Pilgrimage';
const TRACK_NAME = 'Shikoku Henro: Temples 1-23';
/** Markers further than this from the line are left out. */
const CORRIDOR_METERS = 3000;

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_OUTPUT = path.resolve(SCRIPTS_DIR, '../data/trails/shikoku/shikoku-t1-t23.gpx');

/**
 * Alternate routes, each a `{ name, source, points: [lat, lon, ele][] }` file.
 * Kamiyama: from Nabeiwa through Kamiyama town and past Kamiyama Onsen to the
 * Akui river, instead of over Tamagatoge pass - henro.org's "alternative path
 * through Kamiyama". Routed over OpenStreetMap roads, elevation from
 * Copernicus GLO-30 (see the file's `source`).
 */
const ALTERNATES = [path.resolve(SCRIPTS_DIR, 'data/shikoku-kamiyama-alternate.json')];

interface AlternateFile {
  name: string;
  source: string;
  points: [number, number, number][];
}

function loadAlternates(): { name: string; points: GpxPoint[] }[] {
  return ALTERNATES.map(file => {
    const alternate = JSON.parse(fs.readFileSync(file, 'utf-8')) as AlternateFile;
    return {
      name: alternate.name,
      points: alternate.points.map(([lat, lon, ele]) => ({ lat, lon, ele, time: null })),
    };
  });
}

interface CaltopoFeature {
  id: string;
  geometry: { type: string; coordinates: number[] | number[][] } | null;
  properties: {
    title?: string;
    class?: string;
    folderId?: string;
    description?: string;
    [key: string]: unknown;
  };
}

/** CalTopo folder title → GPX `<type>`. A folder not listed here is skipped. */
const FOLDER_TYPES: Record<string, string> = {
  'Temples': 'poi',
  'Henro Houses': 'accommodation',
  'Other accomodation': 'accommodation',
  'Rest areas': 'hut',
  'Campgrounds': 'campsite',
  'Onsen': 'poi',
};

/** Japanese names of the section's temples, added to each temple's description. */
const TEMPLE_KANJI: Record<number, string> = {
  1: '霊山寺', 2: '極楽寺', 3: '金泉寺', 4: '大日寺', 5: '地蔵寺', 6: '安楽寺',
  7: '十楽寺', 8: '熊谷寺', 9: '法輪寺', 10: '切幡寺', 11: '藤井寺', 12: '焼山寺',
  13: '大日寺', 14: '常楽寺', 15: '国分寺', 16: '観音寺', 17: '井戸寺', 18: '恩山寺',
  19: '立江寺', 20: '鶴林寺', 21: '太龍寺', 22: '平等寺', 23: '薬王寺',
};

/** Temples with no marker on the source map, positioned from OpenStreetMap. */
const OSM_TEMPLES: { num: number; name: string; lat: number; lon: number }[] = [
  { num: 3, name: 'Konsenji', lat: 34.147453, lon: 134.4685024 },
  { num: 4, name: 'Dainichiji', lat: 34.1515688, lon: 134.4308846 },
  { num: 5, name: 'Jizoji', lat: 34.1371936, lon: 134.4319428 },
  { num: 6, name: 'Anrakuji', lat: 34.1181096, lon: 134.3884768 },
  { num: 7, name: 'Jurakuji', lat: 34.1206876, lon: 134.3780307 },
  { num: 8, name: 'Kumadaniji', lat: 34.1227308, lon: 134.3400517 },
  { num: 9, name: 'Horinji', lat: 34.1040985, lon: 134.3336021 },
];

/**
 * The Okunoin is not a marker on the source map, but the purple line climbs to
 * it and back from Temple 12. Positioned from OpenStreetMap (焼山寺 奥の院
 * 蔵王大権現, beside the 焼山寺山 summit node, ele 938) so the side trip has a
 * named end.
 */
const OKUNOIN: GpxWaypoint = {
  name: 'Shosanji Okunoin',
  lat: 33.9820924,
  lon: 134.3040326,
  ele: 0,
  type: 'mountain',
  desc:
    'Inner shrine of Temple 12 (焼山寺 奥の院 蔵王大権現) beside the summit of Mt Shosanji (938 m). ' +
    'An out-and-back from the temple. Position from OpenStreetMap.',
};

/**
 * Places to sleep and drink that the source map does not have, mostly on the
 * Temple 11 → 13 mountain crossing, where the map has almost nothing between
 * Fujiidera and Dainichiji. Researched 2026-10-04 against min88.jp (the temple
 * association's inn list) and henro.org; positions from henro.org's place
 * pages or OpenStreetMap. Prices and phone numbers date from then.
 *
 * Left out for want of a position: Morian Loft (Nabeiwa; status unconfirmed)
 * and River Side Camp NEW-TA (Nyuta, near Temple 13).
 */
const CURATED_WAYPOINTS: GpxWaypoint[] = [
  // Bus stops: positions and timetables from Tokushima Bus's GTFS open data
  // (gtfs-data.jp, timetable from 2026-10-08); neither stop is in OSM.
  {
    name: 'Kamiyama Onsen-mae bus stop',
    lat: 33.974011,
    lon: 134.370151,
    ele: 0,
    type: 'poi',
    desc:
      'Bus stop 神山温泉前 on Route 438 at Kamiyama Onsen, on the Kamiyama alternative. ' +
      'Tokushima Bus Kamiyama (56) and Sanagochi (62) lines to Tokushima Station: 15 departures on weekdays, 11 at weekends, ' +
      'first about 6:20, last 19:21 (Oct 2026).',
  },
  {
    name: 'Keimusho-mae bus stop',
    lat: 34.04294,
    lon: 134.430071,
    ele: 0,
    type: 'poi',
    desc:
      'Bus stop 刑務所前 ("prison stop") beside Tokushima Prison, about 200 m off the path 3.6 km before Temple 13; buses start here. ' +
      'Tokushima Bus Ichinomiya (18) and Amanohara-nishi (17) lines to Tokushima Station: 13 departures on weekdays, 11 at weekends, ' +
      'first 6:45, last 19:25 on weekdays and 20:07 at weekends (Oct 2026).',
  },
  {
    name: 'Sudachi-an',
    lat: 33.987025,
    lon: 134.326663,
    ele: 0,
    type: 'accommodation',
    desc:
      'Pilgrim inn お宿すだち庵 at Nabeiwa, on the route 2.7 km below Temple 12 - the only open lodging between Fujiidera and Kamiyama since the Shosanji shukubo and Nabeiwa-so closed. ' +
      '¥4,900 room only, ¥5,900 with breakfast, ¥6,900 with dinner, ¥7,900 with both (Oct 2026); cash only. Six rooms, curry dinner, shuttle to the Kamiyama Onsen bath. ' +
      'Bookings by phone in Japanese (Tel: 090-2677-8000), or in English by email to null1903@gmail.com with name, dates, number of people, gender, ' +
      'the previous night\'s lodging and whether vegetarian. No fixed check-in time; arrivals before 14:00 phone ahead. ' +
      'Bags are carried free from Ryokan Yoshino, Guest House Channel-kan, Awarakuya and Hostel OE near Temple 11 to Sudachi-an, so the Shosanji climb can be walked light. ' +
      'https://sudachian.com/book/',
  },
  {
    name: 'Tamagatoge Rest Stop',
    lat: 33.986874,
    lon: 134.342467,
    ele: 0,
    type: 'water',
    desc:
      'Rest hut on Tamagatoge pass (玉ヶ峠, about 450 m) between Temple 12 and Temple 13. Water tap (working Nov 2025); toilet closed. ' +
      'Signs on the hut forbid camping. https://www.henro.org/place/tamagatao-rest-stop-kamiyama-tokushima',
  },
  {
    name: 'Moja House',
    lat: 33.989688,
    lon: 134.361443,
    ele: 0,
    type: 'accommodation',
    desc:
      'Guesthouse 神山くらしの宿 near the Ono bus stop on Prefectural Road 20, about 0.8 km off the path. Dorm ¥4,500; dinner ¥2,000, breakfast ¥1,000, cooked with the host (Oct 2026). ' +
      'English-speaking host, cash only. Tel: 050-6873-7990 https://moja-house.com',
  },
  {
    name: 'WEEK Kamiyama',
    lat: 33.968773,
    lon: 134.338321,
    ele: 0,
    type: 'accommodation',
    desc:
      'Inn at Shimobun, about 1.7 km off the path. ¥11,000 with breakfast, ¥14,300 with dinner and breakfast (Oct 2026). Tel: 088-677-0313 https://week-kamiyama.jp',
  },
  {
    name: 'Ryokan Sakuraya',
    lat: 33.9675,
    lon: 134.346941,
    ele: 0,
    type: 'accommodation',
    desc:
      'Ryokan さくらや旅館 in central Kamiyama beside the Yorii-naka bus stop (buses to Tokushima Station, last 19:15). ' +
      '¥6,000 room only, ¥8,500 with dinner and breakfast (Oct 2026). Cash only. Tel: 088-676-0036',
  },
  {
    name: 'Kamiyama Onsen Hotel Shiki-no-Sato',
    lat: 33.971875,
    lon: 134.369995,
    ele: 0,
    type: 'accommodation',
    desc:
      'Hotel 神山温泉ホテル四季の里 at the Kamiyama Onsen bath and bus stop, about 2.5 km off the path. Pilgrim rate about ¥10,000 with dinner and breakfast (Oct 2026). ' +
      'Day bath ¥680, 10:00-20:00, closed 4th Tuesday. Tel: 088-676-1117 https://kamiyama-spa.com/',
  },
  {
    name: 'Uemura Ryokan',
    lat: 34.008519,
    lon: 134.374847,
    ele: 0,
    type: 'accommodation',
    desc:
      'Ryokan 植村旅館 on the route 9.6 km past Temple 12, 11.9 km before Temple 13. From ¥5,300 room only, from ¥8,800 with dinner and breakfast (Oct 2026). ' +
      'Large home-cooked meals; arrival by 18:00. Pickups and luggage transfer by arrangement. Tel: 088-678-0859 https://r.goope.jp/uemura-inn',
  },
  {
    name: 'Ryokan Yoshino',
    lat: 34.055767,
    lon: 134.353997,
    ele: 0,
    type: 'accommodation',
    desc:
      'Ryokan 旅館吉野, 10 minutes from Temple 11 - a last bed before the Shosanji climb. ¥5,500 room only, ¥8,000 with dinner and breakfast (Oct 2026). ' +
      'Breakfast from 6:00, rice balls for the trail, luggage forwarding. Tel: 0883-24-1263',
  },
  {
    name: 'Kadoya Ryokan',
    lat: 34.037973,
    lon: 134.463297,
    ele: 0,
    type: 'accommodation',
    desc:
      'Ryokan かどや旅館 beside Temple 13. ¥5,500 room only, ¥8,800 with dinner and breakfast (Oct 2026). Cash only; check-in 15:00-18:00. Tel: 088-644-0411',
  },
  {
    name: 'Myozai Ryokan Hana',
    lat: 34.037767,
    lon: 134.463249,
    ele: 0,
    type: 'accommodation',
    desc:
      'Ryokan 名西旅館 花 beside Temple 13. ¥5,000 room only, ¥5,500 with breakfast, ¥7,500 with dinner and breakfast (Oct 2026). Tel: 088-644-0025',
  },
];

/**
 * Source-map markers corrected after the 2026-10 research. Keyed by the
 * cleaned title; the value replaces the marker's description outright.
 */
const DESCRIPTION_OVERRIDES: Record<string, string> = {
  'No.12 Shosanji':
    'Temple 12 of the 88 (焼山寺).\n' +
    'Water on the temple grounds. The temple lodging (shukubo) is closed, confirmed by phone in Sep 2026; camping on the grounds is not permitted. ' +
    'The car park below the temple is reachable by taxi from Kamiyama (about 8 km).',
  'Ryusuian Rest Area':
    'Rest hut at about 500 m on the Temple 11 → 12 climb, with a reliable spring (柳の水) and a toilet. ' +
    'A posted notice allows overnight stays in emergencies only; futon and power outlets inside (2022 report). ' +
    'The source map notes a possible tent spot further on at the Ipponsugi-an mountain hut (34.00759, 134.30514). ' +
    '柳水庵休憩所 https://www.henro.org/place/ryusuian-rest-area-kamiyama-tokushima',
  'Henro House Oyado Eleven':
    'About 400 m from Temple 11. Tent pitches ¥1,000 with a coin shower, plus rooms (Oct 2026). Kitchen, luggage forwarding. ' +
    'https://henrohouse.jp/en/houses/86',
  'Karuizawa Camp':
    'Campground 軽井沢キャンプ場 beside the Akui river, under 100 m from the path, 6.7 km before Temple 13. ' +
    'Own tent ¥1,000, shower ¥300, bath ¥500 (Oct 2026); kitchen and vending machines. Open March to November only; check-in from 13:00. ' +
    'Tel: 088-678-0981 https://www.karuizawa-camp.com/',
};

/** Source-map markers for places that have closed, with the evidence. */
const CLOSED_MARKERS: Record<string, string> = {
  'Kamojima Onsen Iyashi-no-Ya': 'free pilgrim huts; henro.org lists them as permanently closed (checked 2026-10-04)',
};

/**
 * Apply the curated additions and corrections above. Idempotent, so it can run
 * over a fresh CalTopo export or over the committed GPX (`--reapply`).
 */
export function applyCuratedWaypoints(waypoints: GpxWaypoint[]): GpxWaypoint[] {
  const curatedNames = new Set(CURATED_WAYPOINTS.map(w => w.name));
  const kept = waypoints
    .filter(w => !(w.name in CLOSED_MARKERS) && !curatedNames.has(w.name))
    .map(w => (w.name in DESCRIPTION_OVERRIDES ? { ...w, desc: DESCRIPTION_OVERRIDES[w.name] } : w));
  return sortWaypoints([...kept, ...CURATED_WAYPOINTS.map(w => ({ ...w }))]);
}

/**
 * Temples first, in pilgrimage order, then everything else by name: a stable
 * order so a re-export only diffs where the map changed.
 */
function sortWaypoints(waypoints: GpxWaypoint[]): GpxWaypoint[] {
  return waypoints.sort((a, b) => {
    const ta = templeNumber(a.name);
    const tb = templeNumber(b.name);
    if (ta !== null && tb !== null) return ta - tb;
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Spelling fixes for marker titles on the source map. */
const TITLE_FIXES: Record<string, string> = {
  'HENRO HOUSE Gues House sakura-an': 'Henro House Guest House Sakura-an',
  'Karuizama Camp': 'Karuizawa Camp',
};

/** CalTopo writes float noise (134.50294400000007); its markers are 6-decimal. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function templeNumber(title: string): number | null {
  const match = /^No\.(\d+)\s/.exec(title);
  return match ? Number(match[1]) : null;
}

function cleanTitle(title: string): string {
  const fixed = TITLE_FIXES[title] ?? title;
  return fixed.replace(/^HENRO HOUSE /, 'Henro House ').trim();
}

function cleanDescription(description: string | undefined): string {
  return (description ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');
}

function templeDescription(num: number, rest: string, fromOsm: boolean): string {
  const lines = [`Temple ${num} of the 88 (${TEMPLE_KANJI[num]}).`];
  if (rest) lines.push(rest);
  if (fromOsm) lines.push('Position from OpenStreetMap.');
  return lines.join('\n');
}

function distanceToLine(lat: number, lon: number, points: GpxPoint[]): number {
  let best = Infinity;
  for (const point of points) {
    const d = haversineDistance(lat, lon, point.lat, point.lon);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Re-apply the curated waypoints and the alternates to the committed GPX in
 * place, for when they change but there is no fresh CalTopo export to rebuild
 * from. The main track is written back untouched (parse → generate round-trips
 * this file byte for byte); the alternates are rewritten from scripts/data/.
 */
function reapply(gpxPath: string): void {
  const gpx = parseGpx(fs.readFileSync(gpxPath, 'utf-8'), jsdomXmlAdapter);
  const points = gpx.tracks[0].segments.flatMap(segment => segment.points);
  const waypoints = applyCuratedWaypoints(gpx.waypoints);
  fs.writeFileSync(gpxPath, generateGpx(TRACK_NAME, points, waypoints, loadAlternates()));
  console.log(`✓ Re-applied curated waypoints and alternates: ${waypoints.length} waypoints → ${gpxPath}`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === '--reapply') {
    reapply(args[1] ? path.resolve(args[1]) : DEFAULT_OUTPUT);
    return;
  }
  const [inputPath, outputArg] = args;
  if (!inputPath) {
    console.error('Usage: tsx scripts/process-shikoku-caltopo.ts <caltopo-export.json> [output.gpx]');
    console.error('       tsx scripts/process-shikoku-caltopo.ts --reapply [shikoku.gpx]');
    process.exit(1);
  }
  const outputPath = outputArg ? path.resolve(outputArg) : DEFAULT_OUTPUT;

  const geojson = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as { features: CaltopoFeature[] };
  const features = geojson.features;

  const line = features.find(f => f.properties.title === TRACK_TITLE && f.geometry?.type === 'LineString');
  if (!line || !line.geometry) {
    throw new Error(`No LineString titled "${TRACK_TITLE}" in ${inputPath}`);
  }
  // CalTopo writes [lon, lat, ele, time]; the times on this line are synthetic
  // (a fixed 20 s step), so they are dropped.
  const points: GpxPoint[] = (line.geometry.coordinates as number[][]).map(([lon, lat, ele]) => ({
    lat: round6(lat),
    lon: round6(lon),
    ele: Number.isFinite(ele) ? ele : 0,
    time: null,
  }));

  const folderTitles = new Map<string, string>();
  for (const feature of features) {
    if (feature.properties.class === 'Folder') {
      folderTitles.set(feature.id, feature.properties.title ?? '');
    }
  }

  const waypoints: GpxWaypoint[] = [];
  const skippedFolders = new Set<string>();

  for (const feature of features) {
    if (feature.properties.class !== 'Marker' || feature.geometry?.type !== 'Point') continue;
    const [rawLon, rawLat] = feature.geometry.coordinates as number[];
    const lat = round6(rawLat);
    const lon = round6(rawLon);
    if (distanceToLine(lat, lon, points) > CORRIDOR_METERS) continue;

    const title = feature.properties.title ?? '';
    const folder = folderTitles.get(feature.properties.folderId ?? '') ?? '';
    const description = cleanDescription(feature.properties.description);

    if (!folder) {
      // Loose markers are notes to self. The one inside the section flags a
      // stretch where the line disagrees with the henro-michi guide.
      if (/check route/i.test(title)) {
        waypoints.push({
          name: 'Route check (T17 to Tokushima)',
          lat,
          lon,
          ele: 0,
          type: 'waypoint',
          desc:
            'Note on the source map: the henro-michi website and the base map disagree with this line after here. ' +
            'The source map also carries a separate 3.6 km "Henro from T17" line for this stretch.',
        });
      }
      continue;
    }

    const type = FOLDER_TYPES[folder];
    if (!type) {
      skippedFolders.add(folder);
      continue;
    }

    const num = templeNumber(title);
    waypoints.push({
      name: cleanTitle(title),
      lat,
      lon,
      ele: 0,
      type,
      desc: folder === 'Temples' && num !== null ? templeDescription(num, description, false) : description,
    });
  }

  for (const temple of OSM_TEMPLES) {
    waypoints.push({
      name: `No.${temple.num} ${temple.name}`,
      lat: temple.lat,
      lon: temple.lon,
      ele: 0,
      type: 'poi',
      desc: templeDescription(temple.num, '', true),
    });
  }
  waypoints.push(OKUNOIN);

  const curated = applyCuratedWaypoints(waypoints);

  const templeCount = curated.filter(w => templeNumber(w.name) !== null).length;
  if (templeCount !== 23) {
    throw new Error(`Expected Temples 1-23 inside the corridor, found ${templeCount}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateGpx(TRACK_NAME, points, curated, loadAlternates()));

  console.log(`✓ ${points.length} track points, ${curated.length} waypoints → ${outputPath}`);
  if (skippedFolders.size > 0) {
    console.log(`  Skipped folders with no type mapping: ${[...skippedFolders].join(', ')}`);
  }
}

// Guarded so the curated waypoints can be imported by a test without running.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPTS_DIR, 'process-shikoku-caltopo.ts')) {
  main();
}
