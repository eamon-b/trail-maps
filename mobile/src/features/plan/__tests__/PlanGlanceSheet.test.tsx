/**
 * The plan at a glance (the map's sheet) and a place's part in the plan (the
 * waypoint screen's card). Presentational, so every test drives props.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import { Text } from 'react-native';
import type { ComputedDay } from '@lib/plan-types';
import { PlanGlanceSheet } from '../PlanGlanceSheet';
import { StopContextCard } from '../StopContextCard';

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

function isHost(node: TestInstance): boolean {
  return typeof (node as unknown as { type?: unknown }).type === 'string';
}

function count(tree: ReactTestRenderer, label: string): number {
  return tree.root.findAll((n) => isHost(n) && n.props.accessibilityLabel === label).length;
}

function press(tree: ReactTestRenderer, label: string): void {
  const node = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  )[0];
  act(() => (node.props.onPress as () => void)());
}

function day(n: number, startKm: number, endKm: number, startName: string, endName: string): ComputedDay {
  return {
    dayNumber: n,
    startName,
    endName,
    startKm,
    endKm,
    distanceKm: endKm - startKm,
    ascentM: 500,
    descentM: 300,
    estimatedHours: 6.5,
    waterSources: 2,
  };
}

function render(element: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

const noop = () => {};

describe('PlanGlanceSheet', () => {
  it('lists each day on one line, then the stretch not planned yet', () => {
    const tree = render(
      <PlanGlanceSheet
        visible
        onClose={noop}
        units="km"
        onOpenPlanner={noop}
        glance={{
          days: [day(1, 0, 20, 'Start', 'Camp A'), { ...day(2, 20, 42, 'Camp A', 'Hut B'), restDays: 1 }],
          unplanned: day(3, 42, 100, 'Hut B', 'Finish'),
        }}
      />,
    );
    const text = allText(tree);
    expect(text).toContain('2 days · 42.0 km planned');
    expect(count(tree, 'Day 1: Start to Camp A, 20.0 km')).toBe(1);
    expect(count(tree, 'Day 2: Camp A to Hut B, 22.0 km')).toBe(1);
    expect(text).toContain('22.0 km · ↑ 500 m · ↓ 300 m · 6.5 h · +1 rest day');
    expect(count(tree, 'Not planned yet: Hut B to Finish, 58.0 km')).toBe(1);
  });

  it('says how to start a plan when there are no stops', () => {
    const tree = render(
      <PlanGlanceSheet
        visible
        onClose={noop}
        units="km"
        onOpenPlanner={noop}
        glance={{ days: [], unplanned: day(1, 0, 100, 'Start', 'Finish') }}
      />,
    );
    expect(allText(tree)).toContain('No stops yet');
    expect(allText(tree)).toContain('Each stop ends a day');
  });

  it('closes itself before opening the planner', () => {
    const calls: string[] = [];
    const tree = render(
      <PlanGlanceSheet
        visible
        onClose={() => calls.push('close')}
        units="km"
        onOpenPlanner={() => calls.push('open')}
        glance={{ days: [], unplanned: null }}
      />,
    );
    press(tree, 'Open planner');
    expect(calls).toEqual(['close', 'open']);
  });
});

describe('StopContextCard', () => {
  const context = {
    arrive: day(2, 20, 42, 'Camp A', 'Hut B'),
    depart: day(3, 42, 100, 'Hut B', 'Finish'),
    departUnplanned: true,
  };

  it('previews the days a place would make, with a way to stop there', () => {
    const onStopHere = jest.fn();
    const tree = render(
      <StopContextCard
        isStop={false}
        context={context}
        units="km"
        onStopHere={onStopHere}
        onViewPlan={noop}
      />,
    );
    const text = allText(tree);
    expect(text).toContain('If you stop here');
    expect(count(tree, 'Day 2: Camp A to Hut B, 22.0 km')).toBe(1);
    expect(count(tree, 'Then, not planned yet: Hut B to Finish, 58.0 km')).toBe(1);
    press(tree, 'Stop here');
    expect(onStopHere).toHaveBeenCalledTimes(1);
  });

  it('shows a stop as planned, with its own controls and no add button', () => {
    const onViewPlan = jest.fn();
    const tree = render(
      <StopContextCard
        isStop
        context={{ ...context, depart: day(3, 42, 60, 'Hut B', 'Camp C'), departUnplanned: false }}
        units="km"
        onViewPlan={onViewPlan}
      >
        <Text>nights editor</Text>
      </StopContextCard>,
    );
    const text = allText(tree);
    expect(text).toContain('Stop on your plan');
    expect(count(tree, 'Day 3: Hut B to Camp C, 18.0 km')).toBe(1);
    expect(text).toContain('nights editor');
    expect(count(tree, 'Stop here')).toBe(0);
    press(tree, 'View whole plan');
    expect(onViewPlan).toHaveBeenCalledTimes(1);
  });
});
