/**
 * Verifies the guide's direction wiring: the DirectionToggle writes through the
 * settings store, and the GuideProvider re-resolves (re-reverses) the trail
 * whenever that stored direction changes.
 */

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { GuideProvider, useGuide } from '../GuideContext';
import { useSettingsStore } from '../../../state/settings-store';

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
  return { getTrailJson: jest.fn(() => trail) };
});

describe('GuideProvider direction re-resolution', () => {
  beforeEach(() => {
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
