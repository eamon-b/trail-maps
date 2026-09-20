/**
 * The three controls that hang off a chosen stop. Theme is mocked; only the
 * text/props surface of react-test-renderer is used, as in the sibling specs.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { PLAN_LIMITS, type PlanStop } from '@lib/plan-types';
import { StopEditor } from '../StopEditor';

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

function byLabel(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll((n) => n.props.accessibilityLabel === label);
}

function press(tree: ReactTestRenderer, label: string): void {
  const target = byLabel(tree, label).find((n) => typeof n.props.onPress === 'function')!;
  act(() => (target.props.onPress as () => void)());
}

const handlers = () => ({
  onNights: jest.fn(),
  onNote: jest.fn(),
  onBooked: jest.fn(),
});

function stop(overrides: Partial<PlanStop> = {}): PlanStop {
  return { waypointId: 'w_camp', km: 12.5, name: 'Standley Chasm', nights: 1, ...overrides };
}

function render(
  planStop: PlanStop,
  props: ReturnType<typeof handlers>,
): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<StopEditor stop={planStop} {...props} />);
  });
  return tree;
}

describe('StopEditor', () => {
  it('steps nights up and clamps the buttons at the ends', () => {
    const props = handlers();
    const tree = render(stop(), props);

    expect(byLabel(tree, 'Fewer nights')[0].props.disabled).toBe(true);
    press(tree, 'More nights');
    expect(props.onNights).toHaveBeenCalledWith(2);

    const atMax = render(stop({ nights: PLAN_LIMITS.nightsMax }), props);
    expect(byLabel(atMax, 'More nights')[0].props.disabled).toBe(true);
    expect(byLabel(atMax, 'Fewer nights')[0].props.disabled).toBe(false);
  });

  it('explains what a second night means', () => {
    expect(allText(render(stop(), handlers()))).not.toContain('rest day');
    expect(allText(render(stop({ nights: 2 }), handlers()))).toContain('2 nights = 1 rest day here');
    expect(allText(render(stop({ nights: 4 }), handlers()))).toContain('4 nights = 3 rest days here');
  });

  it('commits the note on blur, not on every keystroke', () => {
    const props = handlers();
    const tree = render(stop(), props);
    const input = byLabel(tree, 'Stop note')[0];

    act(() => (input.props.onChangeText as (t: string) => void)('rang ahead'));
    expect(props.onNote).not.toHaveBeenCalled();

    act(() => (input.props.onBlur as () => void)());
    expect(props.onNote).toHaveBeenCalledWith('rang ahead');
    expect(input.props.maxLength).toBe(PLAN_LIMITS.noteMax);
  });

  it('shows the stored note and follows an external change to it', () => {
    const props = handlers();
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<StopEditor stop={stop({ note: 'two beds' })} {...props} />);
    });
    expect(byLabel(tree, 'Stop note')[0].props.value).toBe('two beds');

    act(() => {
      tree.update(<StopEditor stop={stop({ note: 'cancelled' })} {...props} />);
    });
    expect(byLabel(tree, 'Stop note')[0].props.value).toBe('cancelled');
  });

  it('exposes Booked as a checkbox and toggles it', () => {
    const props = handlers();
    const tree = render(stop(), props);
    const unchecked = byLabel(tree, 'Booked')[0];
    expect(unchecked.props.accessibilityRole).toBe('checkbox');
    expect(unchecked.props.accessibilityState).toEqual({ checked: false });

    press(tree, 'Booked');
    expect(props.onBooked).toHaveBeenCalledWith(true);

    const booked = render(stop({ booked: true }), props);
    expect(byLabel(booked, 'Booked')[0].props.accessibilityState).toEqual({ checked: true });
    press(booked, 'Booked');
    expect(props.onBooked).toHaveBeenLastCalledWith(false);
  });
});
