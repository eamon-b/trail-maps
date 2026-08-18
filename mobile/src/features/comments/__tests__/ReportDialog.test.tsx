/**
 * Report dialog behaviour: no reason means no submit, an unregistered reporter
 * is prompted for a display name first (reports are authenticated), and a
 * failure stays visible with the chosen reason intact.
 */

import React from 'react';
import { Text, TextInput } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ReportDialog, REPORT_FAILED_MESSAGE } from '../ReportDialog';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { NetworkError } from '../../../api/client';

jest.mock('../../../theme', () => ({
  useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }),
}));

function mount(props: {
  registered: boolean;
  onSubmit: (args: unknown) => Promise<void>;
  onCancel?: () => void;
}): ReactTestRenderer {
  let tree!: ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ReportDialog
        commentId="theirs"
        registered={props.registered}
        onCancel={props.onCancel ?? (() => {})}
        onSubmit={props.onSubmit as never}
      />,
    );
  });
  return tree;
}

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

describe('ReportDialog', () => {
  it('requires a reason before reporting', () => {
    const onSubmit = jest.fn();
    const r = mount({ registered: true, onSubmit });

    press(r, 'Send report');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain('Choose a reason.');
  });

  it('submits the chosen reason and trimmed detail', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const r = mount({ registered: true, onSubmit });

    press(r, 'Reason: Offensive or abusive');
    setInput(r, 0, '  slurs in the note  ');
    await pressAsync(r, 'Send report');

    expect(onSubmit).toHaveBeenCalledWith({
      reason: 'offensive',
      detail: 'slurs in the note',
      displayName: undefined,
    });
  });

  it('submits with no detail at all', async () => {
    const onSubmit = jest.fn().mockResolvedValue(undefined);
    const r = mount({ registered: true, onSubmit });

    press(r, 'Reason: Spam or advertising');
    await pressAsync(r, 'Send report');

    expect(onSubmit).toHaveBeenCalledWith({
      reason: 'spam',
      detail: null,
      displayName: undefined,
    });
  });

  it('rejects an over-long detail without calling onSubmit', async () => {
    const onSubmit = jest.fn();
    const r = mount({ registered: true, onSubmit });

    press(r, 'Reason: Something else');
    setInput(r, 0, 'x'.repeat(501));
    await pressAsync(r, 'Send report');

    expect(onSubmit).not.toHaveBeenCalled();
    expect(renderedText(r)).toContain('500 characters');
  });

  it('surfaces a failure and keeps the dialog open for a retry', async () => {
    const onSubmit = jest
      .fn()
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockResolvedValueOnce(undefined);
    const r = mount({ registered: true, onSubmit });

    press(r, 'Reason: Spam or advertising');
    await pressAsync(r, 'Send report');
    expect(renderedText(r)).toContain(NETWORK_ERROR_MESSAGE);

    await pressAsync(r, 'Send report');
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it('uses fallback copy for an unrecognised failure', async () => {
    const onSubmit = jest.fn().mockRejectedValue(new Error('boom'));
    const r = mount({ registered: true, onSubmit });

    press(r, 'Reason: Spam or advertising');
    await pressAsync(r, 'Send report');

    expect(renderedText(r)).toContain(REPORT_FAILED_MESSAGE);
  });

  describe('first report (unregistered)', () => {
    it('prompts for a display name, then reports with it', async () => {
      const onSubmit = jest.fn().mockResolvedValue(undefined);
      const r = mount({ registered: false, onSubmit });

      press(r, 'Reason: Inaccurate or misleading');
      press(r, 'Send report');
      // Nothing is sent until a name exists — reports are authenticated.
      expect(onSubmit).not.toHaveBeenCalled();

      setInput(r, 0, '  Trail Ghost  ');
      await pressAsync(r, 'Save display name and report');

      expect(onSubmit).toHaveBeenCalledWith({
        reason: 'inaccurate',
        detail: null,
        displayName: 'Trail Ghost',
      });
    });

    it('rejects an empty display name', () => {
      const onSubmit = jest.fn();
      const r = mount({ registered: false, onSubmit });

      press(r, 'Reason: Spam or advertising');
      press(r, 'Send report');
      press(r, 'Save display name and report');

      expect(onSubmit).not.toHaveBeenCalled();
      expect(renderedText(r)).toContain('Enter a display name.');
    });
  });

  it('cancels without submitting', () => {
    const onCancel = jest.fn();
    const onSubmit = jest.fn();
    const r = mount({ registered: true, onSubmit, onCancel });

    press(r, 'Cancel report');

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
