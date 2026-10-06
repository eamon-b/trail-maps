/**
 * A text field's local draft, committed to its document without waiting for a
 * blur that may never come.
 *
 * The plan's free-text fields (a stop's note, the plan's name) used to commit
 * only on blur. Two everyday moves skip the blur: the Plan screen's scroll
 * views use `keyboardShouldPersistTaps="handled"`, so tapping a button leaves
 * the field focused, and going back unmounts the screen before it blurs. Both
 * silently dropped what had been typed. So the draft commits:
 *   - `delayMs` after the last keystroke — one SQLite write (and later one
 *     `PUT`) per pause rather than per character;
 *   - on blur, straight away;
 *   - on unmount, if anything is still waiting.
 *
 * A change to `value` that did not come from this field (another screen, a
 * sync) replaces the draft; this field's own commit coming back does not, so
 * the cursor is never yanked mid-edit. `normalize` says what the document will
 * make of a commit (trimmed, capped), which is how the two are told apart.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

/** Pause after the last keystroke before the draft is committed. */
export const DRAFT_COMMIT_DELAY_MS = 500;

export interface DraftField {
  draft: string;
  /** The `TextInput`'s `onChangeText`. */
  setDraft: (text: string) => void;
  /** The `TextInput`'s `onBlur`: commits anything still waiting. */
  flush: () => void;
}

export function useDraftField(
  value: string,
  onCommit: (text: string) => void,
  normalize: (text: string) => string,
  delayMs: number = DRAFT_COMMIT_DELAY_MS,
): DraftField {
  const [draft, setDraftState] = useState(value);
  // What the document last said the value was, or what our own last commit
  // will make it say.
  const known = useRef(value);
  // The draft not yet committed (null: nothing waiting).
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The latest callbacks, for a timer or an unmount that outlives the render
  // that scheduled it.
  const latest = useRef({ onCommit, normalize });
  useEffect(() => {
    latest.current = { onCommit, normalize };
  }, [onCommit, normalize]);

  const clearTimer = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const flush = useCallback(() => {
    clearTimer();
    const text = pending.current;
    if (text == null) return;
    pending.current = null;
    known.current = latest.current.normalize(text);
    latest.current.onCommit(text);
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      setDraftState(text);
      pending.current = text;
      clearTimer();
      timer.current = setTimeout(flush, delayMs);
    },
    [flush, delayMs],
  );

  useEffect(() => {
    if (value === known.current) return;
    // Someone else changed it: their value wins over an uncommitted draft.
    known.current = value;
    pending.current = null;
    clearTimer();
    setDraftState(value);
  }, [value]);

  // Leaving the screen is the commit a blur would have been.
  useEffect(() => flush, [flush]);

  return { draft, setDraft, flush };
}
