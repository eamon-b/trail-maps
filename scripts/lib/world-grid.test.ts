import { describe, it, expect } from 'vitest';
import {
  WORLD_CELL_SIZE_DEG,
  WORLD_SHARDS,
  cellsForShard,
  copernicusKey,
  copernicusTileUrl,
  dem1DegTiles,
  demTileName,
  enumerateWorldCells,
  isAlignedWorldCellId,
  parseTileListNames,
  parseWorldCellId,
  shardForCell,
  worldCell,
  worldCellFromId,
  worldCellId,
  worldShardNames,
} from './world-grid';
import {
  neededTiles,
  planTiles,
  parseFetchArgs,
  resolveCells,
  demTilePath,
  isTiffMagic,
} from '../fetch-dem-copernicus';

describe('worldCellId / parseWorldCellId', () => {
  it('round-trips all four quadrants', () => {
    const corners: [number, number, string][] = [
      [6, 46, 'N46E006'],
      [132, -26, 'S26E132'],
      [-80, -2, 'S02W080'],
      [-120, 48, 'N48W120'],
    ];
    for (const [west, south, id] of corners) {
      expect(worldCellId(west, south)).toBe(id);
      expect(parseWorldCellId(id)).toEqual({ west, south });
      expect(isAlignedWorldCellId(id)).toBe(true);
    }
  });

  it('uses N00/E000 at the equator and prime meridian', () => {
    expect(worldCellId(0, 0)).toBe('N00E000');
    expect(parseWorldCellId('N00E000')).toEqual({ west: 0, south: 0 });
    // The zero corners have exactly one spelling.
    expect(parseWorldCellId('S00E000')).toBeNull();
    expect(parseWorldCellId('N00W000')).toBeNull();
  });

  it('handles the negative side of both zero lines', () => {
    expect(worldCellId(-2, -2)).toBe('S02W002');
    expect(parseWorldCellId('S02W002')).toEqual({ west: -2, south: -2 });
  });

  it('covers the antimeridian and polar edges of the lattice', () => {
    expect(worldCellId(-180, -90)).toBe('S90W180');
    expect(isAlignedWorldCellId('S90W180')).toBe(true);
    expect(worldCellId(178, 88)).toBe('N88E178');
    expect(isAlignedWorldCellId('N88E178')).toBe(true);
    // 180 / 90 are the exclusive ends: no cell starts there.
    expect(() => worldCellId(180, 0)).toThrow();
    expect(() => worldCellId(0, 90)).toThrow();
    expect(isAlignedWorldCellId('N90E000')).toBe(false);
  });

  it('east edge cell is lon 178, not 180', () => {
    const cells = enumerateWorldCells();
    const wests = cells.map(c => c.west);
    expect(Math.max(...wests)).toBe(178);
    expect(Math.min(...wests)).toBe(-180);
    expect(cells.some(c => c.id === 'N88E178')).toBe(true);
    expect(cells.some(c => c.west === 180)).toBe(false);
  });
});

describe('isAlignedWorldCellId', () => {
  it('rejects odd degrees', () => {
    expect(parseWorldCellId('S25E132')).toEqual({ west: 132, south: -25 });
    expect(isAlignedWorldCellId('S25E132')).toBe(false);
    expect(isAlignedWorldCellId('S26E133')).toBe(false);
  });

  it('rejects out-of-range coordinates', () => {
    expect(isAlignedWorldCellId('N92E000')).toBe(false);
    expect(isAlignedWorldCellId('S92E000')).toBe(false);
    expect(isAlignedWorldCellId('N00E182')).toBe(false);
    expect(isAlignedWorldCellId('N00W182')).toBe(false);
  });

  it('rejects malformed ids', () => {
    for (const id of ['', 'N6E006', 'N06E06', 'n46e006', 'X46E006', 'N46E006 ', 'N46E0060']) {
      expect(parseWorldCellId(id)).toBeNull();
      expect(isAlignedWorldCellId(id)).toBe(false);
    }
  });

  it('rejects legacy Australia cell ids', () => {
    for (const id of ['E132_S24', 'E112_S34', 'S24E132_']) {
      expect(parseWorldCellId(id)).toBeNull();
      expect(isAlignedWorldCellId(id)).toBe(false);
    }
  });

  it('worldCellFromId only builds aligned cells', () => {
    expect(worldCellFromId('S26E132')).toEqual({
      id: 'S26E132',
      west: 132,
      south: -26,
      east: 134,
      north: -24,
    });
    expect(worldCellFromId('S25E132')).toBeNull();
    expect(worldCellFromId('E132_S24')).toBeNull();
  });
});

