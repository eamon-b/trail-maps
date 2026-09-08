import { describe, expect, it } from 'vitest';

import {
  countDuplicatePois,
  isCompatibleType,
  markDuplicatePois,
  nameScore,
  nameTokens,
  nonDuplicatePois,
  type DedupWaypointLike,
} from './poi-dedup';
import type { TrailPOI, TrailPOICategory } from './trail-types';

function poi(over: Partial<TrailPOI> & { name: string | null }): TrailPOI {
  return {
    id: 1,
    type: 'node',
    category: 'camping' as TrailPOICategory,
    lat: -35,
    lon: 148,
    tags: {},
    distanceAlongTrail: 10,
    distanceFromTrail: 0.1,
    ...over,
  };
}

function wp(over: Partial<DedupWaypointLike> & { name: string }): DedupWaypointLike {
  return { id: 'w_1', type: 'campsite', lat: -35, lon: 148, ...over };
}

/** Roughly `metres` north of the base latitude. */
function latOffset(metres: number): number {
  return -35 + metres / 111320;
}

describe('nameTokens', () => {
  it('drops generic place words that carry no identity', () => {
    expect(nameTokens('Buddong Hut Camp Site')).toEqual(['buddong']);
    expect(nameTokens('Finke River Campground')).toEqual(['finke', 'river']);
  });

  it('strips curator prefixes used in the bundled GPX files', () => {
    expect(nameTokens('R: Ormiston Gorge')).toEqual(['ormiston', 'gorge']);
    expect(nameTokens('Kiosk: Standley Chasm')).toEqual(['standley', 'chasm']);
    expect(nameTokens('CLOSED C - Ben Smith campsite')).toEqual(['ben', 'smith']);
  });

  it('drops a trailing qualifier', () => {
    expect(nameTokens('Conto Campground - Leeuwin-Naturaliste NP')).toEqual(['conto']);
  });

  it('returns nothing for an unnamed or wholly generic POI', () => {
    expect(nameTokens(null)).toEqual([]);
    expect(nameTokens('Campsite')).toEqual([]);
  });
});

describe('nameScore', () => {
  it('scores containment as a full match', () => {
    expect(nameScore('Buddong Hut Camp Site', 'Buddong hut')).toBe(1);
    expect(nameScore('Mount Clare hut', 'Mount Clare')).toBe(1);
  });

  it('tolerates spelling drift', () => {
    expect(nameScore("Hewett's Hill Campsite", "Hewitt's Hill Campsite")).toBeGreaterThan(0.9);
  });

  it('scores unrelated places low', () => {
    expect(nameScore('Bossawa Campsite', 'Barrois camp')).toBeLessThan(0.9);
  });

  it('is zero when either name reduces to nothing', () => {
    expect(nameScore(null, 'Buddong hut')).toBe(0);
    expect(nameScore('Campsite', 'Buddong hut')).toBe(0);
  });
});

describe('isCompatibleType', () => {
  it('matches a category against its waypoint types', () => {
    expect(isCompatibleType('camping', 'campsite')).toBe(true);
    expect(isCompatibleType('restaurant', 'food')).toBe(true);
  });

  it('never treats a town as a dedup target', () => {
    // A town waypoint marks an area, so every shop in it carries its name.
    expect(isCompatibleType('resupply', 'town')).toBe(false);
    expect(isCompatibleType('restaurant', 'town')).toBe(false);
    expect(isCompatibleType('camping', 'town')).toBe(false);
  });

  it('excludes transport entirely', () => {
    expect(isCompatibleType('transport', 'trailhead')).toBe(false);
  });
});

