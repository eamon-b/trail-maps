/**
 * Fetch OpenStreetMap points of interest along each built trail and write
 * them to `data/trails/<trail>/pois.json` for review. `build-trails.ts` then
 * appends the reviewed entries as extra waypoints (`source: 'osm'`).
 *
 * What counts as "interesting", how far off the track it may sit, and how OSM
 * candidates are reconciled with the curated waypoints all live in
 * `scripts/lib/poi-enrichment.ts` — this file is the network and file I/O.
 *
 * Usage: npm run fetch:pois [-- trail-id ...] [--offline]
 *   - no ids:     every trail under data/trails/
 *   - --offline:  reuse the last raw Overpass responses (node_modules/.cache)
 *                 instead of querying — for iterating on the rules
 *
 * Prerequisite: `npm run build:trails` (reads the built route from
 * public/data/generated/<id>.json). Curated waypoints there are the merge
 * baseline; the build's own OSM rows are ignored via `source: 'osm'`.
 */

import * as fs from "fs";
import * as net from "net";
import * as path from "path";
import { fileURLToPath } from "url";

// Node's happy-eyeballs gives each resolved address 250 ms by default. On a
// slow link that is not enough for the IPv4 handshake, so `fetch` falls over
// to IPv6 and, where that route is dead, times out — "fetch failed ETIMEDOUT"
// while curl to the same host works. Give each family a real chance.
net.setDefaultAutoSelectFamilyAttemptTimeout(3000);
import {
  findWaypointVisits,
  DEFAULT_WAYPOINT_MAX_DISTANCE_METERS,
} from "../src/lib/trail-ingest.js";
import type {
  ProcessedTrail,
  TrackPoint,
  TrailWaypoint,
} from "../src/lib/trail-types.js";
import {
  buildCorridor,
  buildOverpassQuery,
  candidateToPoiEntry,
  classifyOsmElement,
  mergeOsmCandidates,
  nearestOnTrack,
  parsePoisFile,
  planQueryBoxes,
  POIS_FILE_NOTE,
  POIS_FILE_SOURCE,
  POIS_FILENAME,
  type CuratedWaypointLike,
  type LatLon,
  type OsmCandidate,
  type OsmTags,
  type PoisFile,
} from "./lib/poi-enrichment.js";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPTS_DIR, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data/trails");
const GENERATED_DIR = path.join(PROJECT_ROOT, "public/data/generated");
const RAW_CACHE_DIR = path.join(
  PROJECT_ROOT,
  "node_modules/.cache/trail-maps-pois"
);

/** Tried in turn on retry: the main instance first, then public mirrors. */
const OVERPASS_ENDPOINTS = process.env.OVERPASS_ENDPOINT
  ? [process.env.OVERPASS_ENDPOINT]
  : [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
    ];
const USER_AGENT =
  "trail-maps-poi-fetch/2 (+https://github.com/eamon-b/trail-maps)";
const DELAY_BETWEEN_QUERIES_MS = 3000;
const RETRY_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];
const QUERY_TIMEOUT_S = 180;

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: OsmTags;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  remark?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** POST one query, retrying on rate limits, gateway errors and network hiccups. */
async function runOverpassQuery(query: string): Promise<OverpassElement[]> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1];
      process.stdout.write(
        ` ${lastError?.message ?? "failed"}; retry ${attempt} in ${delay / 1000}s…`
      );
      await sleep(delay);
    }
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: `data=${encodeURIComponent(query)}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout((QUERY_TIMEOUT_S + 30) * 1000),
      });
      if (
        response.status === 429 ||
        response.status === 502 ||
        response.status === 503 ||
        response.status === 504
      ) {
        lastError = new Error(`Overpass ${response.status}`);
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Overpass ${response.status}: ${text.slice(0, 200)}`);
      }
      const json = (await response.json()) as OverpassResponse;
      // Overpass reports runtime failures (timeouts, memory) as 200 + remark.
      if (json.remark && /error|timed out|runtime/i.test(json.remark)) {
        lastError = new Error(`Overpass remark: ${json.remark.slice(0, 200)}`);
        continue;
      }
      return json.elements ?? [];
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Overpass "))
        throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("Overpass query failed");
}

/** Every element in every query box, deduped by `type/id`. */
async function fetchCorridorElements(
  chunks: LatLon[][]
): Promise<OverpassElement[]> {
  const queries = planQueryBoxes(chunks);
  const byId = new Map<string, OverpassElement>();
  for (let i = 0; i < queries.length; i++) {
    process.stdout.write(
      `  Query ${i + 1}/${queries.length} (${queries[i].length} box(es))…`
    );
    const elements = await runOverpassQuery(
      buildOverpassQuery(queries[i], QUERY_TIMEOUT_S)
    );
    for (const el of elements) byId.set(`${el.type}/${el.id}`, el);
    console.log(` ${elements.length} elements`);
    if (i < queries.length - 1) await sleep(DELAY_BETWEEN_QUERIES_MS);
  }
  return [...byId.values()];
}

