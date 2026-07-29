import {
  formatDistance,
  convertDistance,
  convertElevation,
  formatElevation,
} from '@lib/format-distance';

describe('formatDistance', () => {
  it('formats kilometres with a suffix', () => {
    expect(formatDistance(688.3, 'km')).toBe('688.3 km');
  });

  it('converts and formats miles', () => {
    // 688.3 km / 1.609344 ≈ 427.69 mi
    expect(formatDistance(688.3, 'mi')).toBe('427.7 mi');
  });

  it('honours the decimals option', () => {
    expect(formatDistance(5, 'km', { decimals: 0 })).toBe('5 km');
    expect(formatDistance(5, 'km', { decimals: 2 })).toBe('5.00 km');
  });

  it('can omit the unit suffix', () => {
    expect(formatDistance(10, 'km', { withUnit: false })).toBe('10.0');
  });

  it('treats nullish input as zero', () => {
    // @ts-expect-error exercising defensive coercion
    expect(formatDistance(undefined, 'km')).toBe('0.0 km');
  });

  it('convertDistance round-trips km unchanged', () => {
    expect(convertDistance(42, 'km')).toBe(42);
    expect(convertDistance(1.609344, 'mi')).toBeCloseTo(1, 5);
  });
});

describe('convertElevation', () => {
  it('leaves metres unchanged for metric', () => {
    expect(convertElevation(389, 'km')).toBe(389);
  });

  it('converts metres to feet for imperial', () => {
    expect(convertElevation(389, 'mi')).toBeCloseTo(1276.25, 1);
  });

  it('coerces nullish input to zero', () => {
    // @ts-expect-error exercising defensive coercion
    expect(convertElevation(undefined, 'mi')).toBe(0);
  });
});

describe('formatElevation', () => {
  it('formats metres for metric', () => {
    expect(formatElevation(389, 'km')).toBe('389 m');
  });

  it('formats feet with a thousands separator for imperial', () => {
    expect(formatElevation(389, 'mi')).toBe('1,276 ft');
  });

  it('groups large metric values', () => {
    expect(formatElevation(2000, 'km')).toBe('2,000 m');
  });

  it('handles zero and below without artefacts', () => {
    expect(formatElevation(0, 'km')).toBe('0 m');
    expect(formatElevation(-3, 'km')).toBe('-3 m');
  });
});
