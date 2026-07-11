import { markedWaypointName, accuracyPreamble } from '../mark-location';

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
});
