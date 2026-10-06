/**
 * The draft hook behind the plan's free-text fields: what gets committed, and
 * when — after a pause, on blur, on unmount — and that a change from elsewhere
 * replaces the draft while this field's own commit coming back does not.
 */

import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { DRAFT_COMMIT_DELAY_MS, useDraftField, type DraftField } from '../use-draft-field';

const trim = (text: string) => text.trim();

describe('useDraftField', () => {
  let field!: DraftField;
  function Probe({ value, onCommit }: { value: string; onCommit: (text: string) => void }) {
    field = useDraftField(value, onCommit, trim);
    return null;
  }

  function render(value: string, onCommit: (text: string) => void): ReactTestRenderer {
    let tree!: ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(<Probe value={value} onCommit={onCommit} />);
    });
    return tree;
  }

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('commits once typing pauses, not on every keystroke', () => {
    const onCommit = jest.fn();
    render('', onCommit);
    act(() => field.setDraft('r'));
    act(() => field.setDraft('ra'));
    act(() => field.setDraft('rang'));
    act(() => jest.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS - 1));
    expect(onCommit).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('rang');
  });

  it('commits straight away on blur, and only once', () => {
    const onCommit = jest.fn();
    render('', onCommit);
    act(() => field.setDraft('two beds'));
    act(() => field.flush());
    expect(onCommit).toHaveBeenCalledWith('two beds');
    act(() => jest.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS));
    act(() => field.flush());
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('commits a draft still waiting when the screen goes away', () => {
    // Back-navigation unmounts the field before it ever blurs.
    const onCommit = jest.fn();
    const tree = render('', onCommit);
    act(() => field.setDraft('rang ahead'));
    act(() => tree.unmount());
    expect(onCommit).toHaveBeenCalledWith('rang ahead');
  });

  it('commits nothing on unmount when nothing was typed', () => {
    const onCommit = jest.fn();
    const tree = render('stored', onCommit);
    act(() => tree.unmount());
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('keeps the draft when its own commit comes back normalised', () => {
    const onCommit = jest.fn();
    const tree = render('', onCommit);
    act(() => field.setDraft('rang '));
    act(() => jest.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS));
    act(() => tree.update(<Probe value="rang" onCommit={onCommit} />));
    // The trailing space the hiker is still typing past survives.
    expect(field.draft).toBe('rang ');
  });

  it('takes a change made elsewhere over an uncommitted draft', () => {
    const onCommit = jest.fn();
    const tree = render('two beds', onCommit);
    act(() => field.setDraft('two beds, rang'));
    act(() => tree.update(<Probe value="cancelled" onCommit={onCommit} />));
    expect(field.draft).toBe('cancelled');
    act(() => jest.advanceTimersByTime(DRAFT_COMMIT_DELAY_MS));
    act(() => tree.unmount());
    expect(onCommit).not.toHaveBeenCalled();
  });
});
