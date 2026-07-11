import type { TrailWaypoint } from '../../lib/trail-utils';
import type { ComputedDay } from '../plan-calculator-types';
import {
  extractResupplyPoints,
  computeResupplyGaps,
  analyzeResupply,
  analyzeResupplyForSection,
  correlateResupplyWithDays,
  calculateFoodWeight,
  foodCarryForGap,
  findNextResupply,
  DEFAULT_GRAMS_PER_DAY,
} from '@lib/resupply-calculator';
import type { ResupplyPoint } from '@lib/resupply-calculator';

function makeWaypoints(items: { name: string; type: string; km: number }[]): TrailWaypoint[] {
  return items.map((s, i) => ({
    id: `wp-${i}`,
    name: s.name,
    lat: -33,
    lon: 115,
    type: s.type,
    totalDistance: s.km,
  }));
}

// ---------------------------------------------------------------------------
// extractResupplyPoints
// ---------------------------------------------------------------------------

describe('extractResupplyPoints', () => {
  it('extracts town and food types', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 5 },
      { name: 'Collie', type: 'town', km: 50 },
      { name: 'Store', type: 'food', km: 30 },
      { name: 'Creek', type: 'water', km: 20 },
    ]);
    const points = extractResupplyPoints(wps);
    expect(points).toHaveLength(2);
    // Should be sorted by km
    expect(points[0].name).toBe('Store');
    expect(points[1].name).toBe('Collie');
  });

  it('returns empty for no resupply points', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 5 },
    ]);
    expect(extractResupplyPoints(wps)).toHaveLength(0);
  });

  it('excludes the new registry types (hazard/lookout/junction) from resupply math', () => {
    const wps = makeWaypoints([
      { name: 'Cliff edge', type: 'hazard', km: 5 },
      { name: 'Big View', type: 'lookout', km: 10 },
      { name: 'Fork', type: 'junction', km: 15 },
      { name: 'Collie', type: 'town', km: 50 },
    ]);
    const points = extractResupplyPoints(wps);
    expect(points).toHaveLength(1);
    expect(points[0].name).toBe('Collie');
  });
});

// ---------------------------------------------------------------------------
// calculateFoodWeight
// ---------------------------------------------------------------------------

