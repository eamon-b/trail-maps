/**
 * sectionOptions: waypoints bracketed by synthetic termini so the default
 * section is always the whole track and both trail ends are reachable.
 */

import { sectionOptions, TERMINUS_EPSILON_KM } from '../plan-section';
import type { TrailJson } from '../../../services/trail-assets';

function makeTrail(waypointKms: number[], totalDistance: number): TrailJson {
  return {
    config: { name: 'Test Trail' },
    track: { totalDistance },
    waypoints: waypointKms.map((km, i) => ({
      id: `wp_${i}`,
      name: `WP ${km}`,
      type: 'campsite',
      totalDistance: km,
    })),
  } as unknown as TrailJson;
}

describe('sectionOptions', () => {
  it('adds no synthetics when waypoints bracket the termini exactly (Cape to Cape)', () => {
    const trail = makeTrail([0, 40, 123.4], 123.4);
    const opts = sectionOptions(trail);
    expect(opts).toHaveLength(3);
    expect(opts[0].km).toBe(0);
    expect(opts[opts.length - 1].km).toBe(123.4);
    // No synthetic ids present.
    expect(opts.some((o) => o.id === 'section-start' || o.id === 'section-end')).toBe(false);
  });

  it('adds both synthetics when waypoints fall short of both termini (AAWT)', () => {
    const trail = makeTrail([13.2, 350, 680.1], 688.3);
    const opts = sectionOptions(trail);
    expect(opts).toHaveLength(5);
    expect(opts[0]).toMatchObject({ id: 'section-start', name: 'Trail start', km: 0 });
    expect(opts[opts.length - 1]).toMatchObject({ id: 'section-end', name: 'Trail end', km: 688.3 });
    // Default section spans the whole track.
    expect(opts[0].km).toBe(0);
    expect(opts[opts.length - 1].km).toBe(688.3);
  });

  it('treats a terminus within epsilon as already bracketed (no synthetic)', () => {
    const eps = TERMINUS_EPSILON_KM / 2;
    const trail = makeTrail([eps, 50, 100 - eps], 100);
    const opts = sectionOptions(trail);
    expect(opts).toHaveLength(3);
    expect(opts.some((o) => o.id === 'section-start' || o.id === 'section-end')).toBe(false);
  });

  it('flips which synthetic is added with direction (asymmetric trail)', () => {
    // Forward: a waypoint AT km 0, last short of the end -> only an end synthetic.
    const forward = makeTrail([0, 300, 600], 688.3);
    const fOpts = sectionOptions(forward);
    expect(fOpts.some((o) => o.id === 'section-start')).toBe(false);
    expect(fOpts.some((o) => o.id === 'section-end')).toBe(true);

    // Reversed (guide trail is direction-applied): km' = total - km, re-sorted.
    // The old start (km 0) becomes the end AT totalDistance, and the old end
    // (600) becomes 88.3 -> short of the start, so only a start synthetic.
    const reversed = makeTrail([688.3 - 600, 688.3 - 300, 688.3 - 0], 688.3);
    const rOpts = sectionOptions(reversed);
    expect(rOpts.some((o) => o.id === 'section-start')).toBe(true);
    expect(rOpts.some((o) => o.id === 'section-end')).toBe(false);
  });

  it('brackets an empty waypoint list to the two termini', () => {
    const trail = makeTrail([], 42);
    const opts = sectionOptions(trail);
    expect(opts).toHaveLength(2);
    expect(opts[0].km).toBe(0);
    expect(opts[1].km).toBe(42);
  });
});
