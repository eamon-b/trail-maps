/**
 * The waypoint feed's own-comment actions — delete and retry — as the screen
 * runs them: a delete is confirmed first (a tap on the wrong row should not
 * remove a trail report for good), and either one that fails says so instead
 * of becoming an unhandled rejection from an `onPress`.
 */

import { Alert } from 'react-native';
import { apiErrorMessage } from '../../api/error-message';

/**
 * Run an async action, alerting `failureTitle` with a sentence the hiker can
 * act on if it throws. Never rejects; resolves to whether it succeeded.
 */
export async function runCommentAction(
  action: () => Promise<unknown>,
  failureTitle: string,
  fallbackMessage: string,
): Promise<boolean> {
  try {
    await action();
    return true;
  } catch (error) {
    Alert.alert(failureTitle, apiErrorMessage(error, fallbackMessage));
    return false;
  }
}

/** Ask before deleting the hiker's own comment; `onDelete` runs only on Delete. */
export function confirmDeleteComment(onDelete: () => Promise<unknown>): void {
  Alert.alert('Delete comment', 'Delete your comment? This can’t be undone.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete',
      style: 'destructive',
      onPress: () =>
        void runCommentAction(
          onDelete,
          'Couldn’t delete comment',
          'Your comment wasn’t deleted. Please try again.',
        ),
    },
  ]);
}

/** Re-send what is waiting in the outbox, alerting if that fails outright. */
export function retryComment(onRetry: () => Promise<unknown>): Promise<boolean> {
  return runCommentAction(
    onRetry,
    'Couldn’t send comment',
    'Your comment is still saved on this phone. Please try again.',
  );
}
