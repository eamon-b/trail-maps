/**
 * Two things about GuideProvider:
 *
 * 1. Direction wiring — the DirectionToggle writes through the settings store,
 *    and the provider re-resolves (re-reverses) the trail whenever that stored
 *    direction changes.
 * 2. Async resolution — a bundled trail must never render a spinner frame, an
 *    imported one renders a spinner INSTEAD of children until its file is read
 *    (so `trail` is never null for a consumer), and an id that resolves to
 *    nothing lands on the not-found state.
 */

import React from 'react';
import { ActivityIndicator } from 'react-native';
import TestRenderer, {
  act,
  type TestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { GuideProvider, useGuide } from '../GuideContext';
import { useSettingsStore } from '../../../state/settings-store';
import { getTrailJson, loadTrail } from '../../../services/trail-loader';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('../../../services/trail-loader', () => {
  const trail = {
    config: {
      id: 't',
      name: 'Test Trail',
      shortName: 'TT',
      region: 'Nowhere',
      lengthKm: 10,
      direction: { default: 'Northbound', reversed: 'Southbound' },
    },
    waypoints: [
      { id: 'w_a', name: 'Start', lat: 0, lon: 0, type: 'trailhead', totalDistance: 0, elevation: 100 },
      { id: 'w_b', name: 'Middle', lat: 0, lon: 0, type: 'water', totalDistance: 4, elevation: 200 },
      { id: 'w_c', name: 'End', lat: 0, lon: 0, type: 'trailhead', totalDistance: 10, elevation: 150 },
    ],
    track: {
      points: [
        { lat: 0, lon: 0, ele: 100, dist: 0 },
        { lat: 0, lon: 0, ele: 200, dist: 4 },
        { lat: 0, lon: 0, ele: 150, dist: 10 },
      ],
      displayPoints: [
        { lat: 0, lon: 0, ele: 100, dist: 0 },
        { lat: 0, lon: 0, ele: 150, dist: 10 },
      ],
      totalDistance: 10,
      totalAscent: 100,
      totalDescent: 50,
    },
  };
  return {
    getTrailJson: jest.fn(() => trail),
    loadTrail: jest.fn(async () => null),
    __trail: trail,
  };
});

const mockGetTrailJson = getTrailJson as jest.Mock;
const mockLoadTrail = loadTrail as jest.Mock;
const BUNDLED_TRAIL = (jest.requireMock('../../../services/trail-loader') as { __trail: unknown })
  .__trail;

/** Deferred promise, so a load can be observed mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('GuideProvider direction re-resolution', () => {
  beforeEach(() => {
    mockGetTrailJson.mockReturnValue(BUNDLED_TRAIL);
    mockLoadTrail.mockResolvedValue(null);
    act(() => {
      useSettingsStore.setState({ perTrailDirection: {} });
    });
  });

  it('re-reverses the trail when the stored direction toggles', () => {
    let seen: { direction: string; firstName: string } = { direction: '', firstName: '' };
    function Consumer() {
      const g = useGuide();
      seen = { direction: g.direction, firstName: g.trail.waypoints[0].name };
      return null;
    }

    act(() => {
      TestRenderer.create(
        <GuideProvider trailId="t">
          <Consumer />
        </GuideProvider>,
      );
    });

    expect(seen.direction).toBe('default');
    expect(seen.firstName).toBe('Start');

    act(() => {
      useSettingsStore.getState().toggleDirection('t');
    });

    expect(seen.direction).toBe('reversed');
    // Reversing flips waypoint order: the far end becomes the first row.
    expect(seen.firstName).toBe('End');
  });
});

describe('GuideProvider async resolution', () => {
  beforeEach(() => {
    mockGetTrailJson.mockReturnValue(BUNDLED_TRAIL);
    mockLoadTrail.mockResolvedValue(null);
    act(() => {
      useSettingsStore.setState({ perTrailDirection: {} });
    });
  });

  function Child() {
    useGuide();
    return null;
  }

  it('renders a bundled trail without ever showing a spinner', () => {
    let rendered = 0;
    function CountingChild() {
      rendered += 1;
      useGuide();
      return null;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideProvider trailId="t">
          <CountingChild />
        </GuideProvider>,
      );
    });

    expect(rendered).toBe(1);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(mockLoadTrail).not.toHaveBeenCalled();
  });

  it('shows a spinner instead of children while an imported trail loads', async () => {
    mockGetTrailJson.mockReturnValue(null);
    const gate = deferred<unknown>();
    mockLoadTrail.mockReturnValue(gate.promise);

    let mounted = false;
    function ImportedChild() {
      mounted = true;
      useGuide();
      return null;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideProvider trailId="u_imported">
          <ImportedChild />
        </GuideProvider>,
      );
    });

    // The whole point of the spinner-instead-of-children contract: no consumer
    // ever sees a half-loaded guide.
    expect(mounted).toBe(false);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);

    await act(async () => {
      gate.resolve(BUNDLED_TRAIL);
      await gate.promise;
    });

    expect(mounted).toBe(true);
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('falls back to not-found when an id resolves to nothing', async () => {
    mockGetTrailJson.mockReturnValue(null);
    mockLoadTrail.mockResolvedValue(null);

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <GuideProvider trailId="u_missing">
          <Child />
        </GuideProvider>,
      );
    });

    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(0);
    const texts = tree.root
      .findAll((n: TestInstance) => typeof n.props.children === 'string')
      .map((n) => n.props.children as string);
    expect(texts.join(' ')).toContain('Guide not found');
  });

  it('treats a failed read as not-found rather than crashing', async () => {
    mockGetTrailJson.mockReturnValue(null);
    mockLoadTrail.mockRejectedValue(new Error('EACCES'));

    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <GuideProvider trailId="u_broken">
          <Child />
        </GuideProvider>,
      );
    });

    const texts = tree.root
      .findAll((n: TestInstance) => typeof n.props.children === 'string')
      .map((n) => n.props.children as string);
    expect(texts.join(' ')).toContain('Guide not found');
  });

  it('ignores a load that lands after the trail id changed', async () => {
    mockGetTrailJson.mockReturnValue(null);
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    mockLoadTrail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    let seenId = '';
    function IdChild() {
      seenId = useGuide().trail.config.id;
      return null;
    }

    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(
        <GuideProvider trailId="u_first">
          <IdChild />
        </GuideProvider>,
      );
    });

    act(() => {
      tree.update(
        <GuideProvider trailId="u_second">
          <IdChild />
        </GuideProvider>,
      );
    });

    // The first read finishes late; its result belongs to a guide the user has
    // already navigated away from, so it must not paint.
    await act(async () => {
      first.resolve({ ...(BUNDLED_TRAIL as object), config: { id: 'u_first' } });
      await first.promise;
    });
    expect(seenId).toBe('');
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);

    await act(async () => {
      second.resolve(BUNDLED_TRAIL);
      await second.promise;
    });
    expect(seenId).toBe('t');
  });
});
