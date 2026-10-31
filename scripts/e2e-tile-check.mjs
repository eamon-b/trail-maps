#!/usr/bin/env node
/**
 * End-to-end verification for the deployed map + contour tile pipeline.
 *
 * Runs these independent checks against production infrastructure:
 *
 *   1. Worker /health     — the mobile app gates online contour injection
 *                           entirely on GET /health reporting
 *                           `sources.world.ok === true` (see
 *                           mobile/src/services/online-style-service.ts,
 *                           isContourServiceHealthy). If this probe fails, the
 *                           app silently ships maps with no contours at all.
 *                           Checks 1-5 use the source the app requests
 *                           (APP_SOURCE): they are the app's contract with the
 *                           public contour dataset, which it uses like any
 *                           other client.
 *                           Also asserts the archive advertises maxZoom 15, the
 *                           maxzoom the client declares for the contour source.
 *   2. Tile decode        — contour tiles fetched from the Cloudflare Worker
 *                           parse as valid Mapbox Vector Tiles.
 *   3. Content-Encoding   — a gzip-accepting client sees `Content-Encoding:
 *                           gzip` and decodable MVT bytes, and an identity
 *                           client receives plain (non-gzip-framed) MVT.
 *                           (Follow-up to the worker gzip hardening — the
 *                           failure mode is a header/body compression mismatch
 *                           that hands the client undecodable bytes. Note the
 *                           Cloudflare edge transcodes per Accept-Encoding:
 *                           identity clients get a decompressed body with NO
 *                           Content-Encoding header, so the header must be
 *                           asserted on the gzip-accepting fetch only.)
 *   4. High-zoom coverage — a known-populated z14 AND z15 tile over Kosciuszko
 *                           serve real MVT. The fast probe loop only covers
 *                           z10-z13, so an archive rebuilt with a lower maxzoom
 *                           would pass every other check while silently
 *                           blanking contours at the zooms hikers actually use.
 *   5. Trail offline sets — every trail the app bundles
 *                           (mobile/assets/trails/index.json — the app offers
 *                           an offline download for each one) has a pack: its
 *                           manifest.json parses and lists every file the app
 *                           installs (base + contours), and every mbtiles it
 *                           lists exists (at `files[].key` when the
 *                           manifest is content-addressed, else at
 *                           `files[].name`) at the manifest size,
 *                           starts with the SQLite magic, and is not a
 *                           suspiciously small stub. (An empty/corrupt
 *                           mbtiles crashes the app natively on device.)
 *   6. Tiered contours    — the contour zoom tiers (scripts/tile-pipeline.ts
 *                           CONTOUR_TIERS, issue #135) are live: the Mt
 *                           Sonder z9 tile from the worker's `world` and
 *                           `contours` sources holds only 100 m lines, at
 *                           a sane density, and so does every z9 tile of
 *                           every pack's contours.mbtiles (read with Range
 *                           requests: scripts/lib/http-mbtiles.mjs). An
 *                           untiered archive fails here while passing every
 *                           other check.
 *   7. Contours alias     — (--alias, and every full run) `contours` really
 *                           is the alias of `world` (#228): /health reports
 *                           sources.contours.archive.key as world.pmtiles
 *                           (the alias deploy took effect) and both sources
 *                           serve byte-identical Australian tiles through the
 *                           edge (the purge of /contours/* took effect). Both
 *                           archives were tiered, so the density check alone
 *                           cannot tell them apart.
 *
 * No build state or external npm deps required — reads only the committed
 * trail index, hits public URLs, uses Node's built-in fetch + zlib. Exits
 * non-zero if any check fails.
 *
 * Usage:  node scripts/e2e-tile-check.mjs            # every check
 *         node scripts/e2e-tile-check.mjs --packs    # trail offline sets only
 *         node scripts/e2e-tile-check.mjs --tiered   # tiered contours only
 *         node scripts/e2e-tile-check.mjs --packs --tiered  # packs, and tiered contours
 *         node scripts/e2e-tile-check.mjs --alias    # contours alias of world (after deploy + purge)
 * Env:    CONTOUR_TILE_URL   (default: the worker the app's builds use)
 *         TILE_BASE_URL      (default: the pack host the app's builds use)
 *
 * The defaults are the URLs in mobile/eas.json, so the probes go through the
 * same Cloudflare edge the app does — an edge-cached 404 fails here too.
 */

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { httpRangeReader, readPrefix, readZoomTiles } from './lib/http-mbtiles.mjs';
import { checkZ9Tiered } from './lib/mvt-contours.mjs';

