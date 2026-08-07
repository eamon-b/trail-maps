/**
 * The card a variant tap opens: it has to name the class, carry the numbers in
 * the user's units, and offer a way out.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { VariantInfoCard } from '../VariantInfoCard';
import { TRACK_COLORS } from '../map-style';
import { variantInfo } from '../variant-info';
import type { MapVariant } from '../map-geojson';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const ALTERNATE: MapVariant = {
  name: 'Alternative High Route',
  distance: 5,
  elevation: { ascent: 536, descent: 511 },
  startDistance: 54.81,
  endDistance: 58.78,
  waypoints: [{}],
};

const SIDE_TRIP: MapVariant = {
  name: 'Mt Sonder Summit (return)',
  distance: 14.7,
  elevation: { ascent: 973, descent: 962 },
  startDistance: 215.83,
};

const render = (props: React.ComponentProps<typeof VariantInfoCard>): ReactTestRenderer => {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<VariantInfoCard {...props} />);
  });
  return tree;
};

/** Rendered text, in tree order. */
function texts(tree: ReactTestRenderer): string[] {
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

describe('VariantInfoCard', () => {
  it('reads out an alternate: class, name, length, gain/loss, both junctions', () => {
    const info = variantInfo(ALTERNATE, 'alternate', 'alternate-0');
    expect(texts(render({ info, unit: 'km', onDismiss: jest.fn() }))).toEqual([
      'Alternate',
      'Alternative High Route',
      '✕',
      '5.0 km',
      '+536 m · −511 m',
      'Branches at 54.8 km · Rejoins at 58.8 km',
      '1 waypoint',
    ]);
  });

  it('reads out a side trip as out-and-back, and omits an empty waypoint list', () => {
    const info = variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0');
    expect(texts(render({ info, unit: 'km', onDismiss: jest.fn() }))).toEqual([
      'Side trip',
      'Mt Sonder Summit (return)',
      '✕',
      '14.7 km',
      '+973 m · −962 m',
      'Branches at 215.8 km · out-and-back',
    ]);
  });

  it('follows the units setting', () => {
    const info = variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0');
    const shown = texts(render({ info, unit: 'mi', onDismiss: jest.fn() }));
    expect(shown).toContain('9.1 mi');
    expect(shown).toContain('+3,192 ft · −3,156 ft');
    expect(shown).toContain('Branches at 134.1 mi · out-and-back');
  });

  it('drops rows the data cannot fill instead of showing blanks', () => {
    const info = variantInfo({ name: 'Unmeasured spur' }, 'side-trip', 'side-trip-1');
    expect(texts(render({ info, unit: 'km', onDismiss: jest.fn() }))).toEqual([
      'Side trip',
      'Unmeasured spur',
      '✕',
    ]);
  });

  it('swatches the class in the same colour the map paints the line', () => {
    const alternate = JSON.stringify(
      render({
        info: variantInfo(ALTERNATE, 'alternate', 'alternate-0'),
        unit: 'km',
        onDismiss: jest.fn(),
      }).toJSON(),
    );
    expect(alternate).toContain(TRACK_COLORS.alternate);
    expect(alternate).not.toContain(TRACK_COLORS.sideTrip);

    const sideTrip = JSON.stringify(
      render({
        info: variantInfo(SIDE_TRIP, 'side-trip', 'side-trip-0'),
        unit: 'km',
        onDismiss: jest.fn(),
      }).toJSON(),
    );
    expect(sideTrip).toContain(TRACK_COLORS.sideTrip);
  });

  it('dismisses on the close button', () => {
    const onDismiss = jest.fn();
    const tree = render({
      info: variantInfo(ALTERNATE, 'alternate', 'alternate-0'),
      unit: 'km',
      onDismiss,
    });
    const close = tree.root.findAll(
      (n) => (n.props as { accessibilityLabel?: string }).accessibilityLabel === 'Dismiss route details',
    )[0];
    act(() => {
      (close.props as { onPress: () => void }).onPress();
    });
    expect(onDismiss).toHaveBeenCalled();
  });
});
