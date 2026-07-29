import { spacing, touchTarget } from '../spacing';

describe('Design Tokens — Spacing', () => {
  it('follows 4pt base grid', () => {
    const values = Object.values(spacing);
    for (const val of values) {
      expect(val % 4).toBe(0);
    }
  });

  it('has ascending values', () => {
    const values = Object.values(spacing);
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1]);
    }
  });

  it('minimum touch target is 44pt', () => {
    expect(touchTarget.min).toBe(44);
  });

  it('field touch target is 56pt for primary field actions', () => {
    expect(touchTarget.field).toBe(56);
  });
});
