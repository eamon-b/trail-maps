import { describe, expect, it } from 'vitest';
import {
  COUNTRIES,
  LENGTH_BANDS,
  countryName,
  groupTrails,
  isValidCountry,
  isValidState,
  lengthBand,
  matchesFilter,
  sortTrails,
  stateName,
  type GroupableTrail,
} from './trail-regions';

const t = (name: string, lengthKm: number, country?: string | null, states?: string[] | null): GroupableTrail => ({
  name,
  lengthKm,
  country,
  states,
});

describe('lengthBand', () => {
  it('splits at 30 and 300 km', () => {
    expect(lengthBand(0)).toBe('day');
    expect(lengthBand(29.9)).toBe('day');
    expect(lengthBand(30)).toBe('multi');
    expect(lengthBand(300)).toBe('multi');
    expect(lengthBand(300.1)).toBe('long');
    expect(lengthBand(4874.7)).toBe('long');
  });

  it('agrees with LENGTH_BANDS', () => {
    for (const km of [0, 12, 30, 150, 300, 301, 3000]) {
      const band = LENGTH_BANDS.find((b) => b.id === lengthBand(km))!;
      expect(km).toBeGreaterThanOrEqual(band.minKm);
      expect(km).toBeLessThanOrEqual(band.maxKm);
    }
  });
});

describe('names and validation', () => {
  it('labels countries and states', () => {
    expect(countryName('AU')).toBe('Australia');
    expect(countryName('nz')).toBe('New Zealand');
    expect(countryName('KE')).toBe('KE');
    expect(countryName(null)).toBe('Other');
    expect(stateName('AU', 'VIC')).toBe('Victoria');
    expect(stateName('NZ', 'SI')).toBe('South Island');
    expect(stateName('AU', 'XYZ')).toBe('XYZ');
    expect(stateName('AU', null)).toBeNull();
  });

  it('accepts any two-letter country', () => {
    expect(isValidCountry('AU')).toBe(true);
    expect(isValidCountry('ke')).toBe(true);
    expect(isValidCountry('AUS')).toBe(false);
    expect(isValidCountry('A1')).toBe(false);
    expect(isValidCountry(undefined)).toBe(false);
  });

  it('accepts only a state the country lists', () => {
    expect(isValidState('AU', 'NSW')).toBe(true);
    expect(isValidState('NZ', 'STI')).toBe(true);
    expect(isValidState('AU', 'SI')).toBe(false);
    expect(isValidState('AU', 'nsw')).toBe(false);
    expect(isValidState('US', 'CO')).toBe(false);
    expect(isValidState('KE', 'X')).toBe(false);
    expect(isValidState('AU', 42)).toBe(false);
  });

  it('treats no state as valid', () => {
    expect(isValidState('US', null)).toBe(true);
    expect(isValidState('JP', undefined)).toBe(true);
    expect(isValidState('AU', '')).toBe(true);
    expect(isValidState('KE', null)).toBe(true);
  });

  it('has unique codes', () => {
    const codes = COUNTRIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of COUNTRIES) {
      expect(c.code).toMatch(/^[A-Z]{2}$/);
      const states = c.states.map((s) => s.code);
      expect(new Set(states).size).toBe(states.length);
    }
  });
});

