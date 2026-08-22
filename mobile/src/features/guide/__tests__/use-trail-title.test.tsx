/**
 * The header title hook: bundled names must resolve on the very first render
 * (no placeholder flash for the shipped trails), imported ones arrive a tick
 * later from the registry, and a lookup for a guide the user has navigated away
 * from must never paint.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { useTrailTitle } from '../use-trail-title';
import { getTrailIndexEntry, getTrailIndexEntryAsync } from '../../../services/trail-loader';

jest.mock('../../../services/trail-loader', () => ({
  getTrailIndexEntry: jest.fn(() => null),
  getTrailIndexEntryAsync: jest.fn(async () => null),
}));

const mockSync = getTrailIndexEntry as jest.Mock;
const mockAsync = getTrailIndexEntryAsync as jest.Mock;

const BUNDLED = {
  id: 'heysen',
  name: 'Heysen Trail',
  shortName: 'Heysen',
  lengthKm: 1200,
  source: 'bundled',
};

const IMPORTED = {
  id: 'u_abc',
  name: 'My Weekend Loop',
  shortName: 'My Weekend Loop',
  lengthKm: 42,
  source: 'imported',
};

let titles: string[] = [];

function Probe({ trailId }: { trailId: string }) {
  titles.push(useTrailTitle(trailId));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useTrailTitle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    titles = [];
    mockSync.mockReturnValue(null);
    mockAsync.mockResolvedValue(null);
  });

  it('resolves a bundled short name synchronously, with no registry read', () => {
    mockSync.mockReturnValue(BUNDLED);

    act(() => {
      TestRenderer.create(<Probe trailId="heysen" />);
    });

    expect(titles).toEqual(['Heysen']);
    expect(mockAsync).not.toHaveBeenCalled();
  });

  it('shows the fallback until the imported name arrives', async () => {
    const gate = deferred<typeof IMPORTED | null>();
    mockAsync.mockReturnValue(gate.promise);

    act(() => {
      TestRenderer.create(<Probe trailId="u_abc" />);
    });
    expect(titles).toEqual(['Guide']);

    await act(async () => {
      gate.resolve(IMPORTED);
      await gate.promise;
    });
    expect(titles[titles.length - 1]).toBe('My Weekend Loop');
  });

  it('keeps the fallback for an id no source knows', async () => {
    await act(async () => {
      TestRenderer.create(<Probe trailId="u_gone" />);
    });
    expect(titles[titles.length - 1]).toBe('Guide');
  });

  it('does not paint a stale name after the trail id changes', async () => {
    const first = deferred<typeof IMPORTED | null>();
    const second = deferred<typeof IMPORTED | null>();
    mockAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe trailId="u_first" />);
    });
    act(() => {
      tree.update(<Probe trailId="u_second" />);
    });

    await act(async () => {
      first.resolve({ ...IMPORTED, name: 'First', shortName: 'First' });
      await first.promise;
    });
    expect(titles[titles.length - 1]).toBe('Guide');

    await act(async () => {
      second.resolve({ ...IMPORTED, name: 'Second', shortName: 'Second' });
      await second.promise;
    });
    expect(titles[titles.length - 1]).toBe('Second');
  });
});
