/**
 * ThemeProvider renders nothing until the saved preference is read (to avoid a
 * theme flash). A read that fails must still let the app render — with the
 * default theme — rather than leave it blank.
 */

import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeProvider, useTheme } from '../ThemeContext';

function Probe() {
  const { themeVariant, autoDarkMode } = useTheme();
  return <Text>{`${themeVariant}:${autoDarkMode}`}</Text>;
}

async function render(): Promise<ReactTestRenderer> {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = TestRenderer.create(
      <ThemeProvider>
        <Probe />
      </ThemeProvider>,
    );
  });
  return tree;
}

function text(tree: ReactTestRenderer): string | null {
  const nodes = tree.root.findAllByType(Text);
  return nodes.length > 0 ? String(nodes[0].props.children) : null;
}

// jest.setup.js mocks AsyncStorage with a `getItem` that resolves null.
const getItem = AsyncStorage.getItem as jest.Mock;
const storageDefault = () => Promise.resolve(null);
let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  getItem.mockImplementation(storageDefault);
});

describe('ThemeProvider', () => {
  it('renders with the saved theme', async () => {
    const saved: Record<string, string> = {
      'tracknotes:theme': 'dark',
      'tracknotes:autoDark': 'false',
    };
    getItem.mockImplementation((key: string) => Promise.resolve(saved[key] ?? null));
    const tree = await render();
    expect(text(tree)).toBe('dark:false');
  });

  it('still renders, with the default theme, when the storage read fails', async () => {
    getItem.mockImplementation(() => Promise.reject(new Error('storage is corrupt')));
    const tree = await render();
    // Default: follow the system (light in the test renderer).
    expect(text(tree)).toBe('light:true');
    expect(warnSpy).toHaveBeenCalled();
  });
});
