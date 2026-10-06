import { describe, it, expect } from 'vitest';
import {
  extractWaterSources,
  computeWaterGaps,
  analyzeWaterCarry,
  analyzeWaterCarryForSection,
  DEFAULT_DRY_STRETCH_KM,
} from './water-carry-calculator';
import type { PlanWaypoint } from './plan-types';

const waypoints: PlanWaypoint[] = [
  { name: 'Spring', type: 'water', totalDistance: 10 },
  { name: 'Town Creek', type: 'water-tank', totalDistance: 30 },
  { name: 'Township', type: 'town', totalDistance: 20 },  // not water
  { name: 'Bore', type: 'water', totalDistance: 60 },
];

describe('extractWaterSources', () => {
  it('includes only water and water-tank types', () => {
    const sources = extractWaterSources(waypoints);
    expect(sources).toHaveLength(3);
    expect(sources.map(s => s.name)).toEqual(['Spring', 'Town Creek', 'Bore']);
  });

  it('sorts by km', () => {
    const sources = extractWaterSources(waypoints);
    expect(sources[0].km).toBe(10);
    expect(sources[1].km).toBe(30);
    expect(sources[2].km).toBe(60);
  });

  it('detects seasonal notes in description', () => {
    const seasonal: PlanWaypoint[] = [
      { name: 'Dry Creek', type: 'water', totalDistance: 15, description: 'May be dry in summer' },
      { name: 'Reliable Spring', type: 'water', totalDistance: 25, description: 'Permanent spring' },
    ];
    const sources = extractWaterSources(seasonal);
    expect(sources[0].seasonalNote).toBeTruthy();
    expect(sources[1].seasonalNote).toBeUndefined();
  });

  it('returns empty when no water waypoints', () => {
    expect(extractWaterSources([{ name: 'Town', type: 'town', totalDistance: 10 }])).toHaveLength(0);
  });
});

describe('computeWaterGaps', () => {
  it('computes gaps between water sources', () => {
    const sources = extractWaterSources(waypoints);
    const gaps = computeWaterGaps(sources, 0, 80);
    // start→Spring (10km), Spring→TownCreek (20km), TownCreek→Bore (30km), Bore→end (20km)
    expect(gaps).toHaveLength(4);
    expect(gaps[0].fromName).toBe('Trail Start');
    expect(gaps[0].distanceKm).toBe(10);
    expect(gaps[2].distanceKm).toBe(30);
    expect(gaps[3].toName).toBe('Trail End');
  });

  it('marks gap as dry stretch when >= 15km', () => {
    const sources = extractWaterSources(waypoints);
    const gaps = computeWaterGaps(sources, 0, 80);
    // Spring→TownCreek = 20km → dry stretch
    expect(gaps[1].isDryStretch).toBe(true);
    // start→Spring = 10km → not dry
    expect(gaps[0].isDryStretch).toBe(false);
  });

  it('uses custom dry stretch threshold', () => {
    const sources = extractWaterSources(waypoints);
    const gaps = computeWaterGaps(sources, 0, 80, 25);
    // TownCreek→Bore = 30km >= 25 → dry
    const bigGap = gaps.find(g => g.fromName === 'Town Creek');
    expect(bigGap?.isDryStretch).toBe(true);
    // Spring→TownCreek = 20km < 25 → not dry
    const smallGap = gaps.find(g => g.fromName === 'Spring');
    expect(smallGap?.isDryStretch).toBe(false);
  });

  it('makes the whole range one gap when there are no sources', () => {
    expect(computeWaterGaps([], 10, 40)).toEqual([
      { fromName: 'Trail Start', toName: 'Trail End', fromKm: 10, toKm: 40, distanceKm: 30, isDryStretch: true },
    ]);
    expect(computeWaterGaps([], 10, 20)[0].isDryStretch).toBe(false);
    expect(computeWaterGaps([], 10, 10)).toEqual([]);
  });

  it('DEFAULT_DRY_STRETCH_KM is 15', () => {
    expect(DEFAULT_DRY_STRETCH_KM).toBe(15);
  });
});

