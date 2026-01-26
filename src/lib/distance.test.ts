import { describe, it, expect } from 'vitest';
import {
  haversineDistance3D,
  waypointToPointDistance,
  isWaypointNearPoints,
  findCloseWaypoints,
} from './distance';
import type { GpxPoint, GpxWaypoint } from './types';

describe('haversineDistance3D', () => {
  it('should return 0 for the same point', () => {
    const result = haversineDistance3D(
      -37.8136, 144.9631, 100,
      -37.8136, 144.9631, 100
    );
    expect(result).toBe(0);
  });

  it('should calculate distance between Sydney and Melbourne (~714 km)', () => {
    // Sydney: -33.8688, 151.2093
    // Melbourne: -37.8136, 144.9631
    const result = haversineDistance3D(
      -33.8688, 151.2093, 0,
      -37.8136, 144.9631, 0
    );
    // Distance should be approximately 714 km (714000 meters)
    expect(result).toBeGreaterThan(700000);
    expect(result).toBeLessThan(730000);
  });

  it('should calculate 3D distance including elevation difference', () => {
    // Two points at same location but 1000m elevation difference
    const horizontalDist = haversineDistance3D(
      -37.8136, 144.9631, 0,
      -37.8136, 144.9631, 0
    );
    const verticalDist = haversineDistance3D(
      -37.8136, 144.9631, 0,
      -37.8136, 144.9631, 1000
    );

    expect(horizontalDist).toBe(0);
    expect(verticalDist).toBe(1000);
  });

  it('should combine horizontal and vertical distance correctly', () => {
    // Small horizontal distance with elevation change
    // Points ~100m apart horizontally with 100m elevation difference
    const result = haversineDistance3D(
      -37.8136, 144.9631, 0,
      -37.8137, 144.9632, 100
    );

    // 3D distance should be greater than just the elevation difference
    expect(result).toBeGreaterThan(100);
  });
});

describe('waypointToPointDistance', () => {
  it('should calculate distance between waypoint and track point', () => {
    const waypoint: GpxWaypoint = {
      lat: -37.8136,
      lon: 144.9631,
      ele: 50,
      name: 'Test Waypoint',
      desc: 'Description',
    };

    const point: GpxPoint = {
      lat: -37.8136,
      lon: 144.9631,
      ele: 50,
      time: null,
    };

    const result = waypointToPointDistance(waypoint, point);
    expect(result).toBe(0);
  });

  it('should return correct distance for different points', () => {
    const waypoint: GpxWaypoint = {
      lat: -33.8688,  // Sydney
      lon: 151.2093,
      ele: 0,
      name: 'Sydney',
      desc: '',
    };

    const point: GpxPoint = {
      lat: -37.8136,  // Melbourne
      lon: 144.9631,
      ele: 0,
      time: null,
    };

    const result = waypointToPointDistance(waypoint, point);
    expect(result).toBeGreaterThan(700000);
    expect(result).toBeLessThan(730000);
  });
});

describe('isWaypointNearPoints', () => {
  const waypoint: GpxWaypoint = {
    lat: -37.8136,
    lon: 144.9631,
    ele: 0,
    name: 'Melbourne',
    desc: '',
  };

  it('should return true when waypoint is near a point', () => {
    const points: GpxPoint[] = [
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null },
    ];

    expect(isWaypointNearPoints(waypoint, points, 1)).toBe(true);
  });

  it('should return false when waypoint is far from all points', () => {
    const points: GpxPoint[] = [
      { lat: -33.8688, lon: 151.2093, ele: 0, time: null }, // Sydney
    ];

    // Sydney is ~714km from Melbourne, so 5km threshold should return false
    expect(isWaypointNearPoints(waypoint, points, 5)).toBe(false);
  });

  it('should return true if any point is within range', () => {
    const points: GpxPoint[] = [
      { lat: -33.8688, lon: 151.2093, ele: 0, time: null }, // Sydney (far)
      { lat: -37.8136, lon: 144.9631, ele: 0, time: null }, // Melbourne (close)
    ];

    expect(isWaypointNearPoints(waypoint, points, 1)).toBe(true);
  });

  it('should return false for empty points array', () => {
    expect(isWaypointNearPoints(waypoint, [], 5)).toBe(false);
  });
});

describe('findCloseWaypoints', () => {
  const points: GpxPoint[] = [
    { lat: -37.8136, lon: 144.9631, ele: 0, time: null }, // Melbourne
    { lat: -37.8200, lon: 144.9700, ele: 0, time: null }, // Near Melbourne
  ];

  const waypoints: GpxWaypoint[] = [
    { lat: -37.8136, lon: 144.9631, ele: 0, name: 'Melbourne CBD', desc: '' },
    { lat: -33.8688, lon: 151.2093, ele: 0, name: 'Sydney', desc: '' },
    { lat: -37.8150, lon: 144.9650, ele: 0, name: 'Near Melbourne', desc: '' },
  ];

  it('should return only waypoints within distance threshold', () => {
    const result = findCloseWaypoints(points, waypoints, 5);

    expect(result).toHaveLength(2);
    expect(result.map(w => w.name)).toContain('Melbourne CBD');
    expect(result.map(w => w.name)).toContain('Near Melbourne');
    expect(result.map(w => w.name)).not.toContain('Sydney');
  });

  it('should return empty array when no waypoints are close', () => {
    const farPoints: GpxPoint[] = [
      { lat: 0, lon: 0, ele: 0, time: null }, // Far away
    ];

    const result = findCloseWaypoints(farPoints, waypoints, 5);
    expect(result).toHaveLength(0);
  });

  it('should return all waypoints with large distance threshold', () => {
    // 1000km should include everything
    const result = findCloseWaypoints(points, waypoints, 1000);
    expect(result).toHaveLength(3);
  });

  it('should handle empty waypoints array', () => {
    const result = findCloseWaypoints(points, [], 5);
    expect(result).toHaveLength(0);
  });

  it('should handle empty points array', () => {
    const result = findCloseWaypoints([], waypoints, 5);
    expect(result).toHaveLength(0);
  });
});
