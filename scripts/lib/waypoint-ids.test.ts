import { describe, it, expect } from 'vitest';
import {
  assignWaypointIds,
  stringifyRegistry,
  ID_PATTERN,
  MATCH_RADIUS_METERS,
  type WaypointRegistry,
  type WaypointForId,
} from './waypoint-ids';

/** Deep clone so a test's mutations never leak into another. */
function clone<T>(o: T): T {
  return JSON.parse(JSON.stringify(o));
}

/** Offset a coordinate north by roughly `metres` (≈111.32 km / degree lat). */
function movedNorth(lat: number, metres: number): number {
  return lat + metres / 111_320;
}

const TRAIL = 'demo';

describe('assignWaypointIds', () => {
  it('mints ids that satisfy the id pattern', () => {
    const registry: WaypointRegistry = {};
    const waypoints: WaypointForId[] = [
      { name: 'Waalegh Campsite', type: 'campsite', lat: -32.014203, lon: 116.257545 },
      { name: 'Some Water Tank', type: 'water-tank', lat: -32.1, lon: 116.3 },
    ];
    const ids = assignWaypointIds(TRAIL, waypoints, registry);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(id).toMatch(ID_PATTERN);
      expect(id.startsWith('w_')).toBe(true);
    }
    expect(new Set(ids).size).toBe(2);
    expect(registry[TRAIL]).toHaveLength(2);
  });

  it('(a) is stable across rebuilds: same input twice yields identical ids and no registry growth', () => {
    const waypoints: WaypointForId[] = [
      { name: 'Alpha Hut', type: 'hut', lat: -33.0, lon: 150.0 },
      { name: 'Bravo Camp', type: 'campsite', lat: -33.5, lon: 150.5 },
      { name: 'Charlie Water', type: 'water', lat: -34.0, lon: 151.0 },
    ];

    const registry: WaypointRegistry = {};
    const firstIds = assignWaypointIds(TRAIL, waypoints, registry);
    const registryAfterFirst = clone(registry);

    // Rebuild against the now-populated registry with identical input.
    const secondIds = assignWaypointIds(TRAIL, clone(waypoints), registry);

    expect(secondIds).toEqual(firstIds);
    // No new entries were appended.
    expect(registry[TRAIL]).toHaveLength(3);
    expect(registry).toEqual(registryAfterFirst);
    // Serialised form is byte-identical (stable git diff).
    expect(stringifyRegistry(registry)).toEqual(stringifyRegistry(registryAfterFirst));
  });

  it('(b) reuses the id when a waypoint drifts <100 m and is renamed', () => {
    const original: WaypointForId = {
      name: 'Old Name Hut',
      type: 'hut',
      lat: -33.0,
      lon: 150.0,
    };
    const registry: WaypointRegistry = {};
    const [mintedId] = assignWaypointIds(TRAIL, [original], registry);

    // Drift ~40 m north (well within the 100 m radius) and rename it.
    const drifted: WaypointForId = {
      name: 'Renamed Hut',
      type: 'hut',
      lat: movedNorth(-33.0, 40),
      lon: 150.0,
    };
    const [reusedId] = assignWaypointIds(TRAIL, [drifted], registry);

    expect(reusedId).toBe(mintedId);
    // No new entry; the stored name/lat drifted to current values.
    expect(registry[TRAIL]).toHaveLength(1);
    expect(registry[TRAIL][0].name).toBe('Renamed Hut');
    expect(registry[TRAIL][0].lat).toBeCloseTo(drifted.lat, 6);
  });

  it('does NOT reuse the id when a waypoint drifts beyond 100 m', () => {
    const registry: WaypointRegistry = {};
    const [firstId] = assignWaypointIds(
      TRAIL,
      [{ name: 'Far Hut', type: 'hut', lat: -33.0, lon: 150.0 }],
      registry,
    );
    // Move ~250 m north — outside the match radius, so a new id is minted.
    const [secondId] = assignWaypointIds(
      TRAIL,
      [{ name: 'Far Hut', type: 'hut', lat: movedNorth(-33.0, 250), lon: 150.0 }],
      registry,
    );
    expect(secondId).not.toBe(firstId);
    expect(registry[TRAIL]).toHaveLength(2);
  });

  it('does NOT reuse across different types even when co-located', () => {
    const registry: WaypointRegistry = {};
    const [hutId] = assignWaypointIds(
      TRAIL,
      [{ name: 'Junction', type: 'hut', lat: -33.0, lon: 150.0 }],
      registry,
    );
    const [waterId] = assignWaypointIds(
      TRAIL,
      [{ name: 'Junction', type: 'water', lat: -33.0, lon: 150.0 }],
      registry,
    );
    expect(waterId).not.toBe(hutId);
    expect(registry[TRAIL]).toHaveLength(2);
  });

  it('(c) throws when two built waypoints resolve to the same sole registry entry', () => {
    // Seed the registry with a single entry.
    const registry: WaypointRegistry = {};
    assignWaypointIds(
      TRAIL,
      [{ name: 'Shared Camp', type: 'campsite', lat: -33.0, lon: 150.0 }],
      registry,
    );

    // Two built waypoints both fall within 100 m of that one entry.
    const twoWaypoints: WaypointForId[] = [
      { name: 'Shared Camp', type: 'campsite', lat: -33.0, lon: 150.0 },
      { name: 'Shared Camp', type: 'campsite', lat: movedNorth(-33.0, 30), lon: 150.0 },
    ];
    expect(() => assignWaypointIds(TRAIL, twoWaypoints, registry)).toThrow(
      /Ambiguous waypoint identity/,
    );
  });

  it('two genuinely-distinct nearby waypoints each mint their own id on a first build', () => {
    // Both within the match radius, same type, but registry starts empty, so
    // there is no pre-existing entry to be ambiguous about — each mints.
    const registry: WaypointRegistry = {};
    const ids = assignWaypointIds(
      TRAIL,
      [
        { name: 'Big River 1', type: 'campsite', lat: -36.0, lon: 147.0 },
        { name: 'Big River 2', type: 'campsite', lat: movedNorth(-36.0, 30), lon: 147.0 },
      ],
      registry,
    );
    expect(ids[0]).not.toBe(ids[1]);
    expect(registry[TRAIL]).toHaveLength(2);
    // And they stay stable / 1:1 on rebuild (no throw).
    const rebuilt = assignWaypointIds(
      TRAIL,
      [
        { name: 'Big River 1', type: 'campsite', lat: -36.0, lon: 147.0 },
        { name: 'Big River 2', type: 'campsite', lat: movedNorth(-36.0, 30), lon: 147.0 },
      ],
      registry,
    );
    expect(rebuilt).toEqual(ids);
    expect(registry[TRAIL]).toHaveLength(2);
  });

  it('(d) registry is append-only: a removed waypoint keeps its entry', () => {
    const registry: WaypointRegistry = {};
    const [keepId, dropId] = assignWaypointIds(
      TRAIL,
      [
        { name: 'Kept Hut', type: 'hut', lat: -33.0, lon: 150.0 },
        { name: 'Retired Hut', type: 'hut', lat: -34.0, lon: 151.0 },
      ],
      registry,
    );
    expect(registry[TRAIL]).toHaveLength(2);

    // Rebuild with the second waypoint removed from the source data.
    const ids = assignWaypointIds(
      TRAIL,
      [{ name: 'Kept Hut', type: 'hut', lat: -33.0, lon: 150.0 }],
      registry,
    );
    expect(ids).toEqual([keepId]);
    // The retired waypoint's entry survives (never deleted).
    expect(registry[TRAIL]).toHaveLength(2);
    expect(registry[TRAIL].some((e) => e.id === dropId)).toBe(true);
  });

  it('(e) extends to 12 hex chars when the 8-char mint collides with an existing entry', () => {
    // Compute what a lone waypoint WOULD mint against an empty registry.
    const probe: WaypointRegistry = {};
    const wp: WaypointForId = { name: 'Colliding', type: 'hut', lat: -33.12345, lon: 150.6789 };
    const [wouldMint] = assignWaypointIds(TRAIL, [wp], probe);
    expect(wouldMint).toMatch(/^w_[0-9a-f]{8}$/);

    // Seed a *different* waypoint's entry whose id equals that would-be mint,
    // forcing the collision path. It is a different type/location so it is not
    // a match candidate for `wp`.
    const registry: WaypointRegistry = {
      [TRAIL]: [
        { id: wouldMint, name: 'Decoy', type: 'water', lat: 10, lon: 10 },
      ],
    };
    const [extendedId] = assignWaypointIds(TRAIL, [wp], registry);

    expect(extendedId).not.toBe(wouldMint);
    expect(extendedId).toMatch(/^w_[0-9a-f]{12}$/);
    // The 8-char form is a prefix of the 12-char form (same sha1).
    expect(extendedId.startsWith(wouldMint)).toBe(true);
    expect(registry[TRAIL]).toHaveLength(2);
  });

  it('scopes ids per trail in the registry', () => {
    const registry: WaypointRegistry = {};
    assignWaypointIds('trail-a', [{ name: 'X', type: 'hut', lat: -33, lon: 150 }], registry);
    assignWaypointIds('trail-b', [{ name: 'X', type: 'hut', lat: -33, lon: 150 }], registry);
    expect(Object.keys(registry).sort()).toEqual(['trail-a', 'trail-b']);
    // Same coords/type/name but different trailId → different mint basis → different id.
    expect(registry['trail-a'][0].id).not.toBe(registry['trail-b'][0].id);
  });

  it('MATCH_RADIUS_METERS is 100', () => {
    expect(MATCH_RADIUS_METERS).toBe(100);
  });
});

