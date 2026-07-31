/**
 * Shallow render smoke test for the Skia elevation profile.
 *
 * Skia and the theme are mocked locally (jest.setup.js must not change);
 * gesture-handler + reanimated use the global mocks. The goal is to prove the
 * component mounts, builds its Skia paths after layout, and handles taps/window
 * changes without throwing — not to verify pixel output.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ElevationProfile } from '../ElevationProfile';
import type { ProfilePoint } from '../lod';

// --- Local Skia mock (no native canvas in Jest) ---------------------------
// Container elements pass their children through; leaf primitives render null.
// Plain function components avoid importing React/View inside the factory.
jest.mock('@shopify/react-native-skia', () => {
  const container = ({ children }: { children?: unknown }) => children ?? null;
  const leaf = () => null;
  const makePath = () => ({
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    close: jest.fn(),
    dispose: jest.fn(),
    copy: () => makePath(),
  });
  return {
    Canvas: container,
    Group: container,
    Path: container,
    Line: leaf,
    Circle: leaf,
    Rect: leaf,
    LinearGradient: leaf,
    vec: (x: number, y: number) => ({ x, y }),
    Skia: { Path: { Make: () => makePath() } },
  };
});

// --- Local theme mock -----------------------------------------------------
jest.mock('../../../theme', () => ({
  useTheme: () => ({
    colors: new Proxy({}, { get: () => '#123456' }),
  }),
  useReduceMotion: () => false,
}));

// --- Local gesture-handler mock (chainable proxy) -------------------------
// `mockComposedGestures` records every gesture composition, so a test can assert
// the composed gesture is built once and not rebuilt on window changes.
const mockComposedGestures: unknown[] = [];
jest.mock('react-native-gesture-handler', () => {
  const chainable = (): unknown =>
    new Proxy(function () {}, {
      get: () => () => chainable(),
      apply: () => chainable(),
    });
  const compose = () => {
    const g = chainable();
    mockComposedGestures.push(g);
    return g;
  };
  return {
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: {
      Pan: chainable,
      Pinch: chainable,
      Tap: chainable,
      Simultaneous: compose,
      Race: chainable,
    },
  };
});

function makePoints(n: number): ProfilePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    lat: 0,
    lon: 0,
    dist: (i / (n - 1)) * 100,
    ele: 100 + Math.sin(i / 5) * 50,
  }));
}

function layoutAll(root: ReactTestRenderer) {
  act(() => {
    root.root.findAll((n) => typeof n.props.onLayout === 'function').forEach((n) => {
      n.props.onLayout?.({ nativeEvent: { layout: { width: 360, height: 240 } } });
    });
  });
}

describe('ElevationProfile', () => {
  beforeEach(() => {
    mockComposedGestures.length = 0;
  });

  const baseProps = {
    points: makePoints(300),
    totalKm: 100,
    unit: 'km' as const,
    window: { startKm: 0, endKm: 100 },
    waypoints: [
      { id: 'w1', type: 'water', totalDistance: 25, elevation: 120 },
      { id: 'w2', type: 'campsite', totalDistance: 60, elevation: 80 },
    ],
  };

  it('renders and builds paths after layout', () => {
    const onWindowChange = jest.fn();
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile {...baseProps} onWindowChange={onWindowChange} />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('does not rebuild its gesture when the window changes', () => {
    // gesture-handler cancels an in-flight gesture if the GestureDetector's
    // config is swapped, so panning would die on its own first frame if the
    // composed gesture depended on the window.
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(<ElevationProfile {...baseProps} onWindowChange={jest.fn()} />);
    });
    layoutAll(root);
    expect(mockComposedGestures).toHaveLength(1);

    for (const window of [
      { startKm: 10, endKm: 60 },
      { startKm: 20, endKm: 22 },
      { startKm: 21, endKm: 23 },
    ]) {
      act(() => {
        root.update(
          <ElevationProfile {...baseProps} window={window} onWindowChange={jest.fn()} />,
        );
      });
    }
    expect(mockComposedGestures).toHaveLength(1);
    act(() => root.unmount());
  });

  it('renders a zoomed window without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          window={{ startKm: 40, endKm: 41 }}
          currentKm={40.5}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders an empty state with no points', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          points={[]}
          totalKm={0}
          unit="km"
          window={{ startKm: 0, endKm: 0 }}
          onWindowChange={jest.fn()}
        />,
      );
    });
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders a current-position marker without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile {...baseProps} currentKm={40} onWindowChange={jest.fn()} />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders active-route highlight bands without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          highlightRanges={[
            { startKm: 10, endKm: 40 },
            { startKm: 70, endKm: 90 },
          ]}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });

  it('renders favorited markers (imperial units) without throwing', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          {...baseProps}
          unit="mi"
          favoriteIds={new Set(['w1'])}
          onWindowChange={jest.fn()}
        />,
      );
    });
    layoutAll(root);
    expect(root.toJSON()).toBeTruthy();
    act(() => root.unmount());
  });
});
