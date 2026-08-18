import { directionLabel, otherDirection } from '../direction-label';

describe('directionLabel', () => {
  const names = { default: 'Northbound', reversed: 'Southbound' };

  it('uses the trail direction names when present', () => {
    expect(directionLabel(names, 'default')).toBe('Northbound');
    expect(directionLabel(names, 'reversed')).toBe('Southbound');
  });

  it('falls back to generic labels when names are missing', () => {
    expect(directionLabel(undefined, 'default')).toBe('Forward');
    expect(directionLabel(undefined, 'reversed')).toBe('Reversed');
    expect(directionLabel({}, 'default')).toBe('Forward');
    expect(directionLabel({ default: '' }, 'default')).toBe('Forward');
  });
});

describe('otherDirection', () => {
  it('flips the direction', () => {
    expect(otherDirection('default')).toBe('reversed');
    expect(otherDirection('reversed')).toBe('default');
  });
});
