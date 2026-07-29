/**
 * Cheap mount smoke for the inputs card: it renders the section boundaries and
 * its steppers drive the handlers. Theme is mocked (jest.setup.js is fixed);
 * only the `findAll` + `props` surface of the local react-test-renderer shim is
 * used.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { PlanInputsCard } from '../PlanInputsCard';
import type { WaypointOption } from '../plan-adapters';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const options: WaypointOption[] = [
  { id: 'a', name: 'Start', km: 0, type: 'trailhead' },
  { id: 'b', name: 'Middle', km: 30, type: 'campsite' },
  { id: 'c', name: 'End', km: 60, type: 'trailhead' },
];

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

function press(tree: ReactTestRenderer, accessibilityLabel: string): void {
  const target = tree.root.findAll(
    (n) => n.props.accessibilityLabel === accessibilityLabel && typeof n.props.onPress === 'function',
  )[0];
  act(() => (target.props.onPress as () => void)());
}

describe('PlanInputsCard', () => {
  const baseProps = {
    options,
    startIdx: 0,
    endIdx: 2,
    dailyHours: 8,
    pace: 'average' as const,
    units: 'km' as const,
    onStartIdx: jest.fn(),
    onEndIdx: jest.fn(),
    onDailyHours: jest.fn(),
    onPace: jest.fn(),
    onResetSection: jest.fn(),
  };

  it('renders the section boundaries, pace options and daily hours', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<PlanInputsCard {...baseProps} />);
    });
    const text = allText(tree);
    expect(text).toContain('Start');
    expect(text).toContain('End');
    expect(text).toContain('Average'); // pace segmented control mounted
    expect(text).toContain('8 h');
  });

  it('steps the start boundary forward', () => {
    const onStartIdx = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<PlanInputsCard {...baseProps} onStartIdx={onStartIdx} />);
    });
    press(tree, 'Next Start');
    expect(onStartIdx).toHaveBeenCalledWith(1);
  });

  it('increments daily hours', () => {
    const onDailyHours = jest.fn();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<PlanInputsCard {...baseProps} onDailyHours={onDailyHours} />);
    });
    press(tree, 'More daily hours');
    expect(onDailyHours).toHaveBeenCalledWith(9);
  });
});
