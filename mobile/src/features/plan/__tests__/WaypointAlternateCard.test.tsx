/**
 * The waypoint screen's alternate card: where the alternate leaves and rejoins
 * the main route, whether the plan takes it, and the choice to take or drop it.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { PlanAlternate } from '@lib/plan-alternates';
import { WaypointAlternateCard } from '../WaypointAlternateCard';
import type { WaypointAlternate } from '../waypoint-alternates';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join('\n');
}

function pressable(tree: ReactTestRenderer, label: string) {
  return tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
}

const ridge: PlanAlternate = {
  name: 'Ridge',
  index: 0,
  startKm: 20,
  endKm: 40,
  distanceKm: 25,
  mainDistanceKm: 20,
  ascentM: 400,
  descentM: 400,
};

const onRidge: WaypointAlternate = {
  role: 'on',
  name: 'Ridge',
  plannable: ridge,
  taken: false,
  leavesKm: 20,
  rejoinsKm: 40,
  leavesAt: { id: 'fork', name: 'Fork Hut', km: 20 },
  rejoinsAt: null,
  parentName: null,
  distanceKm: 25,
  ascentM: 400,
  descentM: 400,
  kmAlong: 12,
  replaces: ['Valley'],
};

function render(props: Partial<React.ComponentProps<typeof WaypointAlternateCard>>) {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <WaypointAlternateCard alternate={onRidge} units="km" {...props} />,
    );
  });
  return tree;
}

it('shows where the alternate leaves and rejoins, and takes it', () => {
  const onAlternate = jest.fn();
  const onOpenPlace = jest.fn();
  const tree = render({ onAlternate, onOpenPlace });
  const text = allText(tree);
  expect(text).toContain('⑂ On an alternate: Ridge');
  expect(text).toContain('12.0 km along it');
  expect(text).toContain('5.0 km longer than the main route');
  expect(text).toContain('Leaves the main route at Fork Hut (20.0 km)');
  expect(text).toContain('Rejoins the main route at 40.0 km');
  expect(text).toContain('Your plan stays on the main route here.');
  expect(text).toContain('Taking it drops Valley');

  const [junction] = pressable(tree, 'Leaves the main route at Fork Hut (20.0 km)');
  act(() => (junction.props.onPress as () => void)());
  expect(onOpenPlace).toHaveBeenCalledWith('fork');

  const [take] = pressable(tree, 'Take this alternate: Ridge');
  act(() => (take.props.onPress as () => void)());
  expect(onAlternate).toHaveBeenCalledWith('Ridge', true);
});

it('offers to stay on the main route once the plan takes it', () => {
  const onAlternate = jest.fn();
  const tree = render({ alternate: { ...onRidge, taken: true, replaces: [] }, onAlternate });
  expect(allText(tree)).toContain('Your plan takes this alternate.');
  const [stay] = pressable(tree, 'Stay on the main route: Ridge');
  act(() => (stay.props.onPress as () => void)());
  expect(onAlternate).toHaveBeenCalledWith('Ridge', false);
});

it('does not link a junction to the screen it is on', () => {
  const tree = render({
    alternate: { ...onRidge, role: 'rejoins', rejoinsAt: { id: 'join', name: 'Join', km: 40 } },
    currentWaypointId: 'join',
    onOpenPlace: jest.fn(),
  });
  const text = allText(tree);
  expect(text).toContain('↩ An alternate rejoins the main route here: Ridge');
  // Its own junction is the place on screen, so only where it leaves is listed.
  expect(text).not.toContain('Rejoins the main route at');
  expect(pressable(tree, 'Leaves the main route at Fork Hut (20.0 km)')).toHaveLength(1);
});

it('has no choice for an alternate a plan cannot take', () => {
  const tree = render({
    alternate: { ...onRidge, plannable: null, parentName: 'Ridge', leavesKm: null, rejoinsKm: null, name: 'Spur' },
    onAlternate: jest.fn(),
  });
  expect(allText(tree)).toContain('It branches off another alternate: Ridge.');
  expect(pressable(tree, 'Take this alternate: Spur')).toHaveLength(0);
});

it('drops the "Alternate:" the data starts a name with', () => {
  const tree = render({
    alternate: { ...onRidge, name: 'Alternate: Highline', replaces: ['Alternative: Low road'] },
    onAlternate: jest.fn(),
  });
  const text = allText(tree);
  expect(text).toContain('⑂ On an alternate: Highline');
  expect(text).toContain('Taking it drops Low road');
  expect(pressable(tree, 'Take this alternate: Highline')).toHaveLength(1);
});
