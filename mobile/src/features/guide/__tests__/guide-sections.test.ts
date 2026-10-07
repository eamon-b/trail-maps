import { buildGuideSections, regionSubtitle, type SectionableTrail } from '../guide-sections';

const T = (over: Partial<SectionableTrail> & { id: string }): SectionableTrail => ({
  name: over.id,
  lengthKm: 100,
  source: 'bundled',
  ...over,
});

const TRAILS: SectionableTrail[] = [
  T({ id: 'heysen', name: 'Heysen Trail', country: 'AU', states: ['SA'] }),
  T({ id: 'te_araroa', name: 'Te Araroa', country: 'NZ', states: ['NI', 'SI'] }),
  T({ id: 'aawt', name: 'Australian Alps Walking Track', country: 'AU', states: ['VIC', 'NSW', 'ACT'] }),
  T({ id: 'shikoku', name: 'Shikoku Henro', country: 'JP' }),
  T({ id: 'gamma', name: 'Gamma Way', source: 'remote', country: 'AU', states: ['NSW'] }),
  T({ id: 'nowhere', name: 'Unlabelled Trail' }),
  T({ id: 'c_1', name: 'Kiwi Loop', source: 'community', country: 'NZ', states: ['SI'] }),
  T({ id: 'c_2', name: 'Aussie Loop', source: 'community', country: 'AU', states: ['VIC'] }),
  T({ id: 'u_2', name: 'Newer import', source: 'imported' }),
  T({ id: 'u_1', name: 'Older import', source: 'imported' }),
];

const shape = (sections: ReturnType<typeof buildGuideSections>) =>
  sections.map((s) => [s.title, s.data.map((t) => t.id)]);

describe('buildGuideSections', () => {
  it('orders tiers: countries (curated), then Community, then Imported', () => {
    expect(shape(buildGuideSections(TRAILS, null))).toEqual([
      // NSW before VIC (the region order in trail-regions), state groups before
      // a trail with no state.
      ['Australia', ['gamma', 'aawt', 'heysen']],
      ['New Zealand', ['te_araroa']],
      ['Japan', ['shikoku']],
      ['Other', ['nowhere']],
      ['Community', ['c_2', 'c_1']],
      // Imports keep the order they came in (newest first).
      ['Imported', ['u_2', 'u_1']],
    ]);
  });

  it('lifts the current trail into "Hiking now" and out of its own section', () => {
    const sections = buildGuideSections(TRAILS, 'te_araroa');
    expect(shape(sections)[0]).toEqual(['Hiking now', ['te_araroa']]);
    expect(sections.find((s) => s.title === 'New Zealand')).toBeUndefined();
    expect(sections[0].kind).toBe('current');
  });

  it('ignores a current trail that is no longer listed', () => {
    expect(shape(buildGuideSections(TRAILS, 'u_deleted'))[0][0]).toBe('Australia');
  });

  it('filters every tier by name or region', () => {
    expect(shape(buildGuideSections(TRAILS, null, 'loop'))).toEqual([
      ['Community', ['c_2', 'c_1']],
    ]);
    expect(shape(buildGuideSections(TRAILS, null, 'south island'))).toEqual([
      ['New Zealand', ['te_araroa']],
      ['Community', ['c_1']],
    ]);
    expect(buildGuideSections(TRAILS, 'heysen', 'zzz')).toEqual([]);
  });
});

describe('regionSubtitle', () => {
  it('names a curated trail’s states', () => {
    expect(regionSubtitle(TRAILS[2])).toBe(
      'Victoria, New South Wales, Australian Capital Territory',
    );
    expect(regionSubtitle(TRAILS[3])).toBeNull();
  });

  it('names a community route’s country and state', () => {
    expect(regionSubtitle(TRAILS[6])).toBe('New Zealand · South Island');
  });

  it('is empty for an import', () => {
    expect(regionSubtitle(TRAILS[8])).toBeNull();
  });
});
