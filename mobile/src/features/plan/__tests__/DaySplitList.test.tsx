/**
 * Day-split list smoke: it renders one card per computed day and surfaces the
 * subtle over-target hint only when a day's Naismith hours exceed the splitter's
 * snap window around the target (Decision 8). Theme is mocked (jest.setup.js);
 * only the text surface of the local react-test-renderer shim is used.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DaySplitList } from '../DaySplitList';
import { planFloorHours, planWindowHours } from '../plan-adapters';
import type { PlanDay } from '../plan-adapters';

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

function day(overrides: Partial<PlanDay>): PlanDay {
  return {
    dayNumber: 1,
    startName: 'Start',
    endName: 'Camp',
    startKm: 0,
    endKm: 20,
    distanceKm: 20,
    ascentM: 100,
    descentM: 100,
    estimatedHours: 8,
    waterSources: 2,
    snappedToCamp: true,
    endKind: 'camp',
    ...overrides,
  };
}

function render(days: PlanDay[], targetHours: number): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<DaySplitList days={days} targetHours={targetHours} units="km" />);
  });
  return tree;
}

describe('DaySplitList', () => {
  it('renders a card per day with its route and est. time', () => {
    const tree = render([day({ dayNumber: 1 }), day({ dayNumber: 2, endName: 'Town' })], 8);
    const text = allText(tree);
    expect(text).toContain('Day 1');
    expect(text).toContain('Day 2');
    expect(text).toContain('8.0 h');
  });

  it('shows the over-target hint when a day exceeds target + window', () => {
    // targetHours 8 -> window = clamp(0.35*8, .75, 2.5) = 2.5; threshold = 10.5.
    expect(planWindowHours(8)).toBeCloseTo(2.5, 5);
    const tree = render([day({ estimatedHours: 11.2 })], 8);
    expect(allText(tree)).toContain('+3.2 h over target');
  });

  it('omits the hint when every day is within the snap window', () => {
    // 10.4 h < threshold 10.5 h — no hint.
    const tree = render([day({ estimatedHours: 10.4 })], 8);
    expect(allText(tree)).not.toContain('over target');
  });

  it('grants the final day the splitter floor allowance at high hour targets', () => {
    // targetHours 16 -> window caps at 2.5 but floor = 0.25*16 = 4: the splitter
    // legitimately lets the final day run to 20 h, so no hint at 19.5 h...
    expect(planFloorHours(16)).toBeCloseTo(4, 5);
    const finish = day({ endKind: 'finish', snappedToCamp: false, estimatedHours: 19.5 });
    expect(allText(render([finish], 16))).not.toContain('over target');
    // ...while an interior day at the same hours is over its window and flags.
    const interior = day({ endKind: 'camp', estimatedHours: 19.5 });
    expect(allText(render([interior], 16))).toContain('+3.5 h over target');
  });

  it('renders the empty state for no days', () => {
    const tree = render([], 8);
    expect(allText(tree)).toContain('Choose a section');
  });
});