describe('stringifyRegistry', () => {
  it('sorts trails alphabetically and entries by id, with trailing newline', () => {
    const registry: WaypointRegistry = {
      zebra: [
        { id: 'w_ffff0002', name: 'B', type: 'hut', lat: 1, lon: 2 },
        { id: 'w_ffff0001', name: 'A', type: 'hut', lat: 3, lon: 4 },
      ],
      alpha: [{ id: 'w_00000001', name: 'C', type: 'water', lat: 5, lon: 6 }],
    };
    const out = stringifyRegistry(registry);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed)).toEqual(['alpha', 'zebra']);
    expect(parsed.zebra.map((e: { id: string }) => e.id)).toEqual([
      'w_ffff0001',
      'w_ffff0002',
    ]);
    // Fixed key order per entry.
    expect(Object.keys(parsed.zebra[0])).toEqual(['id', 'name', 'type', 'lat', 'lon']);
  });

  it('is deterministic regardless of input key/entry order', () => {
    const a: WaypointRegistry = {
      t: [
        { id: 'w_2', name: 'B', type: 'hut', lat: 1, lon: 2 },
        { id: 'w_1', name: 'A', type: 'hut', lat: 3, lon: 4 },
      ],
    };
    const b: WaypointRegistry = {
      t: [
        { id: 'w_1', name: 'A', type: 'hut', lat: 3, lon: 4 },
        { id: 'w_2', name: 'B', type: 'hut', lat: 1, lon: 2 },
      ],
    };
    expect(stringifyRegistry(a)).toEqual(stringifyRegistry(b));
  });
});