describe('enumerateWorldCells', () => {
  it('covers the whole lattice by default', () => {
    const cells = enumerateWorldCells();
    expect(cells).toHaveLength(180 * 90);
    expect(new Set(cells.map(c => c.id)).size).toBe(cells.length);
  });

  it('includes every cell a non-even bbox intersects', () => {
    // Straddles the lon 134 lattice line inside the lat -24..-22 row.
    const cells = enumerateWorldCells({ west: 133.4, south: -23.7, east: 134.6, north: -22.9 });
    expect(cells.map(c => c.id).sort()).toEqual(['S24E132', 'S24E134']);
  });

  it('snaps outwards on all four sides', () => {
    const cells = enumerateWorldCells({ west: -0.5, south: -0.5, east: 0.5, north: 0.5 });
    expect(cells.map(c => c.id).sort()).toEqual(['N00E000', 'S02E000', 'S02W002', 'N00W002'].sort());
  });

  it('a bbox that only touches a cell edge does not pull that cell in', () => {
    const cells = enumerateWorldCells({ west: 132, south: -26, east: 134, north: -24 });
    expect(cells.map(c => c.id)).toEqual(['S26E132']);
  });

  it('a degenerate bbox still yields its containing cell', () => {
    const cells = enumerateWorldCells({ west: 134, south: -24, east: 134, north: -24 });
    expect(cells.map(c => c.id)).toEqual(['S24E134']);
  });

  it('clamps to the lattice at the world edges', () => {
    const cells = enumerateWorldCells({ west: -181, south: -95, east: -179, north: -89 });
    expect(cells.map(c => c.id)).toEqual(['S90W180']);
  });

  it('rejects an inverted bbox', () => {
    expect(() => enumerateWorldCells({ west: 10, south: 0, east: 5, north: 1 })).toThrow();
    expect(() => enumerateWorldCells({ west: 0, south: 10, east: 1, north: 5 })).toThrow();
  });
});

describe('Australia lattice compatibility', () => {
  it('world cell S26E132 covers the same ground as legacy E132_S24', () => {
    // Legacy ids store degrees *south* as positive and name the NORTH edge:
    // E132_S24 => lon 132..134, lat -(24 + 2)..-24.
    const legacy = { lon: 132, latSouthPositive: 24 };
    const legacyBounds = {
      west: legacy.lon,
      east: legacy.lon + WORLD_CELL_SIZE_DEG,
      north: -legacy.latSouthPositive,
      south: -(legacy.latSouthPositive + WORLD_CELL_SIZE_DEG),
    };
    expect(legacyBounds).toEqual({ west: 132, east: 134, south: -26, north: -24 });

    const world = worldCell(legacyBounds.west, legacyBounds.south);
    expect(world.id).toBe('S26E132');
    expect({
      west: world.west,
      east: world.east,
      south: world.south,
      north: world.north,
    }).toEqual(legacyBounds);
  });

  it('every legacy Australia cell corner lands on the world lattice', () => {
    for (let lon = 112; lon < 154; lon += 2) {
      for (let lat = 10; lat < 44; lat += 2) {
        expect(isAlignedWorldCellId(worldCellId(lon, -(lat + 2)))).toBe(true);
      }
    }
  });
});

describe('dem1DegTiles / demTileName', () => {
  it('returns the four 1° tiles below the cell top, not above it', () => {
    const names = dem1DegTiles(worldCell(132, -26)).map(demTileName);
    expect(names).toEqual(['S26E132', 'S25E132', 'S26E133', 'S25E133']);
  });

  it('handles a cell touching the equator from the south', () => {
    const names = dem1DegTiles(worldCell(10, -2)).map(demTileName);
    expect(names).toEqual(['S02E010', 'S01E010', 'S02E011', 'S01E011']);
  });

  it('handles a cell touching the prime meridian from the west', () => {
    const names = dem1DegTiles(worldCell(-2, 46)).map(demTileName);
    expect(names).toEqual(['N46W002', 'N47W002', 'N46W001', 'N47W001']);
  });

  it('handles the cell whose SW corner is (0, 0)', () => {
    const names = dem1DegTiles(worldCell(0, 0)).map(demTileName);
    expect(names).toEqual(['N00E000', 'N01E000', 'N00E001', 'N01E001']);
  });
});

