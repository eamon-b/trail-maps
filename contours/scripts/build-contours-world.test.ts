import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  batchCellsByBytes,
  batchCellsLabel,
  batchDoneLabel,
  batchDoneMarker,
  batchFileName,
  batchMatchesSettings,
  canReuseBatch,
  canReuseConversion,
  mergeModeFor,
  outOfRangeBatches,
  parseArgs,
  selectionName,
  shardMbtilesName,
  shardPmtilesPath,
} from './build-contours-world.js';

// Only the pure helpers are exercised here. Nothing below spawns gdal,
// tippecanoe, tile-join or pmtiles, or touches the DEM / work dirs.

describe('parseArgs', () => {
  it('parses a shard build with defaults', () => {
    const args = parseArgs(['--shard', 'oceania']);
    expect(args.shard).toBe('oceania');
    expect(args.parallel).toBe(1);
    expect(args.mergeOnly).toBe(false);
    expect(args.cellsOnly).toBe(false);
    expect(args.batchesOnly).toBe(false);
    expect(args.batches).toBeNull();
    expect(args.joinBatches).toBe(false);
    expect(args.join).toBe(false);
  });

  it('requires a selection unless --join', () => {
    expect(() => parseArgs([])).toThrow(/--shard, --bbox or --cell is required/);
    expect(parseArgs(['--join']).join).toBe(true);
  });

  it('rejects an unknown shard and unknown flags', () => {
    expect(() => parseArgs(['--shard', 'atlantis'])).toThrow(/Unknown shard "atlantis"/);
    expect(() => parseArgs(['--shard', 'oceania', '--nope'])).toThrow(/Unknown argument: --nope/);
  });

  it('refuses a flag value that is another flag', () => {
    expect(() => parseArgs(['--shard', '--force'])).toThrow(/--shard requires a value/);
    expect(() => parseArgs(['--shard', 'oceania', '--batches-only', '--batch'])).toThrow(/--batch requires a value/);
  });

  it('parses --bbox and --parallel', () => {
    const args = parseArgs(['--bbox', '132', '-26', '134', '-24', '--parallel', '8']);
    expect(args.bbox).toEqual({ west: 132, south: -26, east: 134, north: -24 });
    expect(args.parallel).toBe(8);
    expect(() => parseArgs(['--bbox', '132', 'x', '134', '-24'])).toThrow(/must be numbers/);
    expect(() => parseArgs(['--bbox', '132', '-26'])).toThrow(/requires W S E N/);
    expect(() => parseArgs(['--shard', 'oceania', '--parallel', '0'])).toThrow(/positive integer/);
  });

  describe('--cells-only', () => {
    it('is accepted on its own', () => {
      const args = parseArgs(['--shard', 'oceania', '--cells-only']);
      expect(args.cellsOnly).toBe(true);
      expect(args.mergeOnly).toBe(false);
    });

    it('is the opposite of --merge-only', () => {
      expect(() => parseArgs(['--shard', 'oceania', '--cells-only', '--merge-only'])).toThrow(/opposites/);
    });

    it('cannot be combined with either merge half', () => {
      expect(() => parseArgs(['--shard', 'oceania', '--cells-only', '--batches-only'])).toThrow(/never merges/);
      expect(() => parseArgs(['--shard', 'oceania', '--cells-only', '--join-batches'])).toThrow(
        /opposites|never merges/
      );
    });
  });

  describe('--batches-only / --join-batches', () => {
    it('accepts --batches-only with --merge-only', () => {
      const args = parseArgs(['--shard', 'oceania', '--merge-only', '--batches-only']);
      expect(args.batchesOnly).toBe(true);
      expect(args.mergeOnly).toBe(true);
      expect(args.batches).toBeNull();
    });

    it('rejects both halves at once', () => {
      expect(() => parseArgs(['--shard', 'oceania', '--batches-only', '--join-batches'])).toThrow(
        /--batches-only and --join-batches are opposites/
      );
    });

    it('--join-batches implies --merge-only', () => {
      const args = parseArgs(['--shard', 'oceania', '--join-batches']);
      expect(args.joinBatches).toBe(true);
      expect(args.mergeOnly).toBe(true);
    });
  });

  describe('--batch', () => {
    it('parses a sorted, de-duplicated list of 0-based indexes', () => {
      const args = parseArgs(['--shard', 'oceania', '--merge-only', '--batches-only', '--batch', '3, 1,3,0']);
      expect(args.batches).toEqual([0, 1, 3]);
    });

    it('parses a single index', () => {
      expect(parseArgs(['--shard', 'oceania', '--batches-only', '--batch', '2']).batches).toEqual([2]);
    });

    it('rejects anything but non-negative integers', () => {
      for (const bad of ['-1', '1.5', 'a', '1,,2', '']) {
        expect(() => parseArgs(['--shard', 'oceania', '--batches-only', '--batch', bad])).toThrow(
          /comma-separated batch indexes/
        );
      }
    });

    it('needs --batches-only', () => {
      expect(() => parseArgs(['--shard', 'oceania', '--merge-only', '--batch', '1'])).toThrow(
        /--batch needs --batches-only/
      );
      expect(() => parseArgs(['--shard', 'oceania', '--join-batches', '--batch', '1'])).toThrow();
    });
  });
});

