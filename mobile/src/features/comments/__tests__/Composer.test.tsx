/**
 * Composer failure surface.
 *
 * Posting is offline-first, so the one thing that can genuinely fail is
 * registering the device on a first post. Before the fix that rejection was
 * swallowed by a try/finally with no catch: the name prompt closed, nothing was
 * queued, and the user got no feedback at all. These tests pin the replacement
 * behaviour — visible error, draft preserved, no unhandled rejection.
 */

import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import * as ImagePicker from 'expo-image-picker';
import { Composer, PHOTO_FAILED_MESSAGE, POST_FAILED_MESSAGE } from '../Composer';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { NetworkError } from '../../../api/client';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

jest.mock('expo-image', () => ({ Image: 'Image' }));

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  requestCameraPermissionsAsync: jest.fn(() => Promise.resolve({ granted: false })),
}));

function mount(props: {
  registered: boolean;
  onSubmit: (args: unknown) => Promise<void>;
  waypointType?: string;
}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <Composer
        waypointType={props.waypointType ?? 'hut'}
        registered={props.registered}
        onSubmit={props.onSubmit as never}
      />,
    );
  });
  return tree;
}

/** All rendered text, flattened, so copy assertions don't depend on structure. */
function renderedText(r: ReactTestRenderer): string {
  return r.root
    .findAllByType(Text)
    .map((n) => JSON.stringify(n.props.children))
    .join(' ');
}

function press(r: ReactTestRenderer, accessibilityLabel: string) {
  const target = r.root.findAll(
    (n) =>
      n.props?.accessibilityLabel === accessibilityLabel &&
      typeof n.props?.onPress === 'function',
  )[0];
  act(() => {
    (target.props.onPress as () => void)();
  });
}

/** Fire a press and let the submit promise chain settle. */
async function pressAsync(r: ReactTestRenderer, accessibilityLabel: string) {
  press(r, accessibilityLabel);
  await act(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });
}

function setInput(r: ReactTestRenderer, index: number, text: string) {
  const input = r.root.findAllByType(TextInput)[index];
  act(() => {
    (input.props.onChangeText as (t: string) => void)(text);
  });
}

/** The draft note input's current value (the name prompt's input is index 1). */
function inputValue(r: ReactTestRenderer, index = 0): string {
  return r.root.findAllByType(TextInput)[index].props.value as string;
}

describe('Composer', () => {
  it('surfaces a network failure inline and keeps the draft', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new NetworkError('POST /v1/devices failed'));
    const r = mount({ registered: true, onSubmit, waypointType: 'water' });

    setInput(r, 0, 'Tank is full');
    await pressAsync(r, 'Post comment');

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
    // Draft survives so retrying is one tap.
    expect(inputValue(r)).toBe('Tank is full');
  });

  it('uses fallback copy for an unrecognised failure', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('boom'));
    const r = mount({ registered: true, onSubmit });

    setInput(r, 0, 'Hut is dry');
    await pressAsync(r, 'Post comment');

    expect(renderedText(r)).toContain(POST_FAILED_MESSAGE);
  });

  it('clears the error and the draft on a successful post', async () => {
    const onSubmit = jest
      .fn()
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValueOnce(undefined);
    const r = mount({ registered: true, onSubmit });

    setInput(r, 0, 'Hut is dry');
    await pressAsync(r, 'Post comment');
    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);

    await pressAsync(r, 'Post comment');

    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(renderedText(r)).not.toContain(NETWORK_ERROR_MESSAGE);
    expect(inputValue(r)).toBe('');
  });

  it('clears a stale error as soon as the user edits the draft', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new NetworkError('offline'));
    const r = mount({ registered: true, onSubmit });

    setInput(r, 0, 'Hut is dry');
    await pressAsync(r, 'Post comment');
    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);

    setInput(r, 0, 'Hut is dry and cold');
    expect(renderedText(r)).not.toContain(NETWORK_ERROR_MESSAGE);
  });

  it('reports a picker failure instead of leaving a rejected promise', async () => {
    (ImagePicker.launchImageLibraryAsync as jest.Mock).mockRejectedValue(
      new Error('picker exploded'),
    );
    const r = mount({ registered: true, onSubmit: jest.fn() });

    await pressAsync(r, 'Add photo from library');

    expect(renderedText(r)).toContain(PHOTO_FAILED_MESSAGE);
  });

  it('does not submit an empty draft', () => {
    const onSubmit = jest.fn();
    const r = mount({ registered: true, onSubmit });

    press(r, 'Post comment');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  describe('first post (unregistered)', () => {
    it('prompts for a name, then reports registration failure without losing it', async () => {
      const onSubmit = jest
        .fn()
        .mockRejectedValueOnce(new NetworkError('POST /v1/devices failed'))
        .mockResolvedValueOnce(undefined);
      const r = mount({ registered: false, onSubmit });

      setInput(r, 0, 'First note');
      press(r, 'Post comment');
      // Nothing is submitted until a display name is entered.
      expect(onSubmit).not.toHaveBeenCalled();

      setInput(r, 1, '  Trail Ghost  ');
      await pressAsync(r, 'Save display name and post');

      expect(onSubmit).toHaveBeenCalledWith({
        text: 'First note',
        waterStatus: null,
        photo: null,
        displayName: 'Trail Ghost',
      });
      expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);
      // Prompt stays open with the typed name so retry is one tap.
      expect(inputValue(r, 1)).toBe('  Trail Ghost  ');
      expect(inputValue(r, 0)).toBe('First note');

      await pressAsync(r, 'Retry posting comment');

      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(renderedText(r)).not.toContain(NETWORK_ERROR_MESSAGE);
      expect(inputValue(r, 0)).toBe('');
    });

    it('rejects an empty display name without calling onSubmit', () => {
      const onSubmit = jest.fn();
      const r = mount({ registered: false, onSubmit });

      setInput(r, 0, 'First note');
      press(r, 'Post comment');
      press(r, 'Save display name and post');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(renderedText(r)).toContain('Enter a display name.');
    });
  });
});