describe('matchesFilter', () => {
  const aawt = t('Australian Alps Walking Track', 688, 'AU', ['VIC', 'NSW', 'ACT']);

  it('matches everything with an empty filter', () => {
    expect(matchesFilter(aawt, {})).toBe(true);
    expect(matchesFilter(aawt, { query: '   ', bands: [] })).toBe(true);
  });

  it('searches name, country and state names, case-insensitively', () => {
    expect(matchesFilter(aawt, { query: 'alps' })).toBe(true);
    expect(matchesFilter(aawt, { query: 'AUSTRALIA' })).toBe(true);
    expect(matchesFilter(aawt, { query: 'capital territory' })).toBe(true);
    expect(matchesFilter(aawt, { query: 'tasmania' })).toBe(false);
  });

  it('searches extra text', () => {
    expect(matchesFilter(aawt, { query: 'aawt' })).toBe(false);
    expect(matchesFilter(aawt, { query: 'aawt' }, 'AAWT')).toBe(true);
  });

  it('filters by any of the chosen bands', () => {
    expect(matchesFilter(aawt, { bands: ['long'] })).toBe(true);
    expect(matchesFilter(aawt, { bands: ['day', 'multi'] })).toBe(false);
    expect(matchesFilter(aawt, { query: 'alps', bands: ['day'] })).toBe(false);
  });

  it('copes with a trail that has no country or states', () => {
    expect(matchesFilter(t('Loop', 10), { query: 'loop' })).toBe(true);
    expect(matchesFilter(t('Loop', 10, null, null), { query: 'other' })).toBe(true);
  });
});

describe('sortTrails', () => {
  const list = [t('beta', 20), t('Alpha', 100), t('gamma', 20)];

  it('sorts by name, ignoring case', () => {
    expect(sortTrails(list, 'name').map((x) => x.name)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('sorts by length, ties by name', () => {
    expect(sortTrails(list, 'length').map((x) => x.name)).toEqual(['beta', 'gamma', 'Alpha']);
    expect(sortTrails(list, 'length-desc').map((x) => x.name)).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('does not mutate its input', () => {
    const before = list.map((x) => x.name);
    sortTrails(list, 'name');
    expect(list.map((x) => x.name)).toEqual(before);
  });
});

describe('groupTrails', () => {
  const trails = [
    t('Te Araroa', 3056, 'NZ', ['NI', 'SI']),
    t('Overland Track', 62, 'AU', ['TAS']),
    t('Six Foot Track', 44, 'AU', ['NSW']),
    t('Great North Walk', 257, 'AU', ['NSW']),
    t('AAWT', 688, 'AU', ['VIC', 'NSW', 'ACT']),
    t('CDT', 4874, 'US', []),
    t('Shikoku', 154, 'jp', []),
    t('Mystery', 5),
    t('Kenya walk', 40, 'KE', null),
    t('Bhutan walk', 40, 'BT', null),
    t('Odd', 10, 'AU', ['ZZZ']),
    t('Stateless', 10, 'AU', []),
  ];

  it('orders countries as listed, unlisted by name, then Other', () => {
    const groups = groupTrails(trails);
    expect(groups.map((g) => g.code)).toEqual(['AU', 'NZ', 'JP', 'US', 'BT', 'KE', 'XX']);
    expect(groups.at(-1)!.name).toBe('Other');
    expect(groups[0].name).toBe('Australia');
  });

  it('groups by the first state, in the country’s state order', () => {
    const au = groupTrails(trails)[0];
    expect(au.states.map((s) => s.code)).toEqual(['NSW', 'VIC', 'TAS', 'ZZZ', null]);
    expect(au.states[0].name).toBe('New South Wales');
    expect(au.states[3].name).toBe('ZZZ');
    expect(au.states[4].name).toBeNull();
    expect(au.count).toBe(6);
  });

  it('sorts trails inside a group', () => {
    const nsw = groupTrails(trails, 'name')[0].states[0];
    expect(nsw.trails.map((x) => x.name)).toEqual(['Great North Walk', 'Six Foot Track']);
    const nswByLength = groupTrails(trails, 'length')[0].states[0];
    expect(nswByLength.trails.map((x) => x.name)).toEqual(['Six Foot Track', 'Great North Walk']);
  });

  it('puts a stateless country in one null group', () => {
    const us = groupTrails(trails).find((g) => g.code === 'US')!;
    expect(us.states).toEqual([{ code: null, name: null, trails: [trails[5]] }]);
    expect(us.count).toBe(1);
  });

  it('returns nothing for no trails', () => {
    expect(groupTrails([])).toEqual([]);
  });
});
