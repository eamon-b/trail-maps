/**
 * Pack reuse for imported guides.
 *
 * The geometry cases use injected candidates so the rule itself is pinned
 * independently of what happens to be bundled; one case runs against the real
 * bundled coverage table so the wiring (index order, buffer, JSON shape) is
 * exercised too.
 */

import {
  MIN_PACK_OVERLAP,
  bundledPackCandidates,
  offlinePackPlan,
  overlapRatio,
  pickPack,
  resetBundledPackCandidates,
  resolveOfflinePack,
  trailBounds,
  type PackCandidate,
} from '../offline-pack-resolver';
import { getTrailJson, listTrails } from '../trail-loader';

/** A 10°×10° pack centred on the origin, and a small one well to the east. */
const PACKS: PackCandidate[] = [
  { trailId: 'bigtrail', name: 'Big Trail', bounds: { west: 0, south: 0, east: 10, north: 10 } },
  { trailId: 'faraway', name: 'Far Away', bounds: { west: 100, south: 0, east: 110, north: 10 } },
];

/** A trail whose track spans the given box, as the resolver reads it. */
function trailSpanning(west: number, south: number, east: number, north: number) {
  return {
    track: {
      displayPoints: [
        { lat: south, lon: west },
        { lat: north, lon: east },
      ],
    },
  };
}

describe('overlapRatio', () => {
  it('is 1 for a fully contained box', () => {
    expect(overlapRatio(PACKS[0].bounds, { west: 1, south: 1, east: 2, north: 2 })).toBe(1);
  });

  it('is the covered share of the INNER box, not the outer', () => {
    // Half of a 2°-wide box hangs off the pack's western edge.
    expect(overlapRatio(PACKS[0].bounds, { west: -1, south: 1, east: 1, north: 2 })).toBeCloseTo(
      0.5,
    );
  });

  it('is 0 for a disjoint box', () => {
    expect(overlapRatio(PACKS[0].bounds, { west: 50, south: 50, east: 51, north: 51 })).toBe(0);
  });

  it('falls back to containment for a zero-area box', () => {
    // A single point, and a track running exactly north-south: both have no
    // area, so a ratio is meaningless and containment is the honest answer.
    expect(overlapRatio(PACKS[0].bounds, { west: 5, south: 5, east: 5, north: 5 })).toBe(1);
    expect(overlapRatio(PACKS[0].bounds, { west: 5, south: 1, east: 5, north: 9 })).toBe(1);
    expect(overlapRatio(PACKS[0].bounds, { west: 50, south: 5, east: 50, north: 5 })).toBe(0);
  });
});

describe('pickPack', () => {
  it('prefers a containing pack', () => {
    expect(pickPack({ west: 2, south: 2, east: 3, north: 3 }, PACKS)?.trailId).toBe('bigtrail');
  });

  it('accepts a partial overlap at or above the threshold', () => {
    // 9 of the 10 square degrees of a 10x1 box sit inside the pack.
    const covered = pickPack({ west: 1, south: 1, east: 11, north: 2 }, PACKS);
    expect(overlapRatio(PACKS[0].bounds, { west: 1, south: 1, east: 11, north: 2 })).toBeCloseTo(
      0.9,
    );
    expect(covered?.trailId).toBe('bigtrail');
  });

  it('rejects an overlap below the threshold', () => {
    // Only half the box is covered — well under MIN_PACK_OVERLAP.
    expect(MIN_PACK_OVERLAP).toBeGreaterThan(0.5);
    expect(pickPack({ west: 8, south: 1, east: 12, north: 2 }, PACKS)).toBeNull();
  });

  it('returns null when nothing is near', () => {
    expect(pickPack({ west: -50, south: -50, east: -49, north: -49 }, PACKS)).toBeNull();
  });

  it('picks the best-covered candidate when several qualify', () => {
    const box = { west: 1, south: 1, east: 3, north: 2 };
    const overlapping: PackCandidate[] = [
      { trailId: 'less', name: 'Less', bounds: { west: 0, south: 0, east: 2.7, north: 10 } },
      { trailId: 'most', name: 'Most', bounds: { west: 0, south: 0, east: 2.9, north: 10 } },
    ];
    // Neither contains the box, both clear the threshold (85% and 95%), and the
    // better-covered one wins even though it is second in the list.
    expect(overlapRatio(overlapping[0].bounds, box)).toBeCloseTo(0.85);
    expect(overlapRatio(overlapping[1].bounds, box)).toBeCloseTo(0.95);
    expect(pickPack(box, overlapping)?.trailId).toBe('most');
  });
});

