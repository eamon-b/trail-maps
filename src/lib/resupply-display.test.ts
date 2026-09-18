/**
 * The words the web and the phone share for a resupply option.
 *
 * The description cases used to be reachable only through the jsdom Resupply-tab
 * test; they live here now because the helper is platform-neutral and the
 * abbreviation rule is the part most likely to be broken by a "simplification".
 */

import { describe, it, expect } from 'vitest';
import { accessSummary, firstSentence, resupplySummaryText } from './resupply-display';
import type { ResupplySummary } from './resupply-plan';

const km = (value: number): string => `${value.toFixed(1)} km`;
const kg = (value: number): string => `${value.toFixed(1)} kg`;
/** What the phone would pass under an imperial unit setting. */
const mi = (value: number): string => `${(value * 0.621371).toFixed(1)} mi`;

describe('firstSentence', () => {
  it('stops at the first terminator', () => {
    expect(firstSentence('General store and post office. Closed Sundays.')).toBe(
      'General store and post office.',
    );
    expect(firstSentence('Is there water? Sometimes.')).toBe('Is there water?');
    expect(firstSentence('Closed! Ring ahead.')).toBe('Closed!');
  });

  it('does not cut the description short at a dotted abbreviation', () => {
    expect(firstSentence('Store beside U.S. 50 with a hiker box. Closed Mondays.')).toBe(
      'Store beside U.S. 50 with a hiker box.',
    );
    expect(firstSentence('Camp below Mt. Sonder. Water 200 m north.')).toBe(
      'Camp below Mt. Sonder.',
    );
    expect(firstSentence('Water approx. 3 km on. Treat it.')).toBe('Water approx. 3 km on.');
  });

  it('reads the prose out of a generator’s |-separated metadata', () => {
    expect(
      firstSentence('mi 1947.3 (SOBO mi 1947.3) | off. mi 1955.8 | CO | Leave the CDT here for Salida. Hitch east.'),
    ).toBe('Leave the CDT here for Salida.');
  });

  it('returns the whole text when nothing terminates it', () => {
    expect(firstSentence('Hitch east from the pass')).toBe('Hitch east from the pass');
    expect(firstSentence('  padded  ')).toBe('padded');
  });

  it('is empty for an empty or metadata-only description', () => {
    expect(firstSentence('')).toBe('');
    expect(firstSentence(' | | ')).toBe('');
  });
});

describe('accessSummary', () => {
  it('names the distance and how you get there', () => {
    expect(accessSummary({ offTrailKm: 22, accessMode: 'hitch' }, km)).toBe('22.0 km hitch');
    expect(accessSummary({ offTrailKm: 4.5, accessMode: 'shuttle' }, km)).toBe('4.5 km shuttle');
  });

  it('falls back to "off trail" when the mode is unknown or on-trail', () => {
    expect(accessSummary({ offTrailKm: 3 }, km)).toBe('3.0 km off trail');
    // An on-trail place with a distance is a contradiction in the data; the
    // distance is the thing the hiker walks, so it wins.
    expect(accessSummary({ offTrailKm: 3, accessMode: 'on-trail' }, km)).toBe('3.0 km off trail');
  });

  it('says "on trail" with no distance, and nothing at all when there is nothing to say', () => {
    expect(accessSummary({ accessMode: 'on-trail' }, km)).toBe('on trail');
    expect(accessSummary({}, km)).toBe('');
    expect(accessSummary({ offTrailKm: 0, accessMode: 'foot' }, km)).toBe('foot');
  });

  it('formats through the caller’s units', () => {
    expect(accessSummary({ offTrailKm: 22.5, accessMode: 'hitch' }, mi)).toBe('14.0 mi hitch');
  });
});

describe('resupplySummaryText', () => {
  const summary = (over: Partial<ResupplySummary> = {}): ResupplySummary => ({
    stops: 4,
    longestKm: 10,
    longestDays: 2,
    totalFoodKg: 3.4,
    hasData: true,
    ...over,
  });

  it('reads as the web datasheet subtitle does', () => {
    expect(resupplySummaryText(summary(), km, kg)).toBe(
      '4 stops · longest carry 10.0 km / 2 days · 3.4 kg food in total',
    );
  });

  it('is singular for one stop and one day', () => {
    expect(resupplySummaryText(summary({ stops: 1, longestDays: 1 }), km, kg)).toBe(
      '1 stop · longest carry 10.0 km / 1 day · 3.4 kg food in total',
    );
  });

  it('formats through the caller’s units', () => {
    expect(resupplySummaryText(summary(), mi, v => `${(v * 2.20462).toFixed(1)} lb`)).toBe(
      '4 stops · longest carry 6.2 mi / 2 days · 7.5 lb food in total',
    );
  });
});