describe('mergeModeFor', () => {
  it('maps the flags to the merge half', () => {
    expect(mergeModeFor(parseArgs(['--shard', 'oceania', '--merge-only']))).toBe('full');
    expect(mergeModeFor(parseArgs(['--shard', 'oceania', '--merge-only', '--batches-only']))).toBe('batches-only');
    expect(mergeModeFor(parseArgs(['--shard', 'oceania', '--join-batches']))).toBe('join-batches');
  });
});

describe('selection naming', () => {
  it('names the work dir and output after the shard, else custom', () => {
    expect(selectionName({ shard: 'oceania' })).toBe('oceania');
    expect(selectionName({ shard: null })).toBe('custom');
    expect(shardMbtilesName({ shard: 'europe' })).toBe('world_europe.mbtiles');
    expect(shardMbtilesName({ shard: null })).toBe('world_custom.mbtiles');
  });
});

describe('batchCellsByBytes', () => {
  const bytes = new Map([
    ['A', 40],
    ['B', 40],
    ['C', 30],
    ['D', 200],
    ['E', 10],
  ]);

  it('closes a batch before a cell that would push it over the cap', () => {
    expect(batchCellsByBytes(['A', 'B', 'C', 'D', 'E'], bytes, 100)).toEqual([['A', 'B'], ['C'], ['D'], ['E']]);
  });

  it('gives an oversized cell a batch of its own', () => {
    expect(batchCellsByBytes(['D'], bytes, 100)).toEqual([['D']]);
  });

  it('keeps everything in one batch under the cap, and is empty for no cells', () => {
    expect(batchCellsByBytes(['A', 'B', 'C', 'D', 'E'], bytes, 1000)).toEqual([['A', 'B', 'C', 'D', 'E']]);
    expect(batchCellsByBytes([], bytes, 100)).toEqual([]);
  });

  it('counts a cell with no recorded size as zero bytes', () => {
    expect(batchCellsByBytes(['A', 'X', 'B'], bytes, 80)).toEqual([['A', 'X', 'B']]);
  });
});

