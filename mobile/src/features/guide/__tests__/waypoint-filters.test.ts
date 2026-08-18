import {
  familyForType,
  matchesFamily,
  formatSignedDistance,
  FILTER_FAMILIES,
} from '../waypoint-filters';

describe('familyForType', () => {
  it('maps types to their filterable family', () => {
    expect(familyForType('water')).toBe('water');
    expect(familyForType('water-tank')).toBe('water');
    expect(familyForType('campsite')).toBe('camp');
    expect(familyForType('town')).toBe('town');
    expect(familyForType('hut')).toBe('shelter');
  });

  it('classes junctions/hazards/unknowns as "other"', () => {
    expect(familyForType('junction')).toBe('other');
    expect(familyForType('hazard')).toBe('other');
    expect(familyForType('totally-made-up')).toBe('other');
  });
});

describe('matchesFamily', () => {
  it('all matches everything', () => {
    expect(matchesFamily('junction', 'all')).toBe(true);
    expect(matchesFamily('water', 'all')).toBe(true);
  });

  it('a family matches only its own types', () => {
    expect(matchesFamily('water', 'water')).toBe(true);
    expect(matchesFamily('campsite', 'water')).toBe(false);
    expect(matchesFamily('junction', 'shelter')).toBe(false);
  });

  it('the favorites family is an id-based cut, not a type-based one', () => {
    // Type is irrelevant; only the isFavorite flag decides.
    expect(matchesFamily('water', 'favorites', true)).toBe(true);
    expect(matchesFamily('water', 'favorites', false)).toBe(false);
    expect(matchesFamily('junction', 'favorites', true)).toBe(true);
  });

  it('type-based families ignore the isFavorite flag', () => {
    expect(matchesFamily('water', 'water', false)).toBe(true);
    expect(matchesFamily('campsite', 'water', true)).toBe(false);
    expect(matchesFamily('anything', 'all', false)).toBe(true);
  });

  it('exposes exactly the six chips (favorites second)', () => {
    expect(FILTER_FAMILIES.map((f) => f.value)).toEqual([
      'all',
      'favorites',
      'water',
      'camp',
      'town',
      'shelter',
    ]);
  });
});

describe('formatSignedDistance', () => {
  it('labels positive deltas as ahead', () => {
    expect(formatSignedDistance(12.4, 'km')).toEqual({ label: '12.4 km ahead', direction: 'ahead' });
  });

  it('labels negative deltas as behind (magnitude only)', () => {
    expect(formatSignedDistance(-3.1, 'km')).toEqual({ label: '3.1 km behind', direction: 'behind' });
  });

  it('collapses a near-zero delta to "Here"', () => {
    expect(formatSignedDistance(0, 'km')).toEqual({ label: 'Here', direction: 'here' });
    expect(formatSignedDistance(0.01, 'km').direction).toBe('here');
  });

  it('is unit-aware', () => {
    expect(formatSignedDistance(1.609344, 'mi').label).toBe('1.0 mi ahead');
  });
});