describe('markDuplicatePois', () => {
  it('flags a POI that matches a nearby compatible waypoint', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Buddong Hut Camp Site', lat: latOffset(5) })],
      [wp({ name: 'Buddong hut', id: 'w_abc' })]
    )!;
    expect(marked.duplicateOf).toBe('w_abc');
    expect(marked.duplicateDistanceM).toBe(5);
  });

  it('leaves a distinct POI untouched, with no duplicate fields at all', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Barrois camp' })],
      [wp({ name: 'Buddong hut' })]
    )!;
    expect(marked).not.toHaveProperty('duplicateOf');
    expect(marked).not.toHaveProperty('duplicateDistanceM');
  });

  it('does not match beyond 250 m', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Buddong Hut Camp Site', lat: latOffset(400) })],
      [wp({ name: 'Buddong hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('never flags an unnamed POI', () => {
    // A nameless water tap beside a campsite waypoint is complementary
    // information, not a repeat of it.
    const [marked] = markDuplicatePois(
      [poi({ name: null, category: 'water', lat: latOffset(23) })],
      [wp({ name: 'Mount Duckworth Campsite', type: 'water' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('does not collapse a shop into the town waypoint that shares its name', () => {
    // Regression: BP Pemberton / Walpole IGA / Premier Hotel Albany were all
    // being swallowed by their town waypoints.
    const marked = markDuplicatePois(
      [
        poi({ name: 'BP Pemberton', category: 'resupply', lat: latOffset(200) }),
        poi({ name: 'Premier Hotel Albany', category: 'restaurant', lat: latOffset(120) }),
      ],
      [wp({ name: 'Pemberton', type: 'town' }), wp({ name: 'Albany', type: 'town' })]
    )!;
    expect(marked.every(p => p.duplicateOf === undefined)).toBe(true);
  });

  it('does not equate two bus stops that share tokens in a different order', () => {
    // Opposite sides of one intersection are two real stops.
    const marked = markDuplicatePois(
      [poi({ name: 'Canning Rd After Recreation Rd', category: 'transport' })],
      [wp({ name: 'Recreation Rd After Canning Rd', type: 'trailhead' })]
    )!;
    expect(marked[0].duplicateOf).toBeUndefined();
  });

  it('requires a compatible category', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Ormiston Gorge', category: 'water' })],
      [wp({ name: 'Ormiston Gorge', type: 'campsite' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('prefers the closer waypoint when two score the same', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Simpsons Gap', lat: latOffset(0) })],
      [
        wp({ name: 'Simpsons Gap', id: 'w_far', lat: latOffset(154) }),
        wp({ name: 'Simpsons Gap', id: 'w_near', lat: latOffset(20) }),
      ]
    )!;
    expect(marked.duplicateOf).toBe('w_near');
  });

  it('ignores waypoints with no id, which cannot be referenced', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Buddong Hut Camp Site' })],
      [{ name: 'Buddong hut', type: 'campsite', lat: -35, lon: 148 }]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('clears a stale flag rather than trusting the input', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Barrois camp', duplicateOf: 'w_gone', duplicateDistanceM: 4 })],
      [wp({ name: 'Buddong hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
    expect(marked.duplicateDistanceM).toBeUndefined();
  });

  it('does not mutate its input', () => {
    const input = [poi({ name: 'Buddong Hut Camp Site' })];
    markDuplicatePois(input, [wp({ name: 'Buddong hut' })]);
    expect(input[0]).not.toHaveProperty('duplicateOf');
  });

  it('passes POIs through when a trail has no waypoints', () => {
    const marked = markDuplicatePois([poi({ name: 'Buddong Hut Camp Site' })], [])!;
    expect(marked).toHaveLength(1);
    expect(marked[0].duplicateOf).toBeUndefined();
  });

  it('returns undefined for a trail that was never fetched', () => {
    expect(markDuplicatePois(undefined, [wp({ name: 'Buddong hut' })])).toBeUndefined();
  });
});

describe('nonDuplicatePois / countDuplicatePois', () => {
  const pois = [
    poi({ name: 'a', duplicateOf: 'w_1' }),
    poi({ name: 'b' }),
    poi({ name: 'c', duplicateOf: 'w_2' }),
  ];

  it('filters and counts the flagged ones', () => {
    expect(nonDuplicatePois(pois)).toHaveLength(1);
    expect(countDuplicatePois(pois)).toBe(2);
    expect(countDuplicatePois(undefined)).toBe(0);
    expect(nonDuplicatePois(undefined)).toEqual([]);
  });
});
