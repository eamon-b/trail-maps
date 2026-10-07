/**
 * A hidden route's card says it is hidden and why; the detail lists the checks
 * and the review the owner may see, offers Open guide only when it is given,
 * and Delete calls back.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { MySharedRouteCard, MySharedRouteDetail } from '../MySharedRoutes';
import { ownRoute } from './fixtures';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

let mounted: ReactTestRenderer | null = null;

afterEach(() => {
  const tree = mounted;
  mounted = null;
  if (tree) act(() => tree.unmount());
});

function render(node: React.ReactElement): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(node);
  });
  mounted = tree;
  return tree;
}

function texts(r: ReactTestRenderer): string[] {
  return r.root.findAllByType(Text).map((t) => {
    const c = t.props.children as unknown;
    return Array.isArray(c) ? c.join('') : String(c);
  });
}

function pressByLabel(r: ReactTestRenderer, label: string): void {
  const [target] = r.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  expect(target).toBeDefined();
  act(() => (target.props.onPress as () => void)());
}

const HIDDEN = ownRoute({
  status: 'hidden',
  hiddenReason: 'review',
  trailUrl: null,
  review: {
    status: 'done',
    verdict: 'reject',
    confidence: 0.9,
    summary: 'The description advertises a guiding business.',
    concerns: ['Commercial content'],
  },
});

describe('MySharedRouteCard', () => {
  it('shows a hidden route’s pill, reason and review summary', () => {
    const r = render(
      <MySharedRouteCard route={HIDDEN} units="km" expanded={false} onPress={() => undefined} />,
    );
    const t = texts(r);
    expect(t).toContain('Lake Loop');
    expect(t).toContain('Hidden');
    expect(t).toContain('Hidden by the automatic review');
    expect(t).toContain('The description advertises a guiding business.');
    expect(t.some((s) => s.includes('Australia') && s.includes('Victoria') && s.includes('12.4'))).toBe(true);
  });

  it('gives a shared route its own pill and no reason', () => {
    const r = render(
      <MySharedRouteCard route={ownRoute({ status: 'verified' })} units="km" expanded={false} onPress={() => undefined} />,
    );
    const t = texts(r);
    expect(t).toContain('Verified');
    expect(t.some((s) => s.startsWith('Hidden'))).toBe(false);
  });

  it('shows its detail only when expanded, and toggles on press', () => {
    const onPress = jest.fn();
    const detail = <Text>DETAIL</Text>;
    const closed = render(
      <MySharedRouteCard route={HIDDEN} units="km" expanded={false} onPress={onPress}>
        {detail}
      </MySharedRouteCard>,
    );
    expect(texts(closed)).not.toContain('DETAIL');
    pressByLabel(closed, 'Lake Loop');
    expect(onPress).toHaveBeenCalled();
    act(() => closed.unmount());
    mounted = null;
    const open = render(
      <MySharedRouteCard route={HIDDEN} units="km" expanded onPress={onPress}>
        {detail}
      </MySharedRouteCard>,
    );
    expect(texts(open)).toContain('DETAIL');
  });
});

describe('MySharedRouteDetail', () => {
  it('lists the description, checks and review concerns, without Open guide for a hidden route', () => {
    const r = render(
      <MySharedRouteDetail route={HIDDEN} deleting={false} onDelete={() => undefined} />,
    );
    const t = texts(r);
    expect(t).toContain(HIDDEN.description);
    expect(t).toContain('The track is a single line.');
    expect(t).toContain('Commercial content');
    expect(t).not.toContain('Open guide');
  });

  it('calls back for Delete and Open guide', () => {
    const onDelete = jest.fn();
    const onOpenGuide = jest.fn();
    const r = render(
      <MySharedRouteDetail
        route={ownRoute()}
        deleting={false}
        onDelete={onDelete}
        onOpenGuide={onOpenGuide}
      />,
    );
    pressByLabel(r, 'Delete Lake Loop');
    pressByLabel(r, 'Open Lake Loop as a guide');
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onOpenGuide).toHaveBeenCalledTimes(1);
  });
});