describe('calculateFoodWeight', () => {
  it('calculates weight at default grams/day', () => {
    const result = calculateFoodWeight(5);
    expect(result.days).toBe(5);
    expect(result.weightGrams).toBe(5 * DEFAULT_GRAMS_PER_DAY);
    expect(result.weightKg).toBe(3.4); // 3400g → 3.4kg
  });

  it('calculates weight with custom grams/day', () => {
    const result = calculateFoodWeight(3, 750);
    expect(result.weightGrams).toBe(2250);
    expect(result.weightKg).toBe(2.3);
  });

  it('handles 0 days', () => {
    const result = calculateFoodWeight(0);
    expect(result.weightGrams).toBe(0);
    expect(result.weightKg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// computeResupplyGaps
// ---------------------------------------------------------------------------

describe('computeResupplyGaps', () => {
  const points = [
    { name: 'Town A', km: 40, type: 'town' },
    { name: 'Store', km: 100, type: 'food' },
    { name: 'Town B', km: 150, type: 'town' },
  ];

  it('includes start-to-first and last-to-end gaps', () => {
    const gaps = computeResupplyGaps(points, 0, 200);
    expect(gaps).toHaveLength(4);
    expect(gaps[0].fromName).toBe('Trail Start');
    expect(gaps[0].distanceKm).toBe(40);
    expect(gaps[3].toName).toBe('Trail End');
    expect(gaps[3].distanceKm).toBe(50);
  });

  it('estimates days at given pace', () => {
    const gaps = computeResupplyGaps(points, 0, 200, 20);
    // 40km at 20km/day = 2 days
    expect(gaps[0].estimatedDays).toBe(2);
    // 60km at 20km/day = 3 days
    expect(gaps[1].estimatedDays).toBe(3);
  });

  it('flags long gaps (>5 days)', () => {
    const gaps = computeResupplyGaps(points, 0, 200, 10);
    // 40km at 10km/day = 4 days (not long)
    expect(gaps[0].isLong).toBe(false);
    // 60km at 10km/day = 6 days (long!)
    expect(gaps[1].isLong).toBe(true);
  });

  it('returns empty for no points', () => {
    expect(computeResupplyGaps([], 0, 100)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeResupply
// ---------------------------------------------------------------------------

describe('analyzeResupply', () => {
  it('returns hasResupplyData=false when no resupply points', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 10 },
    ]);
    const result = analyzeResupply(wps, 100);
    expect(result.hasResupplyData).toBe(false);
    expect(result.points).toHaveLength(0);
  });

  it('computes full analysis', () => {
    const wps = makeWaypoints([
      { name: 'Town A', type: 'town', km: 80 },
      { name: 'Town B', type: 'town', km: 200 },
    ]);
    const result = analyzeResupply(wps, 250, 25);
    expect(result.hasResupplyData).toBe(true);
    expect(result.points).toHaveLength(2);
    expect(result.gaps).toHaveLength(3);
    expect(result.longestGapKm).toBe(120); // Town A → Town B
    expect(result.longestGapDays).toBe(5); // 120/25 = 4.8 → ceil = 5
  });
});

// ---------------------------------------------------------------------------
// findNextResupply
// ---------------------------------------------------------------------------

describe('findNextResupply', () => {
  const wps = makeWaypoints([
    { name: 'Town A', type: 'town', km: 40 },
    { name: 'Store', type: 'food', km: 80 },
    { name: 'Town B', type: 'town', km: 120 },
  ]);

  it('finds the next resupply after current position', () => {
    const next = findNextResupply(wps, 50);
    expect(next?.name).toBe('Store');
  });

  it('returns first point if before all', () => {
    const next = findNextResupply(wps, 0);
    expect(next?.name).toBe('Town A');
  });

  it('returns null if past all resupply points', () => {
    const next = findNextResupply(wps, 130);
    expect(next).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// foodCarryForGap
// ---------------------------------------------------------------------------

describe('foodCarryForGap', () => {
  it('estimates food weight for a gap', () => {
    const gap = {
      fromName: 'A',
      toName: 'B',
      fromKm: 0,
      toKm: 60,
      distanceKm: 60,
      estimatedDays: 3,
      isLong: false,
    };
    const result = foodCarryForGap(gap);
    expect(result.days).toBe(3);
    expect(result.weightGrams).toBe(3 * DEFAULT_GRAMS_PER_DAY);
  });
});

// ---------------------------------------------------------------------------
// analyzeResupplyForSection
// ---------------------------------------------------------------------------

describe('analyzeResupplyForSection', () => {
  const wps = makeWaypoints([
    { name: 'Town A', type: 'town', km: 50 },
    { name: 'Store B', type: 'food', km: 120 },
    { name: 'Town C', type: 'town', km: 200 },
    { name: 'Town D', type: 'town', km: 300 },
  ]);

  it('scopes analysis to section km range', () => {
    const result = analyzeResupplyForSection(wps, 100, 250, 25);
    // Only Store B (120) and Town C (200) are in range [100, 250]
    expect(result.points).toHaveLength(2);
    expect(result.points[0].name).toBe('Store B');
    expect(result.points[1].name).toBe('Town C');
    expect(result.hasResupplyData).toBe(true);
    // Gaps: section start (100) -> Store B (120), Store B (120) -> Town C (200), Town C (200) -> section end (250)
    expect(result.gaps).toHaveLength(3);
    expect(result.gaps[0].fromName).toBe('Trail Start');
    expect(result.gaps[0].distanceKm).toBe(20);
    expect(result.gaps[1].distanceKm).toBe(80);
    expect(result.gaps[2].toName).toBe('Trail End');
    expect(result.gaps[2].distanceKm).toBe(50);
    expect(result.longestGapKm).toBe(80);
  });

  it('excludes resupply points outside section', () => {
    const result = analyzeResupplyForSection(wps, 130, 190, 20);
    // No resupply points in [130, 190]
    expect(result.points).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    // hasResupplyData should still be true because the trail has resupply points overall
    expect(result.hasResupplyData).toBe(true);
  });

  it('returns empty when no resupply in section', () => {
    const noResupplyWps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 10 },
      { name: 'Water', type: 'water', km: 50 },
    ]);
    const result = analyzeResupplyForSection(noResupplyWps, 0, 100);
    expect(result.points).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.hasResupplyData).toBe(false);
    expect(result.longestGapKm).toBe(0);
    expect(result.longestGapDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// correlateResupplyWithDays
// ---------------------------------------------------------------------------

function makeDay(dayNumber: number, startKm: number, endKm: number): ComputedDay {
  return {
    dayNumber,
    startKm,
    endKm,
    date: `2026-04-0${dayNumber}`,
    startName: `Start ${dayNumber}`,
    endName: `End ${dayNumber}`,
    distanceKm: endKm - startKm,
    ascentM: 0,
    descentM: 0,
    estimatedHours: 5,
    waterSources: 1,
  };
}

describe('correlateResupplyWithDays', () => {
  const days: ComputedDay[] = [
    makeDay(1, 0, 25),
    makeDay(2, 25, 50),
    makeDay(3, 50, 80),
    makeDay(4, 80, 110),
  ];

  it('matches resupply points to the correct day', () => {
    const points: ResupplyPoint[] = [
      { name: 'Town A', km: 30, type: 'town' },
    ];
    const result = correlateResupplyWithDays(points, days);
    expect(result).toHaveLength(1);
    expect(result[0].arrivalDay).toBe(2);
    expect(result[0].arrivalDate).toBe('2026-04-02');
    expect(result[0].point.name).toBe('Town A');
  });

  it('returns arrival day number', () => {
    const points: ResupplyPoint[] = [
      { name: 'Store', km: 70, type: 'food' },
    ];
    const result = correlateResupplyWithDays(points, days);
    expect(result).toHaveLength(1);
    expect(result[0].arrivalDay).toBe(3);
    expect(result[0].arrivalDate).toBe('2026-04-03');
  });

  it('handles multiple resupply points in same day', () => {
    const points: ResupplyPoint[] = [
      { name: 'Store A', km: 55, type: 'food' },
      { name: 'Town B', km: 75, type: 'town' },
    ];
    const result = correlateResupplyWithDays(points, days);
    expect(result).toHaveLength(2);
    // Both fall within day 3 (50-80 km)
    expect(result[0].arrivalDay).toBe(3);
    expect(result[1].arrivalDay).toBe(3);
    expect(result[0].point.name).toBe('Store A');
    expect(result[1].point.name).toBe('Town B');
  });

  it('returns empty array when no resupply points', () => {
    const result = correlateResupplyWithDays([], days);
    expect(result).toHaveLength(0);
    expect(result).toEqual([]);
  });
});
