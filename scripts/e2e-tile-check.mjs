#!/usr/bin/env node
/**
 * End-to-end verification for the deployed map + contour tile pipeline.
 *
 * Runs three independent checks against production infrastructure:
 *
 *   1. Tile decode        — contour tiles fetched from the Cloudflare Worker
 *                           gunzip and parse as valid Mapbox Vector Tiles.
 *   2. Content-Encoding   — the worker advertises `Content-Encoding: gzip`,
 *                           the body is genuinely gzip-framed (1f 8b magic),
 *                           and a decompressing client receives valid MVT.
 *                           (Follow-up to the worker gzip hardening — the
 *                           failure mode is a header/body compression mismatch
 *                           that hands the client undecodable bytes.)
 *   3. Trail offline sets — each trail's manifest.json parses, and every
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

async function findPopulatedTile() {
  // Probe candidates until one returns a 200 (populated) tile.
  for (const t of CANDIDATE_TILES) {
    const url = `${CONTOUR_URL}/contours/${t.z}/${t.x}/${t.y}.pbf`;
    let res;
    try {
      // Explicitly request no compression so we can inspect raw gzip framing.
      res = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
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
  console.log(`\n[1/3] Contour worker reachability + tile decode`);
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

  // --- Check 2: Content-Encoding: gzip advertised ---
  console.log(`\n[2/3] Content-Encoding: gzip verification`);
  const ce = (res.headers.get('content-encoding') || '').toLowerCase();
  const raw = Buffer.from(await res.arrayBuffer());

  // Node's fetch transparently decompresses when the server sets
  // Content-Encoding, so `raw` may already be decompressed even though we
  // asked for identity. Handle both: verify header intent + decode correctly.
  const gzipMagic = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b;

  if (ce !== 'gzip') {
    failures.push(
      `Worker did not advertise Content-Encoding: gzip (got "${ce || 'none'}"). ` +
        'Clients will not know to decompress the tile.'
    );
  } else {
    console.log(`      ✓ Content-Encoding: gzip header present`);
  }

  let mvtBytes;
  if (gzipMagic) {
    // Got raw gzip framing — decompress ourselves and validate.
    console.log(`      ✓ body is gzip-framed (1f 8b magic bytes)`);
    try {
      mvtBytes = gunzipSync(raw);
    } catch (e) {
      failures.push(`gunzip of tile body failed: ${e.message}`);
    }
  } else {
    // Runtime auto-decompressed. That itself confirms header+body agreed
    // (a mismatch would have thrown or produced garbage). Validate as-is.
    console.log(
      `      ~ runtime auto-decompressed the body (Accept-Encoding honored upstream)`
    );
    mvtBytes = raw;
  }

  // --- Check 1 (decode): valid MVT after decompression ---
  console.log(`\n[3/3] Vector-tile structural decode`);
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

  // --- Cross-check: a decompressing client gets valid MVT directly ---
  try {
    const res2 = await fetch(url); // default: Accept-Encoding: gzip, auto-decompress
    if (res2.status === 200) {
      const body2 = Buffer.from(await res2.arrayBuffer());
      const bytes2 =
        body2.length >= 2 && body2[0] === 0x1f && body2[1] === 0x8b
          ? gunzipSync(body2)
          : body2;
      const v2 = isValidMvt(bytes2);
      if (!v2.ok) {
        failures.push(
          `Decompressing client received undecodable tile: ${v2.reason}`
        );
      } else {
        console.log(`      ✓ decompressing-client fetch also yields valid MVT`);
      }
    }
  } catch (e) {
    failures.push(`Decompressing-client cross-check failed: ${e.message}`);
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

  await checkContourWorker();
  await checkTrailOfflineArtifacts();
  await checkGridBaseReachable();

  console.log('\n' + '='.repeat(70));
  if (failures.length === 0) {
    console.log('RESULT: PASS — all contour/gzip checks succeeded.');
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
