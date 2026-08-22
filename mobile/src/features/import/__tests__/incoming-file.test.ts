/**
 * The receive-intent path: a launch URL in, a push onto the import review
 * screen out.
 *
 * The classification rule carries the weight here. It is the only thing
 * standing between "a file manager opened a GPX with us" and "expo-router was
 * about to handle a `tracknotes://` deep link and we stole it", and it has to
 * make that call from a string alone — so it is tested exhaustively while the
 * hook is tested for wiring.
 *
 * expo-file-system is mocked locally, as in import-gpx.test.ts: the global
 * jest.setup.js only stubs the legacy `readAsStringAsync` surface, not the
 * `File`/`Directory` classes this module uses.
 */

import React from 'react';
import { Alert } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  INCOMING_DIR,
  classifyIncomingUrl,
  incomingImportRoute,
  stageIncomingFile,
  stagedFileName,
  useIncomingFile,
} from '../incoming-file';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockFiles: Record<string, string> = {};
const mockWritten: { uri: string; text: string }[] = [];
const mockDirectoryOps: string[] = [];
let mockDirectoryExists = false;

jest.mock('expo-file-system', () => {
  class MockFile {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      const joined = parts.map((p) => (typeof p === 'string' ? p : p.uri));
      this.uri = joined.length === 1 ? joined[0] : `${joined[0].replace(/\/$/, '')}/${joined.slice(1).join('/')}`;
    }
    async text(): Promise<string> {
      const value = mockFiles[this.uri];
      if (value === undefined) throw new Error(`ENOENT: ${this.uri}`);
      return value;
    }
    write(text: string): void {
      mockWritten.push({ uri: this.uri, text });
      mockFiles[this.uri] = text;
    }
  }

  class MockDirectory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = parts.map((p) => (typeof p === 'string' ? p : p.uri)).join('/');
    }
    get exists(): boolean {
      return mockDirectoryExists;
    }
    delete(): void {
      mockDirectoryOps.push(`delete:${this.uri}`);
      mockDirectoryExists = false;
    }
    create(): void {
      mockDirectoryOps.push(`create:${this.uri}`);
      mockDirectoryExists = true;
    }
  }

  return {
    File: MockFile,
    Directory: MockDirectory,
    Paths: { cache: { uri: 'file:///cache' } },
  };
});

const mockPush = jest.fn();
let mockNavigationState: { key: string } | undefined = { key: 'root' };

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRootNavigationState: () => mockNavigationState,
}));

let mockUrl: string | null = null;
jest.mock('expo-linking', () => ({
  useURL: () => mockUrl,
}));

const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);

const HANDOFF = JSON.stringify({ format: 'tracknotes-trail', version: 1, trail: {} });
const GPX = '<?xml version="1.0"?><gpx/>';

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockFiles)) delete mockFiles[key];
  mockWritten.length = 0;
  mockDirectoryOps.length = 0;
  mockDirectoryExists = false;
  mockUrl = null;
  mockNavigationState = { key: 'root' };
});

// ---------------------------------------------------------------------------

describe('classifyIncomingUrl', () => {
  it.each([
    ['file:///storage/emulated/0/Download/larapinta.gpx', 'larapinta.gpx'],
    ['content://com.android.providers.downloads/my%20walk.gpx', 'my walk.gpx'],
    ['file:///tmp/weekend.tracknotes.json', 'weekend.tracknotes.json'],
    ['FILE:///tmp/Trail.GPX', 'Trail.GPX'],
    ['file:///tmp/route.xml', 'route.xml'],
  ])('claims %s', (url, fileName) => {
    expect(classifyIncomingUrl(url)).toEqual({ uri: url.trim(), fileName });
  });

  it('claims an opaque content URI, since the OS already filtered by MIME type', () => {
    const url = 'content://com.android.providers.downloads.documents/document/msf%3A1000000123';
    expect(classifyIncomingUrl(url)).toEqual({ uri: url, fileName: 'msf:1000000123' });
  });

  it.each([
    ['a deep link', 'tracknotes://guide/bibbulmun-track'],
    ['a dev-client link', 'tracknotes://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081'],
    ['an https URL', 'https://example.com/trail.gpx'],
    ['a schemeless string', '/storage/emulated/0/walk.gpx'],
    ['an empty string', ''],
  ])('ignores %s', (_label, url) => {
    expect(classifyIncomingUrl(url)).toBeNull();
  });

  it.each(['file:///tmp/photo.jpg', 'content://media/external/images/1/snap.png', 'file:///a/b.pdf'])(
    'ignores another app\'s file type: %s',
    (url) => {
      expect(classifyIncomingUrl(url)).toBeNull();
    },
  );

  it('ignores null and undefined', () => {
    expect(classifyIncomingUrl(null)).toBeNull();
    expect(classifyIncomingUrl(undefined)).toBeNull();
  });

  it('strips a query string before reading the name', () => {
    expect(classifyIncomingUrl('file:///tmp/walk.gpx?v=2')?.fileName).toBe('walk.gpx');
  });

  it('survives a malformed percent escape', () => {
    expect(classifyIncomingUrl('content://p/100%zz')).toEqual({
      uri: 'content://p/100%zz',
      fileName: '100%zz',
    });
  });
});