interface TrailSource {
  trailDir: string;
  trailId: string;
  trail: ProcessedTrail;
}

/** Map data/trails/<dir> → built trail via trail.json's id. */
function loadTrailSources(requestedIds: string[]): TrailSource[] {
  const dirs = fs
    .readdirSync(DATA_DIR)
    .map((name) => path.join(DATA_DIR, name))
    .filter(
      (p) =>
        fs.statSync(p).isDirectory() &&
        fs.existsSync(path.join(p, "trail.json"))
    );

  const sources: TrailSource[] = [];
  for (const trailDir of dirs) {
    const config = JSON.parse(
      fs.readFileSync(path.join(trailDir, "trail.json"), "utf-8")
    ) as { id: string };
    if (requestedIds.length > 0 && !requestedIds.includes(config.id)) continue;
    const builtPath = path.join(GENERATED_DIR, `${config.id}.json`);
    if (!fs.existsSync(builtPath)) {
      throw new Error(
        `${builtPath} not found — run "npm run build:trails" first`
      );
    }
    sources.push({
      trailDir,
      trailId: config.id,
      trail: JSON.parse(fs.readFileSync(builtPath, "utf-8")) as ProcessedTrail,
    });
  }

  const found = new Set(sources.map((s) => s.trailId));
  const missing = requestedIds.filter((id) => !found.has(id));
  if (missing.length > 0)
    throw new Error(`Unknown trail id(s): ${missing.join(", ")}`);
  return sources;
}

/** All curated waypoints in the built trail, from every view, minus OSM rows. */
function curatedWaypoints(trail: ProcessedTrail): CuratedWaypointLike[] {
  const rows: CuratedWaypointLike[] = [
    ...trail.waypoints,
    ...trail.offTrailWaypoints,
  ];
  for (const variant of [...trail.alternates, ...trail.sideTrips]) {
    for (const wp of variant.waypoints ?? []) rows.push(wp);
  }
  return rows.filter((w) => w.source !== "osm");
}

function readExistingRejected(poisPath: string): string[] {
  if (!fs.existsSync(poisPath)) return [];
  const existing = parsePoisFile(
    JSON.parse(fs.readFileSync(poisPath, "utf-8")),
    poisPath
  );
  return existing.rejected;
}

