/**
 * Global 2°×2° cell grid for the world contour build.
 *
 * The Australia build (`tile-pipeline.ts` / `build-contours-australia.ts`) uses
 * cell ids like `E132_S24` where the `S` number is the cell's *north* edge in
 * positive degrees south — unusable outside the southern/eastern quadrant. This
 * module is the signed-degree replacement: every coordinate is a real
 * lat/lon, and a cell id names its SW corner.
 *
 * The lattice (even degrees, lon −180..178, lat −90..88) *contains* the
 * Australia lattice exactly — `E132_S24` covers lat −26..−24, lon 132..134,
 * which is world cell `S26E132` — so per-cell contour outputs from the two
 * builds are geometrically compatible. The ids are deliberately distinct so a
 * work dir can never mix them.
 *
 * DEM tiles are Copernicus GLO-30 1°×1° COGs, also named by SW corner.
 */

export const WORLD_CELL_SIZE_DEG = 2;

/** Lattice bounds. Max values are exclusive: the last cell starts at 178 / 88. */
export const WORLD_LON_MIN = -180;
export const WORLD_LON_MAX = 180;
export const WORLD_LAT_MIN = -90;
export const WORLD_LAT_MAX = 90;

/** A 2°×2° grid cell in signed degrees. */
export interface WorldCell {
  id: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

/** SW corner of a 1°×1° Copernicus DEM tile, in signed degrees. */
export interface DemTile {
  lat: number;
  lon: number;
}

/**
 * Cell / DEM tile id format: latitude first, SW corner, zero padded —
 * `N46E006`, `S26E132`, `S02W080`, `N00E000`.
 *
 * A corner value of exactly 0 is always written `N00` / `E000`; `S00` and
 * `W000` are not produced and are rejected on parse, so every cell has exactly
 * one spelling (otherwise `.done` markers and tier filenames could duplicate).
 */
export const WORLD_CELL_ID_PATTERN = /^([NS])(\d{2})([EW])(\d{3})$/;

/** AWS Open Data bucket holding the GLO-30 COGs (anonymous, no auth). */
export const COPERNICUS_BASE_URL = 'https://copernicus-dem-30m.s3.amazonaws.com';

/**
 * Manifest of every tile that exists in the bucket (~26,450 lines, one bare
 * tile directory name per line). Ocean tiles are simply absent from the bucket,
 * so this list is the land mask — no 404 probing needed.
 */
export const COPERNICUS_TILE_LIST_URL = `${COPERNICUS_BASE_URL}/tileList.txt`;

function latPart(lat: number): string {
  return `${lat < 0 ? 'S' : 'N'}${String(Math.abs(lat)).padStart(2, '0')}`;
}

function lonPart(lon: number): string {
  return `${lon < 0 ? 'W' : 'E'}${String(Math.abs(lon)).padStart(3, '0')}`;
}

/** Cell id for a SW corner. Throws for corners outside the world. */
export function worldCellId(west: number, south: number): string {
  if (!Number.isInteger(west) || !Number.isInteger(south)) {
    throw new Error(`Cell corner must be whole degrees: (${west}, ${south})`);
  }
  if (west < WORLD_LON_MIN || west >= WORLD_LON_MAX) {
    throw new Error(`Cell longitude out of range: ${west}`);
  }
  if (south < WORLD_LAT_MIN || south >= WORLD_LAT_MAX) {
    throw new Error(`Cell latitude out of range: ${south}`);
  }
  return `${latPart(south)}${lonPart(west)}`;
}

/**
 * Parse a cell id back to its SW corner. Returns null for anything that isn't
 * the canonical format — including the legacy Australia ids (`E132_S24`) and
 * the non-canonical `S00`/`W000` spellings. Does NOT check the lattice or the
 * coordinate range; use {@link isAlignedWorldCellId} for that.
 */
export function parseWorldCellId(id: string): { west: number; south: number } | null {
  const m = id.match(WORLD_CELL_ID_PATTERN);
  if (!m) return null;
  const [, ns, latDigits, ew, lonDigits] = m;
  const lat = parseInt(latDigits, 10);
  const lon = parseInt(lonDigits, 10);
  if ((ns === 'S' && lat === 0) || (ew === 'W' && lon === 0)) return null;
  return {
    west: ew === 'W' ? -lon : lon,
    south: ns === 'S' ? -lat : lat,
  };
}

/**
 * True if the id parses AND names a real cell of the canonical lattice.
 * A misaligned id like `S25E132` would build fine in isolation, but its output
 * overlaps two real cells and duplicates features in the merged tileset.
 */
export function isAlignedWorldCellId(id: string): boolean {
  const parsed = parseWorldCellId(id);
  if (!parsed) return false;
  return (
    parsed.west % WORLD_CELL_SIZE_DEG === 0 &&
    parsed.south % WORLD_CELL_SIZE_DEG === 0 &&
    parsed.west >= WORLD_LON_MIN && parsed.west < WORLD_LON_MAX &&
    parsed.south >= WORLD_LAT_MIN && parsed.south < WORLD_LAT_MAX
  );
}

/** Build the cell whose SW corner is (west, south). */
export function worldCell(west: number, south: number): WorldCell {
  return {
    id: worldCellId(west, south),
    west,
    south,
    east: west + WORLD_CELL_SIZE_DEG,
    north: south + WORLD_CELL_SIZE_DEG,
  };
}

/** Build a cell from its id, or null if the id isn't an aligned cell id. */
export function worldCellFromId(id: string): WorldCell | null {
  const parsed = parseWorldCellId(id);
  if (!parsed || !isAlignedWorldCellId(id)) return null;
  return worldCell(parsed.west, parsed.south);
}

function floorToLattice(value: number): number {
  return Math.floor(value / WORLD_CELL_SIZE_DEG) * WORLD_CELL_SIZE_DEG;
}

function ceilToLattice(value: number): number {
  return Math.ceil(value / WORLD_CELL_SIZE_DEG) * WORLD_CELL_SIZE_DEG;
}

/**
 * Every lattice cell intersecting `bbox` (whole world when omitted). The bbox
 * edges need not be even degrees — they are snapped outwards, so a bbox is
 * always fully covered by the returned cells. A bbox that only touches a cell
 * edge does not pull that cell in; a degenerate (zero-width or zero-height)
 * bbox still yields the cell containing it.
 */
export function enumerateWorldCells(bbox?: {
  west: number;
  south: number;
  east: number;
  north: number;
}): WorldCell[] {
  let lonStart = WORLD_LON_MIN;
  let lonEnd = WORLD_LON_MAX;
  let latStart = WORLD_LAT_MIN;
  let latEnd = WORLD_LAT_MAX;

  if (bbox) {
    if (bbox.east < bbox.west || bbox.north < bbox.south) {
      throw new Error(
        `Invalid bbox: west=${bbox.west} south=${bbox.south} east=${bbox.east} north=${bbox.north}`
      );
    }
    lonStart = Math.max(WORLD_LON_MIN, floorToLattice(bbox.west));
    lonEnd = Math.min(WORLD_LON_MAX, ceilToLattice(bbox.east));
    if (lonEnd <= lonStart) lonEnd = Math.min(WORLD_LON_MAX, lonStart + WORLD_CELL_SIZE_DEG);
    latStart = Math.max(WORLD_LAT_MIN, floorToLattice(bbox.south));
    latEnd = Math.min(WORLD_LAT_MAX, ceilToLattice(bbox.north));
    if (latEnd <= latStart) latEnd = Math.min(WORLD_LAT_MAX, latStart + WORLD_CELL_SIZE_DEG);
  }

  const cells: WorldCell[] = [];
  for (let lon = lonStart; lon < lonEnd; lon += WORLD_CELL_SIZE_DEG) {
    for (let lat = latStart; lat < latEnd; lat += WORLD_CELL_SIZE_DEG) {
      cells.push(worldCell(lon, lat));
    }
  }
  return cells;
}

/**
 * The four 1° DEM tiles covering a cell, as SW corners. A DEM tile named
 * (lat, lon) covers lat..lat+1, lon..lon+1, so cell S02E010 (lat −2..0) needs
 * tiles at lat −2 and −1, not −1 and 0.
 */
export function dem1DegTiles(cell: WorldCell): DemTile[] {
  const tiles: DemTile[] = [];
  for (let lon = cell.west; lon < cell.east; lon++) {
    for (let lat = cell.south; lat < cell.north; lat++) {
      tiles.push({ lat, lon });
    }
  }
  return tiles;
}

/** Local short name for a DEM tile: `N46E006`, `S24E132`. */
export function demTileName(tile: DemTile): string {
  return `${latPart(tile.lat)}${lonPart(tile.lon)}`;
}

/** Copernicus full tile name: `Copernicus_DSM_COG_10_S24_00_E132_00_DEM`. */
export function copernicusTileName(tile: DemTile): string {
  return `Copernicus_DSM_COG_10_${latPart(tile.lat)}_00_${lonPart(tile.lon)}_00_DEM`;
}

/** AWS object key: the tile directory plus the same name again, `.tif`. */
export function copernicusKey(tile: DemTile): string {
  const name = copernicusTileName(tile);
  return `${name}/${name}.tif`;
}

export function copernicusTileUrl(tile: DemTile): string {
  return `${COPERNICUS_BASE_URL}/${copernicusKey(tile)}`;
}

/**
 * Short tile names present in a tileList.txt body. Lines that aren't a
 * well-formed tile directory name (blank lines, a truncated last line from an
 * interrupted download) are skipped rather than poisoning the land mask with a
 * name no tile resolution will ever match.
 */
export function parseTileListNames(text: string): Set<string> {
  const names = new Set<string>();
  const pattern = /^Copernicus_DSM_COG_10_([NS]\d{2})_00_([EW]\d{3})_00_DEM$/;
  for (const rawLine of text.split('\n')) {
    const m = rawLine.trim().match(pattern);
    if (!m) continue;
    names.add(`${m[1]}${m[2]}`);
  }
  return names;
}

// --- Shards ---

/** A named region of the world; bboxes are signed degrees. */
export interface WorldShard {
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Ordered shard bboxes. `shardForCell` returns the FIRST shard whose bbox
 * contains the cell centre, so overlapping boxes are fine: priority order makes
 * the partition total and disjoint, and the final world-covering `rest` entry
 * guarantees every cell lands somewhere.
 *
 * Only the *partition* matters — shards exist so tippecanoe merges continent-
 * sized inputs instead of one world-sized input, not to be geographically
 * correct. A coastline in the "wrong" shard costs nothing; a cell in two shards
 * would duplicate features, and a cell in none would silently disappear.
 *
 * Ordering notes (all deliberate):
 * - antarctica and greenland come first: their ice-sheet contours are enormous
 *   and near-useless, so they must be separately skippable rather than swallowed
 *   by a continental catch-all.
 * - iceland precedes greenland only because it sits inside greenland's bbox and
 *   would otherwise inherit greenland's "build last or skip" status.
 * - a name may appear more than once (africa is two boxes, because the Red Sea
 *   runs diagonally and one rectangle cannot separate Africa from Arabia).
 *   Use `worldShardNames()` / `cellsForShard()` rather than indexing this list.
 */
export const WORLD_SHARDS: WorldShard[] = [
  { name: 'antarctica', west: -180, south: -90, east: 180, north: -60 },
  { name: 'iceland', west: -25, south: 62, east: -12, north: 68 },
  { name: 'greenland', west: -74, south: 59, east: -10, north: 84 },
  // Oceania before asia-east so Australia/NZ/PNG win the overlap; asia-east
  // then picks up the western Indonesian islands south of the equator.
  { name: 'oceania', west: 110, south: -50, east: 180, north: 0 },
  { name: 'asia-east', west: 90, south: -12, east: 180, north: 82 },
  { name: 'asia-west', west: 36, south: -12, east: 90, north: 82 },
  { name: 'africa', west: -30, south: -40, east: 55, north: 12 },
  { name: 'africa', west: -30, south: 12, east: 36, north: 40 },
  { name: 'europe', west: -32, south: 34, east: 40, north: 82 },
  // Central America before north-america so Mexico's south and the Caribbean
  // don't get pulled into the (much larger) North America shard.
  { name: 'central-america', west: -118, south: 7, east: -59, north: 25 },
  // South edge 14 (not 20) so Hawaii isn't split between this shard and `rest`;
  // the Mexican and Caribbean overlap is already claimed by central-america.
  { name: 'north-america', west: -180, south: 14, east: -30, north: 84 },
  { name: 'south-america', west: -95, south: -60, east: -28, north: 15 },
  { name: 'rest', west: -180, south: -90, east: 180, north: 90 },
];

/**
 * The shard a cell belongs to: first bbox containing the cell centre. Half-open
 * on the north/east edges so a centre landing exactly on a shared boundary
 * belongs to exactly one shard.
 */
export function shardForCell(cell: WorldCell): string {
  const lon = (cell.west + cell.east) / 2;
  const lat = (cell.south + cell.north) / 2;
  const shard = WORLD_SHARDS.find(
    s => lon >= s.west && lon < s.east && lat >= s.south && lat < s.north
  );
  if (!shard) {
    throw new Error(
      `No shard for cell ${cell.id} — WORLD_SHARDS must end with a world-covering catch-all`
    );
  }
  return shard.name;
}

/** Unique shard names in priority order. */
export function worldShardNames(): string[] {
  return [...new Set(WORLD_SHARDS.map(s => s.name))];
}

/** Every cell assigned to a shard. Throws for an unknown shard name. */
export function cellsForShard(name: string): WorldCell[] {
  const names = worldShardNames();
  if (!names.includes(name)) {
    throw new Error(`Unknown shard "${name}". Known shards: ${names.join(', ')}`);
  }
  return enumerateWorldCells().filter(cell => shardForCell(cell) === name);
}
