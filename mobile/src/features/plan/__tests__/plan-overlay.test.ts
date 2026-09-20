/**
 * The plan → map/profile conversion.
 *
 * The bug this exists to prevent: a reversed guide ringing the wrong hut. Stops
 * are stored NOBO-absolute and the guide trail is direction-applied, so every
 * assertion here is really about that one mirror.
 */

import type { PlanDocument } from '@lib/plan-types';
import { plannedStopFeatureIds, plannedStopKms } from '../plan-overlay';

const TOTAL = 100;

const WAYPOINTS = [
  { id: 'w_1', name: 'Hut', totalDistance: 20 },
  { id: 'w_2', name: 'Spring', totalDistance: 50 },
  { name: 'Unnamed camp', totalDistance: 80 },
];

function plan(over: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'p1',
    trailId: 'heysen',
    name: 'Heysen',
    direction: 'NOBO',
    startDate: null,
    stops: [{ waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 }],
    updatedAt: 'T',
    version: 1,
    ...over,
  };
}

describe('plannedStopFeatureIds', () => {
  it('rings the waypoint a stop names', () => {
    expect([...plannedStopFeatureIds(plan(), WAYPOINTS, 'NOBO', TOTAL)]).toEqual(['w_1']);
  });

  it('rings nothing for an absent or empty plan', () => {
    expect(plannedStopFeatureIds(undefined, WAYPOINTS, 'NOBO', TOTAL).size).toBe(0);
    expect(plannedStopFeatureIds(plan({ stops: [] }), WAYPOINTS, 'NOBO', TOTAL).size).toBe(0);
  });

  it('follows the mirror when the guide is reversed', () => {
    // SOBO: the hut at NOBO 20 is at active km 80 on the reversed trail.
    const reversedWaypoints = [
      { id: 'w_1', name: 'Hut', totalDistance: 80 },
      { id: 'w_2', name: 'Spring', totalDistance: 50 },
    ];
    expect([...plannedStopFeatureIds(plan(), reversedWaypoints, 'SOBO', TOTAL)]).toEqual(['w_1']);

    // A stop with no waypoint id has only its km to go on, which is where the
    // mirror actually bites: NOBO 20 is the hut going one way and nothing
    // going the other.
    const kmOnly = plan({ stops: [{ km: 20, name: 'Hut', nights: 1 }] });
    expect([...plannedStopFeatureIds(kmOnly, reversedWaypoints, 'SOBO', TOTAL)]).toEqual(['w_1']);
    expect([...plannedStopFeatureIds(kmOnly, reversedWaypoints, 'NOBO', TOTAL)]).toEqual([]);
  });

  it('falls back to the name+index id for a waypoint without one', () => {
    const kmOnly = plan({ stops: [{ km: 80, name: 'Unnamed camp', nights: 1 }] });
    expect([...plannedStopFeatureIds(kmOnly, WAYPOINTS, 'NOBO', TOTAL)]).toEqual([
      'Unnamed camp-2',
    ]);
  });
});

describe('plannedStopKms', () => {
  it('gives the day boundaries in the walking direction, sorted', () => {
    const two = plan({
      stops: [
        { waypointId: 'w_2', km: 50, name: 'Spring', nights: 1 },
        { waypointId: 'w_1', km: 20, name: 'Hut', nights: 1 },
      ],
    });
    expect(plannedStopKms(two, 'NOBO', TOTAL)).toEqual([20, 50]);
    expect(plannedStopKms(two, 'SOBO', TOTAL)).toEqual([50, 80]);
  });

  it('is empty without a plan', () => {
    expect(plannedStopKms(undefined, 'NOBO', TOTAL)).toEqual([]);
  });
});