const CONTOUR_URL = (process.env.CONTOUR_TILE_URL || 'https://tiles.contour-map-tiles.net').replace(/\/$/, '');
const TILE_BASE_URL = (process.env.TILE_BASE_URL || 'https://data.tracknotes.info').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Tile math + candidate tiles over high-relief Australian land (contours exist)
// ---------------------------------------------------------------------------

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  return { z, x, y };
}

const LAND_POINTS = [
  ['Kosciuszko', -36.45, 148.26],
  ['Blue Mountains', -33.7, 150.3],
  ['Adelaide Hills', -34.95, 138.72],
  ['Perth Hills', -31.95, 116.1],
  ['Canberra', -35.28, 149.13],
  ['Grampians', -37.15, 142.5],
];
const ZOOMS = [12, 11, 13, 10];

const CANDIDATE_TILES = [];
for (const z of ZOOMS) {
  for (const [name, lat, lon] of LAND_POINTS) {
    CANDIDATE_TILES.push({ name, ...lonLatToTile(lon, lat, z) });
  }
}

// The contour source is declared with maxzoom 15 in the mobile online style
// (online-style-service.ts, injectContours), so the archive must go that deep.
const EXPECTED_MAX_ZOOM = 15;
// Probed individually rather than added to ZOOMS so the main loop stays fast.
const HIGH_ZOOMS = [14, 15];

// ---------------------------------------------------------------------------
// Minimal protobuf validation: a Mapbox Vector Tile is a protobuf message with
// repeated `layers` at field 3 (wire type 2). Walk the top-level fields,
// require exact varint framing over the whole buffer, and require at least one
// field-3/wire-2 (a layer). This detects garbage/undecompressed bytes without
// pulling in @mapbox/vector-tile.
// ---------------------------------------------------------------------------

function readVarint(buf, pos) {
  let result = 0n;
  let shift = 0n;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result, pos];
    shift += 7n;
    if (shift > 70n) throw new Error('varint too long');
  }
  throw new Error('truncated varint');
}

