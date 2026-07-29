import { formatDistance, convertDistance } from '@lib/format-distance';

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
