// Variables prefixed with "mock" are accessible inside jest.mock factories
const mockDirExists = jest.fn(() => false);
const mockDirList = jest.fn((): unknown[] => []);

jest.mock('expo-file-system', () => {
  // Must define constructor inside factory; use `this` so instanceof works
  function MockDir(this: Record<string, unknown>) {
    Object.defineProperty(this, 'exists', { get: () => mockDirExists() });
    this.list = mockDirList;
    this.name = 'tiles';
    this.create = jest.fn();
    this.delete = jest.fn();
  }

  return {
    __esModule: true,
    Directory: MockDir,
    Paths: { document: '/mock/document', availableDiskSpace: 1000000000 },
    readAsStringAsync: jest.fn(),
    writeAsStringAsync: jest.fn(),
    documentDirectory: '/mock/document/',
    cacheDirectory: '/mock/cache/',
  };
});

// Mock tile-service entirely since TileManager is a thin wrapper
jest.mock('../tile-service', () => ({
  getTrailTileStatus: jest.fn(),
  downloadTrailTiles: jest.fn().mockResolvedValue(undefined),
  deleteTrailTiles: jest.fn(),
  provisionGlyphs: jest.fn().mockResolvedValue('/mock/fonts'),
  buildTopoStyle: jest.fn().mockReturnValue({ version: 8, layers: [] }),
}));

import { TileManager } from '../tile-manager';
import {
  getTrailTileStatus,
  deleteTrailTiles,
  provisionGlyphs,
  buildTopoStyle,
} from '../tile-service';

const mockGetStatus = getTrailTileStatus as jest.MockedFunction<typeof getTrailTileStatus>;
const mockDelete = deleteTrailTiles as jest.MockedFunction<typeof deleteTrailTiles>;
const mockProvisionGlyphs = provisionGlyphs as jest.MockedFunction<typeof provisionGlyphs>;
const mockBuildStyle = buildTopoStyle as jest.MockedFunction<typeof buildTopoStyle>;

describe('TileManager', () => {
  let manager: TileManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDirExists.mockReturnValue(false);
    mockDirList.mockReturnValue([]);
    manager = new TileManager();
  });

  it('isTrailDownloaded delegates to getTrailTileStatus().complete', () => {
    mockGetStatus.mockReturnValue({
      trailId: 'heysen',
      files: [],
      complete: true,
      totalSizeBytes: 5000,
    });

    expect(manager.isTrailDownloaded('heysen')).toBe(true);
    expect(mockGetStatus).toHaveBeenCalledWith('heysen');

    mockGetStatus.mockReturnValue({
      trailId: 'heysen',
      files: [],
      complete: false,
      totalSizeBytes: 0,
    });

    expect(manager.isTrailDownloaded('heysen')).toBe(false);
  });

  it('getTrailStatus delegates to getTrailTileStatus', () => {
    const status = {
      trailId: 'bibbulmun',
      files: [{ name: 'base.mbtiles' as const, exists: true, sizeBytes: 3000 }],
      complete: false,
      totalSizeBytes: 3000,
    };
    mockGetStatus.mockReturnValue(status);

    expect(manager.getTrailStatus('bibbulmun')).toBe(status);
    expect(mockGetStatus).toHaveBeenCalledWith('bibbulmun');
  });

  it('getDownloadedTrails returns empty when no tiles directory exists', () => {
    mockDirExists.mockReturnValue(false);

    expect(manager.getDownloadedTrails()).toEqual([]);
  });

  it('getDownloadedTrails filters to complete trails when directory exists', () => {
    mockDirExists.mockReturnValue(true);

    const { Directory } = require('expo-file-system');
    const dir1 = new Directory();
    Object.defineProperty(dir1, 'name', { value: 'trail-1' });
    const dir2 = new Directory();
    Object.defineProperty(dir2, 'name', { value: 'trail-2' });
    const dir3 = new Directory();
    Object.defineProperty(dir3, 'name', { value: 'trail-3' });

    mockDirList.mockReturnValue([dir1, dir2, dir3]);

    mockGetStatus.mockImplementation((id: string) => ({
      trailId: id,
      files: [],
      complete: id === 'trail-1' || id === 'trail-3',
      totalSizeBytes: id === 'trail-1' ? 5000 : id === 'trail-3' ? 8000 : 0,
    }));

    expect(manager.getDownloadedTrails()).toEqual(['trail-1', 'trail-3']);
  });

  it('getOfflineStyle returns null when trail is not downloaded', async () => {
    mockGetStatus.mockReturnValue({
      trailId: 'heysen',
      files: [],
      complete: false,
      totalSizeBytes: 0,
    });

    const result = await manager.getOfflineStyle('heysen');
    expect(result).toBeNull();
    expect(mockProvisionGlyphs).not.toHaveBeenCalled();
    expect(mockBuildStyle).not.toHaveBeenCalled();
  });

  it('getOfflineStyle provisions glyphs and returns style when downloaded', async () => {
    mockGetStatus.mockReturnValue({
      trailId: 'heysen',
      files: [],
      complete: true,
      totalSizeBytes: 10000,
    });

    const expectedStyle = { version: 8, layers: [], sources: {} };
    mockBuildStyle.mockReturnValue(expectedStyle);
    mockProvisionGlyphs.mockResolvedValue('/mock/fonts');

    const result = await manager.getOfflineStyle('heysen');

    expect(mockProvisionGlyphs).toHaveBeenCalled();
    expect(mockBuildStyle).toHaveBeenCalledWith('heysen', '/mock/fonts');
    expect(result).toBe(expectedStyle);
  });

  it('deleteTrail delegates to deleteTrailTiles', () => {
    manager.deleteTrail('bibbulmun');

    expect(mockDelete).toHaveBeenCalledWith('bibbulmun');
  });

  it('getTotalStorageUsed sums sizes across all downloaded trails', () => {
    mockDirExists.mockReturnValue(true);

    const { Directory } = require('expo-file-system');
    const dir1 = new Directory();
    Object.defineProperty(dir1, 'name', { value: 'trail-a' });
    const dir2 = new Directory();
    Object.defineProperty(dir2, 'name', { value: 'trail-b' });

    mockDirList.mockReturnValue([dir1, dir2]);

    mockGetStatus.mockImplementation((id: string) => ({
      trailId: id,
      files: [],
      complete: true,
      totalSizeBytes: id === 'trail-a' ? 4000 : 6000,
    }));

    expect(manager.getTotalStorageUsed()).toBe(10000);
  });
});
