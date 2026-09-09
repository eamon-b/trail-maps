/**
 * The map key only advertises track classes the trail actually draws, and it
 * labels them with the same colours the map paints.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { TrackLegend } from '../TrackLegend';
import { trackColors } from '../map-style';

// Chrome colours come from the theme; track colours must not, so a
// single-colour theme stub also proves the swatches bypass it. `isDark` is the
// one thing the legend does read, because the map repaints the tracks in dark
// mode and the key has to follow.
let mockIsDark = false;
jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }), isDark: mockIsDark }),
}));

beforeEach(() => {
  mockIsDark = false;
});

const render = (props: React.ComponentProps<typeof TrackLegend>): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<TrackLegend {...props} />);
  });
  return tree;
};

/** Rendered text, in tree order (the ambient test-renderer types omit types). */
function labels(tree: ReactTestRenderer): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      found.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const children = (node as { children?: unknown } | null)?.children;
    if (children) walk(children);
  };
  walk(tree.toJSON());
  return found;
}

/** The whole rendered tree as text, for "is this colour anywhere" assertions. */
const rendered = (tree: ReactTestRenderer) => JSON.stringify(tree.toJSON());

describe('TrackLegend', () => {
  it('renders nothing when there are no alternates, side trips or POIs', () => {
    expect(render({}).toJSON()).toBeNull();
    expect(
      render({ hasAlternates: false, hasSideTrips: false, hasPois: false }).toJSON(),
    ).toBeNull();
  });

  it('lists only the classes present on the trail', () => {
    expect(labels(render({ hasAlternates: true }))).toEqual(['Trail', 'Alternate']);
    expect(labels(render({ hasSideTrips: true }))).toEqual(['Trail', 'Side trip']);
    expect(labels(render({ hasAlternates: true, hasSideTrips: true }))).toEqual([
      'Trail',
      'Alternate',
      'Side trip',
    ]);
  });

  it('names the OSM points of interest only while they are drawn', () => {
    // The POI row earns its place the same way the variant rows do: it appears
    // when there is something on the map the walker could otherwise mistake for
    // a curated waypoint, and only then.
    expect(labels(render({ hasPois: true }))).toEqual(['Trail', 'Points of interest']);
    expect(labels(render({ hasAlternates: true, hasPois: true }))).toEqual([
      'Trail',
      'Alternate',
      'Points of interest',
    ]);
    expect(labels(render({ hasAlternates: true }))).not.toContain('Points of interest');
  });

  it('marks POIs with a hollow ring rather than a line swatch', () => {
    // Six category colours means no single hue identifies them; the shape does
    // — a ring around a hole, against the waypoint badge's filled disc.
    const json = rendered(render({ hasPois: true }));
    expect(json).toContain('"borderWidth":1.5');
    // ...and it is a ring, not another bar: the line swatches have no border.
    expect(rendered(render({ hasAlternates: true }))).not.toContain('"borderWidth":1.5');
  });

  it('swatches use the map’s own track colours', () => {
    const json = rendered(render({ hasAlternates: true, hasSideTrips: true }));
    const track = trackColors('light');
    expect(json).toContain(track.main);
    expect(json).toContain(track.alternate);
    expect(json).toContain(track.sideTrip);
  });

  it('follows the map into dark mode instead of naming colours it no longer paints', () => {
    mockIsDark = true;
    const json = rendered(render({ hasAlternates: true, hasSideTrips: true }));
    const dark = trackColors('dark');
    expect(json).toContain(dark.main);
    expect(json).toContain(dark.alternate);
    expect(json).toContain(dark.sideTrip);
    expect(json).not.toContain(trackColors('light').main);
  });
});
