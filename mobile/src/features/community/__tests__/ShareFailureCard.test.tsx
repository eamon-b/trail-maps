/** The 409 for the hiker's own route offers a way to it; any other failure does not. */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ApiError } from '../../../api/client';
import { ShareFailureCard } from '../ShareFailureCard';
import { shareFailure } from '../share-form';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

const DUPLICATE = 'This exact track has been shared before';
const conflict = (extra: object) =>
  new ApiError(409, 'duplicate', DUPLICATE, {
    error: { code: 'duplicate', message: DUPLICATE },
    ...extra,
  });

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

function viewButton(r: ReactTestRenderer) {
  return r.root.findAll(
    (n) => n.props.accessibilityLabel === 'View my shared routes' && typeof n.props.onPress === 'function',
  );
}

it('offers the hiker’s own earlier route and opens it', () => {
  const onView = jest.fn();
  const r = render(
    <ShareFailureCard
      failure={shareFailure(conflict({ existingId: 'c_AAAAAAAAAAAAAAAA' }))}
      onViewMyRoutes={onView}
    />,
  );
  expect(r.root.findAllByType(Text).map((t) => t.props.children)).toContain(DUPLICATE);
  const [button] = viewButton(r);
  act(() => (button.props.onPress as () => void)());
  expect(onView).toHaveBeenCalledWith('c_AAAAAAAAAAAAAAAA');
});

it('keeps the plain message when the duplicate is someone else’s', () => {
  const r = render(<ShareFailureCard failure={shareFailure(conflict({}))} onViewMyRoutes={jest.fn()} />);
  expect(r.root.findAllByType(Text).map((t) => t.props.children)).toContain(DUPLICATE);
  expect(viewButton(r)).toHaveLength(0);
});
