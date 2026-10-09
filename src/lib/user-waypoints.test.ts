import { describe, expect, it } from 'vitest';
import {
  checkUserWaypointInput,
  isUserWaypointId,
  placeOnTrack,
  placeUserWaypoints,
  userWaypointId,
  userWaypointInfo,
  type UserWaypoint,
} from './user-waypoints';
import { createReversedTrail } from './trail-reverse';

// A straight line due north along lon 138, ~1.11 km per 0.01° of latitude,
// climbing 10 m per point.
const points = Array.from({ length: 11 }, (_, i) => ({
  lat: -35 + i * 0.01,
  lon: 138,
  ele: 100 + i * 10,
  dist: Math.round(i * 1.11195 * 1000) / 1000,
}));

function trail() {
  return {
    config: { id: 't' },
    waypoints: [
      { id: 'w_a', name: 'Start', type: 'trailhead', lat: -35, lon: 138, totalDistance: 0, distance: 0, ascent: 0, descent: 0, totalAscent: 0, totalDescent: 0, trackIndex: 0 },
      { id: 'w_b', name: 'Hut', type: 'hut', lat: -34.94, lon: 138, totalDistance: 6.67, distance: 6.67, ascent: 60, descent: 0, totalAscent: 60, totalDescent: 0, trackIndex: 6 },
    ],
    track: { points, displayPoints: points, totalDistance: points[10].dist, totalAscent: 100, totalDescent: 0 },
  };
}

function uw(overrides: Partial<UserWaypoint> = {}): UserWaypoint {
  return {
    id: userWaypointId('2b0f8a8e-5c4d-4e1f-9a2b-3c4d5e6f7a8b'),
    trailId: 't',
    name: 'Creek',
    type: 'water',
    lat: -34.97,
    lon: 138.001, // ~91 m east of the line
    description: '',
    visibility: 'private',
    mine: true,
    authorName: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ids', () => {
  it('mints and recognises hiker waypoint ids', () => {
    const id = userWaypointId('2B0F8A8E-5C4D-4E1F-9A2B-3C4D5E6F7A8B');
    expect(id).toBe('hw_2b0f8a8e-5c4d-4e1f-9a2b-3c4d5e6f7a8b');
    expect(isUserWaypointId(id)).toBe(true);
    expect(isUserWaypointId('w_766c3fd2')).toBe(false);
    expect(isUserWaypointId('uw_abc')).toBe(false);
    // Inside the comments API's waypoint-id pattern, so comments work on it.
    expect(/^[a-z0-9_-]{4,64}$/.test(id)).toBe(true);
  });
});

describe('checkUserWaypointInput', () => {
  it('normalises a good input', () => {
    const r = checkUserWaypointInput({ name: '  Spring  by   the hut ', type: 'water', lat: -35.1234567, lon: 138.7654321, description: ' Cold ' });
    expect(r).toEqual({
      ok: true,
      value: { name: 'Spring by the hut', type: 'water', lat: -35.123457, lon: 138.765432, description: 'Cold' },
    });
  });

  it('names the field at fault', () => {
    expect(checkUserWaypointInput({ name: '', type: 'water', lat: 0, lon: 0 })).toMatchObject({ ok: false, field: 'name' });
    expect(checkUserWaypointInput({ name: 'x'.repeat(81), type: 'water', lat: 0, lon: 0 })).toMatchObject({ ok: false, field: 'name' });
    expect(checkUserWaypointInput({ name: 'A', type: 'town-access', lat: 0, lon: 0 })).toMatchObject({ ok: false, field: 'type' });
    expect(checkUserWaypointInput({ name: 'A', type: 'water', lat: NaN, lon: 0 })).toMatchObject({ ok: false, field: 'position' });
    expect(checkUserWaypointInput({ name: 'A', type: 'water', lat: 0, lon: 181 })).toMatchObject({ ok: false, field: 'position' });
    expect(checkUserWaypointInput({ name: 'A', type: 'water', lat: 0, lon: 0, description: 'x'.repeat(1001) })).toMatchObject({ ok: false, field: 'description' });
  });
});

describe('placeOnTrack', () => {
  it('projects onto the line between vertices', () => {
    const at = placeOnTrack(-34.975, 138.001, points)!;
    expect(at.km).toBeCloseTo(2.78, 1);
    expect(at.metres).toBeGreaterThan(85);
    expect(at.metres).toBeLessThan(95);
  });
});

describe('placeUserWaypoints', () => {
  it('returns the same trail when there is nothing to place', () => {
    const t = trail();
    expect(placeUserWaypoints(t, [])).toBe(t);
  });

  it('places a waypoint in km order and re-measures the leg after it', () => {
    const placed = placeUserWaypoints(trail(), [uw()]);
    expect(placed.waypoints.map((w) => w.name)).toEqual(['Start', 'Creek', 'Hut']);
    const creek = placed.waypoints[1];
    expect(creek.totalDistance).toBeCloseTo(3.34, 1);
    expect((creek as { elevation?: number }).elevation).toBe(130);
    expect(creek.distance).toBeCloseTo(3.34, 1);
    expect(creek.ascent).toBe(30);
    expect(userWaypointInfo(creek)).toMatchObject({ visibility: 'private', mine: true });
    const hut = placed.waypoints[2];
    expect(hut.distance).toBeCloseTo(6.67 - creek.totalDistance!, 2);
    expect(hut.ascent).toBe(30);
    // Untouched before it.
    expect(placed.waypoints[0]).toEqual(trail().waypoints[0]);
    expect(userWaypointInfo(hut)).toBeNull();
  });

  it('drops a waypoint too far from the trail', () => {
    const placed = placeUserWaypoints(trail(), [uw({ lon: 138.2 })]);
    expect(placed.waypoints).toHaveLength(2);
  });

  it('survives a direction reversal', () => {
    const placed = placeUserWaypoints(trail(), [uw()]);
    const reversed = createReversedTrail(placed);
    const creek = reversed.waypoints.find((w) => w.name === 'Creek')!;
    expect(creek.totalDistance).toBeCloseTo(points[10].dist - placed.waypoints[1].totalDistance!, 2);
    expect(userWaypointInfo(creek)).not.toBeNull();
  });
});
