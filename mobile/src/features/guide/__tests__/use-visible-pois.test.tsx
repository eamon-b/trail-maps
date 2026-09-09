/**
 * `useVisiblePois` is the single source the map, list and profile read, so what
 * matters here is that it answers from the live store: flip a category in the
 * settings store and every surface has to follow on the next render.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { defaultPoiFilterState } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { useSettingsStore } from '../../../state/settings-store';
import { hasPois, useVisiblePois } from '../use-visible-pois';

function poi(over: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'water',
    lat: -34,
    lon: 138,
    name: 'Tap',
    tags: {},
    distanceAlongTrail: 1,
    distanceFromTrail: 0.05,
    ...over,
  };
}

const pois: TrailPOI[] = [
  poi({ id: 1, category: 'water' }),
  poi({ id: 2, category: 'transport' }),
  poi({ id: 3, category: 'camping', duplicateOf: 'w_abc' }),
];

describe('useVisiblePois', () => {
  let latest: TrailPOI[] = [];
  let renderer: ReactTestRenderer | null = null;

  function Harness({ trail }: { trail: { pois?: TrailPOI[] } }) {
    latest = useVisiblePois(trail);
    return null;
  }

  function mount(trail: { pois?: TrailPOI[] }) {
    act(() => {
      renderer = TestRenderer.create(<Harness trail={trail} />);
    });
  }

  beforeEach(() => {
    useSettingsStore.setState({ poiFilter: defaultPoiFilterState() });
  });

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
  });

  it('hides POIs that duplicate a curated waypoint', () => {
    mount({ pois });
    expect(latest.map((p) => p.id)).toEqual([1, 2]);
  });

  it('follows a category the walker turns off', () => {
    mount({ pois });
    act(() => {
      useSettingsStore.getState().setPoiCategory('transport', false);
    });
    expect(latest.map((p) => p.id)).toEqual([1]);
  });

  it('shows nothing at all once the master switch is off', () => {
    mount({ pois });
    act(() => {
      useSettingsStore.getState().setPoiEnabled(false);
    });
    expect(latest).toEqual([]);
  });

  it('is empty for a trail that was never enriched', () => {
    mount({});
    expect(latest).toEqual([]);
  });
});

describe('hasPois', () => {
  it('separates "never fetched" from "found nothing"', () => {
    expect(hasPois({})).toBe(false);
    expect(hasPois({ pois: [] })).toBe(false);
    expect(hasPois({ pois: [poi()] })).toBe(true);
  });
});
