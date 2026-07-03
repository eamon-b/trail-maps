import { processGpxFile, processGpxContent, saveCustomTrail, type ImportError } from '../custom-trail-service';
import { TrailDataService } from '../trail-data-service';
import type { ProcessingResult } from '../../lib/gpx-processor';

// Mock expo modules
jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));
jest.mock('expo-file-system', () => ({
  readAsStringAsync: jest.fn(),
}));

// Mock the database
jest.mock('../../db/database', () => ({
  getDatabase: jest.fn().mockResolvedValue({
    runAsync: jest.fn().mockResolvedValue({ changes: 1, lastInsertRowId: 1 }),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    getAllAsync: jest.fn().mockResolvedValue([]),
    execAsync: jest.fn().mockResolvedValue(undefined),
  }),
}));

const MINIMAL_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test Trail</name></metadata>
  <trk>
    <name>Test Track</name>
    <trkseg>
      <trkpt lat="-31.974" lon="116.058"><ele>295</ele></trkpt>
      <trkpt lat="-31.975" lon="116.059"><ele>300</ele></trkpt>
      <trkpt lat="-31.976" lon="116.060"><ele>310</ele></trkpt>
      <trkpt lat="-31.977" lon="116.061"><ele>305</ele></trkpt>
    </trkseg>
  </trk>
  <wpt lat="-31.974" lon="116.058"><name>Start</name></wpt>
</gpx>`;

const INVALID_XML = 'This is not XML content';

describe('processGpxContent', () => {
  it('processes a valid GPX string and returns trail data', async () => {
    const result = await processGpxContent(MINIMAL_GPX, 'test-trail.gpx');

    expect(result.trail).toBeDefined();
    expect(result.trail.config.name).toBe('Test Trail');
    expect(result.trail.track.points.length).toBeGreaterThan(0);
    expect(result.warnings).toBeInstanceOf(Array);
  });

  it('derives trail name from filename when GPX has no track name', async () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
      <trk><trkseg>
        <trkpt lat="-31.974" lon="116.058"><ele>295</ele></trkpt>
        <trkpt lat="-31.975" lon="116.059"><ele>300</ele></trkpt>
      </trkseg></trk>
    </gpx>`;

    const result = await processGpxContent(gpx, 'my-cool-trail.gpx');
    // trailName option overrides, which is derived from filename
    expect(result.trail.config.name).toBe('My Cool Trail');
  });

  it('throws ImportError for invalid GPX content', async () => {
    try {
      await processGpxContent(INVALID_XML, 'bad.gpx');
      fail('Should have thrown');
    } catch (e) {
      const err = e as ImportError;
      expect(err.type).toBe('processing');
      expect(err.message).toBeDefined();
      expect(err.suggestion).toBeDefined();
    }
  });

  it('allows overriding trail name via options', async () => {
    const result = await processGpxContent(MINIMAL_GPX, 'test.gpx', {
      trailName: 'My Custom Name',
    });
    expect(result.trail.config.name).toBe('My Custom Name');
  });
});

describe('processGpxFile', () => {
  const FileSystem = require('expo-file-system');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects non-GPX file extensions', async () => {
    try {
      await processGpxFile('file:///test.kml', 'test.kml', 1000);
      fail('Should have thrown');
    } catch (e) {
      const err = e as ImportError;
      expect(err.type).toBe('validation');
      expect(err.message).toContain('.kml');
    }
  });

  it('rejects files exceeding 50MB', async () => {
    try {
      await processGpxFile('file:///big.gpx', 'big.gpx', 60 * 1024 * 1024);
      fail('Should have thrown');
    } catch (e) {
      const err = e as ImportError;
      expect(err.type).toBe('validation');
      expect(err.message).toContain('too large');
    }
  });

  it('rejects non-XML content', async () => {
    FileSystem.readAsStringAsync.mockResolvedValueOnce('Not XML content at all');

    try {
      await processGpxFile('file:///test.gpx', 'test.gpx', 100);
      fail('Should have thrown');
    } catch (e) {
      const err = e as ImportError;
      expect(err.type).toBe('processing');
      expect(err.message).toContain("doesn't appear to be a GPX file");
    }
  });

  it('processes a valid GPX file', async () => {
    FileSystem.readAsStringAsync.mockResolvedValueOnce(MINIMAL_GPX);

    const result = await processGpxFile('file:///test.gpx', 'test.gpx', 1000);
    expect(result.trail).toBeDefined();
    expect(result.trail.track.points.length).toBeGreaterThan(0);
  });
});

describe('saveCustomTrail', () => {
  it('saves a processed trail to the database', async () => {
    const result = await processGpxContent(MINIMAL_GPX, 'test.gpx');
    const importResult = await saveCustomTrail(result, 'My Trail', 'test.gpx');

    expect(importResult.trailId).toMatch(/^custom-my-trail-/);
    expect(importResult.trailName).toBe('My Trail');
    expect(importResult.warnings).toBeInstanceOf(Array);
  });

  it('generates unique trail IDs', async () => {
    const result = await processGpxContent(MINIMAL_GPX, 'test.gpx');

    const import1 = await saveCustomTrail(result, 'Same Name', 'test1.gpx');
    // Small delay to ensure different timestamp
    await new Promise((r) => setTimeout(r, 10));
    const import2 = await saveCustomTrail(result, 'Same Name', 'test2.gpx');

    expect(import1.trailId).not.toBe(import2.trailId);
  });
});
