/**
 * The mobile import flow end-to-end minus the UI: pick → read → ingest → save.
 *
 * `@lib/gpx-import` itself is exercised under Vitest (src/lib/gpx-import.test.ts)
 * and its Metro/Hermes resolution by `services/__tests__/gpx-import-lib.test.ts`.
 * What is unique here is the wiring: that the fast-xml-parser adapter is
 * actually used (Hermes has no DOMParser), that the file name only ever
 * *suggests* a name, that the edited name reaches `config` before persistence,
 * and that nothing is written when the file is unusable.
 *
 * expo-file-system is mocked locally — the global jest.setup.js only stubs the
 * legacy readAsStringAsync surface, not the `File` class this module uses.
 */

import {
  applyTrailName,
  importGpxFromUri,
  pickGpxFile,
  saveImport,
  suggestName,
  yieldToUi,
} from '../import-gpx';
import { saveImportedTrail } from '../../../services/imported-trail-store';
import { getDocumentAsync } from 'expo-document-picker';
import type { ImportReport } from '@lib/gpx-import';
import type { ProcessedTrail } from '@lib/trail-types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation((uri: string) => ({
    uri,
    get exists() {
      return mockFiles[uri] !== undefined;
    },
    text: jest.fn(async () => {
      if (mockFiles[uri] === undefined) throw new Error(`ENOENT: ${uri}`);
      return mockFiles[uri];
    }),
  })),
}));

jest.mock('expo-document-picker', () => ({
  getDocumentAsync: jest.fn(),
}));

jest.mock('../../../db/database', () => ({
  getDatabase: jest.fn(async () => ({ __db: true })),
}));

jest.mock('../../../services/imported-trail-store', () => ({
  saveImportedTrail: jest.fn(async () => undefined),
}));

const mockPicker = getDocumentAsync as jest.Mock;
const mockSave = saveImportedTrail as jest.Mock;

const SAMPLE_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Phone Import</name></metadata>
  <wpt lat="-33.8688" lon="151.2093"><name>C: First Camp</name></wpt>
  <trk>
    <name>Day 1</name>
    <trkseg>
      <trkpt lat="-33.8688" lon="151.2093"><ele>10</ele></trkpt>
      <trkpt lat="-33.8700" lon="151.2100"><ele>25</ele></trkpt>
      <trkpt lat="-33.8750" lon="151.2150"><ele>40</ele></trkpt>
    </trkseg>
  </trk>
</gpx>`;

/** A GPX with no name anywhere, so the file name has to fill in. */
const UNNAMED_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="-33.8688" lon="151.2093"><ele>10</ele></trkpt>
    <trkpt lat="-33.8700" lon="151.2100"><ele>25</ele></trkpt>
  </trkseg></trk>
</gpx>`;

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  mockSave.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe('pickGpxFile', () => {
  it('returns the picked file, copied into the cache directory', async () => {
    mockPicker.mockResolvedValue({
      canceled: false,
      assets: [{ uri: 'file:///cache/walk.gpx', name: 'walk.gpx', mimeType: 'application/xml' }],
    });

    await expect(pickGpxFile()).resolves.toEqual({
      uri: 'file:///cache/walk.gpx',
      fileName: 'walk.gpx',
    });
    // copyToCacheDirectory is what makes an Android content:// URI readable.
    expect(mockPicker).toHaveBeenCalledWith(
      expect.objectContaining({ copyToCacheDirectory: true, multiple: false }),
    );
  });

  it('returns null when the user cancels', async () => {
    mockPicker.mockResolvedValue({ canceled: true, assets: null });
    await expect(pickGpxFile()).resolves.toBeNull();
  });

  it('returns null when the picker reports success with no asset', async () => {
    mockPicker.mockResolvedValue({ canceled: false, assets: [] });
    await expect(pickGpxFile()).resolves.toBeNull();
  });
});

