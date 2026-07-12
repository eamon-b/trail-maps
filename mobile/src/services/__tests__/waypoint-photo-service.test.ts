/**
 * Tests for the waypoint photo service: downscale bounds math and the
 * store/delete file lifecycle (with mocked expo modules).
 */

// In-memory fake for the expo-file-system File/Directory API. Everything is
// defined inside the factory (jest.mock is hoisted above class declarations);
// the test reaches the file map via the __files escape hatch.
jest.mock('expo-file-system', () => {
  const files = new Map<string, { exists: boolean }>();

  class MockEntry {
    uri: string;
    constructor(...parts: (string | MockEntry)[]) {
      this.uri = parts.map(p => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists() {
      return files.get(this.uri)?.exists ?? false;
    }
  }

  class MockFile extends MockEntry {
    copy(dest: MockFile) {
      files.set(dest.uri, { exists: true });
    }
    delete() {
      files.delete(this.uri);
    }
  }

  class MockDirectory extends MockEntry {
    create() {
      files.set(this.uri, { exists: true });
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { document: '/doc', cache: '/cache' },
    __files: files,
  };
});

const mockManipulateAsync = jest.fn();
jest.mock('expo-image-manipulator', () => ({
  manipulateAsync: (...args: unknown[]) => mockManipulateAsync(...args),
  SaveFormat: { JPEG: 'jpeg' },
}));

const mockLaunchCamera = jest.fn();
const mockLaunchLibrary = jest.fn();
jest.mock('expo-image-picker', () => ({
  requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  launchCameraAsync: (...args: unknown[]) => mockLaunchCamera(...args),
  launchImageLibraryAsync: (...args: unknown[]) => mockLaunchLibrary(...args),
}));

import {
  constrainDimensions,
  pickWaypointPhoto,
  storeWaypointPhoto,
  deleteWaypointPhoto,
  MAX_DIMENSION,
  JPEG_QUALITY,
} from '../waypoint-photo-service';

const mockFiles: Map<string, { exists: boolean }> = jest.requireMock('expo-file-system').__files;

beforeEach(() => {
  mockFiles.clear();
  jest.clearAllMocks();
});

describe('constrainDimensions', () => {
  it('returns null when already within bounds (no resize needed)', () => {
    expect(constrainDimensions(1600, 1200)).toBeNull();
    expect(constrainDimensions(800, 600)).toBeNull();
  });

  it('scales landscape images to max width, preserving aspect', () => {
    expect(constrainDimensions(3200, 2400)).toEqual({ width: 1600, height: 1200 });
  });

  it('scales portrait images to max height, preserving aspect', () => {
    expect(constrainDimensions(2400, 3200)).toEqual({ width: 1200, height: 1600 });
  });

  it('never exceeds the max on either edge', () => {
    const r = constrainDimensions(5000, 100);
    expect(r).toEqual({ width: 1600, height: 32 });
    expect(Math.max(r!.width, r!.height)).toBeLessThanOrEqual(MAX_DIMENSION);
  });

  it('returns null for degenerate dimensions', () => {
    expect(constrainDimensions(0, 0)).toBeNull();
  });
});

describe('storeWaypointPhoto', () => {
  it('downscales oversized images and stores the file under waypoint-photos/', async () => {
    mockManipulateAsync.mockResolvedValue({ uri: '/tmp/manipulated.jpg' });
    mockFiles.set('/tmp/manipulated.jpg', { exists: true });

    const uri = await storeWaypointPhoto('wp-1', { uri: '/tmp/picked.jpg', width: 4000, height: 3000 });

    expect(mockManipulateAsync).toHaveBeenCalledWith(
      '/tmp/picked.jpg',
      [{ resize: { width: 1600, height: 1200 } }],
      { compress: JPEG_QUALITY, format: 'jpeg' },
    );
    expect(uri).toBe('/doc/waypoint-photos/wp-1.jpg');
    expect(mockFiles.get('/doc/waypoint-photos/wp-1.jpg')?.exists).toBe(true);
  });

  it('skips the resize action for small images (still recompresses)', async () => {
    mockManipulateAsync.mockResolvedValue({ uri: '/tmp/manipulated.jpg' });

    await storeWaypointPhoto('wp-2', { uri: '/tmp/picked.jpg', width: 800, height: 600 });

    expect(mockManipulateAsync).toHaveBeenCalledWith(
      '/tmp/picked.jpg',
      [],
      { compress: JPEG_QUALITY, format: 'jpeg' },
    );
  });

  it('still caps width when dimensions are unknown (Android 0×0 providers)', async () => {
    mockManipulateAsync.mockResolvedValue({ uri: '/tmp/manipulated.jpg' });

    // width/height 0 → constrainDimensions can't decide, but the full-res
    // image must not slip through: cap width, let the manipulator preserve
    // aspect from the only edge given.
    await storeWaypointPhoto('wp-3', { uri: '/tmp/picked.jpg', width: 0, height: 0 });

    expect(mockManipulateAsync).toHaveBeenCalledWith(
      '/tmp/picked.jpg',
      [{ resize: { width: MAX_DIMENSION } }],
      { compress: JPEG_QUALITY, format: 'jpeg' },
    );
  });
});

describe('deleteWaypointPhoto', () => {
  it('deletes an existing photo file', () => {
    mockFiles.set('/doc/waypoint-photos/wp-1.jpg', { exists: true });
    deleteWaypointPhoto('/doc/waypoint-photos/wp-1.jpg');
    expect(mockFiles.has('/doc/waypoint-photos/wp-1.jpg')).toBe(false);
  });

  it('is a no-op for null / missing files', () => {
    expect(() => deleteWaypointPhoto(null)).not.toThrow();
    expect(() => deleteWaypointPhoto('/doc/waypoint-photos/gone.jpg')).not.toThrow();
  });
});

describe('pickWaypointPhoto', () => {
  it('returns the picked asset from the library', async () => {
    mockLaunchLibrary.mockResolvedValue({
      canceled: false,
      assets: [{ uri: '/tmp/lib.jpg', width: 100, height: 50 }],
    });
    const picked = await pickWaypointPhoto('library');
    expect(picked).toEqual({ uri: '/tmp/lib.jpg', width: 100, height: 50 });
  });

  it('returns null when the user cancels', async () => {
    mockLaunchCamera.mockResolvedValue({ canceled: true, assets: null });
    const picked = await pickWaypointPhoto('camera');
    expect(picked).toBeNull();
  });
});
