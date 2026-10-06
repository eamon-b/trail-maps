import { describe, expect, it } from 'vitest';
import { isUnchanged, storedElevation, type ClimateLocation } from './fetch-climate';

describe('storedElevation', () => {
  it('keeps an explicitly configured elevation, whatever the waypoint says', () => {
    // The regression: a configured correction was overwritten by the
    // waypoint's height when it differed from the API's by over 200 m.
    expect(storedElevation(820, 820, 1105)).toBe(820);
    expect(storedElevation(820, 780, undefined)).toBe(820);
  });

  it('prefers the waypoint height when the API is more than 200 m off and nothing is configured', () => {
    expect(storedElevation(undefined, 400, 1105)).toBe(1105);
    expect(storedElevation(undefined, 400, 550)).toBe(400);
    expect(storedElevation(undefined, 400, undefined)).toBe(400);
    expect(storedElevation(undefined, 400, 0)).toBe(400);
  });

  it('stores what --changed compares against, so a corrected location is reused next run', () => {
    const loc: ClimateLocation = { name: 'River camp', lat: -41.1, lon: 146.2, elevation: 820 };
    const stored = {
      name: loc.name,
      lat: loc.lat,
      lon: loc.lon,
      elevation: storedElevation(loc.elevation, 795, 1105),
      monthly: [],
    };
    expect(isUnchanged(loc, stored)).toBe(true);
  });
});
