/**
 * The text of the linking section: a code that can be read aloud, a countdown
 * that cannot go negative, and a device line that says why the phone has no
 * Remove button.
 */

import type { DeviceTokenSummary } from '@lib/comments-api-types';
import {
  deviceSubtitle,
  deviceTitle,
  formatCountdown,
  groupCode,
  isRemovable,
  secondsUntil,
  shortDate,
} from '../linked-browsers';

const NOW = Date.parse('2026-09-20T00:00:00Z');

function device(over: Partial<DeviceTokenSummary> = {}): DeviceTokenSummary {
  return {
    id: 'aaaaaaaaaaaa',
    kind: 'linked',
    label: null,
    createdAt: '2026-09-01T00:00:00Z',
    lastSeenAt: '2026-09-19T00:00:00Z',
    expiresAt: '2027-03-19T00:00:00Z',
    current: false,
    ...over,
  };
}

describe('groupCode', () => {
  it('splits eight characters into two groups', () => {
    expect(groupCode('ABCD2345')).toBe('ABCD 2345');
  });

  it('leaves a short or already-spaced code readable', () => {
    expect(groupCode('ABC')).toBe('ABC');
    expect(groupCode('ABCD 2345')).toBe('ABCD 2345');
  });
});

describe('the countdown', () => {
  it('counts whole seconds and never goes below zero', () => {
    expect(secondsUntil('2026-09-20T00:10:00Z', NOW)).toBe(600);
    expect(secondsUntil('2026-09-19T00:00:00Z', NOW)).toBe(0);
    expect(secondsUntil('not a date', NOW)).toBe(0);
  });

  it('formats as m:ss', () => {
    expect(formatCountdown(600)).toBe('10:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('device rows', () => {
  it('prefers the browser’s own label, and names the kind otherwise', () => {
    expect(deviceTitle(device({ label: 'Chrome on macOS' }))).toBe('Chrome on macOS');
    expect(deviceTitle(device({ label: '   ' }))).toBe('A browser');
    expect(deviceTitle(device({ kind: 'primary' }))).toBe('This phone');
  });

  it('says which row is the phone, and when a browser was last used', () => {
    expect(deviceSubtitle(device({ kind: 'primary', current: true, expiresAt: null }), NOW)).toContain(
      'This phone',
    );
    const linked = deviceSubtitle(device(), NOW);
    expect(linked).toContain('last used 19 Sep 2026');
    expect(linked).toContain('expires 19 Mar 2027');
  });

  it('says so when a linked token has already run out', () => {
    expect(deviceSubtitle(device({ expiresAt: '2026-01-01T00:00:00Z' }), NOW)).toContain(
      'expired 1 Jan 2026',
    );
  });

  it('falls back to the created date when there is nothing else to say', () => {
    expect(
      deviceSubtitle(device({ lastSeenAt: null, expiresAt: null }), NOW),
    ).toBe('added 1 Sep 2026');
  });

  it('offers Remove for a browser and never for the phone', () => {
    expect(isRemovable(device())).toBe(true);
    expect(isRemovable(device({ kind: 'primary' }))).toBe(false);
  });

  it('formats a date without Intl, and tolerates rubbish', () => {
    expect(shortDate('2026-12-05T10:00:00Z')).toMatch(/Dec 2026$/);
    expect(shortDate(null)).toBe('');
    expect(shortDate('nope')).toBe('');
  });
});
