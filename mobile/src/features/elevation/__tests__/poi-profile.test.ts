/**
 * POI profile markers: ids, the elevation sampled off the track, and what
 * happens when there is no track to sample.
 */

import { poiProfileMarkers, POI_PROFILE_MAX_WINDOW_KM } from '../poi-profile';
import type { TrailPOI } from '@lib/trail-types';

function poi(overrides: Partial<TrailPOI> = {}): TrailPOI {
  return {
    id: 12345,
    type: 'node',
    category: 'water',
    lat: -35,
    lon: 138,
    name: 'Tank',
    tags: {},
    distanceAlongTrail: 10,
    distanceFromTrail: 0.2,
    ...overrides,
  };
}

// A 0–40 km track climbing 100 m per 10 km.
const points = [
  { dist: 0, ele: 100 },
  { dist: 10, ele: 200 },
  { dist: 20, ele: 300 },
  { dist: 30, ele: 400 },
  { dist: 40, ele: 500 },
];

describe('poiProfileMarkers', () => {
  it('samples elevation from the nearest track point', () => {
    const markers = poiProfileMarkers([poi({ distanceAlongTrail: 21 })], points);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      kind: 'poi',
      type: 'water',
      totalDistance: 21,
      elevation: 300,
    });
  });

  it('keys markers by the slash-free route key', () => {
    const markers = poiProfileMarkers(
      [poi({ type: 'way', id: 42 }), poi({ type: 'node', id: 7 })],
      points,
    );
    expect(markers.map((m) => m.id)).toEqual(['way-42', 'node-7']);
  });

  it('carries the POI category through as the marker type', () => {
    const markers = poiProfileMarkers([poi({ category: 'emergency' })], points);
    expect(markers[0].type).toBe('emergency');
  });

  it('leaves elevation undefined when there is no track', () => {
    const markers = poiProfileMarkers([poi()], []);
    expect(markers[0].elevation).toBeUndefined();
    expect(markers[0].totalDistance).toBe(10);
  });

  it('does not require the POIs to arrive in distance order', () => {
    const markers = poiProfileMarkers(
      [
        poi({ id: 3, distanceAlongTrail: 30 }),
        poi({ id: 1, distanceAlongTrail: 0 }),
        poi({ id: 2, distanceAlongTrail: 19 }),
      ],
      points,
    );
    // Order is preserved (the profile places each from its own km) and every
    // marker still samples its own neighbourhood of the track.
    expect(markers.map((m) => m.id)).toEqual(['node-3', 'node-1', 'node-2']);
    expect(markers.map((m) => m.elevation)).toEqual([400, 100, 300]);
  });

  it('returns nothing for no POIs', () => {
    expect(poiProfileMarkers([], points)).toEqual([]);
  });
});

describe('POI_PROFILE_MAX_WINDOW_KM', () => {
  it('is the 60 km readability ceiling the pane gates on', () => {
    expect(POI_PROFILE_MAX_WINDOW_KM).toBe(60);
  });
});
