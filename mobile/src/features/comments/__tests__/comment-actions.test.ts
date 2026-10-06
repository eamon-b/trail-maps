/**
 * Deleting your own comment asks first, and a delete or retry that fails is
 * reported to the hiker rather than escaping an `onPress` as a rejection.
 */

import { Alert, type AlertButton } from 'react-native';
import { NetworkError } from '../../../api/client';
import { NETWORK_ERROR_MESSAGE } from '../../../api/error-message';
import { confirmDeleteComment, retryComment, runCommentAction } from '../comment-actions';

let alertSpy: jest.SpyInstance;
beforeEach(() => {
  alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
});
afterEach(() => alertSpy.mockRestore());

/** The buttons of the most recent alert. */
function lastButtons(): AlertButton[] {
  return alertSpy.mock.calls[alertSpy.mock.calls.length - 1][2] as AlertButton[];
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('confirmDeleteComment', () => {
  it('deletes nothing until the hiker confirms', async () => {
    const onDelete = jest.fn().mockResolvedValue(undefined);
    confirmDeleteComment(onDelete);
    expect(onDelete).not.toHaveBeenCalled();

    lastButtons().find((b) => b.text === 'Cancel')?.onPress?.();
    expect(onDelete).not.toHaveBeenCalled();

    lastButtons().find((b) => b.style === 'destructive')?.onPress?.();
    await flush();
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('says so when the delete fails', async () => {
    confirmDeleteComment(jest.fn().mockRejectedValue(new Error('disk full')));
    lastButtons().find((b) => b.style === 'destructive')?.onPress?.();
    await flush();
    expect(alertSpy).toHaveBeenLastCalledWith(
      'Couldn’t delete comment',
      'Your comment wasn’t deleted. Please try again.',
    );
  });
});

describe('retryComment', () => {
  it('reports an offline retry in words the hiker can act on', async () => {
    await expect(retryComment(jest.fn().mockRejectedValue(new NetworkError('x')))).resolves.toBe(
      false,
    );
    expect(alertSpy).toHaveBeenLastCalledWith('Couldn’t send comment', NETWORK_ERROR_MESSAGE);
  });
});

describe('runCommentAction', () => {
  it('stays quiet when the action succeeds', async () => {
    await expect(runCommentAction(jest.fn().mockResolvedValue(1), 'T', 'F')).resolves.toBe(true);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