describe('stagedFileName', () => {
  it('names a GPX copy .gpx', () => {
    expect(stagedFileName('walk.gpx', GPX)).toBe('incoming.gpx');
  });

  it('names a handoff copy .tracknotes.json', () => {
    expect(stagedFileName('x.json', HANDOFF)).toBe('incoming.tracknotes.json');
  });

  it('falls back to the bytes for an opaque name', () => {
    expect(stagedFileName('', HANDOFF)).toBe('incoming.tracknotes.json');
    expect(stagedFileName('', GPX)).toBe('incoming.gpx');
  });
});

describe('stageIncomingFile', () => {
  it('copies the file into the cache and reports the staged URI', async () => {
    mockFiles['content://provider/doc/1'] = GPX;

    const staged = await stageIncomingFile({ uri: 'content://provider/doc/1', fileName: 'walk.gpx' });

    expect(staged.uri).toBe(`file:///cache/${INCOMING_DIR}/incoming.gpx`);
    expect(mockWritten).toEqual([{ uri: staged.uri, text: GPX }]);
  });

  it('keeps the original file name, which only ever suggests a guide name', async () => {
    mockFiles['content://provider/doc/1'] = GPX;
    const staged = await stageIncomingFile({
      uri: 'content://provider/doc/1',
      fileName: '2026-08-22 walk.gpx',
    });
    expect(staged.fileName).toBe('2026-08-22 walk.gpx');
  });

  it('wipes a previous staged file rather than accumulating', async () => {
    mockDirectoryExists = true;
    mockFiles['content://provider/doc/1'] = GPX;

    await stageIncomingFile({ uri: 'content://provider/doc/1', fileName: 'walk.gpx' });

    expect(mockDirectoryOps).toEqual([
      `delete:file:///cache/${INCOMING_DIR}`,
      `create:file:///cache/${INCOMING_DIR}`,
    ]);
  });

  it('does not try to delete a directory that is not there yet', async () => {
    mockFiles['content://provider/doc/1'] = GPX;
    await stageIncomingFile({ uri: 'content://provider/doc/1', fileName: 'walk.gpx' });
    expect(mockDirectoryOps).toEqual([`create:file:///cache/${INCOMING_DIR}`]);
  });

  it('propagates an unreadable source, so the caller can say so', async () => {
    await expect(
      stageIncomingFile({ uri: 'content://provider/gone', fileName: 'walk.gpx' }),
    ).rejects.toThrow(/ENOENT/);
  });
});

describe('incomingImportRoute', () => {
  it('builds the params app/import.tsx reads', () => {
    expect(incomingImportRoute({ uri: 'file:///cache/incoming/incoming.gpx', fileName: 'walk.gpx' })).toEqual({
      pathname: '/import',
      params: { uri: 'file:///cache/incoming/incoming.gpx', fileName: 'walk.gpx' },
    });
  });
});

describe('useIncomingFile', () => {
  function Probe(): null {
    useIncomingFile();
    return null;
  }

  async function render(): Promise<void> {
    await act(async () => {
      TestRenderer.create(React.createElement(Probe));
    });
  }

  it('stages an incoming file and pushes the import screen', async () => {
    mockUrl = 'content://provider/documents/larapinta.gpx';
    mockFiles[mockUrl] = GPX;

    await render();

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/import',
      params: { uri: `file:///cache/${INCOMING_DIR}/incoming.gpx`, fileName: 'larapinta.gpx' },
    });
    // The screen must never see the content:// URI: its read grant dies with
    // the activity that received the intent.
    expect(mockPush.mock.calls[0][0].params.uri).not.toContain('content://');
  });

  it('leaves deep links to expo-router', async () => {
    mockUrl = 'tracknotes://guide/bibbulmun-track';
    await render();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('does nothing before the root navigator exists', async () => {
    mockNavigationState = undefined;
    mockUrl = 'file:///tmp/walk.gpx';
    mockFiles[mockUrl] = GPX;

    await render();

    expect(mockPush).not.toHaveBeenCalled();
  });

  it('imports a given URL only once, however often the layout re-renders', async () => {
    mockUrl = 'file:///tmp/walk.gpx';
    mockFiles[mockUrl] = GPX;

    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Probe));
    });
    await act(async () => {
      renderer?.update(React.createElement(Probe));
    });

    expect(mockPush).toHaveBeenCalledTimes(1);
  });

  it('alerts instead of navigating when the file cannot be read', async () => {
    mockUrl = 'content://provider/gone';

    await render();

    expect(mockPush).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Could not open that file', expect.stringMatching(/ENOENT/));
  });
});
