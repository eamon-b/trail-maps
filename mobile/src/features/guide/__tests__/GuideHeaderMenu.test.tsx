/**
 * Guide header overflow menu (issue #26 preview). Theme and the reduce-motion
 * hook are mocked, so these are pure render/interaction assertions: the menu
 * stays closed until the ⋯ trigger is pressed, each item runs its action and
 * dismisses the popover, the backdrop dismisses without acting, and the
 * a11y contract (button/menu/menuitem roles, expanded state) holds.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { GuideHeaderMenu, type GuideMenuItem } from '../GuideHeaderMenu';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
  useReduceMotion: () => mockReduceMotion,
}));

// Flipped per test, then read by the mocked hook above.
let mockReduceMotion = false;

function collectText(node: unknown, out: string[]): void {
  if (typeof node === 'string') out.push(node);
  else if (typeof node === 'number') out.push(String(node));
  else if (Array.isArray(node)) node.forEach((n) => collectText(n, out));
}

function allText(tree: ReactTestRenderer): string {
  const texts: string[] = [];
  tree.root.findAll(() => true).forEach((n) => collectText(n.props.children, texts));
  return texts.join(' ');
}

/**
 * First-seen-order dedupe. A Pressable and the host View it renders both carry
 * the same a11y props, so the tree yields each one more than once.
 */
function uniq(values: string[]): string[] {
  return values.filter((v, i) => values.indexOf(v) === i);
}

function labels(tree: ReactTestRenderer): string[] {
  return uniq(
    tree.root
      .findAll((n) => typeof n.props.accessibilityLabel === 'string')
      .map((n) => n.props.accessibilityLabel as string),
  );
}

/** First node carrying both the label and a press handler (the Pressable). */
function byLabel(tree: ReactTestRenderer, label: string) {
  const [node] = tree.root.findAll(
    (n) => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled "${label}"`);
  return node;
}

/** The RN Modal wrapping the popover — the only node with onRequestClose. */
function modalOf(tree: ReactTestRenderer) {
  const [node] = tree.root.findAll((n) => typeof n.props.onRequestClose === 'function');
  if (!node) throw new Error('No modal rendered');
  return node;
}

/** The popover container. */
function menuOf(tree: ReactTestRenderer) {
  const [node] = tree.root.findAll((n) => n.props.accessibilityRole === 'menu');
  if (!node) throw new Error('No menu rendered');
  return node;
}

/** Node props come back loosely typed, so handlers need a cast to be called. */
function handler(node: { props: Record<string, unknown> }, prop: string): () => void {
  return node.props[prop] as () => void;
}

function press(tree: ReactTestRenderer, label: string): void {
  act(() => {
    handler(byLabel(tree, label), 'onPress')();
  });
}

function rolesOf(tree: ReactTestRenderer, role: string): string[] {
  return uniq(
    tree.root
      .findAll((n) => n.props.accessibilityRole === role)
      .map((n) => (n.props.accessibilityLabel as string) ?? ''),
  );
}

let onRoutes: jest.Mock;
let onPlan: jest.Mock;
let onDownloads: jest.Mock;

function items(): GuideMenuItem[] {
  return [
    { key: 'routes', label: 'Routes', glyph: '⋔', onPress: onRoutes },
    { key: 'plan', label: 'Plan', glyph: '▤', onPress: onPlan },
    { key: 'downloads', label: 'Offline maps', glyph: '⤓', onPress: onDownloads },
  ];
}

function render(): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<GuideHeaderMenu items={items()} tintColor="#ffffff" />);
  });
  return tree;
}

/** Render, then open the popover. */
function renderOpen(): ReactTestRenderer {
  const tree = render();
  press(tree, 'More actions');
  return tree;
}

describe('GuideHeaderMenu', () => {
  beforeEach(() => {
    mockReduceMotion = false;
    onRoutes = jest.fn();
    onPlan = jest.fn();
    onDownloads = jest.fn();
  });

  it('renders one ⋯ trigger and no items until it is pressed', () => {
    const tree = render();
    expect(allText(tree)).toContain('⋯');
    expect(labels(tree)).toEqual(['More actions']);
    expect(allText(tree)).not.toContain('Offline maps');
  });

  it('reveals every action once opened', () => {
    const text = allText(renderOpen());
    expect(text).toContain('Routes');
    expect(text).toContain('Plan');
    expect(text).toContain('Offline maps');
  });

  it('keeps the glyphs the inline header used, next to their labels', () => {
    const text = allText(renderOpen());
    expect(text).toContain('⋔');
    expect(text).toContain('▤');
    expect(text).toContain('⤓');
  });

  it('reports its expanded state to assistive tech', () => {
    const tree = render();
    expect(byLabel(tree, 'More actions').props.accessibilityState).toEqual({ expanded: false });
    press(tree, 'More actions');
    expect(byLabel(tree, 'More actions').props.accessibilityState).toEqual({ expanded: true });
  });

  it('exposes a menu container with menuitem children', () => {
    const tree = renderOpen();
    expect(rolesOf(tree, 'menu')).toEqual(['More actions']);
    expect(rolesOf(tree, 'menuitem')).toEqual(['Routes', 'Plan', 'Offline maps']);
  });

  it('marks the popover as a modal region for screen readers', () => {
    expect(menuOf(renderOpen()).props.accessibilityViewIsModal).toBe(true);
  });

  it('runs the pressed action and closes the menu', () => {
    const tree = renderOpen();
    press(tree, 'Plan');
    expect(onPlan).toHaveBeenCalledTimes(1);
    expect(onRoutes).not.toHaveBeenCalled();
    expect(onDownloads).not.toHaveBeenCalled();
    // Closed again: the header stays mounted under a pushed screen, so a
    // lingering popover would float over the destination.
    expect(allText(tree)).not.toContain('Offline maps');
  });

  it('routes each item to its own action', () => {
    press(renderOpen(), 'Routes');
    expect(onRoutes).toHaveBeenCalledTimes(1);
    press(renderOpen(), 'Offline maps');
    expect(onDownloads).toHaveBeenCalledTimes(1);
  });

  it('dismisses on a backdrop tap without running anything', () => {
    const tree = renderOpen();
    press(tree, 'Close menu');
    expect(allText(tree)).not.toContain('Offline maps');
    expect(onRoutes).not.toHaveBeenCalled();
    expect(onPlan).not.toHaveBeenCalled();
    expect(onDownloads).not.toHaveBeenCalled();
  });

  it('dismisses on the Android back button', () => {
    const tree = renderOpen();
    act(() => {
      handler(modalOf(tree), 'onRequestClose')();
    });
    expect(allText(tree)).not.toContain('Offline maps');
  });

  it('fades in by default but snaps when reduce motion is on', () => {
    expect(modalOf(renderOpen()).props.animationType).toBe('fade');

    mockReduceMotion = true;
    expect(modalOf(renderOpen()).props.animationType).toBe('none');
  });

  it('renders nothing extra for an empty action list', () => {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<GuideHeaderMenu items={[]} tintColor="#ffffff" />);
    });
    press(tree, 'More actions');
    expect(rolesOf(tree, 'menuitem')).toEqual([]);
  });
});