describe('copernicusKey', () => {
  it('builds the verified S24E132 key', () => {
    expect(copernicusKey({ lat: -24, lon: 132 })).toBe(
      'Copernicus_DSM_COG_10_S24_00_E132_00_DEM/Copernicus_DSM_COG_10_S24_00_E132_00_DEM.tif'
    );
    expect(copernicusTileUrl({ lat: -24, lon: 132 })).toBe(
      'https://copernicus-dem-30m.s3.amazonaws.com/' +
      'Copernicus_DSM_COG_10_S24_00_E132_00_DEM/Copernicus_DSM_COG_10_S24_00_E132_00_DEM.tif'
    );
  });

  it('pads and signs every quadrant', () => {
    expect(copernicusKey({ lat: 0, lon: 6 })).toBe(
      'Copernicus_DSM_COG_10_N00_00_E006_00_DEM/Copernicus_DSM_COG_10_N00_00_E006_00_DEM.tif'
    );
    expect(copernicusKey({ lat: 46, lon: -2 })).toBe(
      'Copernicus_DSM_COG_10_N46_00_W002_00_DEM/Copernicus_DSM_COG_10_N46_00_W002_00_DEM.tif'
    );
    expect(copernicusKey({ lat: -1, lon: -80 })).toBe(
      'Copernicus_DSM_COG_10_S01_00_W080_00_DEM/Copernicus_DSM_COG_10_S01_00_W080_00_DEM.tif'
    );
    expect(copernicusKey({ lat: -90, lon: 179 })).toBe(
      'Copernicus_DSM_COG_10_S90_00_E179_00_DEM/Copernicus_DSM_COG_10_S90_00_E179_00_DEM.tif'
    );
  });
});

describe('parseTileListNames', () => {
  it('parses bucket manifest lines into short names', () => {
    const text = [
      'Copernicus_DSM_COG_10_N00_00_E006_00_DEM',
      'Copernicus_DSM_COG_10_S24_00_E132_00_DEM',
      'Copernicus_DSM_COG_10_N46_00_W002_00_DEM',
      '',
    ].join('\n');
    expect(parseTileListNames(text)).toEqual(new Set(['N00E006', 'S24E132', 'N46W002']));
  });

  it('skips malformed lines including a truncated final line', () => {
    const text = [
      'Copernicus_DSM_COG_10_N00_00_E006_00_DEM',
      'garbage',
      'Copernicus_DSM_COG_10_N00_00_E006_00',
      'Copernicus_DSM_COG_10_N0_00_E006_00_DEM',
      'Copernicus_DSM_COG_1',
    ].join('\n');
    expect(parseTileListNames(text)).toEqual(new Set(['N00E006']));
  });

  it('tolerates CRLF line endings', () => {
    expect(parseTileListNames('Copernicus_DSM_COG_10_S24_00_E132_00_DEM\r\n')).toEqual(
      new Set(['S24E132'])
    );
  });
});

describe('shards', () => {
  it('assigns every world cell to exactly one shard', () => {
    const names = new Set(worldShardNames());
    for (const cell of enumerateWorldCells()) {
      const shard = shardForCell(cell);
      expect(names.has(shard)).toBe(true);
    }
  });

  it('ends with a world-covering catch-all', () => {
    const last = WORLD_SHARDS[WORLD_SHARDS.length - 1];
    expect(last).toEqual({ name: 'rest', west: -180, south: -90, east: 180, north: 90 });
  });

  it('puts all of Australia in oceania', () => {
    const australia = enumerateWorldCells({ west: 112, south: -44, east: 152, north: -10 });
    expect(australia.length).toBeGreaterThan(100);
    for (const cell of australia) {
      expect(shardForCell(cell)).toBe('oceania');
    }
  });

  it('puts New Zealand and PNG in oceania', () => {
    for (const cell of enumerateWorldCells({ west: 166, south: -47, east: 178, north: -34 })) {
      expect(shardForCell(cell)).toBe('oceania');
    }
    for (const cell of enumerateWorldCells({ west: 141, south: -10, east: 150, north: -2 })) {
      expect(shardForCell(cell)).toBe('oceania');
    }
  });

  it('puts deep southern cells in antarctica', () => {
    expect(shardForCell(worldCell(0, -70))).toBe('antarctica');
    expect(shardForCell(worldCell(-150, -80))).toBe('antarctica');
  });

  it('keeps Greenland and Iceland out of the continental shards', () => {
    expect(shardForCell(worldCell(-44, 70))).toBe('greenland');
    expect(shardForCell(worldCell(-20, 64))).toBe('iceland');
  });

  it('cellsForShard partitions the world', () => {
    const total = enumerateWorldCells().length;
    const counted = worldShardNames().reduce((sum, name) => sum + cellsForShard(name).length, 0);
    expect(counted).toBe(total);
    expect(cellsForShard('oceania').some(c => c.id === 'S26E132')).toBe(true);
    expect(() => cellsForShard('atlantis')).toThrow(/Unknown shard/);
  });
});

