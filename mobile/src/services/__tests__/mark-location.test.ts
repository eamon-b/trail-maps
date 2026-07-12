import {
  markedWaypointName,
  accuracyPreamble,
  isFixStale,
  STALE_FIX_MS,
} from '../mark-location';

describe('markedWaypointName', () => {
  it('formats as "Marked HH:MM" with zero padding', () => {
    expect(markedWaypointName(new Date(2026, 6, 11, 9, 5))).toBe('Marked 09:05');
    expect(markedWaypointName(new Date(2026, 6, 11, 14, 30))).toBe('Marked 14:30');
    expect(markedWaypointName(new Date(2026, 6, 11, 0, 0))).toBe('Marked 00:00');
  });
});

describe('accuracyPreamble', () => {
  it('returns null for a good fix (≤ 50 m) or unknown accuracy', () => {
    expect(accuracyPreamble(null)).toBeNull();
    expect(accuracyPreamble(8)).toBeNull();
    expect(accuracyPreamble(50)).toBeNull();
  });

  it('annotates a degraded fix', () => {
    expect(accuracyPreamble(120)).toBe('±120 m fix');
    expect(accuracyPreamble(75.6)).toBe('±76 m fix');
  });

  it('appends fix age when 15–60 s old and accuracy is annotated', () => {
    expect(accuracyPreamble(120, 32000)).toBe('±120 m fix, 32 s old');
    // Boundaries: 15 s and 60 s are inclusive
    expect(accuracyPreamble(120, 15000)).toBe('±120 m fix, 15 s old');
    expect(accuracyPreamble(120, 60000)).toBe('±120 m fix, 60 s old');
  });

  it('does not annotate age for a fresh fix (< 15 s)', () => {
    expect(accuracyPreamble(120, 5000)).toBe('±120 m fix');
    expect(accuracyPreamble(120, 0)).toBe('±120 m fix');
  });

  it('never annotates age when accuracy itself is not annotated (≤ 50 m)', () => {
    expect(accuracyPreamble(30, 40000)).toBeNull();
    expect(accuracyPreamble(null, 40000)).toBeNull();
  });
});

describe('isFixStale', () => {
  it('is false for a fresh fix', () => {
    const now = 1_000_000;
    expect(isFixStale(now - 1000, now)).toBe(false);
    expect(isFixStale(now - STALE_FIX_MS, now)).toBe(false); // exactly at threshold
  });

  it('is true once the fix is older than the stale window', () => {
    const now = 1_000_000;
    expect(isFixStale(now - (STALE_FIX_MS + 1), now)).toBe(true);
    expect(isFixStale(now - 5 * 60_000, now)).toBe(true);
  });
});