describe('analyzeWaterCarry', () => {
  it('returns hasWaterData=false when no water waypoints', () => {
    const result = analyzeWaterCarry([{ name: 'Town', type: 'town', totalDistance: 20 }], 100);
    expect(result.hasWaterData).toBe(false);
    expect(result.sources).toHaveLength(0);
  });

  it('computes dry stretch count', () => {
    const result = analyzeWaterCarry(waypoints, 80);
    // Dry stretches: Spring→TownCreek (20km), TownCreek→Bore (30km), Bore→end (20km)
    expect(result.dryStretchCount).toBeGreaterThanOrEqual(2);
  });

  it('computes longest gap km', () => {
    const result = analyzeWaterCarry(waypoints, 80);
    expect(result.longestGapKm).toBe(30); // TownCreek→Bore
  });

  it('returns sources array', () => {
    const result = analyzeWaterCarry(waypoints, 80);
    expect(result.sources).toHaveLength(3);
    expect(result.hasWaterData).toBe(true);
  });
});

// --- Edge cases from code review ---

describe('computeWaterGaps edge cases', () => {
  it('does not produce zero-distance gap when two sources at same km', () => {
    const sources = [
      { name: 'Spring A', km: 20, type: 'water' },
      { name: 'Spring B', km: 20, type: 'water' },
      { name: 'Creek', km: 50, type: 'water' },
    ];
    const gaps = computeWaterGaps(sources, 0, 80);
    // No gap should have distanceKm <= 0
    for (const gap of gaps) {
      expect(gap.distanceKm).toBeGreaterThan(0);
    }
  });

  it('clamps negative dryStretchThreshold to 0', () => {
    const sources = [
      { name: 'Spring', km: 10, type: 'water' },
      { name: 'Creek', km: 20, type: 'water' },
    ];
    // Negative threshold is clamped to 0, meaning all gaps are flagged
    const gaps = computeWaterGaps(sources, 0, 30, -5);
    // Every gap >= 0 → all flagged as dry stretch (safe default)
    for (const gap of gaps) {
      expect(gap.isDryStretch).toBe(true);
    }
  });
});

describe('extractWaterSources seasonal keyword variants', () => {
  it('detects "dries up in summer" as seasonal', () => {
    const wps: PlanWaypoint[] = [
      { name: 'Var Creek', type: 'water', totalDistance: 10, description: 'Dries up in summer months' },
    ];
    const sources = extractWaterSources(wps);
    expect(sources[0].seasonalNote).toBeTruthy();
  });

  it('detects "often dry" as seasonal', () => {
    const wps: PlanWaypoint[] = [
      { name: 'Dry Creek', type: 'water', totalDistance: 10, description: 'Often dry after October' },
    ];
    const sources = extractWaterSources(wps);
    expect(sources[0].seasonalNote).toBeTruthy();
  });

  it('detects "not reliable" / "unreliable" as seasonal', () => {
    const wps: PlanWaypoint[] = [
      { name: 'Iffy Spring', type: 'water', totalDistance: 10, description: 'Not reliable in dry years' },
    ];
    const sources = extractWaterSources(wps);
    expect(sources[0].seasonalNote).toBeTruthy();
  });
});

describe('analyzeWaterCarryForSection', () => {
  it('reports a waterless section as one dry stretch, not as no dry stretches', () => {
    // The trail maps water at 10, 30 and 60 km; nothing between 32 and 58.
    const result = analyzeWaterCarryForSection(waypoints, 32, 58);
    expect(result.hasWaterData).toBe(true);
    expect(result.sources).toEqual([]);
    expect(result.gaps).toEqual([
      { fromName: 'Trail Start', toName: 'Trail End', fromKm: 32, toKm: 58, distanceKm: 26, isDryStretch: true },
    ]);
    expect(result.longestGapKm).toBe(26);
    expect(result.dryStretchCount).toBe(1);
  });

  it('says there is no water data when the trail maps no water at all', () => {
    const result = analyzeWaterCarryForSection([{ name: 'Hut', type: 'hut', totalDistance: 5 }], 0, 50);
    expect(result).toEqual({ sources: [], gaps: [], longestGapKm: 0, dryStretchCount: 0, hasWaterData: false });
  });
});