async function processTrail(
  source: TrailSource,
  offline: boolean
): Promise<number> {
  const { trailDir, trailId, trail } = source;
  console.log(`\n${trailId}`);
  console.log("-".repeat(trailId.length));

  const mainTrack: TrackPoint[] = trail.track.points;
  const variantTracks: LatLon[][] = [
    ...trail.alternates,
    ...trail.sideTrips,
  ].map((v) => v.points);
  const chunks = buildCorridor([mainTrack, ...variantTracks]);
  console.log(
    `  Route ${trail.track.totalDistance.toFixed(0)} km + ${variantTracks.length} variant(s) → ${chunks.length} corridor chunk(s)`
  );

  // Raw Overpass elements — cached so rule tweaks don't re-query.
  const cachePath = path.join(RAW_CACHE_DIR, `${trailId}.json`);
  let elements: OverpassElement[];
  if (offline) {
    if (!fs.existsSync(cachePath))
      throw new Error(`--offline but no cache at ${cachePath}`);
    elements = JSON.parse(
      fs.readFileSync(cachePath, "utf-8")
    ) as OverpassElement[];
    console.log(
      `  Using ${elements.length} cached elements from ${path.relative(PROJECT_ROOT, cachePath)}`
    );
  } else {
    elements = await fetchCorridorElements(chunks);
    fs.mkdirSync(RAW_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(elements));
    console.log(`  ${elements.length} distinct elements in corridor`);
  }

  // Classify, locate against the track, and keep what sits inside its rule's radius.
  const candidates: OsmCandidate[] = [];
  const outsideRadius: Record<string, number> = {};
  let unclassified = 0;
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined || lon === undefined) continue;
    const tags = el.tags ?? {};
    const classified = classifyOsmElement(tags);
    if (!classified) {
      unclassified++;
      continue;
    }
    const onMain = nearestOnTrack({ lat, lon }, mainTrack);
    if (!onMain) continue;
    let distanceFromTrackM = onMain.distanceM;
    for (const variant of variantTracks) {
      const onVariant = nearestOnTrack(
        { lat, lon },
        variant.map((p) => ({ ...p, dist: 0 }))
      );
      if (onVariant && onVariant.distanceM < distanceFromTrackM)
        distanceFromTrackM = onVariant.distanceM;
    }
    if (distanceFromTrackM > classified.rule.radiusM) {
      outsideRadius[classified.rule.kind] =
        (outsideRadius[classified.rule.kind] ?? 0) + 1;
      continue;
    }
    candidates.push({
      osmId: `${el.type}/${el.id}`,
      name: classified.name,
      type: classified.rule.type,
      kind: classified.rule.kind,
      lat,
      lon,
      distanceFromTrackM,
      trailKm: onMain.km,
      tags,
    });
  }
  console.log(
    `  ${candidates.length} candidates (${unclassified} elements matched no rule, ${Object.values(
      outsideRadius
    ).reduce((a, b) => a + b, 0)} outside their rule's radius)`
  );

  // Reconcile with the curated waypoints.
  const curated = curatedWaypoints(trail);
  const merged = mergeOsmCandidates(candidates, curated);

  // A waypoint the main route passes twice fans into two rows that share an
  // id, which the build refuses. Skip those rather than break the build.
  const maxDist =
    trail.config.waypointMaxDistance ?? DEFAULT_WAYPOINT_MAX_DISTANCE_METERS;
  const kept: OsmCandidate[] = [];
  const multiVisit: OsmCandidate[] = [];
  for (const c of merged.kept) {
    const asWaypoint: TrailWaypoint = {
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      type: c.type,
    };
    const visits = findWaypointVisits([asWaypoint], mainTrack, maxDist);
    if (visits.length > 1) multiVisit.push(c);
    else kept.push(c);
  }

  const reasonCounts: Record<string, number> = {};
  for (const r of merged.rejected) {
    const bucket = r.reason.split(" ").slice(0, 3).join(" ");
    reasonCounts[bucket] = (reasonCounts[bucket] ?? 0) + 1;
  }
  console.log(`  ${merged.rejected.length} dropped as already covered:`);
  for (const [reason, count] of Object.entries(reasonCounts))
    console.log(`    - ${reason}…: ${count}`);
  if (multiVisit.length > 0) {
    console.log(
      `  ${multiVisit.length} skipped because the route passes them twice:`
    );
    for (const c of multiVisit)
      console.log(`    - ${c.name} (${c.kind}, ${c.osmId})`);
  }

  const byType: Record<string, number> = {};
  for (const c of kept) byType[c.type] = (byType[c.type] ?? 0) + 1;
  console.log(`  ${kept.length} new waypoints:`);
  for (const [type, count] of Object.entries(byType).sort())
    console.log(`    - ${type}: ${count}`);

  const poisPath = path.join(trailDir, POIS_FILENAME);
  const rejected = readExistingRejected(poisPath);
  const file: PoisFile = {
    trailId,
    note: POIS_FILE_NOTE,
    source: POIS_FILE_SOURCE,
    fetchedAt: new Date().toISOString(),
    rejected,
    pois: kept.map(candidateToPoiEntry),
  };
  fs.writeFileSync(poisPath, `${JSON.stringify(file, null, 2)}\n`);
  console.log(
    `  Wrote ${path.relative(PROJECT_ROOT, poisPath)}${rejected.length ? ` (kept ${rejected.length} rejected id(s))` : ""}`
  );
  return kept.length;
}

async function main() {
  const args = process.argv.slice(2);
  const offline = args.includes("--offline");
  const ids = args.filter((a) => !a.startsWith("--"));

  console.log("POI Fetch (OpenStreetMap via Overpass)");
  console.log("======================================");
  if (!fs.existsSync(GENERATED_DIR)) {
    throw new Error(
      `${GENERATED_DIR} not found — run "npm run build:trails" first`
    );
  }

  const sources = loadTrailSources(ids);
  console.log(
    `${sources.length} trail(s)${offline ? " (offline, from cache)" : ""}`
  );

  let total = 0;
  const failed: string[] = [];
  for (let i = 0; i < sources.length; i++) {
    try {
      total += await processTrail(sources[i], offline);
    } catch (error) {
      console.error(
        `  ✗ ${sources[i].trailId}: ${error instanceof Error ? error.message : String(error)}`
      );
      failed.push(sources[i].trailId);
    }
    if (!offline && i < sources.length - 1)
      await sleep(DELAY_BETWEEN_QUERIES_MS);
  }

  console.log(
    `\nDone: ${total} OSM waypoints across ${sources.length - failed.length} trail(s).`
  );
  console.log(
    "Next: review data/trails/*/pois.json, then `npm run build:trails` to apply."
  );
  if (failed.length > 0) {
    console.error(`Failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Fatal:", error instanceof Error ? error.message : error);
  process.exit(1);
});