describe('fetch-dem-copernicus pure helpers', () => {
  it('parses the selection flags', () => {
    expect(parseFetchArgs(['--bbox', '132', '-26', '134', '-24'])).toMatchObject({
      bbox: { west: 132, south: -26, east: 134, north: -24 },
      parallel: 4,
      dryRun: false,
      refreshTileList: false,
    });
    expect(parseFetchArgs(['--cells', 'S26E132, S26E134'])).toMatchObject({
      cells: ['S26E132', 'S26E134'],
    });
    expect(
      parseFetchArgs(['--shard', 'oceania', '--parallel', '8', '--dry-run', '--refresh-tilelist'])
    ).toMatchObject({ shard: 'oceania', parallel: 8, dryRun: true, refreshTileList: true });
  });

  it('rejects unusable argument sets', () => {
    expect(() => parseFetchArgs([])).toThrow(/--bbox, --cells or --shard/);
    expect(() => parseFetchArgs(['--bbox', '132', '-26'])).toThrow(/W S E N/);
    expect(() => parseFetchArgs(['--bbox', 'a', 'b', 'c', 'd'])).toThrow(/numbers/);
    expect(() => parseFetchArgs(['--shard'])).toThrow(/requires a value/);
    expect(() => parseFetchArgs(['--shard', 'oceania', '--parallel', '0'])).toThrow(/positive/);
    expect(() => parseFetchArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('resolves cells from a bbox and dedupes overlapping selections', () => {
    const args = parseFetchArgs(['--bbox', '132', '-26', '134.5', '-24', '--cells', 'S26E132']);
    expect(resolveCells(args).map(c => c.id)).toEqual(['S26E132', 'S26E134']);
  });

  it('rejects a misaligned cell id', () => {
    expect(() => resolveCells(parseFetchArgs(['--cells', 'S25E132']))).toThrow(/Invalid cell id/);
    expect(() => resolveCells(parseFetchArgs(['--cells', 'E132_S24']))).toThrow(/Invalid cell id/);
  });

  it('resolves the deduped 1° tiles for a two-cell selection', () => {
    const cells = resolveCells(parseFetchArgs(['--bbox', '132', '-26', '134', '-22']));
    expect(cells.map(c => c.id)).toEqual(['S24E132', 'S26E132']);
    // Two stacked cells share no tile rows, so 8 distinct tiles.
    expect(neededTiles(cells).map(demTileName)).toEqual([
      'S23E132', 'S23E133', 'S24E132', 'S24E133',
      'S25E132', 'S25E133', 'S26E132', 'S26E133',
    ]);
  });

  it('dedupes tiles shared by adjacent cells', () => {
    const cells = resolveCells(parseFetchArgs(['--cells', 'S26E132,S26E134']));
    const names = neededTiles(cells).map(demTileName);
    expect(names).toHaveLength(8);
    expect(new Set(names).size).toBe(8);
  });

  it('splits tiles into download / ocean / present', () => {
    const tiles = neededTiles([worldCell(132, -26)]);
    const demDir = '/tmp/does-not-exist-dem';
    const present = new Set([demTilePath(demDir, { lat: -26, lon: 132 })]);
    const plan = planTiles({
      tiles,
      demDir,
      // S25E133 is "ocean": absent from the bucket manifest.
      available: new Set(['S26E132', 'S25E132', 'S26E133']),
      exists: filePath => present.has(filePath),
    });
    expect(plan.present.map(demTileName)).toEqual(['S26E132']);
    expect(plan.toDownload.map(demTileName)).toEqual(['S25E132', 'S26E133']);
    expect(plan.ocean.map(demTileName)).toEqual(['S25E133']);
  });

  it('accepts both TIFF byte orders and rejects anything else', () => {
    expect(isTiffMagic(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBe(true);
    expect(isTiffMagic(Buffer.from([0x4d, 0x4d, 0x00, 0x2a]))).toBe(true);
    expect(isTiffMagic(Buffer.from('<?xml version'))).toBe(false);
    expect(isTiffMagic(Buffer.alloc(4))).toBe(false);
  });
});
