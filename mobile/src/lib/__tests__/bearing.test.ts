import {
  bearingBetween,
  cardinalDirection,
  formatBearing,
  relativeRotation,
  isHeadingUsable,
  MIN_SPEED_FOR_HEADING_MS,
  MAX_FIX_AGE_FOR_HEADING_MS,
} from '../bearing';

describe('bearingBetween', () => {
  it('returns 0 for due north', () => {
    expect(bearingBetween(-35, 138, -34, 138)).toBeCloseTo(0, 5);
  });

  it('returns 90 for due east', () => {
    expect(bearingBetween(0, 138, 0, 139)).toBeCloseTo(90, 1);
  });

  it('returns 180 for due south', () => {
    expect(bearingBetween(-34, 138, -35, 138)).toBeCloseTo(180, 5);
  });

  it('returns 270 for due west', () => {
    expect(bearingBetween(0, 139, 0, 138)).toBeCloseTo(270, 1);
  });

  it('returns a NE-quadrant bearing for a NE target', () => {
    const b = bearingBetween(-35, 138, -34.9, 138.1);
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThan(90);
  });
});

describe('cardinalDirection', () => {
  it('maps bearings to 16-wind names', () => {
    expect(cardinalDirection(0)).toBe('N');
    expect(cardinalDirection(45)).toBe('NE');
    expect(cardinalDirection(90)).toBe('E');
    expect(cardinalDirection(247)).toBe('WSW');
    expect(cardinalDirection(359)).toBe('N');
  });

  it('normalizes out-of-range inputs', () => {
    expect(cardinalDirection(405)).toBe('NE');
    expect(cardinalDirection(-90)).toBe('W');
  });
});

describe('formatBearing', () => {
  it('formats degrees + cardinal', () => {
    expect(formatBearing(247)).toBe('247° WSW');
  });
});

describe('relativeRotation (arrow rotation incl. wrap-around)', () => {
  it('is 0 when heading straight at the target', () => {
    expect(relativeRotation(90, 90)).toBe(0);
  });

  it('is positive when the target is to the right', () => {
    expect(relativeRotation(120, 90)).toBe(30);
  });

  it('is negative when the target is to the left', () => {
    expect(relativeRotation(60, 90)).toBe(-30);
  });

  it('handles wrap-around: heading 350°, target 10° → +20° (not -340°)', () => {
    expect(relativeRotation(10, 350)).toBe(20);
  });

  it('handles wrap-around the other way: heading 10°, target 350° → -20°', () => {
    expect(relativeRotation(350, 10)).toBe(-20);
  });

  it('maps the antipodal case to +180', () => {
    expect(relativeRotation(180, 0)).toBe(180);
  });
});

describe('isHeadingUsable (moving/stationary gating — decision 8)', () => {
  const now = 1_000_000;

  it('accepts a fresh fix while moving', () => {
    expect(isHeadingUsable(90, 1.4, now - 5_000, now)).toBe(true);
  });

  it('rejects standing still (speed ≤ 0.5 m/s)', () => {
    expect(isHeadingUsable(90, 0, now - 5_000, now)).toBe(false);
    expect(isHeadingUsable(90, MIN_SPEED_FOR_HEADING_MS, now - 5_000, now)).toBe(false);
  });

  it('rejects unknown speed', () => {
    expect(isHeadingUsable(90, null, now - 5_000, now)).toBe(false);
    expect(isHeadingUsable(90, undefined, now - 5_000, now)).toBe(false);
  });

  it('rejects a stale fix (≥ 60 s old)', () => {
    expect(isHeadingUsable(90, 1.4, now - MAX_FIX_AGE_FOR_HEADING_MS, now)).toBe(false);
    expect(isHeadingUsable(90, 1.4, null, now)).toBe(false);
  });

  it('rejects the -1 "course unknown" heading even with a fresh moving fix', () => {
    // expo-location reports coords.heading = -1 when course is unknown
    // (common on Android): a fictitious ~359° arrow is worse than none.
    expect(isHeadingUsable(-1, 1.4, now - 5_000, now)).toBe(false);
  });

  it('rejects a null/undefined heading', () => {
    expect(isHeadingUsable(null, 1.4, now - 5_000, now)).toBe(false);
    expect(isHeadingUsable(undefined, 1.4, now - 5_000, now)).toBe(false);
  });

  it('accepts heading 0 (due north is a valid course)', () => {
    expect(isHeadingUsable(0, 1.4, now - 5_000, now)).toBe(true);
  });

  it('accepts a near-360 heading (359.9)', () => {
    expect(isHeadingUsable(359.9, 1.4, now - 5_000, now)).toBe(true);
  });
});