describe('importGpxFromUri', () => {
  it('reads and ingests a file through the fast-xml-parser adapter', async () => {
    mockFiles['file:///cache/walk.gpx'] = SAMPLE_GPX;

    const imported = await importGpxFromUri('file:///cache/walk.gpx', { fileName: 'walk.gpx' });

    expect(imported.report.name).toBe('Phone Import');
    expect(imported.suggestedName).toBe('Phone Import');
    expect(imported.trail.config.id).toMatch(/^u_/);
    expect(imported.trail.track.points).toHaveLength(3);
    expect(imported.trail.waypoints[0].id).toMatch(/^uw_/);
  });

  it('reports its stages in order so the screen can show progress', async () => {
    mockFiles['file:///cache/walk.gpx'] = SAMPLE_GPX;
    const stages: string[] = [];

    await importGpxFromUri('file:///cache/walk.gpx', { onStage: (s) => stages.push(s) });

    expect(stages).toEqual(['reading', 'ingesting']);
  });

  it('falls back to the file name when the GPX names nothing', async () => {
    mockFiles['file:///cache/2026-08-22 walk.gpx'] = UNNAMED_GPX;

    const imported = await importGpxFromUri('file:///cache/2026-08-22 walk.gpx', {
      fileName: '2026-08-22 walk.gpx',
    });

    expect(imported.suggestedName).toBe('2026-08-22 walk');
  });

  it('propagates a read failure instead of building an empty trail', async () => {
    await expect(importGpxFromUri('file:///cache/gone.gpx')).rejects.toThrow(/ENOENT/);
  });

  it('propagates a parse failure', async () => {
    mockFiles['file:///cache/bad.gpx'] = '<gpx><trk></gpx>';
    await expect(importGpxFromUri('file:///cache/bad.gpx')).rejects.toThrow(/Invalid GPX XML/);
  });
});

describe('suggestName', () => {
  const report = (name: string) => ({ name }) as ImportReport;

  it('prefers the name the GPX gave itself', () => {
    expect(suggestName(report('Larapinta'), 'export.gpx')).toBe('Larapinta');
  });

  it('strips only the final extension from a file name', () => {
    expect(suggestName(report('Imported trail'), 'my.trip.gpx')).toBe('my.trip');
  });

  it('falls back to the generic name with nothing to go on', () => {
    expect(suggestName(report('Imported trail'), '')).toBe('Imported trail');
    expect(suggestName(report('Imported trail'))).toBe('Imported trail');
  });
});

describe('applyTrailName', () => {
  const trail = {
    config: { id: 'u_abc', name: 'Old', shortName: 'Old', region: 'Imported' },
  } as unknown as ProcessedTrail;

  it('sets both name and shortName without touching the content-hashed id', () => {
    const renamed = applyTrailName(trail, '  Kosciuszko loop  ');
    expect(renamed.config).toEqual(
      expect.objectContaining({ id: 'u_abc', name: 'Kosciuszko loop', shortName: 'Kosciuszko loop' }),
    );
  });

  it('does not mutate the input', () => {
    applyTrailName(trail, 'Renamed');
    expect(trail.config.name).toBe('Old');
  });

  it('falls back to the generic name for an all-whitespace name', () => {
    expect(applyTrailName(trail, '   ').config.name).toBe('Imported trail');
  });
});

describe('saveImport', () => {
  it('persists the edited name and returns the id to navigate to', async () => {
    mockFiles['file:///cache/walk.gpx'] = SAMPLE_GPX;
    const imported = await importGpxFromUri('file:///cache/walk.gpx');

    const trailId = await saveImport(imported, 'Sydney shakedown');

    expect(trailId).toBe(imported.trail.config.id);
    const [, savedTrail, meta] = mockSave.mock.calls[0];
    expect(savedTrail.config.name).toBe('Sydney shakedown');
    expect(savedTrail.config.shortName).toBe('Sydney shakedown');
    expect(meta).toEqual({
      hasElevation: imported.report.hasElevation,
      pointCount: imported.report.pointCount,
      waypointCount: imported.report.waypointCount,
    });
  });
});

describe('yieldToUi', () => {
  it('resolves, so the pipeline can await it between stages', async () => {
    await expect(yieldToUi()).resolves.toBeUndefined();
  });
});