describe('batch files and labels', () => {
  it('names batch files and their markers', () => {
    expect(batchFileName(0)).toBe('batch-00.mbtiles');
    expect(batchFileName(7)).toBe('batch-07.mbtiles');
    expect(batchFileName(12)).toBe('batch-12.mbtiles');
    expect(batchDoneMarker('/w/batch-03.mbtiles')).toBe('/w/batch-03.mbtiles.done');
  });

  it('labels a batch by its cells, bytes and settings', () => {
    const cells = batchCellsLabel(['S26E132', 'S26E134', 'S24E132'], 3 * 1024 * 1024);
    expect(cells).toBe('3 cells, 3.0 MB (S26E132…S24E132)');
    expect(batchDoneLabel(cells, 'tippecanoe v2.79.0 settings abc123')).toBe(
      '3 cells, 3.0 MB (S26E132…S24E132), tippecanoe v2.79.0 settings abc123'
    );
  });

  it('labels a one-cell batch with that cell at both ends', () => {
    expect(batchCellsLabel(['N46E006'], 512)).toBe('1 cells, 512 B (N46E006…N46E006)');
  });

  describe('canReuseBatch', () => {
    const label = batchDoneLabel(batchCellsLabel(['S26E132', 'S26E134'], 2048), 'tippecanoe v2.79.0 settings abc');

    it('reuses a batch whose marker names exactly the same cells and settings', () => {
      expect(canReuseBatch(true, label, label)).toBe(true);
    });

    it('re-tiles when the mbtiles or the marker is missing', () => {
      expect(canReuseBatch(false, label, label)).toBe(false);
      expect(canReuseBatch(true, null, label)).toBe(false);
    });

    it('re-tiles when the cells differ', () => {
      const other = batchDoneLabel(batchCellsLabel(['S26E132', 'S26E136'], 2048), 'tippecanoe v2.79.0 settings abc');
      expect(canReuseBatch(true, other, label)).toBe(false);
    });

    it('re-tiles when the tippecanoe release or settings differ', () => {
      const cells = batchCellsLabel(['S26E132', 'S26E134'], 2048);
      expect(canReuseBatch(true, batchDoneLabel(cells, 'tippecanoe v2.78.0 settings abc'), label)).toBe(false);
      expect(canReuseBatch(true, batchDoneLabel(cells, 'tippecanoe v2.79.0 settings def'), label)).toBe(false);
      // A pre-settings marker (cells only) is never reused.
      expect(canReuseBatch(true, cells, label)).toBe(false);
    });
  });

  describe('batchMatchesSettings (--join-batches)', () => {
    const settings = 'tippecanoe v2.79.0 settings abc';

    it('accepts a marker written with this run’s settings, whatever its cells', () => {
      expect(batchMatchesSettings(batchDoneLabel(batchCellsLabel(['S26E132'], 10), settings), settings)).toBe(true);
    });

    it('rejects a marker from another release, other settings, or before settings were recorded', () => {
      const cells = batchCellsLabel(['S26E132'], 10);
      expect(batchMatchesSettings(batchDoneLabel(cells, 'tippecanoe v2.78.0 settings abc'), settings)).toBe(false);
      expect(batchMatchesSettings(batchDoneLabel(cells, 'tippecanoe v2.79.0 settings abcd'), settings)).toBe(false);
      expect(batchMatchesSettings(cells, settings)).toBe(false);
    });
  });

  describe('outOfRangeBatches (--batch I,J)', () => {
    it('is empty when no subset is asked for or every index exists', () => {
      expect(outOfRangeBatches(null, 3)).toEqual([]);
      expect(outOfRangeBatches([0, 2], 3)).toEqual([]);
    });

    it('lists the indexes past the last batch', () => {
      expect(outOfRangeBatches([1, 3, 4], 3)).toEqual([3, 4]);
      expect(outOfRangeBatches([0], 0)).toEqual([0]);
    });
  });
});

describe('--join shard conversions', () => {
  it('converts each shard to a .pmtiles of the same name in the conversion dir', () => {
    const dir = path.join('out', 'pmtiles-shards');
    expect(shardPmtilesPath(path.join('out', 'world_oceania.mbtiles'), dir)).toBe(
      path.join(dir, 'world_oceania.pmtiles')
    );
    expect(shardPmtilesPath(path.join('out', 'world_asia-east.mbtiles'), dir)).toBe(
      path.join(dir, 'world_asia-east.pmtiles')
    );
  });

  describe('canReuseConversion', () => {
    it('reuses a conversion strictly newer than its shard', () => {
      expect(canReuseConversion(2000, 1000)).toBe(true);
    });

    it('re-converts when the shard is newer, equally old, or never converted', () => {
      expect(canReuseConversion(1000, 2000)).toBe(false);
      expect(canReuseConversion(1000, 1000)).toBe(false);
      expect(canReuseConversion(null, 1000)).toBe(false);
    });
  });
});
