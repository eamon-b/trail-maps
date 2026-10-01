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
 */

import * as fs from 'fs';
import * as path from 'path';
import { haversineDistance } from '../src/lib/distance.js';
import { generateGpx } from '../src/lib/gpx-parser.js';
import type { GpxPoint, GpxWaypoint } from '../src/lib/types.js';

const TRACK_TITLE = '88 Temple Pilgrimage';
const TRACK_NAME = 'Shikoku Henro: Temples 1-23';
/** Markers further than this from the line are left out. */
const CORRIDOR_METERS = 3000;

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_OUTPUT = path.resolve(SCRIPTS_DIR, '../data/trails/shikoku/shikoku-t1-t23.gpx');

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

function main(): void {
  const [inputPath, outputArg] = process.argv.slice(2);
  if (!inputPath) {
    console.error('Usage: tsx scripts/process-shikoku-caltopo.ts <caltopo-export.json> [output.gpx]');
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

  // Temples first, in pilgrimage order, then everything else by name: a stable
  // order so a re-export only diffs where the map changed.
  waypoints.sort((a, b) => {
    const ta = templeNumber(a.name);
    const tb = templeNumber(b.name);
    if (ta !== null && tb !== null) return ta - tb;
    if (ta !== null) return -1;
    if (tb !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  const templeCount = waypoints.filter(w => templeNumber(w.name) !== null).length;
  if (templeCount !== 23) {
    throw new Error(`Expected Temples 1-23 inside the corridor, found ${templeCount}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateGpx(TRACK_NAME, points, waypoints));

  console.log(`✓ ${points.length} track points, ${waypoints.length} waypoints → ${outputPath}`);
  if (skippedFolders.size > 0) {
    console.log(`  Skipped folders with no type mapping: ${[...skippedFolders].join(', ')}`);
  }
}

main();
