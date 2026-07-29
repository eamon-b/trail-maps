/**
 * Bridges a composed check-in to the OS share sheet.
 *
 * Wraps React Native's built-in `Share.share`. A user cancelling the sheet
 * resolves normally (RN reports `dismissedAction`, no throw), so there is no
 * error UI to show for the common case; only genuine failures are logged.
 *
 * On Android only `message` is surfaced to the target app; `title`/`subject`
 * are used as the intent title where supported. We pass both so iOS gets a
 * subject line and Android an honest dialog title.
 */

import { useCallback } from 'react';
import { Share } from 'react-native';
import { composeCheckIn, type CheckInInput } from './check-in';

export type ShareCheckIn = (input: CheckInInput) => Promise<void>;

export function useCheckInShare(): ShareCheckIn {
  return useCallback(async (input: CheckInInput) => {
    const { title, message } = composeCheckIn(input);
    try {
      await Share.share(
        { title, message },
        { subject: title, dialogTitle: title },
      );
    } catch (err) {
      // Genuine failure (not a user cancel, which resolves). Nothing actionable
      // for the hiker — just leave a breadcrumb.
      console.warn('[share] check-in share failed', err);
    }
  }, []);
}
