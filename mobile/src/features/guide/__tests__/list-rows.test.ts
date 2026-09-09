/**
 * The datasheet's row model: keys that survive a filter change, and the merge
 * of OSM rows into the waypoint order.
 */

import type { TrailPOI } from '@lib/trail-types';
import {
  interleaveListRows,
  rowKm,
  toWaypointRows,
  waypointKey,
  type ListRow,
} from '../list-rows';
import type { TrailJson } from '../../../services/trail-loader';

type Waypoint = TrailJson['waypoints'][number];

const waypoints = [
  { id: 'w_start', name: 'Trailhead', type: 'trailhead', totalDistance: 0 },
  { name: 'Legacy Spring', type: 'spring', totalDistance: 8 },
  { id: 'w_camp', name: 'Ridge Camp', type: 'campsite', totalDistance: 12 },
] as unknown as Waypoint[];

function poi(id: number, distanceAlongTrail: number): TrailPOI {
  return {
    id,
    type: 'node',
    category: 'water',
    lat: -34.9,
    lon: 138.6,
    name: null,
    tags: {},
    distanceAlongTrail,
    distanceFromTrail: 0.2,
  };
}

describe('waypointKey', () => {
  it('prefers the bundled id and falls back to name plus position', () => {
    expect(waypointKey(waypoints[0], 0)).toBe('w_start');
    expect(waypointKey(waypoints[1], 1)).toBe('Legacy Spring-1');
  });
});

describe('toWaypointRows', () => {
  it('carries the key and the km each row is placed by', () => {
    expect(toWaypointRows(waypoints).map((row) => [row.key, row.km])).toEqual([
      ['w_start', 0],
      ['Legacy Spring-1', 8],
      ['w_camp', 12],
    ]);
  });

  it('keys off the unfiltered order, so a chip cannot rename an id-less row', () => {
    const rows = toWaypointRows(waypoints);
    const filtered = rows.filter((row) => row.waypoint.type !== 'trailhead');
    expect(filtered[0].key).toBe('Legacy Spring-1');
  });
});

describe('interleaveListRows', () => {
  const rows = interleaveListRows(toWaypointRows(waypoints), [poi(2, 12), poi(1, 4)]);

  it('orders every row by distance, waypoint first on a tie', () => {
    expect(rows.map((row) => [row.kind, row.km])).toEqual([
      ['waypoint', 0],
      ['poi', 4],
      ['waypoint', 8],
      ['waypoint', 12],
      ['poi', 12],
    ]);
  });

  it('gives POI rows a namespaced, slash-free key', () => {
    expect(rows.filter((row) => row.kind === 'poi').map((row) => row.key)).toEqual([
      'poi:node-1',
      'poi:node-2',
    ]);
  });

  it('reports the km the focus helpers scroll by', () => {
    expect(rows.map((row: ListRow) => rowKm(row))).toEqual([0, 4, 8, 12, 12]);
  });
});
