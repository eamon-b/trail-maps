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
jest.mock('react-native-gesture-handler', () => {
  const chainable = (): unknown =>
    new Proxy(function () {}, {
      get: () => () => chainable(),
      apply: () => chainable(),
    });
  return {
    GestureDetector: ({ children }: { children: unknown }) => children,
    Gesture: {
      Pan: chainable,
      Pinch: chainable,
      Tap: chainable,
      Simultaneous: chainable,
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
  const baseProps = {
    points: makePoints(300),
    totalKm: 100,
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

  it('renders an empty state with no points', () => {
    let root!: ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(
        <ElevationProfile
          points={[]}
          totalKm={0}
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
});
