#!/usr/bin/env node
/**
 * End-to-end verification for the deployed map + contour tile pipeline.
 *
 * Runs these independent checks against production infrastructure:
 *
 *   1. Worker /health     — the mobile app gates online contour injection
 *                           entirely on GET /health returning 200 with
 *                           `ok === true` (see
 *                           mobile/src/services/online-style-service.ts,
 *                           isContourServiceHealthy). If this probe fails, the
 *                           app silently ships maps with no contours at all.
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
 *   5. Trail offline sets — each trail's manifest.json parses, and every
 *                           mbtiles it lists exists at the manifest size,
 *                           starts with the SQLite magic, and is not a
 *                           suspiciously small stub. (An empty/corrupt
 *                           mbtiles crashes the app natively on device.)
 *
 * No repo build state or external npm deps required — hits public URLs only,
 * uses Node's built-in fetch + zlib. Exits non-zero if any check fails.
 *
 * Usage:  node scripts/e2e-tile-check.mjs
 * Env:    CONTOUR_TILE_URL   (default: the production worker)
 *         TILE_BASE_URL      (default: the production R2 bucket)
 */

import { gunzipSync } from 'node:zlib';

const CONTOUR_URL = (
  process.env.CONTOUR_TILE_URL || 'https://contour-tiles.aus-map-data.workers.dev'
).replace(/\/$/, '');
const TILE_BASE_URL = (
  process.env.TILE_BASE_URL || 'https://pub-2c4c91b48919451cb92108f6171071d6.r2.dev'
).replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Tile math + candidate tiles over high-relief Australian land (contours exist)
// ---------------------------------------------------------------------------

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n
  );
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

  if (res.status !== 200) {
    failures.push(
      `/health → HTTP ${res.status} (expected 200) — the app treats anything else ` +
        'as unhealthy and drops contours entirely'
    );
    return;
  }

  let body;
  try {
    body = await res.json();
  } catch (e) {
    failures.push(`/health body is not JSON: ${e.message}`);
    return;
  }

  if (body?.ok !== true) {
    failures.push(
      `/health returned ok=${JSON.stringify(body?.ok)} (expected true)` +
        (body?.error ? ` — worker error: ${body.error}` : '')
    );
    return;
  }
  console.log(`      ✓ HTTP 200 with ok: true`);

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
    failures.push(
      `/health did not report numeric tiles.minZoom/maxZoom (got ${JSON.stringify(tiles)})`
    );
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
  if (bboxFields.every((f) => Number.isFinite(tiles[f]))) {
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
    const url = `${CONTOUR_URL}/contours/${t.z}/${t.x}/${t.y}.pbf`;
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
      `Worker did not advertise Content-Encoding: gzip to a gzip-accepting ` +
        `client (got "${ce || 'none'}").`
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
      console.log(
        `      ✓ decoded ${mvtBytes.length} bytes → valid MVT with ${v.layerCount} layer(s)`
      );
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
    const url = `${CONTOUR_URL}/contours/${t.z}/${t.x}/${t.y}.pbf`;
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
      console.log(
        `      ✓ ${label}: ${mvtBytes.length} bytes → valid MVT with ${v.layerCount} layer(s)`
      );
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

const TRAIL_IDS = ['aawt', 'bibbulmun', 'cape_to_cape', 'heysen', 'larapinta', 'hume-and-hovell'];
const MIN_MBTILES_BYTES = 500_000;
const SQLITE_MAGIC = 'SQLite format 3 ';

async function checkTrailOfflineArtifacts() {
  console.log(`\n[trails] Per-trail offline manifest + mbtiles sanity`);
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
    for (const file of manifest.files) {
      if (!file.name?.endsWith('.mbtiles')) continue;
      const fileUrl = `${TILE_BASE_URL}/${trailId}/${file.name}`;
      try {
        // Range-read the first 16 bytes: verifies existence, SQLite magic,
        // and (via Content-Range) the full object size — no full download.
        const res = await fetch(fileUrl, { headers: { Range: 'bytes=0-15' } });
        if (res.status !== 206 && res.status !== 200) {
          failures.push(`[${trailId}] ${file.name} → HTTP ${res.status}`);
          continue;
        }

        const contentRange = res.headers.get('content-range') || '';
        const totalSize =
          res.status === 206
            ? parseInt(contentRange.split('/')[1] ?? '', 10)
            : parseInt(res.headers.get('content-length') ?? '', 10);
        if (Number.isFinite(totalSize) && totalSize !== file.size) {
          failures.push(
            `[${trailId}] ${file.name} size mismatch: manifest says ${file.size}, object is ${totalSize}`
          );
        }
        if (file.size < MIN_MBTILES_BYTES) {
          failures.push(
            `[${trailId}] ${file.name} is suspiciously small (${file.size} bytes) — likely an empty stub`
          );
        }

        const head = Buffer.from(await res.arrayBuffer());
        const magic = head.subarray(0, 16).toString('latin1');
        if (res.status === 206 || head.length >= 16) {
          if (magic !== SQLITE_MAGIC) {
            failures.push(`[${trailId}] ${file.name} does not start with the SQLite magic header`);
          }
        }
      } catch (e) {
        failures.push(`[${trailId}] ${file.name} check failed: ${e.message}`);
      }
    }
    if (failures.length === failuresBefore) {
      console.log(`      ✓ ${trailId}: manifest ok, ${manifest.files.length} files checked (v${manifest.version})`);
    } else {
      console.log(`      ✗ ${trailId}: ${failures.length - failuresBefore} problem(s) — see failures below`);
    }
  }
}

async function checkGridBaseReachable() {
  // Light reachability check on the R2 map-tile bucket (grid index).
  const url = `${TILE_BASE_URL}/grid/index.json`;
  try {
    const res = await fetch(url);
    if (res.status === 200) {
      const json = await res.json();
      const cells = Array.isArray(json?.cells)
        ? json.cells.length
        : Object.keys(json || {}).length;
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

  await checkContourHealth();
  await checkContourWorker();
  await checkHighZoomTiles();
  await checkTrailOfflineArtifacts();
  await checkGridBaseReachable();

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('RESULT: PASS — all contour/health/gzip/offline checks succeeded.');
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

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
