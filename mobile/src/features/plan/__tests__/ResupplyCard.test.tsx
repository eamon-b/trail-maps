/**
 * The legs card. Two things worth asserting: the three "no legs" states say
 * three different things (no towns on the trail, none ticked, none in this
 * section — a hiker acts differently on each), and a leg shows the climb and
 * the day it lands on, which the old gap-based card could not.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { ResupplyLeg } from '@lib/resupply-plan';
import { ResupplyCard } from '../ResupplyCard';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('');
}

function leg(over: Partial<ResupplyLeg> = {}): ResupplyLeg {
  return {
    fromName: 'Trail Start',
    toName: 'Salida / Poncha Springs',
    fromKm: 0,
    toKm: 148.2,
    distanceKm: 148.2,
    estimatedDays: 6,
    isLong: true,
    ascentM: 5120,
    descentM: 4870,
    estimatedHours: 44.6,
    food: { weightGrams: 4080, weightKg: 4.1, days: 6 },
    ...over,
  };
}

function render(props: Partial<React.ComponentProps<typeof ResupplyCard>> = {}) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ResupplyCard legs={[]} hasOptions={false} stopCount={0} units="km" {...props} />,
    );
  });
  return tree;
}

describe('ResupplyCard empty states', () => {
  it('says the trail has no resupply at all', () => {
    expect(allText(render())).toContain('No towns or resupply points on this trail.');
  });

  it('says nothing is ticked when the trail has options', () => {
    const text = allText(render({ hasOptions: true, stopCount: 0 }));
    expect(text).toContain('No resupply stops ticked.');
  });

  it('says the ticked stops are all outside this section', () => {
    const text = allText(render({ hasOptions: true, stopCount: 3 }));
    expect(text).toContain('No ticked resupply stops in this section.');
  });
});

describe('ResupplyCard legs', () => {
  it('shows the route, distance, climb, days and food', () => {
    const text = allText(render({ legs: [leg()], hasOptions: true, stopCount: 1 }));
    expect(text).toContain('Trail Start → Salida / Poncha Springs');
    expect(text).toContain('148.2 km · +5,120 m / −4,870 m · ≈ 6 days · 4.1 kg food');
    expect(text).toContain('Long carry');
  });

  it('shows the arrival day only when the camp plan gave one', () => {
    const without = allText(render({ legs: [leg()], hasOptions: true, stopCount: 1 }));
    expect(without).not.toContain('Arrive Day');

    const withDay = allText(
      render({
        legs: [leg({ arrival: { day: 7, date: '2026-03-12' } })],
        hasOptions: true,
        stopCount: 1,
      }),
    );
    expect(withDay).toContain('Arrive Day 7 · 2026-03-12');
  });

  it('follows the unit setting into feet and pounds', () => {
    const text = allText(render({ legs: [leg()], hasOptions: true, stopCount: 1, units: 'mi' }));
    expect(text).toContain('92.1 mi · +16,798 ft / −15,978 ft');
    expect(text).toContain('9.0 lb food');
  });
});
