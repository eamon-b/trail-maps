import { useDownloadsStore } from '../downloads-store';
import { tileManager } from '../../services/tile-manager';
import { resolveStyleSource } from '../../features/map/map-style';
import type { DownloadOptions } from '../../services/tile-service';

jest.mock('../../services/tile-manager', () => ({
  tileManager: {
    getTrailStatus: jest.fn(),
    downloadTrail: jest.fn(),
    deleteTrail: jest.fn(),
    clearValidationCache: jest.fn(),
    checkForUpdate: jest.fn(),
  },
}));

const mockGetStatus = tileManager.getTrailStatus as jest.Mock;
const mockDownload = tileManager.downloadTrail as jest.Mock;
const mockDelete = tileManager.deleteTrail as jest.Mock;
const mockClearCache = tileManager.clearValidationCache as jest.Mock;
const mockCheckForUpdate = tileManager.checkForUpdate as jest.Mock;

function status(state: 'absent' | 'partial' | 'complete', totalSizeBytes = 0) {
  return { trailId: 't', files: [], complete: state === 'complete', state, totalSizeBytes };
}

describe('downloads-store', () => {
  beforeEach(() => {
    useDownloadsStore.setState({ byTrail: {} });
    jest.clearAllMocks();
  });

  it('defaults to an idle status for unknown trails', () => {
    expect(useDownloadsStore.getState().get('nope')).toEqual({
      state: 'absent',
      downloading: false,
      progress: 0,
    });
  });

  it('hydrates statuses from the tile manager', () => {
    mockGetStatus.mockImplementation((id: string) =>
      id === 'aawt' ? status('complete') : status('absent'),
    );
    useDownloadsStore.getState().hydrate(['aawt', 'heysen']);
    expect(useDownloadsStore.getState().get('aawt').state).toBe('complete');
    expect(useDownloadsStore.getState().get('heysen').state).toBe('absent');
  });

  it('refreshStatus re-reads a single trail', () => {
    mockGetStatus.mockReturnValue(status('partial'));
    useDownloadsStore.getState().refreshStatus('aawt');
    expect(useDownloadsStore.getState().get('aawt').state).toBe('partial');
  });

  it('runs a download to completion with progress', async () => {
    mockDownload.mockImplementation(
      async (_id: string, _url: string, opts: DownloadOptions) => {
        opts.onProgress?.({
          fileName: 'base.mbtiles',
          done: true,
          bytesDownloaded: 50,
          bytesTotal: 100,
        });
      },
    );
    mockGetStatus.mockReturnValue(status('complete'));

    await useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');

    const s = useDownloadsStore.getState().get('aawt');
    expect(s.downloading).toBe(false);
    expect(s.state).toBe('complete');
    expect(s.progress).toBe(1);
    expect(mockDownload).toHaveBeenCalledWith(
      'aawt',
      'https://tiles.example',
      expect.objectContaining({ signal: expect.any(Object) }),
    );
  });

  it('records an error when the download fails', async () => {
    mockDownload.mockRejectedValue(new Error('network down'));
    mockGetStatus.mockReturnValue(status('absent'));

    await useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');

    const s = useDownloadsStore.getState().get('aawt');
    expect(s.downloading).toBe(false);
    expect(s.error).toBe('network down');
  });

  it('cancelling clears the error and stops the download', async () => {
    let capturedOpts: DownloadOptions | undefined;
    let rejectDownload: ((e: Error) => void) | undefined;
    mockDownload.mockImplementation(
      (_id: string, _url: string, opts: DownloadOptions) =>
        new Promise<void>((_resolve, reject) => {
          capturedOpts = opts;
          rejectDownload = reject;
        }),
    );
    mockGetStatus.mockReturnValue(status('partial'));

    const promise = useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');
    expect(useDownloadsStore.getState().get('aawt').downloading).toBe(true);

    // User cancels — flips the shared signal the download loop checks.
    useDownloadsStore.getState().cancel('aawt');
    expect(capturedOpts?.signal?.cancelled).toBe(true);

    rejectDownload?.(new Error('Cancelled'));
    await promise;

    const s = useDownloadsStore.getState().get('aawt');
    expect(s.downloading).toBe(false);
    expect(s.error).toBeUndefined();
  });

  it('takes the map off the offline tiles while an update re-download runs', async () => {
    // The regression: during an *update* the pack on disk stays 'complete', so
    // the guide map kept the mbtiles mounted in MapLibre while
    // downloadTrailTiles overwrote them in place (native crash risk).
    let finishDownload: (() => void) | undefined;
    mockDownload.mockImplementation(
      () => new Promise<void>((resolve) => { finishDownload = resolve; }),
    );
    mockGetStatus.mockReturnValue(status('complete'));

    // A fully downloaded trail: the map is on the offline style.
    useDownloadsStore.getState().refreshStatus('aawt');
    let entry = useDownloadsStore.getState().get('aawt');
    expect(resolveStyleSource(entry.state, { downloading: entry.downloading })).toBe('offline');

    const promise = useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');

    // In flight: state is still 'complete', but the map must go online.
    entry = useDownloadsStore.getState().get('aawt');
    expect(entry.state).toBe('complete');
    expect(entry.downloading).toBe(true);
    expect(resolveStyleSource(entry.state, { downloading: entry.downloading })).toBe('online');
    // Stale validation verdicts for the files being rewritten are dropped.
    expect(mockClearCache).toHaveBeenCalledWith('aawt');

    finishDownload?.();
    await promise;

    // Done: back to offline automatically, with a fresh validation pass.
    entry = useDownloadsStore.getState().get('aawt');
    expect(entry.downloading).toBe(false);
    expect(resolveStyleSource(entry.state, { downloading: entry.downloading })).toBe('offline');
    expect(mockClearCache).toHaveBeenCalledTimes(2);
  });

  it('clears the validation cache even when a download fails', async () => {
    mockDownload.mockRejectedValue(new Error('network down'));
    mockGetStatus.mockReturnValue(status('partial'));

    await useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');

    expect(mockClearCache).toHaveBeenCalledTimes(2);
  });

  describe('checkForUpdates', () => {
    it('flags a complete trail whose remote pack is newer', async () => {
      mockGetStatus.mockReturnValue(status('complete'));
      mockCheckForUpdate.mockResolvedValue({
        updateAvailable: true,
        localVersion: 'v1',
        remoteVersion: 'v2',
      });

      await useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example');

      const s = useDownloadsStore.getState().get('aawt');
      expect(s.updateAvailable).toBe(true);
      expect(s.remoteVersion).toBe('v2');
      expect(mockCheckForUpdate).toHaveBeenCalledWith('aawt', 'https://tiles.example');
    });

    it('clears the flag when the local pack is already current', async () => {
      mockGetStatus.mockReturnValue(status('complete'));
      useDownloadsStore.setState({
        byTrail: {
          aawt: { state: 'complete', downloading: false, progress: 1, updateAvailable: true },
        },
      });
      mockCheckForUpdate.mockResolvedValue({
        updateAvailable: false,
        localVersion: 'v2',
        remoteVersion: 'v2',
      });

      await useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example');

      const s = useDownloadsStore.getState().get('aawt');
      expect(s.updateAvailable).toBe(false);
      expect(s.remoteVersion).toBeUndefined();
    });

    it.each(['absent', 'partial'] as const)(
      'never asks (or flags) for a %s pack — that needs a download, not an update',
      async (state) => {
        mockGetStatus.mockReturnValue(status(state));

        await useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example');

        // checkForTileUpdate reports updateAvailable:true for an incomplete
        // pack, which would read as "your maps are out of date" to a user who
        // never downloaded them.
        expect(mockCheckForUpdate).not.toHaveBeenCalled();
        expect(useDownloadsStore.getState().get('aawt').updateAvailable).toBe(false);
      },
    );

    it('skips a trail that is mid-download', async () => {
      mockGetStatus.mockReturnValue(status('complete'));
      useDownloadsStore.setState({
        byTrail: { aawt: { state: 'complete', downloading: true, progress: 0.4 } },
      });

      await useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example');

      expect(mockCheckForUpdate).not.toHaveBeenCalled();
    });

    it('does nothing without a base URL', async () => {
      await useDownloadsStore.getState().checkForUpdates(['aawt'], '');

      expect(mockCheckForUpdate).not.toHaveBeenCalled();
      expect(mockGetStatus).not.toHaveBeenCalled();
    });

    it('fails silently when the check throws (offline): no badge, no error', async () => {
      mockGetStatus.mockReturnValue(status('complete'));
      mockCheckForUpdate.mockRejectedValue(new Error('Network request failed'));

      await expect(
        useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example'),
      ).resolves.toBeUndefined();

      const s = useDownloadsStore.getState().get('aawt');
      expect(s.updateAvailable).toBeFalsy();
      expect(s.error).toBeUndefined();
    });

    it('checks several trails independently', async () => {
      mockGetStatus.mockImplementation((id: string) =>
        id === 'heysen' ? status('absent') : status('complete'),
      );
      mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, remoteVersion: 'v9' });

      await useDownloadsStore
        .getState()
        .checkForUpdates(['aawt', 'heysen', 'bibbulmun'], 'https://tiles.example');

      expect(useDownloadsStore.getState().get('aawt').updateAvailable).toBe(true);
      expect(useDownloadsStore.getState().get('heysen').updateAvailable).toBe(false);
      expect(useDownloadsStore.getState().get('bibbulmun').updateAvailable).toBe(true);
    });

    it('a successful (re-)download clears the update badge', async () => {
      mockGetStatus.mockReturnValue(status('complete'));
      mockCheckForUpdate.mockResolvedValue({ updateAvailable: true, remoteVersion: 'v2' });
      mockDownload.mockResolvedValue(undefined);

      await useDownloadsStore.getState().checkForUpdates(['aawt'], 'https://tiles.example');
      expect(useDownloadsStore.getState().get('aawt').updateAvailable).toBe(true);

      await useDownloadsStore.getState().startDownload('aawt', 'https://tiles.example');

      const s = useDownloadsStore.getState().get('aawt');
      expect(s.updateAvailable).toBe(false);
      expect(s.remoteVersion).toBeUndefined();
    });
  });

  it('deleteTiles removes tiles and refreshes status', () => {
    mockGetStatus.mockReturnValue(status('absent'));
    useDownloadsStore.getState().deleteTiles('aawt');
    expect(mockDelete).toHaveBeenCalledWith('aawt');
    expect(useDownloadsStore.getState().get('aawt').state).toBe('absent');
  });
});
