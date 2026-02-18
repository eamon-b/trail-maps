import { describe, it, expect } from 'vitest';
import {
  extractResupplyPoints,
  computeResupplyGaps,
  analyzeResupply,
  DEFAULT_DAILY_KM,
} from './resupply-calculator';
import type { PlanWaypoint } from './plan-types';

const waypoints: PlanWaypoint[] = [
  { name: 'Springfield', type: 'town', totalDistance: 50 },
  { name: 'Shelbyville', type: 'food', totalDistance: 120 },
  { name: 'Shelby Creek', type: 'water', totalDistance: 80 },   // not a resupply
  { name: 'Capitol City', type: 'town', totalDistance: 200 },
];

describe('extractResupplyPoints', () => {
  it('includes town and food waypoints only', () => {
    const points = extractResupplyPoints(waypoints);
    expect(points).toHaveLength(3);
    expect(points.map(p => p.name)).toEqual(['Springfield', 'Shelbyville', 'Capitol City']);
  });

  it('sorts by km', () => {
    const shuffled: PlanWaypoint[] = [
      { name: 'Far', type: 'town', totalDistance: 200 },
      { name: 'Near', type: 'town', totalDistance: 50 },
    ];
    const points = extractResupplyPoints(shuffled);
    expect(points[0].km).toBe(50);
    expect(points[1].km).toBe(200);
  });

  it('returns empty array when no resupply waypoints', () => {
    const noResupply: PlanWaypoint[] = [
      { name: 'Creek', type: 'water', totalDistance: 30 },
    ];
    expect(extractResupplyPoints(noResupply)).toHaveLength(0);
  });
});

describe('computeResupplyGaps', () => {
  it('computes gaps between resupply points', () => {
    const points = extractResupplyPoints(waypoints);
    const gaps = computeResupplyGaps(points, 0, 250);
    // Gaps: start→Springfield (50km), Springfield→Shelbyville (70km),
    //       Shelbyville→CapitolCity (80km), CapitolCity→end (50km)
    expect(gaps).toHaveLength(4);
    expect(gaps[0].fromName).toBe('Trail Start');
    expect(gaps[0].distanceKm).toBe(50);
    expect(gaps[1].fromName).toBe('Springfield');
    expect(gaps[1].distanceKm).toBe(70);
    expect(gaps[3].toName).toBe('Trail End');
    expect(gaps[3].distanceKm).toBe(50);
  });

  it('marks long gaps (> 5 days at 20km/day)', () => {
    const points = extractResupplyPoints(waypoints);
    const gaps = computeResupplyGaps(points, 0, 250);
    // 70km gap = ceil(70/20) = 4 days → not long
    const shelbyGap = gaps.find(g => g.fromName === 'Springfield');
    expect(shelbyGap?.isLong).toBe(false);
    // 80km gap = ceil(80/20) = 4 days → not long
    const capGap = gaps.find(g => g.fromName === 'Shelbyville');
    expect(capGap?.isLong).toBe(false);
  });

  it('marks gap as long when > threshold days', () => {
    const bigTrail: PlanWaypoint[] = [
      { name: 'Town A', type: 'town', totalDistance: 0 },
      { name: 'Town B', type: 'town', totalDistance: 120 }, // 120/20 = 6 days → LONG
    ];
    const points = extractResupplyPoints(bigTrail);
    const gaps = computeResupplyGaps(points, 0, 120, DEFAULT_DAILY_KM);
    expect(gaps[0].isLong).toBe(true);
    expect(gaps[0].estimatedDays).toBe(6);
  });

  it('returns empty array when no points', () => {
    expect(computeResupplyGaps([], 0, 100)).toHaveLength(0);
  });
});

describe('analyzeResupply', () => {
  it('returns hasResupplyData=false when no town/food waypoints', () => {
    const result = analyzeResupply([{ name: 'Creek', type: 'water', totalDistance: 10 }], 100);
    expect(result.hasResupplyData).toBe(false);
    expect(result.gaps).toHaveLength(0);
  });

  it('computes longest gap', () => {
    const result = analyzeResupply(waypoints, 250);
    expect(result.hasResupplyData).toBe(true);
    expect(result.longestGapKm).toBeGreaterThan(0);
    // Longest should be Shelbyville→Capitol City at 80km
    expect(result.longestGapKm).toBe(80);
  });

  it('computes longestGapDays', () => {
    const result = analyzeResupply(waypoints, 250);
    // 80km / 20km/day = 4 days
    expect(result.longestGapDays).toBe(4);
  });
});
