import {
  WATER_STATUS_OPTIONS,
  estimateEtaMinutes,
  formatEta,
  isWaterFamily,
  relativeDate,
  waterStatusMeta,
} from '../waypoint-detail';

describe('relativeDate', () => {
  const now = Date.parse('2026-07-29T12:00:00Z');

  it('renders coarse buckets', () => {
    expect(relativeDate('2026-07-29T11:59:30Z', now)).toBe('just now');
    expect(relativeDate('2026-07-29T11:45:00Z', now)).toBe('15 min ago');
    expect(relativeDate('2026-07-29T09:00:00Z', now)).toBe('3 h ago');
    expect(relativeDate('2026-07-27T12:00:00Z', now)).toBe('2 d ago');
  });

  it('falls back to an absolute date past a week', () => {
    expect(relativeDate('2026-07-03T12:00:00Z', now)).toBe('3 Jul');
    expect(relativeDate('2025-12-25T12:00:00Z', now)).toBe('25 Dec 2025');
  });

  it('returns empty for an unparseable timestamp', () => {
    expect(relativeDate('not-a-date', now)).toBe('');
  });
});

describe('water helpers', () => {
  it('detects the water family for the composer chips', () => {
    expect(isWaterFamily('water')).toBe(true);
    expect(isWaterFamily('spring')).toBe(true);
    expect(isWaterFamily('water-tank')).toBe(true);
    expect(isWaterFamily('campsite')).toBe(false);
    expect(isWaterFamily('town')).toBe(false);
  });

  it('maps a status to its label and theme token', () => {
    expect(waterStatusMeta('flowing')).toEqual({ label: 'Flowing', colorToken: 'waterFlowing' });
    expect(waterStatusMeta('low')).toEqual({ label: 'Low', colorToken: 'waterLow' });
    expect(waterStatusMeta('dry')).toEqual({ label: 'Dry', colorToken: 'waterDry' });
    expect(WATER_STATUS_OPTIONS).toEqual(['flowing', 'low', 'dry']);
  });
});

describe('eta', () => {
  it('estimates minutes ahead, null at/behind', () => {
    expect(estimateEtaMinutes(4, 4)).toBe(60);
    expect(estimateEtaMinutes(0)).toBeNull();
    expect(estimateEtaMinutes(-2)).toBeNull();
  });

  it('formats a human ETA', () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(0.4)).toBe('<1 min');
    expect(formatEta(30)).toBe('30 min');
    expect(formatEta(90)).toBe('1 h 30 min');
    expect(formatEta(120)).toBe('2 h');
  });
});
