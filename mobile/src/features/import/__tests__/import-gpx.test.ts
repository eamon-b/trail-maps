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
  detectImportFormat,
  importGpxFromUri,
  pickGpxFile,
  saveImport,
  suggestName,
  yieldToUi,
} from '../import-gpx';
import { saveImportedTrail } from '../../../services/imported-trail-store';
import { getDocumentAsync } from 'expo-document-picker';
import { File } from 'expo-file-system';
import type { ImportReport } from '@lib/gpx-import';
import { HANDOFF_FORMAT, serializeTrailHandoff } from '@lib/trail-handoff';
import { backfillImportElevation } from '../elevation-backfill-flow';
import type { ProcessedTrail } from '@lib/trail-types';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};
/** Overrides for the reported size, so a huge file needn't actually be built. */
const mockSizes: Record<string, number> = {};

jest.mock('expo-file-system', () => ({
  File: jest.fn().mockImplementation((uri: string) => ({
    uri,
    get exists() {
      return mockFiles[uri] !== undefined;
    },
    // The real `File.size` reports 0 for a file it cannot stat — which the
    // importer treats as "unknown, let the parser's own caps decide".
    get size() {
      return mockSizes[uri] ?? mockFiles[uri]?.length ?? 0;
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

/** Coordinates but no `<ele>` — what the backfill offer exists for. */
const NO_ELEVATION_GPX = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Flat</name></metadata>
  <trk><trkseg>
    <trkpt lat="-33.8688" lon="151.2093"/>
    <trkpt lat="-33.8700" lon="151.2100"/>
    <trkpt lat="-33.8750" lon="151.2150"/>
  </trkseg></trk>
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
  for (const key of Object.keys(mockSizes)) delete mockSizes[key];
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

  /**
   * The size cap has to bite *before* the read, not inside `parseGpx`: the
   * whole point is never to hold a 50 MB file as a JS string on a phone. The
   * assertion that `text()` was not called is therefore the real one.
   */
  describe('size cap', () => {
    it('refuses an oversized file without reading it', async () => {
      const uri = 'file:///cache/huge.gpx';
      mockFiles[uri] = SAMPLE_GPX;
      mockSizes[uri] = 21 * 1024 * 1024;

      await expect(importGpxFromUri(uri)).rejects.toThrow(/21\.0 MB — the limit is 20\.0 MB/);

      const instance = (File as unknown as jest.Mock).mock.results[0].value as {
        text: jest.Mock;
      };
      expect(instance.text).not.toHaveBeenCalled();
    });

    it('applies the cap to a handoff file too, not just GPX', async () => {
      const uri = 'file:///cache/huge.tracknotes.json';
      mockFiles[uri] = '{}';
      mockSizes[uri] = 50 * 1024 * 1024;
      await expect(importGpxFromUri(uri, { fileName: 'huge.tracknotes.json' })).rejects.toThrow(
        /the limit is 20\.0 MB/,
      );
    });

    it('reads a file the OS reports no size for and lets the parser judge it', async () => {
      const uri = 'content://downloads/document/msf%3A99';
      mockFiles[uri] = SAMPLE_GPX;
      mockSizes[uri] = 0;
      await expect(importGpxFromUri(uri)).resolves.toMatchObject({
        report: { name: 'Phone Import' },
      });
    });
  });
});

describe('detectImportFormat', () => {
  it('trusts a .gpx extension over the bytes', () => {
    expect(detectImportFormat('walk.GPX', '{"format":"x"}')).toBe('gpx');
  });

  it('trusts a .json extension', () => {
    expect(detectImportFormat('trail.tracknotes.json', '<gpx/>')).toBe('handoff');
  });

  it('sniffs the bytes when the name is opaque, as content:// URIs are', () => {
    expect(detectImportFormat('', '  {"format":"tracknotes-trail"}')).toBe('handoff');
    expect(detectImportFormat(undefined, '<?xml version="1.0"?><gpx/>')).toBe('gpx');
  });

  it('falls back to GPX for an unrecognised name and non-JSON bytes', () => {
    expect(detectImportFormat('msf:1000000123', 'garbage')).toBe('gpx');
  });
});

describe('importGpxFromUri — .tracknotes.json handoff', () => {
  /** Build a handoff file the way the web export page does. */
  async function handoffText(): Promise<string> {
    mockFiles['file:///cache/walk.gpx'] = SAMPLE_GPX;
    const imported = await importGpxFromUri('file:///cache/walk.gpx');
    return serializeTrailHandoff(imported.trail);
  }

  it('reads back a trail exported from the web without re-ingesting it', async () => {
    const text = await handoffText();
    mockFiles['file:///cache/weekend.tracknotes.json'] = text;

    const imported = await importGpxFromUri('file:///cache/weekend.tracknotes.json', {
      fileName: 'weekend.tracknotes.json',
    });

    expect(imported.trail.config.name).toBe('Phone Import');
    expect(imported.trail.track.points).toHaveLength(3);
    // Waypoint ids were minted on the other device and must survive the trip:
    // favourites and route references are keyed on them.
    expect(imported.trail.waypoints[0].id).toMatch(/^uw_/);
    expect(imported.trail.config.source).toBe('imported');
  });

  it('synthesizes a report the review screen can render unchanged', async () => {
    mockFiles['file:///cache/x.tracknotes.json'] = await handoffText();

    const { report } = await importGpxFromUri('file:///cache/x.tracknotes.json', {
      fileName: 'x.tracknotes.json',
    });

    expect(report.hasElevation).toBe(true);
    expect(report.pointCount).toBe(3);
    expect(report.waypointCount).toBe(1);
    expect(report.simplified).toBe(false);
    expect(report.warnings).toEqual([]);
    expect(report.gapWarnings).toEqual([]);
  });

  it('takes the handoff branch on content alone when the URI names nothing', async () => {
    mockFiles['content://downloads/document/msf%3A42'] = await handoffText();

    const imported = await importGpxFromUri('content://downloads/document/msf%3A42');

    expect(imported.trail.config.name).toBe('Phone Import');
  });

  it('round-trips through save with the same id, so re-importing is not a duplicate', async () => {
    mockFiles['file:///cache/walk.gpx'] = SAMPLE_GPX;
    const original = await importGpxFromUri('file:///cache/walk.gpx');
    mockFiles['file:///cache/copy.tracknotes.json'] = serializeTrailHandoff(original.trail);

    const reimported = await importGpxFromUri('file:///cache/copy.tracknotes.json', {
      fileName: 'copy.tracknotes.json',
    });

    expect(reimported.trail.config.id).toBe(original.trail.config.id);
  });

  it('rejects a JSON file that is not a Tracknotes export', async () => {
    mockFiles['file:///cache/other.json'] = JSON.stringify({ type: 'FeatureCollection' });

    await expect(
      importGpxFromUri('file:///cache/other.json', { fileName: 'other.json' }),
    ).rejects.toThrow(/not a Tracknotes trail file/);
  });

  it('rejects a handoff written by a newer app version', async () => {
    mockFiles['file:///cache/future.json'] = JSON.stringify({
      format: HANDOFF_FORMAT,
      version: 99,
      trail: {},
    });

    await expect(
      importGpxFromUri('file:///cache/future.json', { fileName: 'future.json' }),
    ).rejects.toThrow(/newer version of Tracknotes/);
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

  /**
   * The seam between the backfill offer and the registry row.
   *
   * `saveImport` reads `report.hasElevation`, so a backfill that updated only
   * the trail would leave a guide flagged "no elevation" on disk while carrying
   * a full profile — and the plan screen would go on calling its day splits
   * distance-only. This reproduces exactly what `app/import.tsx` does: run the
   * flow, spread the result over the import, then save.
   */
  it('records the backfilled profile on the registry row, not the original flat one', async () => {
    mockFiles['file:///cache/flat.gpx'] = NO_ELEVATION_GPX;
    const imported = await importGpxFromUri('file:///cache/flat.gpx');
    expect(imported.report.hasElevation).toBe(false);

    // The flow reads the global fetch, the way the app does on a device.
    const previousFetch = (global as unknown as { fetch?: unknown }).fetch;
    (global as unknown as { fetch: unknown }).fetch = async (
      _url: string,
      init: { body: string },
    ) => {
      const body = JSON.parse(init.body) as { locations: unknown[] };
      return {
        ok: true,
        status: 200,
        json: async () => ({ results: body.locations.map(() => ({ elevation: 120 })) }),
      };
    };
    try {
      const backfilled = await backfillImportElevation(imported, {});
      await saveImport({ ...imported, ...backfilled }, 'Flat walk');
    } finally {
      (global as unknown as { fetch?: unknown }).fetch = previousFetch;
    }

    const [, savedTrail, meta] = mockSave.mock.calls[0];
    expect(meta.hasElevation).toBe(true);
    expect(savedTrail.config.elevationSource).toBe('backfilled');
  });
});

describe('yieldToUi', () => {
  it('resolves, so the pipeline can await it between stages', async () => {
    await expect(yieldToUi()).resolves.toBeUndefined();
  });
});
