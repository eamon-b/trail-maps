import {
  WATER_STATUS_OPTIONS,
  duplicatePoisFor,
  estimateEtaMinutes,
  formatEta,
  isWaterFamily,
  relativeDate,
  tripToWaypoint,
  waterStatusMeta,
} from '../waypoint-detail';
import type { TrailPOI } from '@lib/trail-types';

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

describe('duplicatePoisFor', () => {
  function poi(id: number, overrides: Partial<TrailPOI> = {}): TrailPOI {
    return {
      id,
      type: 'node',
      category: 'camping',
      lat: -35,
      lon: 138,
      name: `POI ${id}`,
      tags: {},
      distanceAlongTrail: 12,
      distanceFromTrail: 0.01,
      ...overrides,
    };
  }

  it('returns the POIs flagged against this waypoint, in order', () => {
    const trail = {
      pois: [
        poi(1, { duplicateOf: 'w_other' }),
        poi(2, { duplicateOf: 'w_hut' }),
        poi(3),
        poi(4, { duplicateOf: 'w_hut' }),
      ],
    };
    expect(duplicatePoisFor(trail, 'w_hut').map((p) => p.id)).toEqual([2, 4]);
  });

  it('is empty when nothing was flagged against the waypoint', () => {
    expect(duplicatePoisFor({ pois: [poi(1), poi(2, { duplicateOf: 'w_a' })] }, 'w_b')).toEqual([]);
  });

  it('is empty for a waypoint with no stable id', () => {
    expect(duplicatePoisFor({ pois: [poi(1, { duplicateOf: 'w_hut' })] }, undefined)).toEqual([]);
  });

  it('is empty for a trail that was never enriched', () => {
    // An absent `pois` means "never fetched", not "found nothing".
    expect(duplicatePoisFor({}, 'w_hut')).toEqual([]);
  });
});

describe('tripToWaypoint', () => {
  // 0 → 1 km climbs 100 m, 1 → 2 km drops 40 m.
  const track = [
    { lat: 0, lon: 0, dist: 0, ele: 100 },
    { lat: 0, lon: 0, dist: 1, ele: 200 },
    { lat: 0, lon: 0, dist: 2, ele: 160 },
  ];

  it('measures distance, climb and time to a waypoint ahead', () => {
    const trip = tripToWaypoint(0, 2, track, 4);
    expect(trip).toMatchObject({ direction: 'ahead', distanceKm: 2, ascentM: 100, descentM: 40 });
    expect(trip!.etaMinutes).toBeGreaterThan(30); // 2 km at 4 km/h, plus the climb
  });

  it('swaps climb and descent for a waypoint walked back to', () => {
    expect(tripToWaypoint(2, 0, track, 4)).toMatchObject({
      direction: 'behind',
      distanceKm: 2,
      ascentM: 40,
      descentM: 100,
    });
  });

  it('is null when the hiker is already there', () => {
    expect(tripToWaypoint(1, 1.02, track, 4)).toBeNull();
  });

  it('does not climb across a route break', () => {
    // The step into index 1 is a ferry: only the 1 → 2 km descent is walked.
    expect(tripToWaypoint(0, 2, track, 4, new Set([1]))).toMatchObject({
      ascentM: 0,
      descentM: 40,
    });
  });
});
