/**
 * Build the Everest Three Passes GPX from the Nepal generator's output.
 *
 * The generator (~/projects/GPX/nepal, Python, not in git) routes every leg
 * over the OpenStreetMap footpath network with SRTM elevation and writes two
 * files: `three-passes-from-jiri.gpx` (22 day tracks, side trips, two
 * alternatives, 71 waypoints) and `three-passes-quiet-variants.gpx` (lower-
 * traffic legs and four more waypoints). Neither is in the repo's conventions:
 * the main route is split by day, with an acclimatisation loop out of Namche
 * as one of the days; the waypoint types are the generator's own (`Village`,
 * `Pass`, `Summit`, …), none of which the planner counts as water or food; and
 * the quiet legs are separate pieces rather than alternates. This script
 * rearranges them into `data/trails/three_passes/three-passes.gpx`:
 *
 * - One main track, Jiri to Lukla anticlockwise, from every day track but the
 *   Day 9 loop. It still walks Lobuche - Gorak Shep - Lobuche (where nearly
 *   everyone sleeps; `knownRetraces` in trail.json) and back down past Namche.
 * - The Day 9 loop, and the generator's side trips, as `Side trip:` tracks.
 *   The fifth-lake walk replaces the fourth-lake one, which it passes.
 * - Alternatives: the Gokyo valley via Machhermo (no Renjo La), the Khunde
 *   high route from Namche to Thame, and the north-side return from Pangboche
 *   through Phortse to Khumjung. The generator's "Phortse link" is left out: it
 *   joins the Gokyo-valley alternative rather than the main route.
 * - Every waypoint typed for the guide (TYPE_BY_SOURCE, TYPE_OVERRIDES).
 *
 * The generator's per-track notes (`<trk><desc>`) are not carried: the GPX
 * parser has nowhere to put them.
 *
 * Usage: tsx scripts/process-three-passes.ts [nepal-dir] [output.gpx]
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { haversineDistance } from '../src/lib/distance.js';
import { generateGpx, parseGpx } from '../src/lib/gpx-parser.js';
import { jsdomXmlAdapter } from './lib/xml-adapter-jsdom.js';
import type { GpxData, GpxPoint, GpxWaypoint } from '../src/lib/types.js';

const TRACK_NAME = 'Three Passes Trek';

const SCRIPTS_DIR = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_SOURCE_DIR = path.join(os.homedir(), 'projects/GPX/nepal');
const DEFAULT_OUTPUT = path.resolve(SCRIPTS_DIR, '../data/trails/three_passes/three-passes.gpx');

const MAIN_FILE = 'three-passes-from-jiri.gpx';
const QUIET_FILE = 'three-passes-quiet-variants.gpx';

/** Consecutive pieces further apart than this are a mistake in the source, not a join. */
const MAX_JOIN_GAP_METERS = 50;

/** The day track that is a loop out of Namche and back, not a leg of the route. */
const ACCLIMATISATION_DAY = 'Day 09';

/** Generator side trip (name without its `Side trip` prefix) → its name here; null leaves it out. */
const SIDE_TRIPS: Record<string, string | null> = {
  'Deurali > Thodung (yak-cheese factory)': 'Deurali > Thodung',
  'Junbesi > Thubten Choling monastery': 'Junbesi > Thubten Choling',
  'Surke > Lukla (resupply / flight out)': 'Surke > Lukla',
  'Gokyo Ri (5,357 m)': 'Gokyo Ri',
  'Gokyo > fourth lake (Thonak Tsho)': null,
  'Gorak Shep > Everest Base Camp (5,364 m)': 'Everest Base Camp',
  'Gorak Shep > Kala Patthar (5,645 m)': 'Kala Patthar',
  'Chhukhung Ri (5,546 m)': 'Chhukhung Ri',
  'Dingboche > Nangkartshang (5,073 m)': 'Nangkartshang',
};

/**
 * Variants built from one or more generator tracks, joined in order. `from`
 * names are matched against the track name with its `Alternative` / `Quiet`
 * prefix removed, or a day track by its `Day NN`.
 */
const VARIANTS: { name: string; from: string[] }[] = [
  { name: 'Side trip: Namche acclimatisation loop', from: [ACCLIMATISATION_DAY] },
  {
    name: 'Side trip: Gokyo fifth lake',
    from: ["Gokyo > fourth lake > fifth lake (Scoundrel's Viewpoint)"],
  },
  { name: 'Side trip: Ama Dablam Base Camp', from: ['Pangboche > Ama Dablam Base Camp'] },
  {
    name: 'Alternative: Gokyo valley via Machhermo',
    from: ['Namche > Gokyo via Mong La, Dole & Machhermo'],
  },
  {
    name: 'Alternative: Khunde high route',
    from: ['Namche > Khumjung > Khunde', 'Khunde > Thamo > Thame (bypasses Namche)'],
  },
  {
    name: 'Alternative: Phortse north-side return',
    from: ['Pangboche > Phortse (high traverse)', 'Phortse > Mong La > Khumjung'],
  },
];

