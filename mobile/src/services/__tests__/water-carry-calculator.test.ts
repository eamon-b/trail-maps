import type { TrailWaypoint } from '../../lib/trail-utils';
import {
  extractWaterSources,
  computeWaterGaps,
  analyzeWaterCarry,
  analyzeWaterCarryForSection,
} from '../water-carry-calculator';

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
// extractWaterSources
// ---------------------------------------------------------------------------

describe('extractWaterSources', () => {
  it('extracts water and water-tank types', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 5 },
      { name: 'Creek', type: 'water', km: 10 },
      { name: 'Tank', type: 'water-tank', km: 20 },
      { name: 'Town', type: 'town', km: 30 },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources).toHaveLength(2);
    expect(sources[0].name).toBe('Creek');
    expect(sources[1].name).toBe('Tank');
  });

  it('returns empty for no water sources', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 5 },
      { name: 'Town', type: 'town', km: 30 },
    ]);
    expect(extractWaterSources(wps)).toHaveLength(0);
  });

  it('sorts by km', () => {
    const wps = makeWaypoints([
      { name: 'Far', type: 'water', km: 40 },
      { name: 'Near', type: 'water', km: 5 },
      { name: 'Mid', type: 'water-tank', km: 20 },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources.map(s => s.km)).toEqual([5, 20, 40]);
  });
});

// ---------------------------------------------------------------------------
// computeWaterGaps
// ---------------------------------------------------------------------------

