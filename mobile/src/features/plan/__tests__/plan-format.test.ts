import { formatHours, formatDays, formatFoodWeight } from '../plan-format';

describe('plan-format', () => {
  it('formats hours to one decimal with a unit', () => {
    expect(formatHours(8)).toBe('8.0 h');
    expect(formatHours(7.25)).toBe('7.3 h');
  });

  it('formats day counts with singular/plural', () => {
    expect(formatDays(1)).toBe('≈ 1 day');
    expect(formatDays(3)).toBe('≈ 3 days');
  });

  it('formats food weight in kg to one decimal', () => {
    expect(formatFoodWeight(2)).toBe('2.0 kg');
    expect(formatFoodWeight(1.36)).toBe('1.4 kg');
  });
});