/** The generator's waypoint `<type>` → ours. */
const TYPE_BY_SOURCE: Record<string, string> = {
  Village: 'teahouse',
  Pass: 'gap',
  Summit: 'mountain',
  Junction: 'junction',
  Lake: 'poi',
  Landmark: 'poi',
  Viewpoint: 'poi',
  Monastery: 'poi',
  'Base Camp': 'poi',
};

/**
 * By name, where the generator's type is not the useful one: the three places
 * with real shops (and an airstrip each), and the two passes with lodges on
 * the crest.
 */
const TYPE_OVERRIDES: Record<string, string> = {
  Jiri: 'town',
  'Namche Bazaar': 'town',
  Lukla: 'town',
  Deurali: 'teahouse',
  'Mong La': 'teahouse',
};

interface Piece {
  name: string;
  points: GpxPoint[];
}

function trackPoints(data: GpxData, name: string): GpxPoint[] {
  const track = data.tracks.find(t => t.name === name);
  if (!track) throw new Error(`No track named "${name}"`);
  return track.segments.flatMap(segment => segment.points);
}

/** Join pieces end to start, dropping the repeated point at each join. */
function join(pieces: Piece[]): GpxPoint[] {
  const points: GpxPoint[] = [];
  for (const piece of pieces) {
    const last = points[points.length - 1];
    if (!last) {
      points.push(...piece.points);
      continue;
    }
    const gap = haversineDistance(last.lat, last.lon, piece.points[0].lat, piece.points[0].lon);
    if (gap > MAX_JOIN_GAP_METERS) throw new Error(`${gap.toFixed(0)} m gap before "${piece.name}"`);
    points.push(...(gap < 1 ? piece.points.slice(1) : piece.points));
  }
  return points;
}

/** A generator track name without its `Side trip` / `Alternative` / `Quiet` prefix. */
function bareName(name: string): string {
  return name.replace(/^(Side trip|Alternative|Quiet)\s+/, '');
}

function main(): void {
  const sourceDir = path.resolve(process.argv[2] ?? DEFAULT_SOURCE_DIR);
  const outputPath = path.resolve(process.argv[3] ?? DEFAULT_OUTPUT);
  const read = (file: string) => parseGpx(fs.readFileSync(path.join(sourceDir, file), 'utf-8'), jsdomXmlAdapter);
  const sources = [read(MAIN_FILE), read(QUIET_FILE)];
  const [mainFile] = sources;

  const findPiece = (from: string): Piece => {
    for (const data of sources) {
      const track = data.tracks.find(t =>
        from.startsWith('Day ') ? t.name.startsWith(from) : bareName(t.name) === from
      );
      if (track) return { name: track.name, points: trackPoints(data, track.name) };
    }
    throw new Error(`No track "${from}"`);
  };

  const days = mainFile.tracks
    .filter(t => /^Day \d+/.test(t.name) && !t.name.startsWith(ACCLIMATISATION_DAY))
    .map(t => ({ name: t.name, points: trackPoints(mainFile, t.name) }));
  const mainPoints = join(days);

  const extraTracks: Piece[] = VARIANTS.map(variant => ({
    name: variant.name,
    points: join(variant.from.map(findPiece)),
  }));
  for (const track of mainFile.tracks.filter(t => t.name.startsWith('Side trip'))) {
    const bare = bareName(track.name);
    if (!(bare in SIDE_TRIPS)) throw new Error(`Side trip "${bare}" is not in SIDE_TRIPS`);
    const name = SIDE_TRIPS[bare];
    if (name) extraTracks.push({ name: `Side trip: ${name}`, points: trackPoints(mainFile, track.name) });
  }
  extraTracks.sort((a, b) => a.name.localeCompare(b.name));

  const seen = new Set<string>();
  const waypoints: GpxWaypoint[] = [];
  for (const waypoint of sources.flatMap(data => data.waypoints)) {
    if (seen.has(waypoint.name)) continue;
    seen.add(waypoint.name);
    const type = TYPE_OVERRIDES[waypoint.name] ?? TYPE_BY_SOURCE[waypoint.type ?? ''];
    if (!type) throw new Error(`No type for "${waypoint.name}" (${waypoint.type})`);
    waypoints.push({ ...waypoint, type });
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateGpx(TRACK_NAME, mainPoints, waypoints, extraTracks));
  console.log(
    `Wrote ${path.relative(process.cwd(), outputPath)}: main route ${mainPoints.length} points from ` +
      `${days.length} legs, ${extraTracks.length} variants, ${waypoints.length} waypoints`
  );
}

main();
