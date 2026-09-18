/**
 * The picker's list. What matters to a hiker: the count of what they have
 * ticked, that a turn-off's options are gathered under it, that a whole row is
 * one checkbox, and that the subline says how far off the route the place is
 * in *their* units. Plus the render guard — 80 CDT rows must not all re-render
 * when one is ticked.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { listResupplyOptions, type ResupplyCandidateWaypoint } from '@lib/resupply-plan';
import { ResupplySelectList, type ResupplySelectListProps } from '../ResupplySelectList';

// One render of any component in this file calls useTheme exactly once, so the
// call count doubles as a render count for the memo guard below.
const mockUseTheme = jest.fn(() => ({ colors: new Proxy({}, { get: () => '#123456' }) }));
jest.mock('../../../theme', () => ({ useTheme: () => mockUseTheme() }));

const waypoints: ResupplyCandidateWaypoint[] = [
  { id: 'w_pass', name: 'Monarch Pass', type: 'town-access', totalDistance: 100 },
  {
    id: 'w_salida',
    name: 'Salida',
    type: 'town',
    totalDistance: 100,
    offTrailKm: 22.5,
    accessMode: 'hitch',
    acceptsBoxes: true,
    accessName: 'Monarch Pass (US 50)',
    description: 'mi 1947.3 | CO | Leave the CDT here for Salida. Safeway and hot springs.',
  },
  { id: 'w_creede', name: 'Creede', type: 'town', totalDistance: 250 },
];

const groups = listResupplyOptions(waypoints);

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
 * Every checkbox row — the Pressable itself, not the host View it renders
 * (which carries the role but no `onPress`).
 */
function rows(tree: ReactTestRenderer) {
  return tree.root.findAll(
    (n) => n.props.accessibilityRole === 'checkbox' && typeof n.props.onPress === 'function',
  );
}

function props(over: Partial<ResupplySelectListProps> = {}): ResupplySelectListProps {
  return {
    groups,
    selectedIds: new Set(['w_salida']),
    section: null,
    units: 'km',
    planMade: true,
    onToggle: jest.fn(),
    onSelectAll: jest.fn(),
    onSelectNone: jest.fn(),
    onReset: jest.fn(),
    ...over,
  };
}

function render(p: ResupplySelectListProps): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ResupplySelectList {...p} />);
    // FlatList schedules its first cell pass on a timer; run it inside act so
    // the update is not reported as an un-acted render.
    jest.runOnlyPendingTimers();
  });
  return tree;
}

describe('ResupplySelectList', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts the ticked options against the trail’s own', () => {
    expect(allText(render(props()))).toContain('1 of 3 stops');
  });

  it('renders a group header over its options', () => {
    const text = allText(render(props()));
    expect(text).toContain('Monarch Pass (US 50) · 100.0 km');
    expect(text).toContain('Salida');
    expect(text).toContain('Creede');
  });

  it('marks a row checked or not, and toggles it by its id', () => {
    const p = props();
    const tree = render(p);
    const byName = new Map(rows(tree).map((r) => [r.props.accessibilityLabel as string, r]));
    expect(byName.get('Salida')!.props.accessibilityState).toEqual({ checked: true });
    expect(byName.get('Creede')!.props.accessibilityState).toEqual({ checked: false });

    act(() => (byName.get('Creede')!.props.onPress as () => void)());
    expect(p.onToggle).toHaveBeenCalledWith('w_creede');
  });

  it('spells the access, the lead sentence and the box in the hiker’s units', () => {
    expect(allText(render(props()))).toContain(
      '22.5 km hitch · Leave the CDT here for Salida. · accepts boxes',
    );
    expect(allText(render(props({ units: 'mi' })))).toContain('14.0 mi hitch');
  });

  it('says which rows the current section leaves out', () => {
    const text = allText(render(props({ section: { startKm: 0, endKm: 150 } })));
    expect(text).toContain('outside section');
    // The in-section rows still show their km.
    expect(text).toContain('100.0 km');
    expect(text).not.toContain('250.0 km');
  });

  it('disables Reset until a plan exists', () => {
    const tree = render(props({ planMade: false }));
    const [reset] = tree.root.findAll(
      (n) => n.props.accessibilityLabel === 'Reset' && typeof n.props.onPress === 'function',
    );
    expect(reset.props.accessibilityState).toEqual({ disabled: true });
  });

  it('leaves rows alone when re-rendered with the same selection', () => {
    const p = props();
    mockUseTheme.mockClear();
    const tree = render(p);
    const first = mockUseTheme.mock.calls.length;

    mockUseTheme.mockClear();
    // Same props: the shell re-renders, the memoised rows do not — so exactly
    // one row's worth of renders drops out. 80 CDT rows depend on this.
    act(() => tree.update(<ResupplySelectList {...p} />));
    expect(mockUseTheme.mock.calls.length).toBe(first - rows(tree).length);
  });
});
