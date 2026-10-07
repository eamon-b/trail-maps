import type { CommunityRouteDetail } from '@lib/community-types';

/** A route as the owner's list returns it. */
export function ownRoute(overrides: Partial<CommunityRouteDetail> = {}): CommunityRouteDetail {
  return {
    id: 'c_AAAAAAAAAAAAAAAA',
    name: 'Lake Loop',
    status: 'unverified',
    country: 'AU',
    state: 'VIC',
    lengthKm: 12.4,
    ascentM: 300,
    hasElevation: true,
    waypointCount: 3,
    bbox: [144, -38, 145, -37],
    start: { lat: -37.5, lon: 144.5 },
    submittedBy: 'Sam',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    verifiedAt: null,
    reviewed: true,
    trailUrl: 'https://data.test/community/v1/c_AAAAAAAAAAAAAAAA.abc.json',
    md5: 'abc',
    bytes: 1000,
    description: 'A gentle loop around the lake with two campsites.',
    credit: null,
    licence: 'CC0-1.0',
    checks: [{ id: 'shape', level: 'pass', message: 'The track is a single line.' }],
    isOwner: true,
    ...overrides,
  };
}
