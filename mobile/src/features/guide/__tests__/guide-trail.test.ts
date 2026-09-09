import { resolveGuideTrail, orderedWaypoints } from '../guide-trail';
import type { TrailJson } from '../../../services/trail-loader';

function makeTrail(): TrailJson {
  return {
    config: {
      id: 't',
      name: 'Test Trail',
      shortName: 'TT',
      region: 'Nowhere',
      lengthKm: 10,
      direction: { default: 'North', reversed: 'South' },
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
}

describe('resolveGuideTrail', () => {
  it('returns the trail unchanged for the default direction', () => {
    const trail = makeTrail();
    expect(resolveGuideTrail(trail, 'default')).toBe(trail);
  });

  it('mirrors waypoint kilometres when reversed', () => {
    const reversed = resolveGuideTrail(makeTrail(), 'reversed');
    // Order flips and each km mirrors about the 10 km total: [10,4,0] -> [0,6,10].
    expect(reversed.waypoints.map((w) => w.name)).toEqual(['End', 'Middle', 'Start']);
    expect(reversed.waypoints.map((w) => w.totalDistance)).toEqual([0, 6, 10]);
  });

  it('swaps trail ascent and descent when reversed', () => {
    const reversed = resolveGuideTrail(makeTrail(), 'reversed');
    expect(reversed.track.totalAscent).toBe(50);
    expect(reversed.track.totalDescent).toBe(100);
  });

  /**
   * POI kilometres mirror with everything else — `createReversedTrail` does it,
   * so the guide inherits it and nothing here special-cases POIs. Cross-track
   * distance is direction-independent and must NOT move.
   */
  it('mirrors POI kilometres when reversed, leaving cross-track distance alone', () => {
    const trail = makeTrail();
    trail.track.totalDistance = 130;
    trail.config.lengthKm = 130;
    trail.track.points[2].dist = 130;
    trail.track.displayPoints[1].dist = 130;
    trail.pois = [
      {
        id: 1,
        type: 'node',
        category: 'water',
        lat: 0,
        lon: 0,
        name: 'Tap',
        tags: {},
        distanceAlongTrail: 3,
        distanceFromTrail: 0.4,
      },
    ];

    const reversed = resolveGuideTrail(trail, 'reversed');

    expect(reversed.pois?.[0].distanceAlongTrail).toBe(127);
    expect(reversed.pois?.[0].distanceFromTrail).toBe(0.4);
  });

  it('leaves a trail that was never enriched without a pois key', () => {
    expect('pois' in resolveGuideTrail(makeTrail(), 'reversed')).toBe(false);
  });
});

describe('orderedWaypoints', () => {
  it('sorts by cumulative distance', () => {
    const trail = makeTrail();
    // Shuffle the source array to prove the sort.
    trail.waypoints = [trail.waypoints[2], trail.waypoints[0], trail.waypoints[1]];
    expect(orderedWaypoints(trail).map((w) => w.totalDistance)).toEqual([0, 4, 10]);
  });
});
