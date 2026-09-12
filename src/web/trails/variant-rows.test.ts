/**
 * Route-variant rows in the Waypoints datasheet, driven through the real trail
 * viewer in jsdom (the same harness as waypoint-filter.test.ts: real markup,
 * real renderer, real event delegation, Leaflet no-ops without layout).
 *
 * What is worth pinning here is identity and wording. Alternates arrive from
 * CalTopo unnamed or sharing a name with their neighbour, so a row key built
 * from the name alone expanded the wrong route's detail; and a variant that
 * hangs off another alternate, or whose junction is a kilometre off the track,
 * has to say so rather than offer a bare km reading.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

const container = (): HTMLElement => {
  const node = document.getElementById('waypoints-container');
  if (!node) throw new Error('missing #waypoints-container');
  return node;
};

const variantRows = (): HTMLElement[] => [...container().querySelectorAll<HTMLElement>('tr.variant-expandable')];

/** The one detail panel currently open, flattened to a line of text. */
const openDetail = (): string => {
  const rows = [...container().querySelectorAll('tr.variant-detail-row')];
  expect(rows).toHaveLength(1);
  return (rows[0].textContent ?? '').replace(/\s+/g, ' ').trim();
};

function variant(overrides: Record<string, unknown>) {
  return {
    type: 'alternate' as const,
    distance: 6,
    elevation: { ascent: 100, descent: 80 },
    points: [
      { lat: -34.01, lon: 138.01, ele: 200 },
      { lat: -34.02, lon: 138.02, ele: 210 },
    ],
    ...overrides,
  };
}

function makeTrail(alternates: ReturnType<typeof variant>[]) {
  const points = Array.from({ length: 71 }, (_, i) => ({
    lat: -34 - i / 1000,
    lon: 138 + i / 1000,
    ele: 100,
    dist: i,
  }));

  return {
    config: { id: 'heysen', name: 'Test Trail', region: 'SA' },
    track: { points, totalDistance: 70, totalAscent: 1300, totalDescent: 1000 },
    waypoints: [
      {
        name: 'Trailhead',
        type: 'endpoint',
        lat: -34,
        lon: 138,
        elevation: 100,
        distance: 0,
        totalDistance: 0,
        ascent: 0,
        descent: 0,
        totalAscent: 0,
        totalDescent: 0,
        trackIndex: 0,
      },
    ],
    offTrailWaypoints: [],
    alternates,
    sideTrips: [],
  };
}

async function boot(trail: ReturnType<typeof makeTrail>): Promise<void> {
  const html = fs.readFileSync(path.join(ROOT, 'src/web/my-trail.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!DOCTYPE html>/i, '').replace(/<\/?html[^>]*>/gi, '');

  vi.resetModules();
  const { initTrailViewer } = await import('./trail-viewer');
  await initTrailViewer('heysen', trail as never);
}

beforeEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () =>
    new Proxy({}, { get: () => () => ({ addColorStop() {}, width: 0 }) });
});

describe('variant rows', () => {
  it('keys same-named and unnamed alternates apart, so each opens its own detail', async () => {
    await boot(
      makeTrail([
        variant({ name: 'Alternate', distance: 6, startDistance: 10, endDistance: 12 }),
        variant({ name: 'Alternate', distance: 9, startDistance: 20, endDistance: 22 }),
        variant({ name: '', distance: 4, startDistance: 30, endDistance: 32 }),
        variant({ name: '', distance: 7, startDistance: 40, endDistance: 42 }),
      ])
    );

    const rows = variantRows();
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map(row => row.dataset.variantKey)).size).toBe(4);

    // The second of a same-named pair, and an unnamed one, each open themselves
    // rather than the first row that happens to share their name.
    rows[1].click();
    expect(openDetail()).toContain('Distance: 9 km');
    expect(openDetail()).toContain('Branches at: 20.0 km');

    rows[3].click();
    expect(openDetail()).toContain('Distance: 7 km');
    expect(openDetail()).toContain('Branches at: 40.0 km');
  });

  it('names the parent alternate, and owns up to a junction short of the track', async () => {
    await boot(
      makeTrail([
        variant({ name: 'Parent Alternate', startDistance: 10, endDistance: 25 }),
        variant({
          name: 'Child Alternate',
          startDistance: 17.8,
          endDistance: 20,
          parent: { name: 'Parent Alternate', index: 0 },
        }),
        variant({
          name: 'Loose Alternate',
          startDistance: 30,
          endDistance: 34,
          startOffsetMeters: 1200,
          endOffsetMeters: 80,
        }),
      ])
    );

    const rows = variantRows();
    rows[1].click();
    expect(openDetail()).toContain('Branches off Parent Alternate at: 17.8 km');

    rows[2].click();
    expect(openDetail()).toContain('Branches at: 30.0 km (≈1.2 km from the trail)');
    // 80 m reads as "here", so the rejoin carries no caveat.
    expect(openDetail()).toContain('Rejoins: 34.0 km Show on map');
  });
});
