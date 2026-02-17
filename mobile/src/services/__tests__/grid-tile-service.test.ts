import type { GridIndex, GridCell } from '@lib/types';
import {
  resolveGridCells,
  fetchGridIndex,
  clearGridIndexCache,
} from '../grid-tile-service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGridIndex(cells: GridCell[]): GridIndex {
  return {
    version: '2024-01-01',
    cellSizeDeg: [2, 2],
    bounds: [112, -44, 154, -10],
    cells,
  };
}

function makeCell(id: string): GridCell {
  const match = id.match(/E(\d+)_S(\d+)/);
  const lon = parseInt(match![1]);
  const lat = parseInt(match![2]);
  return {
    id,
    bounds: [lon, -(lat + 2), lon + 2, -lat],
    totalSize: 50_000_000,
  };
}

// ---------------------------------------------------------------------------
// resolveGridCells
// ---------------------------------------------------------------------------

describe('resolveGridCells', () => {
  it('returns 1 cell when bounds fit within a single grid cell', () => {
    const index = makeGridIndex([
      makeCell('E114_S34'),
      makeCell('E116_S34'),
      makeCell('E114_S36'),
    ]);

    const result = resolveGridCells(
      { west: 114.5, south: -35.5, east: 115.5, north: -34.5 },
      index,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('E114_S34');
  });

  it('returns all overlapping cells when bounds span multiple cells', () => {
    const index = makeGridIndex([
      makeCell('E114_S32'),
      makeCell('E114_S34'),
      makeCell('E116_S32'),
      makeCell('E116_S34'),
    ]);

    const result = resolveGridCells(
      { west: 115, south: -35, east: 117, north: -33 },
      index,
    );

    expect(result).toHaveLength(4);
    const ids = result.map((c) => c.id).sort();
    expect(ids).toEqual(['E114_S32', 'E114_S34', 'E116_S32', 'E116_S34']);
  });

  it('handles negative latitudes (Australian coordinates)', () => {
    const index = makeGridIndex([
      makeCell('E148_S34'),
      makeCell('E148_S36'),
      makeCell('E150_S32'),
      makeCell('E150_S34'),
      makeCell('E150_S36'),
    ]);

    // Sydney area: lon ~150.5-151, lat -34.5 to -33.5
    const result = resolveGridCells(
      { west: 150.5, south: -34.5, east: 151, north: -33.5 },
      index,
    );

    expect(result).toHaveLength(2);
    const ids = result.map((c) => c.id).sort();
    expect(ids).toEqual(['E150_S32', 'E150_S34']);
  });

  it('returns empty array when no index cells match the bounds', () => {
    const index = makeGridIndex([
      makeCell('E114_S34'),
      makeCell('E116_S34'),
    ]);

    const result = resolveGridCells(
      { west: 150, south: -30, east: 152, north: -28 },
      index,
    );

    expect(result).toHaveLength(0);
  });

  it('handles single-point (degenerate) bounds', () => {
    const index = makeGridIndex([
      makeCell('E114_S34'),
      makeCell('E116_S34'),
    ]);

    const result = resolveGridCells(
      { west: 115, south: -35, east: 115, north: -35 },
      index,
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('E114_S34');
  });
});

// ---------------------------------------------------------------------------
// fetchGridIndex
// ---------------------------------------------------------------------------

describe('fetchGridIndex', () => {
  const mockIndex = makeGridIndex([makeCell('E114_S34')]);

  beforeEach(() => {
    clearGridIndexCache();
    (global.fetch as jest.Mock) = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('fetches from network on first call', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIndex,
    });

    const result = await fetchGridIndex('https://tiles.example.com');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://tiles.example.com/grid/index.json',
    );
    expect(result).toEqual(mockIndex);
  });

  it('returns cached result on subsequent calls', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: async () => mockIndex,
    });

    const first = await fetchGridIndex('https://tiles.example.com');
    const second = await fetchGridIndex('https://tiles.example.com');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it('refetches after cache expiry', async () => {
    jest.useFakeTimers();

    const index1 = makeGridIndex([makeCell('E114_S34')]);
    const index2 = makeGridIndex([makeCell('E114_S34'), makeCell('E116_S34')]);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => index1 })
      .mockResolvedValueOnce({ ok: true, json: async () => index2 });

    const first = await fetchGridIndex('https://tiles.example.com');
    expect(first).toEqual(index1);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Advance past the 1-hour cache
    jest.advanceTimersByTime(60 * 60 * 1000 + 1);

    const second = await fetchGridIndex('https://tiles.example.com');
    expect(second).toEqual(index2);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it('throws on non-OK response', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    await expect(
      fetchGridIndex('https://tiles.example.com'),
    ).rejects.toThrow('Failed to fetch grid index: HTTP 404');
  });
});

// ---------------------------------------------------------------------------
// clearGridIndexCache
// ---------------------------------------------------------------------------

describe('clearGridIndexCache', () => {
  beforeEach(() => {
    clearGridIndexCache();
    (global.fetch as jest.Mock) = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('forces next fetchGridIndex call to refetch from network', async () => {
    const index1 = makeGridIndex([makeCell('E114_S34')]);
    const index2 = makeGridIndex([makeCell('E116_S36')]);

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({ ok: true, json: async () => index1 })
      .mockResolvedValueOnce({ ok: true, json: async () => index2 });

    const first = await fetchGridIndex('https://tiles.example.com');
    expect(first).toEqual(index1);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    clearGridIndexCache();

    const second = await fetchGridIndex('https://tiles.example.com');
    expect(second).toEqual(index2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
