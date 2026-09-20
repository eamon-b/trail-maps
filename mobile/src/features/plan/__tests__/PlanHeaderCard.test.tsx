/**
 * The plan's own details card. The start date is a validated text field (the
 * native picker is a later, native-build change), so the thing worth pinning is
 * that only a real YYYY-MM-DD ever escapes it — `setStartDate` throws on
 * anything else, and a bad date would otherwise render "Invalid Date" in every
 * day card.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer, type TestInstance } from 'react-test-renderer';
import { PlanHeaderCard } from '../PlanHeaderCard';

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

/**
 * A Pressable/TextInput surfaces the same props on its element, its component
 * and the host node it renders, so lookups are narrowed to host nodes. The
 * local `react-test-renderer` shim does not declare `type`, hence the cast.
 */
function isHost(node: TestInstance): boolean {
  return typeof (node as unknown as { type?: unknown }).type === 'string';
}

function field(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll((n) => isHost(n) && n.props.accessibilityLabel === label)[0];
}

function render(overrides: Partial<React.ComponentProps<typeof PlanHeaderCard>> = {}) {
  const props: React.ComponentProps<typeof PlanHeaderCard> = {
    name: '',
    namePlaceholder: 'Larapinta Trail',
    startDate: null,
    directionLabel: 'Westbound',
    onName: jest.fn(),
    onStartDate: jest.fn(),
    ...overrides,
  };
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<PlanHeaderCard {...props} />);
  });
  return { tree, props };
}

function type(tree: ReactTestRenderer, label: string, text: string): void {
  act(() => (field(tree, label).props.onChangeText as (t: string) => void)(text));
}

describe('PlanHeaderCard', () => {
  it('shows the trail name as the placeholder and the guide direction', () => {
    const { tree } = render();
    expect(field(tree, 'Plan name').props.placeholder).toBe('Larapinta Trail');
    expect(allText(tree)).toContain('Direction: Westbound — set in the guide');
  });

  it('commits a rename on blur', () => {
    const { tree, props } = render({ name: 'Week one' });
    type(tree, 'Plan name', 'Week two');
    expect(props.onName).not.toHaveBeenCalled();
    act(() => (field(tree, 'Plan name').props.onBlur as () => void)());
    expect(props.onName).toHaveBeenCalledWith('Week two');
  });

  it('accepts a real date as it is typed', () => {
    const { tree, props } = render();
    type(tree, 'Start date', '2026-10-01');
    expect(props.onStartDate).toHaveBeenCalledWith('2026-10-01');
    expect(allText(tree)).not.toContain('Use YYYY-MM-DD');
  });

  it('shows an inline error for a malformed or impossible date, and emits nothing', () => {
    const { tree, props } = render();
    type(tree, 'Start date', '01/10/26');
    act(() => (field(tree, 'Start date').props.onBlur as () => void)());
    expect(props.onStartDate).not.toHaveBeenCalled();
    expect(allText(tree)).toContain('Use YYYY-MM-DD');

    // A well-formed string that is not a real day (there is no 31 February).
    type(tree, 'Start date', '2026-02-31');
    act(() => (field(tree, 'Start date').props.onBlur as () => void)());
    expect(props.onStartDate).not.toHaveBeenCalled();
    expect(allText(tree)).toContain('Use YYYY-MM-DD');
  });

  it('clears the date when the field is emptied', () => {
    const { tree, props } = render({ startDate: '2026-10-01' });
    expect(field(tree, 'Start date').props.value).toBe('2026-10-01');
    type(tree, 'Start date', '');
    expect(props.onStartDate).toHaveBeenCalledWith(null);
  });
});
