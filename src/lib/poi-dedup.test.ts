import { describe, expect, it } from 'vitest';

import {
  applyDuplicateOverrides,
  countDuplicatePois,
  dedupCandidates,
  isCompatibleType,
  markDuplicatePois,
  nameScore,
  namesDistinguished,
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

  it('keeps a name an unspaced hyphen runs through', () => {
    expect(nameTokens('Bay-of-Fires Lodge')).toEqual(['bay', 'of', 'fires', 'lodge']);
    expect(nameTokens('Leeuwin-Naturaliste Hut')).toEqual(['leeuwin', 'naturaliste']);
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
    expect(nameScore('Aire River West Campground', 'Aire River Hike-in Campground')).toBe(1);
  });

  it('does not call one shared word a match', () => {
    expect(nameScore('River Camp', 'Finke River Campground')).toBeLessThan(0.9);
    expect(nameScore('Lake', 'Lake Tali Karng')).toBeLessThan(0.9);
    // A shop or a pub in a town is not the town.
    expect(nameScore('Opua General Store', 'Opua')).toBeLessThan(0.9);
    expect(nameScore('Puhoi Pub', 'Puhoi')).toBeLessThan(0.9);
  });

  it('lets the generic words supply the second shared word', () => {
    // Stripped, these are `melrose` against `melrose and`: one name inside the
    // other on a single word. The caravan park they both name makes it a match.
    expect(nameScore('Melrose Caravan Park', 'Melrose Caravan Park and Campground')).toBe(1);
    // A brand prefix puts another word first, so this one stays apart; a second
    // pin for a caravan park is the cheaper mistake.
    expect(nameScore('Big 4: Hawker Caravan Park', 'Hawker Caravan Park')).toBeLessThan(1);
    expect(nameScore('Burra Caravan & Camping Park', 'Burra Caravan Park')).toBe(1);
    // Every way of spelling "campground" is the same kind of place.
    expect(nameScore('Trezona Camp Ground', 'Trezona Campsite')).toBe(1);
    expect(nameScore('Pines Camp Freedom Camping', 'Pines Campsite')).toBe(1);
    expect(nameScore('Blowering Dam Campsite', 'Blowering camp')).toBe(1);
    // ...but a shelter beside a campsite is not the campsite, and the old hut
    // is not the new one.
    expect(nameScore('Klondyke Shelter', 'Klondyke Corner Campsite')).toBeLessThan(0.9);
    expect(nameScore('Old Aparima Hut', 'Aparima Hut')).toBeLessThan(0.9);
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

  it('lets an OSM hut or restaurant duplicate a teahouse', () => {
    expect(isCompatibleType('camping', 'teahouse')).toBe(true);
    expect(isCompatibleType('restaurant', 'teahouse')).toBe(true);
    expect(isCompatibleType('water', 'teahouse')).toBe(false);
    expect(isCompatibleType('resupply', 'teahouse')).toBe(false);
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
    const [marked] = markDuplicatePois([poi({ name: 'Barrois camp' })], [wp({ name: 'Buddong hut' })])!;
    expect(marked).not.toHaveProperty('duplicateOf');
    expect(marked).not.toHaveProperty('duplicateDistanceM');
  });

  it('keeps a distinct POI that shares one word with a nearby waypoint', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Finke River Campground', lat: latOffset(100) })],
      [wp({ name: 'River Camp', id: 'w_river' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('does not match beyond 250 m', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Buddong Hut Camp Site', lat: latOffset(400) })],
      [wp({ name: 'Buddong hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('folds an unnamed campsite into the hut it sits beside', () => {
    // The AAWT's Pockets Hut: OSM maps the tent area as a nameless camp_site
    // 4 m from the hut.
    const [marked] = markDuplicatePois(
      [poi({ name: null, lat: latOffset(4) })],
      [wp({ id: 'w_pockets', name: 'Pockets Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBe('w_pockets');
    expect(marked.duplicateDistanceM).toBe(4);
  });

  it('takes the nearest compatible waypoint for an unnamed campsite', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: null, lat: latOffset(20) })],
      [
        wp({ id: 'w_far', name: 'Far Hut', type: 'hut', lat: latOffset(-25) }),
        wp({ id: 'w_water', name: 'Creek', type: 'water', lat: latOffset(20) }),
        wp({ id: 'w_near', name: 'Near Campsite', lat: latOffset(12) }),
      ]
    )!;
    expect(marked.duplicateOf).toBe('w_near');
  });

  it('keeps an unnamed campsite beyond 30 m of any hut or campsite', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: null, lat: latOffset(40) })],
      [wp({ name: 'Pockets Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('reads Mt and Mount as one word', () => {
    expect(nameScore('Mount Wills Hut', 'Mt Wills Hut')).toBe(1);
    expect(nameScore('Mount Cooke Campsite', 'Mt. Cooke Campsite')).toBe(1);
  });

  it('accepts spelling drift only within 25 m', () => {
    // The AAWT's Edmondson Hut is OSM's Edmonsons Hut, 2 m away (0.89).
    const near = markDuplicatePois(
      [poi({ name: 'Edmonsons Hut', lat: latOffset(2) })],
      [wp({ name: 'Edmondson Hut', type: 'hut' })]
    )!;
    expect(near[0].duplicateOf).toBe('w_1');
    const far = markDuplicatePois(
      [poi({ name: 'Edmonsons Hut', lat: latOffset(60) })],
      [wp({ name: 'Edmondson Hut', type: 'hut' })]
    )!;
    expect(far[0].duplicateOf).toBeUndefined();
  });

  it('keeps an old hut apart from the new one beside it', () => {
    // Te Araroa: Old Aparima Hut stands 12 m from Aparima Hut.
    const [marked] = markDuplicatePois(
      [poi({ name: 'Old Aparima Hut', lat: latOffset(12) })],
      [wp({ name: 'Aparima Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('tells places apart by direction words and differing numbers', () => {
    expect(namesDistinguished('Buenba Flat #1', 'Buenba Flat South #1')).toBe(true);
    expect(namesDistinguished('Old Aparima Hut', 'Aparima Hut')).toBe(true);
    expect(namesDistinguished('Twins Track 1', 'Twins Track 2')).toBe(true);
    // A number on one side only is not an identity.
    expect(namesDistinguished('Big River', 'Big River 1')).toBe(false);
    expect(namesDistinguished('Mount Wills Hut', 'Mt Wills Hut')).toBe(false);
    // Abbreviated compass words count.
    expect(namesDistinguished('Buenba Flat Sth', 'Buenba Flat')).toBe(true);
    expect(namesDistinguished('Nth Creek Camp', 'North Creek Camp')).toBe(false);
    expect(namesDistinguished('Creek Camp S', 'Creek Camp')).toBe(true);
  });

  it('reads a lone compass letter only at an end of the name, never as an initial', () => {
    expect(nameTokens('Creek Camp S')).toEqual(['creek', 'south']);
    expect(nameTokens('N Branch Hut')).toEqual(['north', 'branch']);
    // Mid-name it is a word, not a direction.
    expect(nameTokens("Night 'n Day")).toEqual(['night', 'n', 'day']);
    // Beside another lone letter it is an initial.
    expect(nameTokens('J W McMahon')).toEqual(['j', 'w', 'mcmahon']);
    expect(nameTokens('W J Smith Hut')).toEqual(['w', 'j', 'smith']);
    expect(nameTokens('Smith J W')).toEqual(['smith', 'j', 'w']);
    expect(namesDistinguished("Night 'n Day", 'Night n Day')).toBe(false);
    expect(namesDistinguished('J W McMahon', 'J W McMahon Hut')).toBe(false);
    // The three-letter forms still expand anywhere.
    expect(nameTokens('Buenba Nth Flat')).toEqual(['buenba', 'north', 'flat']);
  });

  it('folds a campsite named only with generic words like an unnamed one', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: 'Campsite', lat: latOffset(6) })],
      [wp({ id: 'w_mackays', name: 'Mackays Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBe('w_mackays');
  });

  it('never folds by position a name it cannot read', () => {
    // A Japanese name tokenises to nothing, but it is a name: an unrelated
    // campground 23 m from a hut must not fold into it.
    const [marked] = markDuplicatePois(
      [poi({ name: '恵比須浜キャンプ村', lat: latOffset(23) })],
      [wp({ name: 'Ebisuhama Ohenro Rest Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('never folds by position a mixed-script name whose Latin words are generic', () => {
    const [marked] = markDuplicatePois(
      [poi({ name: '遍路小屋 Campsite', lat: latOffset(6) })],
      [wp({ name: 'Mackays Hut', type: 'hut' })]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('keeps an unnamed campsite beside a poi- or water-typed waypoint', () => {
    const marked = markDuplicatePois(
      [poi({ id: 1, name: null, lat: latOffset(3) }), poi({ id: 2, name: null, lat: latOffset(3) })],
      [wp({ id: 'w_rock', name: 'Rock Shelter', type: 'poi' })]
    )!;
    expect(marked.every(p => p.duplicateOf === undefined)).toBe(true);
    const [byWater] = markDuplicatePois(
      [poi({ name: null, lat: latOffset(3) })],
      [wp({ id: 'w_creek', name: 'Hellfire Creek', type: 'water' })]
    )!;
    expect(byWater.duplicateOf).toBeUndefined();
  });

  it('leaves an unnamed campsite alone between two differently named places', () => {
    // The Overland's Waterfall Valley camp site: 20 m from the old hut, 43 m
    // from the group platform.
    const [marked] = markDuplicatePois(
      [poi({ name: null })],
      [
        wp({ id: 'w_old', name: 'Old Waterfall Valley Hut', type: 'hut', lat: latOffset(20) }),
        wp({ id: 'w_group', name: 'Waterfall Valley Group Camping Platform', lat: latOffset(-43) }),
      ]
    )!;
    expect(marked.duplicateOf).toBeUndefined();
  });

  it('folds an unnamed campsite on its hut even with another hut nearby', () => {
    // Shikoku: 1 m from the Katsuura pilgrim hut, 43 m from Yottene Market.
    const [marked] = markDuplicatePois(
      [poi({ name: null })],
      [
        wp({ id: 'w_katsuura', name: 'Pilgrim Hut No.11 Katsuura', type: 'hut', lat: latOffset(1) }),
        wp({ id: 'w_market', name: 'Yottene Market', type: 'hut', lat: latOffset(-43) }),
      ]
    )!;
    expect(marked.duplicateOf).toBe('w_katsuura');
  });

  it('folds an unnamed campsite beside a hut and campsite of one name', () => {
    // The AAWT's Buckwong Hut is both a hut and a campsite waypoint.
    const [marked] = markDuplicatePois(
      [poi({ name: null })],
      [
        wp({ id: 'w_hut', name: 'Buckwong Hut', type: 'hut', lat: latOffset(12) }),
        wp({ id: 'w_camp', name: 'Buckwong Hut', lat: latOffset(1) }),
      ]
    )!;
    expect(marked.duplicateOf).toBe('w_camp');
  });

  it('never flags an unnamed POI other than a campsite', () => {
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
  const pois = [poi({ name: 'a', duplicateOf: 'w_1' }), poi({ name: 'b' }), poi({ name: 'c', duplicateOf: 'w_2' })];

  it('filters and counts the flagged ones', () => {
    expect(nonDuplicatePois(pois)).toHaveLength(1);
    expect(countDuplicatePois(pois)).toBe(2);
    expect(countDuplicatePois(undefined)).toBe(0);
    expect(nonDuplicatePois(undefined)).toEqual([]);
  });
});

describe('open-data trail matching', () => {
  it('joins an apostrophe instead of splitting on it', () => {
    expect(nameTokens("Devil's Kitchen")).toEqual(['devils', 'kitchen']);
    expect(nameScore("Devil's Kitchen", 'Devils Kitchen Hike-in Campground')).toBe(1);
    expect(nameTokens("O' Keefes Hut")).toEqual(['okeefes']);
    expect(nameTokens("Walkers' Rest Camp")).toEqual(['walkers']);
  });

  it('prefers the waypoint with the same name to a closer one it merely contains', () => {
    const [flagged] = markDuplicatePois(
      [poi({ name: 'Aire River West Campground - Otway NP', lat: latOffset(100) })],
      [
        wp({ id: 'w_hike', name: 'Aire River Hike-in Campground', lat: latOffset(90) }),
        wp({ id: 'w_west', name: 'Aire River West Campground' }),
      ]
    )!;
    expect(flagged.duplicateOf).toBe('w_west');
  });

  it('ignores the Great Trails Victoria naming words', () => {
    expect(nameScore('Moleside Bushcamp (GSWW)', 'Moleside Hike-in Campground')).toBe(1);
    expect(nameScore('Lasletts Canoe Camp', 'Lasletts Hike-in Campground')).toBe(1);
  });

  it('flags an exact, co-located match against a generic `poi` waypoint', () => {
    const [flagged] = markDuplicatePois([poi({ name: 'Rock shelter' })], [wp({ name: 'Rock shelter', type: 'poi' })])!;
    expect(flagged.duplicateOf).toBe('w_1');
  });

  it('keeps the type check beyond the co-located radius, and for typed waypoints', () => {
    const [near] = markDuplicatePois(
      [poi({ name: 'Rock shelter', lat: latOffset(30) })],
      [wp({ name: 'Rock shelter', type: 'poi' })]
    )!;
    expect(near.duplicateOf).toBeUndefined();
    const [town] = markDuplicatePois(
      [poi({ name: 'Nelson', category: 'resupply' })],
      [wp({ name: 'Nelson', type: 'town' })]
    )!;
    expect(town.duplicateOf).toBeUndefined();
  });
});

describe('dedupCandidates', () => {
  it('collects main, off-trail and variant waypoints once each', () => {
    const hut = wp({ id: 'w_hut', name: 'Narcissus Hut', type: 'hut' });
    const ids = dedupCandidates({
      waypoints: [hut],
      offTrailWaypoints: [wp({ id: 'w_off', name: 'Dunkeld', type: 'town' })],
      alternates: [{ waypoints: [wp({ id: 'w_alt', name: 'Beach camp' })] }],
      sideTrips: [{ waypoints: [hut, wp({ id: 'w_munro', name: 'Munro Cabin', type: 'hut' })] }, {}],
    }).map(w => w.id);
    expect(ids).toEqual(['w_hut', 'w_off', 'w_alt', 'w_munro']);
  });

  it("lets a POI on a side trip match the side trip's waypoint", () => {
    const [flagged] = markDuplicatePois(
      [poi({ name: 'Munro Cabin' })],
      dedupCandidates({
        waypoints: [],
        sideTrips: [{ waypoints: [wp({ id: 'w_munro', name: 'Munro Cabin', type: 'hut' })] }],
      })
    )!;
    expect(flagged.duplicateOf).toBe('w_munro');
  });
});

describe('applyDuplicateOverrides', () => {
  const hut = wp({ id: 'w_schlink', name: 'Schlink Hut', type: 'hut' });

  it('flags a hand-listed pair no rule matches', () => {
    // Schlink Hilton is the AAWT's Schlink Hut.
    const { pois, unmatched } = applyDuplicateOverrides(
      [poi({ id: 250735325, type: 'way', name: 'Schlink Hilton', lat: latOffset(4) })],
      { 'way/250735325': 'w_schlink' },
      [hut]
    );
    expect(pois[0].duplicateOf).toBe('w_schlink');
    expect(pois[0].duplicateDistanceM).toBe(4);
    expect(unmatched).toEqual([]);
  });

  it('reports an override that replaces a different rule match', () => {
    const { replaced } = applyDuplicateOverrides(
      [poi({ id: 7, type: 'node', name: 'Schlink Hilton', duplicateOf: 'w_other' })],
      { 'node/7': 'w_schlink' },
      [hut, wp({ id: 'w_other', name: 'Other' })]
    );
    expect(replaced).toEqual([{ key: 'node/7', ruleMatch: 'w_other', override: 'w_schlink' }]);
  });

  it('reports a key that matches no POI', () => {
    const { unmatched } = applyDuplicateOverrides([], { 'node/9': 'w_schlink' }, [hut]);
    expect(unmatched).toEqual(['node/9']);
  });

  it('throws on a waypoint id the trail does not have', () => {
    expect(() => applyDuplicateOverrides([], { 'node/9': 'w_missing' }, [hut])).toThrow(/w_missing/);
  });
});