function isValidMvt(buf) {
  if (buf.length === 0) return { ok: false, reason: 'empty buffer' };
  let pos = 0;
  let layerCount = 0;
  try {
    while (pos < buf.length) {
      const [tag, p1] = readVarint(buf, pos);
      pos = p1;
      const fieldNum = Number(tag >> 3n);
      const wireType = Number(tag & 0x7n);
      if (fieldNum === 3 && wireType === 2) layerCount++;
      switch (wireType) {
        case 0: {
          [, pos] = readVarint(buf, pos);
          break;
        }
        case 1:
          pos += 8;
          break;
        case 2: {
          const [len, p2] = readVarint(buf, pos);
          pos = p2 + Number(len);
          break;
        }
        case 5:
          pos += 4;
          break;
        default:
          return { ok: false, reason: `bad wire type ${wireType}` };
      }
      if (pos > buf.length) return { ok: false, reason: 'field overruns buffer' };
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (pos !== buf.length) return { ok: false, reason: 'trailing bytes' };
  if (layerCount === 0) return { ok: false, reason: 'no MVT layers (field 3)' };
  return { ok: true, layerCount };
}

// ---------------------------------------------------------------------------

const failures = [];
const notes = [];

/**
 * Node's fetch (undici) transparently decompresses gzip responses even when
 * Accept-Encoding was set manually, so the body is normally plain MVT already.
 * Gunzip ourselves if a runtime ever hands back the framed body instead.
 * Returns the plain bytes, or null if gunzip failed (a failure is recorded).
 */
function decodeTileBody(raw, label) {
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      return gunzipSync(raw);
    } catch (e) {
      failures.push(`${label}: gunzip of tile body failed: ${e.message}`);
      return null;
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// /health — the mobile app's gate for injecting contours into the online style.
// A non-200, a missing `ok: true`, or an archive that no longer reaches
// maxZoom 15 all mean contours are effectively broken for users even though
// individual tile fetches may still succeed.
// ---------------------------------------------------------------------------

/**
 * The contour source the app requests (online-style-service.ts CONTOUR_SOURCE).
 * Checks 1-5 go through it, not the worker's top-level default or an alias.
 */
const APP_SOURCE = 'world';

async function checkContourHealth() {
  console.log(`\n[1/5] Contour worker /health (mobile contour-injection gate)`);
  const url = `${CONTOUR_URL}/health`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    failures.push(`/health fetch failed: ${e.message} — the app would ship maps with no contours`);
    return;
  }

  // The top-level status describes the worker's default source only; the app
  // reads its own source's entry and accepts a 503 that still carries a body.
  if (res.status !== 200 && res.status !== 503) {
    failures.push(
      `/health → HTTP ${res.status} (expected 200) — the app treats anything else ` +
        'as unhealthy and drops contours entirely'
    );
    return;
  }

  let health;
  try {
    health = await res.json();
  } catch (e) {
    failures.push(`/health body is not JSON: ${e.message}`);
    return;
  }

  const body = health?.sources?.[APP_SOURCE];
  if (body?.ok !== true) {
    failures.push(
      `/health sources.${APP_SOURCE}.ok=${JSON.stringify(body?.ok)} (expected true)` +
        (body?.error ? ` — worker error: ${body.error}` : '')
    );
    return;
  }
  console.log(`      ✓ HTTP ${res.status} with sources.${APP_SOURCE}.ok: true`);

  const archive = body.archive || {};
  if (Number.isFinite(archive.size)) {
    console.log(
      `      ✓ archive ${archive.key ?? '(unnamed)'}: ` +
        `${(archive.size / 1e9).toFixed(2)} GB, etag ${archive.etag ?? 'n/a'}`
    );
  } else {
    failures.push('/health did not report an archive size');
  }

  const tiles = body.tiles || {};
  if (!Number.isFinite(tiles.minZoom) || !Number.isFinite(tiles.maxZoom)) {
    failures.push(`/health did not report numeric tiles.minZoom/maxZoom (got ${JSON.stringify(tiles)})`);
    return;
  }

  console.log(`      ✓ archive zoom range: z${tiles.minZoom}–z${tiles.maxZoom}`);
  if (tiles.maxZoom !== EXPECTED_MAX_ZOOM) {
    failures.push(
      `Archive maxZoom is ${tiles.maxZoom}, expected ${EXPECTED_MAX_ZOOM}. The mobile ` +
        'contour source declares maxzoom 15, so anything lower blanks contours at high zoom.'
    );
  }

  const bboxFields = ['minLon', 'minLat', 'maxLon', 'maxLat'];
  if (bboxFields.every(f => Number.isFinite(tiles[f]))) {
    console.log(
      `      ✓ archive bbox: ${tiles.minLon.toFixed(2)},${tiles.minLat.toFixed(2)} → ` +
        `${tiles.maxLon.toFixed(2)},${tiles.maxLat.toFixed(2)}`
    );
  } else {
    notes.push(`  /health omitted part of the archive bbox: ${JSON.stringify(tiles)}`);
  }
}

async function findPopulatedTile() {
  // Probe candidates until one returns a 200 (populated) tile. Request gzip
  // and only gzip: the Cloudflare edge transcodes per Accept-Encoding (a
  // default Node fetch accepting br gets Content-Encoding: br; an identity
  // request gets a decompressed body with no header at all), so pinning the
  // accepted encoding is the only way to observe the gzip contract.
  for (const t of CANDIDATE_TILES) {
    const url = `${CONTOUR_URL}/${APP_SOURCE}/${t.z}/${t.x}/${t.y}.pbf`;
    let res;
    try {
      res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    } catch (e) {
      notes.push(`  fetch error for ${t.z}/${t.x}/${t.y}: ${e.message}`);
      continue;
    }
    if (res.status === 200) {
      return { tile: t, url, res };
    }
    if (res.status !== 204) {
      notes.push(`  ${t.z}/${t.x}/${t.y} (${t.name}) → HTTP ${res.status}`);
    }
  }
  return null;
}

async function checkContourWorker() {
  console.log(`\n[2/5] Contour worker reachability + tile decode`);
  console.log(`      ${CONTOUR_URL}`);

  const hit = await findPopulatedTile();
  if (!hit) {
    failures.push(
      'No populated contour tile found across any probe location/zoom. ' +
        'Either the upload has not completed or the PMTiles is empty.'
    );
    if (notes.length) console.log(notes.join('\n'));
    return;
  }

  const { tile, url, res } = hit;
  console.log(`      ✓ populated tile: ${tile.z}/${tile.x}/${tile.y} (${tile.name})`);

  // --- Check: Content-Type ---
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/x-protobuf')) {
    failures.push(`Content-Type is "${ct}", expected application/x-protobuf`);
  }

  // --- Content-Encoding: gzip advertised to a gzip-accepting client ---
  console.log(`\n[3/5] Content-Encoding: gzip verification`);
  const ce = (res.headers.get('content-encoding') || '').toLowerCase();
  const raw = Buffer.from(await res.arrayBuffer());

  if (ce !== 'gzip') {
    failures.push(
      `Worker did not advertise Content-Encoding: gzip to a gzip-accepting ` + `client (got "${ce || 'none'}").`
    );
  } else {
    console.log(`      ✓ Content-Encoding: gzip header present`);
  }

  // Either way the decoded bytes must be valid MVT.
  const gzipFramed = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;
  console.log(
    gzipFramed
      ? `      ~ runtime left the body gzip-framed; decompressing manually`
      : `      ✓ body decompresses to plain (non-gzip-framed) bytes`
  );
  const mvtBytes = decodeTileBody(raw, `${tile.z}/${tile.x}/${tile.y}`);

  // --- Valid MVT after decompression ---
  console.log(`\n[4/5] Vector-tile structural decode`);
  if (mvtBytes) {
    const v = isValidMvt(mvtBytes);
    if (v.ok) {
      console.log(`      ✓ decoded ${mvtBytes.length} bytes → valid MVT with ${v.layerCount} layer(s)`);
    } else {
      failures.push(`Decoded tile is not a valid vector tile: ${v.reason}`);
    }
  }

  // --- Cross-check: an identity (non-decompressing) client gets plain MVT ---
  // The Cloudflare edge decompresses for clients that don't accept gzip. A
  // gzip-framed body here is the real mismatch failure mode: bytes the client
  // has no way to decode.
  try {
    const res2 = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
    if (res2.status === 200) {
      const body2 = Buffer.from(await res2.arrayBuffer());
      if (body2.length >= 2 && body2[0] === 0x1f && body2[1] === 0x8b) {
        failures.push(
          'Identity client received gzip-framed bytes — header/body ' +
            'compression mismatch (client cannot decode these).'
        );
      } else {
        const v2 = isValidMvt(body2);
        if (!v2.ok) {
          failures.push(`Identity client received undecodable tile: ${v2.reason}`);
        } else {
          console.log(`      ✓ identity-client fetch yields plain valid MVT`);
        }
      }
    } else {
      failures.push(`Identity-client cross-check → HTTP ${res2.status}`);
    }
  } catch (e) {
    failures.push(`Identity-client cross-check failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// High-zoom coverage. The probe loop above only reaches z13, so a rebuild that
// silently capped the archive below z15 would pass every check while leaving
// contours blank at the zoom levels people navigate at. Kosciuszko is the
// highest-relief point in LAND_POINTS — if anywhere has z15 contours, it does.
// ---------------------------------------------------------------------------

async function checkHighZoomTiles() {
  console.log(`\n[5/5] High-zoom (z${HIGH_ZOOMS.join('/z')}) contour coverage`);

  const [name, lat, lon] = LAND_POINTS[0]; // Kosciuszko
  for (const z of HIGH_ZOOMS) {
    const t = { name, ...lonLatToTile(lon, lat, z) };
    const url = `${CONTOUR_URL}/${APP_SOURCE}/${t.z}/${t.x}/${t.y}.pbf`;
    const label = `z${z} ${t.x}/${t.y} (${name})`;

    let res;
    try {
      res = await fetch(url, { headers: { 'Accept-Encoding': 'gzip' } });
    } catch (e) {
      failures.push(`${label} fetch failed: ${e.message}`);
      continue;
    }

    if (res.status !== 200) {
      failures.push(
        `${label} → HTTP ${res.status} (expected 200). ${
          res.status === 204
            ? 'The archive has no data at this zoom — a rebuild likely capped the ' +
              'maxzoom below 15, which blanks contours when zoomed in.'
            : ''
        }`.trim()
      );
      continue;
    }

    const raw = Buffer.from(await res.arrayBuffer());
    const mvtBytes = decodeTileBody(raw, label);
    if (!mvtBytes) continue;

    const v = isValidMvt(mvtBytes);
    if (v.ok) {
      console.log(`      ✓ ${label}: ${mvtBytes.length} bytes → valid MVT with ${v.layerCount} layer(s)`);
    } else {
      failures.push(`${label} is not a valid vector tile: ${v.reason}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Per-trail offline downloads: manifest + mbtiles sanity.
//
// The app downloads {trail}/manifest.json and the mbtiles files it lists.
// A bad artifact here is worse than a missing one — MapLibre native aborts
// the whole app (std::stoi) on an empty or corrupt mbtiles, and both have
// been uploaded in the past (AAWT: 32KB zero-tile stub; bibbulmun: malformed
// database). Without downloading whole files, verify per trail:
//   - manifest.json exists and parses, with files[] entries
//   - each mbtiles has Content-Length matching the manifest size
//   - each mbtiles starts with the SQLite magic ("SQLite format 3\0")
//   - each mbtiles is at least MIN_MBTILES_BYTES (empty stubs are ~32KB)
// ---------------------------------------------------------------------------

// Every bundled trail, read from the app's own index rather than a list kept
// here: a hand-kept list missed Shikoku, which shipped with no pack and a
// Download button that 404'd.
const TRAIL_IDS = JSON.parse(readFileSync(new URL('../mobile/assets/trails/index.json', import.meta.url), 'utf8')).map(
  trail => trail.id
);
// The app installs exactly these (TILE_FILES in mobile/src/services/tile-paths.ts)
// and treats a pack missing either as never downloaded, so a base-only manifest
// is as unusable as none.
const REQUIRED_FILES = ['base.mbtiles', 'contours.mbtiles'];
const MIN_MBTILES_BYTES = 500_000;
const SQLITE_MAGIC = 'SQLite format 3 ';

async function checkTrailOfflineArtifacts() {
  console.log(`\n[trails] Offline pack for each of the app's ${TRAIL_IDS.length} bundled trails`);
  for (const trailId of TRAIL_IDS) {
    const manifestUrl = `${TILE_BASE_URL}/${trailId}/manifest.json`;
    let manifest;
    try {
      const res = await fetch(manifestUrl);
      if (res.status !== 200) {
        failures.push(`[${trailId}] manifest.json → HTTP ${res.status}`);
        continue;
      }
      manifest = await res.json();
    } catch (e) {
      failures.push(`[${trailId}] manifest.json fetch/parse failed: ${e.message}`);
      continue;
    }

    if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
      failures.push(`[${trailId}] manifest.json lists no files`);
      continue;
    }

    const failuresBefore = failures.length;
    const listed = new Set(manifest.files.map(file => file.name));
    for (const name of REQUIRED_FILES) {
      if (!listed.has(name)) {
        failures.push(`[${trailId}] manifest.json does not list ${name} — the app cannot install the pack`);
      }
    }
    let keyedFiles = 0;
    let md5Files = 0;
    for (const file of manifest.files) {
      if (!file.name?.endsWith('.mbtiles')) continue;
      // Objects are stored under the content-addressed `key` (uploads write
      // new keys and swap the manifest last). Manifests published before
      // content addressing have no key — those objects live at `name`.
      const objectKey = file.key ?? file.name;
      if (file.key) keyedFiles++;
      if (file.md5) md5Files++;
      // Report the logical name, plus the object it actually resolved to.
      const label = file.key ? `${file.name} → ${objectKey}` : file.name;
      const fileUrl = `${TILE_BASE_URL}/${trailId}/${objectKey}`;
      try {
        // Range-read the first 16 bytes: verifies existence, SQLite magic,
        // and (via Content-Range) the full object size — no full download.
        const res = await fetch(fileUrl, { headers: { Range: 'bytes=0-15' } });
        if (res.status !== 206 && res.status !== 200) {
          failures.push(`[${trailId}] ${label} → HTTP ${res.status}`);
          continue;
        }

        const contentRange = res.headers.get('content-range') || '';
        const totalSize =
          res.status === 206
            ? parseInt(contentRange.split('/')[1] ?? '', 10)
            : parseInt(res.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(totalSize) && totalSize !== file.size) {
          failures.push(`[${trailId}] ${label} size mismatch: manifest says ${file.size}, object is ${totalSize}`);
        }
        if (file.size < MIN_MBTILES_BYTES) {
          failures.push(`[${trailId}] ${label} is suspiciously small (${file.size} bytes) — likely an empty stub`);
        }

        // A 200 is the whole object (the edge ignored the Range): take its
        // first bytes and drop the rest unread, not a gigabyte for the CDT.
        const head = Buffer.from(res.status === 206 ? await res.arrayBuffer() : await readPrefix(res, 16));
        const magic = head.subarray(0, 16).toString('latin1');
        if (res.status === 206 || head.length >= 16) {
          if (magic !== SQLITE_MAGIC) {
            failures.push(`[${trailId}] ${label} does not start with the SQLite magic header`);
          }
        }
      } catch (e) {
        failures.push(`[${trailId}] ${label} check failed: ${e.message}`);
      }
    }
    if (failures.length === failuresBefore) {
      // md5 is reported, not verified: checking it would mean downloading whole
      // multi-hundred-MB files. The device verifies it after download instead.
      const addressing =
        keyedFiles > 0
          ? `, ${keyedFiles} content-addressed${md5Files > 0 ? `, ${md5Files} with md5` : ''}`
          : ', legacy (no content-addressed keys)';
      console.log(
        `      ✓ ${trailId}: manifest ok, ${manifest.files.length} files checked ` +
          `(v${manifest.version}${addressing})`
      );
    } else {
      console.log(`      ✗ ${trailId}: ${failures.length - failuresBefore} problem(s) — see failures below`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tiered contours. Only the 100 m tier starts at z9 (CONTOUR_TIERS), so every
// feature of a tiered z9 tile is a 100 m line. Before the tier fix every
// archive tiled every 10 m contour into every zoom: Mt Sonder's z9 tile held
// ~14,000 features (543 KB) and tippecanoe dropped and coarsened them — the
// live world tile kept one line. Built tiered it holds about 1,500 (55 KB).
// ---------------------------------------------------------------------------

/** Mt Sonder (Larapinta Trail), 9/444/290: the tile issue #135 measured. */
const TIERED_SPOT_TILE = { name: 'Mt Sonder', z: 9, x: 444, y: 290 };
const TIERED_SOURCES = ['world', 'contours'];
/** A tiered Mt Sonder z9 holds ~1,500 features; untiered ~14,000, or 1 once dropped. */
const TIERED_SPOT_MIN_FEATURES = 300;
const TIERED_SPOT_MAX_FEATURES = 5_000;

/**
 * Fetch one contour tile through the edge with gzip accepted, as the app does.
 * Returns { status, bytes } (bytes decoded, or null for a non-200 or a body
 * that would not gunzip), or null when the fetch itself failed (recorded).
 */
async function fetchContourTile(label) {
  let res;
  try {
    res = await fetch(`${CONTOUR_URL}/${label}.pbf`, { headers: { 'Accept-Encoding': 'gzip' } });
  } catch (e) {
    failures.push(`[tiered] ${label} fetch failed: ${e.message}`);
    return null;
  }
  if (res.status !== 200) return { status: res.status, bytes: null };
  return { status: 200, bytes: decodeTileBody(Buffer.from(await res.arrayBuffer()), `[tiered] ${label}`) };
}

async function checkTieredSpotTiles() {
  const { name, z, x, y } = TIERED_SPOT_TILE;
  console.log(`\n[tiered] Worker z9 contours tiered (${name}, ${z}/${x}/${y})`);
  for (const source of TIERED_SOURCES) {
    const label = `${source}/${z}/${x}/${y}`;
    const tile = await fetchContourTile(label);
    if (!tile) continue;
    if (tile.status !== 200) {
      failures.push(`[tiered] ${label} → HTTP ${tile.status} (expected 200: ${name} has contours at z9)`);
      continue;
    }
    const bytes = tile.bytes;
    if (!bytes) continue;
    let result;
    try {
      result = checkZ9Tiered(bytes);
    } catch (e) {
      failures.push(`[tiered] ${label} does not decode: ${e.message}`);
      continue;
    }
    if (!result.ok) {
      failures.push(`[tiered] ${label} is not tiered: ${result.reason}`);
    } else if (result.features < TIERED_SPOT_MIN_FEATURES || result.features > TIERED_SPOT_MAX_FEATURES) {
      failures.push(
        `[tiered] ${label} holds ${result.features} contour features, expected ` +
          `${TIERED_SPOT_MIN_FEATURES}–${TIERED_SPOT_MAX_FEATURES} (~1,500 built tiered): ` +
          'too few means tippecanoe dropped lines, too many means the tiers did not apply'
      );
    } else {
      console.log(`      ✓ ${label}: ${result.features} features, all 100 m lines (${bytes.length} bytes)`);
    }
  }
}

// ---------------------------------------------------------------------------
// The `contours` alias (#228). `contours` served the Australia archive until it
// was retired; the worker now maps it to world.pmtiles. Both archives were
// built tiered, so the density check above passes whether or not the alias
// deploy and the purge of the edge-cached /contours/* URLs took effect. These
// checks tell the two apart: what the worker says it reads, and what the edge
// actually serves.
// ---------------------------------------------------------------------------

const ALIAS_SOURCE = 'contours';
const ALIAS_TARGET_SOURCE = 'world';
const WORLD_ARCHIVE_KEY = 'contours/world.pmtiles';

/** Australian tiles both sources must serve byte for byte (z9 and a z12). */
const ALIAS_SAMPLE_TILES = [
  TIERED_SPOT_TILE,
  { name: LAND_POINTS[0][0], ...lonLatToTile(LAND_POINTS[0][2], LAND_POINTS[0][1], 12) },
];

async function checkContoursAlias() {
  console.log(`\n[tiered] /${ALIAS_SOURCE} is an alias of /${ALIAS_TARGET_SOURCE} (#228)`);

  let body;
  try {
    const res = await fetch(`${CONTOUR_URL}/health`, { headers: { Accept: 'application/json' } });
    body = await res.json();
  } catch (e) {
    failures.push(`[alias] /health unreadable: ${e.message}`);
  }
  if (body) {
    const key = body.sources?.[ALIAS_SOURCE]?.archive?.key;
    if (key === WORLD_ARCHIVE_KEY) {
      console.log(`      ✓ /health: sources.${ALIAS_SOURCE}.archive.key = ${key}`);
    } else {
      failures.push(
        `[alias] /health sources.${ALIAS_SOURCE}.archive.key is ${JSON.stringify(key)}, expected ` +
          `${WORLD_ARCHIVE_KEY} — the worker deploy that aliases ${ALIAS_SOURCE} to ${ALIAS_TARGET_SOURCE} is not live`
      );
    }
  }

  for (const { name, z, x, y } of ALIAS_SAMPLE_TILES) {
    const path = `${z}/${x}/${y}`;
    const alias = await fetchContourTile(`${ALIAS_SOURCE}/${path}`);
    const target = await fetchContourTile(`${ALIAS_TARGET_SOURCE}/${path}`);
    if (!alias || !target) continue;
    if (alias.status !== 200 || target.status !== 200) {
      failures.push(
        `[alias] ${path} (${name}): ${ALIAS_SOURCE} → HTTP ${alias.status}, ` +
          `${ALIAS_TARGET_SOURCE} → HTTP ${target.status} (expected 200 from both)`
      );
      continue;
    }
    if (!alias.bytes || !target.bytes) continue;
    if (alias.bytes.equals(target.bytes)) {
      console.log(`      ✓ ${path} (${name}): identical under both sources (${alias.bytes.length} bytes)`);
    } else {
      failures.push(
        `[alias] ${path} (${name}): /${ALIAS_SOURCE} serves ${alias.bytes.length} bytes, ` +
          `/${ALIAS_TARGET_SOURCE} ${target.bytes.length} — the edge still holds the retired ` +
          `archive's tiles under /${ALIAS_SOURCE}/* (purge it) or the alias deploy is not live`
      );
    }
  }
}

/** The manifest of each bundled trail, or null where it cannot be had. */
async function fetchPackManifest(trailId) {
  try {
    const res = await fetch(`${TILE_BASE_URL}/${trailId}/manifest.json?m=${Math.floor(Date.now() / 60_000)}`);
    return res.status === 200 ? await res.json() : null;
  } catch {
    return null;
  }
}

/** Packs read at once: each is a chain of sequential range requests. */
const TIERED_PACK_CONCURRENCY = 4;

/** Check one pack's z9: `{ line }` to print, or `{ failure }` to record. */
async function checkTieredPack(trailId) {
  const manifest = await fetchPackManifest(trailId);
  const file = Array.isArray(manifest?.files) && manifest.files.find(f => f?.name === 'contours.mbtiles');
  if (!file) {
    // The pack check reports a missing manifest or file; don't count it twice.
    return { line: `      - ${trailId}: no contours.mbtiles to read (see the pack check)` };
  }
  const url = `${TILE_BASE_URL}/${trailId}/${file.key ?? file.name}`;
  let tiles;
  try {
    tiles = await readZoomTiles(httpRangeReader(url), 9);
  } catch (e) {
    return { failure: `[tiered] [${trailId}] could not read contours.mbtiles z9: ${e.message}` };
  }
  if (tiles.length === 0) {
    return { failure: `[tiered] [${trailId}] contours.mbtiles has no z9 tiles (contours start at z9)` };
  }
  let features = 0;
  let withLayer = 0;
  const bad = [];
  for (const tile of tiles) {
    try {
      const result = checkZ9Tiered(tile.data);
      features += result.features;
      // A z9 tile over flat country can hold no 100 m line at all: one tile
      // without the contour layer is not a failure, a 10 m line is.
      if (result.reason !== 'no contour layer') withLayer++;
      if (!result.ok && result.reason !== 'no contour layer') bad.push(`9/${tile.x}/${tile.y} (TMS): ${result.reason}`);
    } catch (e) {
      bad.push(`9/${tile.x}/${tile.y} (TMS): does not decode: ${e.message}`);
    }
  }
  if (bad.length > 0) {
    return {
      failure: `[tiered] [${trailId}] ${bad.length} of ${tiles.length} z9 tiles not tiered (v${manifest.version}); first: ${bad[0]}`,
    };
  }
  // But a whole pack without it is one whose tiers were never folded into
  // `contour` (renameContourTiers), and the app's style draws nothing from it.
  if (withLayer === 0 || features === 0) {
    return {
      failure:
        `[tiered] [${trailId}] none of its ${tiles.length} z9 tiles has a contour feature ` +
        `(v${manifest.version}): layers not folded into \`contour\`, or no contours at all`,
    };
  }
  return {
    line: `      ✓ ${trailId}: ${tiles.length} z9 tiles, ${features} features, all 100 m lines (v${manifest.version})`,
  };
}

async function checkTieredPacks() {
  console.log(`\n[tiered] z9 of each pack's contours.mbtiles tiered`);
  const results = new Array(TRAIL_IDS.length);
  let next = 0;
  const worker = async () => {
    while (next < TRAIL_IDS.length) {
      const i = next++;
      results[i] = await checkTieredPack(TRAIL_IDS[i]);
    }
  };
  await Promise.all(Array.from({ length: TIERED_PACK_CONCURRENCY }, worker));
  // Reported in trail order, whatever order they finished in.
  TRAIL_IDS.forEach((trailId, i) => {
    const { line, failure } = results[i];
    if (failure) {
      failures.push(failure);
      console.log(`      ✗ ${trailId}: see failures below`);
    } else {
      console.log(line);
    }
  });
}

async function checkGridBaseReachable() {
  // Light reachability check on the R2 map-tile bucket (grid index).
  const url = `${TILE_BASE_URL}/grid/index.json`;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      const json = await res.json();
      const cells = Array.isArray(json?.cells) ? json.cells.length : Object.keys(json || {}).length;
      console.log(`\n[grid] ✓ ${url} reachable (index lists ${cells} entries)`);
    } else {
      notes.push(`[grid] ${url} → HTTP ${res.status} (grid upload may be pending)`);
      console.log(`\n[grid] ⚠ ${url} → HTTP ${res.status} (non-fatal)`);
    }
  } catch (e) {
    console.log(`\n[grid] ⚠ ${url} unreachable: ${e.message} (non-fatal)`);
  }
}

async function main() {
  console.log('='.repeat(70));
  console.log('E2E tile pipeline check —', new Date().toISOString());
  console.log('='.repeat(70));

  const packs = process.argv.includes('--packs');
  const tiered = process.argv.includes('--tiered');
  // Opt-in, not part of --tiered: it can only pass once #228 is deployed and
  // the edge purged, and the tile-packs workflow runs --tiered on the PR.
  const alias = process.argv.includes('--alias');
  if (packs || tiered || alias) {
    if (packs) await checkTrailOfflineArtifacts();
    if (tiered) await checkTieredSpotTiles();
    if (tiered) await checkTieredPacks();
    if (alias) await checkContoursAlias();
  } else {
    await checkContourHealth();
    await checkContourWorker();
    await checkHighZoomTiles();
    await checkTrailOfflineArtifacts();
    await checkTieredSpotTiles();
    await checkContoursAlias();
    await checkTieredPacks();
    await checkGridBaseReachable();
  }

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('RESULT: PASS — every check run succeeded.');
    console.log('='.repeat(70));
    process.exit(0);
  } else {
    console.log(`RESULT: FAIL — ${failures.length} check(s) failed:`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    if (notes.length) {
      console.log('\nDiagnostics:');
      console.log(notes.join('\n'));
    }
    console.log('='.repeat(70));
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