describe('computeWaterGaps', () => {
  const sources = [
    { name: 'Creek', km: 10, type: 'water' },
    { name: 'River', km: 30, type: 'water' },
    { name: 'Tank', km: 35, type: 'water-tank' },
  ];

  it('includes gap from trail start to first source', () => {
    const gaps = computeWaterGaps(sources, 0, 50);
    expect(gaps[0].fromName).toBe('Trail Start');
    expect(gaps[0].toName).toBe('Creek');
    expect(gaps[0].distanceKm).toBe(10);
  });

  it('includes gap from last source to trail end', () => {
    const gaps = computeWaterGaps(sources, 0, 50);
    const last = gaps[gaps.length - 1];
    expect(last.fromName).toBe('Tank');
    expect(last.toName).toBe('Trail End');
    expect(last.distanceKm).toBe(15);
  });

  it('computes inter-source gaps', () => {
    const gaps = computeWaterGaps(sources, 0, 50);
    // Should have 4 gaps: start→Creek, Creek→River, River→Tank, Tank→end
    expect(gaps).toHaveLength(4);
    expect(gaps[1].distanceKm).toBe(20); // Creek→River
    expect(gaps[2].distanceKm).toBe(5);  // River→Tank
  });

  it('flags dry stretches at threshold', () => {
    const gaps = computeWaterGaps(sources, 0, 50, 15);
    // Creek→River is 20km, exceeds 15km threshold
    expect(gaps[1].isDryStretch).toBe(true);
    // Trail Start→Creek is 10km, under threshold
    expect(gaps[0].isDryStretch).toBe(false);
    // Tank→End is 15km, equals threshold (>= check)
    expect(gaps[3].isDryStretch).toBe(true);
  });

  it('returns empty for no sources', () => {
    expect(computeWaterGaps([], 0, 50)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// analyzeWaterCarry
// ---------------------------------------------------------------------------

describe('analyzeWaterCarry', () => {
  it('returns hasWaterData=false when no water sources exist', () => {
    const wps = makeWaypoints([
      { name: 'Camp', type: 'campsite', km: 10 },
      { name: 'Town', type: 'town', km: 50 },
    ]);
    const result = analyzeWaterCarry(wps, 100);
    expect(result.hasWaterData).toBe(false);
    expect(result.sources).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
  });

  it('computes full analysis with water sources', () => {
    const wps = makeWaypoints([
      { name: 'Creek', type: 'water', km: 10 },
      { name: 'River', type: 'water', km: 40 },
    ]);
    const result = analyzeWaterCarry(wps, 50);
    expect(result.hasWaterData).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.gaps).toHaveLength(3); // start→Creek, Creek→River, River→end
    expect(result.longestGapKm).toBe(30); // Creek→River
    expect(result.dryStretchCount).toBe(1); // 30km > 15km default
  });

  it('counts dry stretches with custom threshold', () => {
    const wps = makeWaypoints([
      { name: 'A', type: 'water', km: 10 },
      { name: 'B', type: 'water', km: 22 },
    ]);
    // Gaps: 0→10 (10km), 10→22 (12km), 22→30 (8km)
    const result = analyzeWaterCarry(wps, 30, 10);
    expect(result.dryStretchCount).toBe(2); // 10km and 12km both >= 10
  });
});

// ---------------------------------------------------------------------------
// analyzeWaterCarryForSection
// ---------------------------------------------------------------------------

describe('analyzeWaterCarryForSection', () => {
  const wps = makeWaypoints([
    { name: 'A', type: 'water', km: 5 },
    { name: 'B', type: 'water', km: 20 },
    { name: 'C', type: 'water', km: 40 },
  ]);

  it('scopes to section boundaries', () => {
    const result = analyzeWaterCarryForSection(wps, 10, 30);
    expect(result.sources).toHaveLength(1); // only B at km 20
    expect(result.gaps).toHaveLength(2); // 10→20, 20→30
    expect(result.gaps[0].fromName).toBe('Trail Start');
    expect(result.gaps[0].distanceKm).toBe(10);
  });

  it('returns empty sources for section with no water', () => {
    const result = analyzeWaterCarryForSection(wps, 25, 35);
    expect(result.sources).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.hasWaterData).toBe(true); // trail has data, just not in section
  });
});

// ---------------------------------------------------------------------------
// analyzeWaterCarryForSection — additional coverage
// ---------------------------------------------------------------------------

describe('analyzeWaterCarryForSection — detailed', () => {
  const wps = makeWaypoints([
    { name: 'Spring', type: 'water', km: 5 },
    { name: 'Creek', type: 'water', km: 15 },
    { name: 'River', type: 'water', km: 30 },
    { name: 'Tank', type: 'water-tank', km: 50 },
    { name: 'Dam', type: 'water', km: 70 },
  ]);

  it('scopes analysis to section km range', () => {
    // Section 10–40 should include Creek (15) and River (30) only
    const result = analyzeWaterCarryForSection(wps, 10, 40);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0].name).toBe('Creek');
    expect(result.sources[1].name).toBe('River');
  });

  it('excludes water sources outside section', () => {
    // Section 20–45 should exclude Spring (5), Creek (15), Dam (70)
    const result = analyzeWaterCarryForSection(wps, 20, 45);
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].name).toBe('River');
    // Spring, Creek, Tank, and Dam should not be present
    const names = result.sources.map(s => s.name);
    expect(names).not.toContain('Spring');
    expect(names).not.toContain('Creek');
    expect(names).not.toContain('Tank');
    expect(names).not.toContain('Dam');
  });

  it('returns correct gap analysis within section', () => {
    // Section 10–40 has Creek (15) and River (30)
    // Gaps: 10→15 (5km), 15→30 (15km), 30→40 (10km)
    const result = analyzeWaterCarryForSection(wps, 10, 40);
    expect(result.gaps).toHaveLength(3);
    expect(result.gaps[0].fromName).toBe('Trail Start');
    expect(result.gaps[0].toName).toBe('Creek');
    expect(result.gaps[0].distanceKm).toBe(5);
    expect(result.gaps[1].fromName).toBe('Creek');
    expect(result.gaps[1].toName).toBe('River');
    expect(result.gaps[1].distanceKm).toBe(15);
    expect(result.gaps[2].fromName).toBe('River');
    expect(result.gaps[2].toName).toBe('Trail End');
    expect(result.gaps[2].distanceKm).toBe(10);
    expect(result.longestGapKm).toBe(15);
    expect(result.dryStretchCount).toBe(1); // 15km >= 15 default threshold
  });

  it('handles no water sources in section', () => {
    // Section 55–65 has no water sources
    const result = analyzeWaterCarryForSection(wps, 55, 65);
    expect(result.sources).toHaveLength(0);
    expect(result.gaps).toHaveLength(0);
    expect(result.longestGapKm).toBe(0);
    expect(result.dryStretchCount).toBe(0);
    // hasWaterData should be true because the trail itself has water sources
    expect(result.hasWaterData).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractWaterSources — seasonal notes
// ---------------------------------------------------------------------------

function makeWaypointsWithDesc(items: { name: string; type: string; km: number; description?: string }[]): TrailWaypoint[] {
  return items.map((s, i) => ({
    id: `wp-${i}`,
    name: s.name,
    lat: -33,
    lon: 115,
    type: s.type,
    totalDistance: s.km,
    description: s.description,
  }));
}

describe('extractWaterSources — seasonal notes', () => {
  it('extracts seasonalNote from description containing "seasonal"', () => {
    const wps = makeWaypointsWithDesc([
      { name: 'Seasonal Creek', type: 'water', km: 10, description: 'Seasonal flow only in winter months' },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources).toHaveLength(1);
    expect(sources[0].seasonalNote).toBe('Seasonal flow only in winter months');
  });

  it('extracts seasonalNote from description containing "dry in summer"', () => {
    const wps = makeWaypointsWithDesc([
      { name: 'Summer Dry Creek', type: 'water', km: 20, description: 'Often dry in summer, check before relying on it' },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources).toHaveLength(1);
    expect(sources[0].seasonalNote).toBe('Often dry in summer, check before relying on it');
  });

  it('extracts seasonalNote from description containing "unreliable"', () => {
    const wps = makeWaypointsWithDesc([
      { name: 'Dodgy Tank', type: 'water-tank', km: 30, description: 'Unreliable water supply, tank may be empty' },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources).toHaveLength(1);
    expect(sources[0].seasonalNote).toBe('Unreliable water supply, tank may be empty');
  });

  it('no seasonalNote when description does not contain keywords', () => {
    const wps = makeWaypointsWithDesc([
      { name: 'Good Creek', type: 'water', km: 15, description: 'Clear flowing water year round' },
      { name: 'Big River', type: 'water', km: 25 },
    ]);
    const sources = extractWaterSources(wps);
    expect(sources).toHaveLength(2);
    expect(sources[0].seasonalNote).toBeUndefined();
    expect(sources[1].seasonalNote).toBeUndefined();
  });
});