describe('trailBounds', () => {
  it('reads displayPoints when present', () => {
    expect(trailBounds(trailSpanning(1, 2, 3, 4))).toEqual({
      west: 1,
      south: 2,
      east: 3,
      north: 4,
    });
  });

  it('falls back to full-resolution points', () => {
    const trail = { track: { displayPoints: [], points: [{ lat: 5, lon: 6 }] } };
    expect(trailBounds(trail)).toEqual({ west: 6, south: 5, east: 6, north: 5 });
  });

  it('is null for a trail with no geometry at all', () => {
    expect(trailBounds(null)).toBeNull();
    expect(trailBounds({})).toBeNull();
    expect(trailBounds({ track: { points: [] } })).toBeNull();
  });
});

describe('resolveOfflinePack', () => {
  it('gives a bundled guide its own pack without consulting candidates', () => {
    expect(resolveOfflinePack('heysen', null, [])).toEqual({ kind: 'own' });
  });

  it('lends a contained import the covering pack', () => {
    expect(resolveOfflinePack('u_abc', trailSpanning(2, 2, 3, 3), PACKS)).toEqual({
      kind: 'bundled',
      packTrailId: 'bigtrail',
      packName: 'Big Trail',
    });
  });

  it('gives an uncovered import nothing', () => {
    expect(resolveOfflinePack('u_abc', trailSpanning(-50, -50, -49, -49), PACKS)).toEqual({
      kind: 'none',
    });
  });

  it('gives an import with no geometry nothing, rather than throwing', () => {
    expect(resolveOfflinePack('u_abc', null, PACKS)).toEqual({ kind: 'none' });
    expect(resolveOfflinePack('u_abc', { track: { points: [] } }, PACKS)).toEqual({ kind: 'none' });
  });
});

describe('bundledPackCandidates', () => {
  beforeEach(resetBundledPackCandidates);
  afterAll(resetBundledPackCandidates);

  it('covers every bundled trail, in bundle order', () => {
    expect(bundledPackCandidates().map((c) => c.trailId)).toEqual(
      listTrails().map((t) => t.id),
    );
  });

  it('memoises the table', () => {
    expect(bundledPackCandidates()).toBe(bundledPackCandidates());
  });

  it('matches a short import taken from the middle of a real bundled track', () => {
    // A three-point "import" lifted straight off the Heysen: it is inside that
    // trail's own coverage by construction, and nowhere near any other.
    const heysen = getTrailJson('heysen');
    const points = heysen!.track.displayPoints;
    const mid = Math.floor(points.length / 2);
    const slice = points.slice(mid, mid + 3).map((p) => ({ lat: p.lat, lon: p.lon }));

    expect(resolveOfflinePack('u_heysen_slice', { track: { displayPoints: slice } })).toEqual({
      kind: 'bundled',
      packTrailId: 'heysen',
      packName: listTrails().find((t) => t.id === 'heysen')!.name,
    });
  });

  it('leaves an import on the other side of the world unmatched', () => {
    expect(resolveOfflinePack('u_alps', trailSpanning(6, 45, 7, 46))).toEqual({ kind: 'none' });
  });
});

describe('offlinePackPlan', () => {
  it('drives a bundled guide off its own id, with nothing to explain', () => {
    expect(offlinePackPlan({ kind: 'own' }, 'heysen')).toEqual({
      packTrailId: 'heysen',
      packAvailable: true,
      note: null,
    });
  });

  it('drives a borrowing import off the LENT pack id and names it', () => {
    const plan = offlinePackPlan(
      { kind: 'bundled', packTrailId: 'bibbulmun', packName: 'Bibbulmun Track' },
      'u_abc',
    );
    expect(plan.packTrailId).toBe('bibbulmun');
    expect(plan.packAvailable).toBe(true);
    expect(plan.note).toContain('Bibbulmun Track');
  });

  it('disables downloads for an uncovered import instead of erroring', () => {
    const plan = offlinePackPlan({ kind: 'none' }, 'u_abc');
    expect(plan.packTrailId).toBeNull();
    expect(plan.packAvailable).toBe(false);
    expect(plan.note).toMatch(/aren't available/);
  });
});
