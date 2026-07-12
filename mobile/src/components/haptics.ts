import * as Haptics from 'expo-haptics';
import { durations } from '../tokens/motion';
import type { LocationState } from './LocationStatusBar';

/**
 * App-wide haptics vocabulary. Components speak in these four verbs instead
 * of raw expo-haptics calls, so feedback stays consistent everywhere:
 * - selection: a light tick for taps/toggles (PressableRow's default)
 * - success:   a saved/completed confirmation
 * - warning:   destructive-adjacent or attention-needed feedback
 * - error:     a failed action
 */
export type HapticType = 'selection' | 'success' | 'warning' | 'error';

/**
 * User preference gate. Haptics fire unless the user disables them in
 * Settings ("Haptic feedback", default on). Hydrated once at app start from
 * AsyncStorage (root layout) and updated live by the setting, so every call
 * site — PressableRow and the raw triggerHaptic/triggerLocationHaptic callers
 * — honours the preference for free.
 *
 * NOTE: deliberately independent of reduce-motion. Vibration is not motion;
 * a user who reduces animation may still want tactile feedback, so the two
 * preferences are kept separate.
 */
let hapticsEnabled = true;

/** Update the global haptics-enabled preference (Settings toggle / app start). */
export function setHapticsEnabled(enabled: boolean): void {
  hapticsEnabled = enabled;
}

/** Current haptics-enabled preference (exposed mainly for tests). */
export function getHapticsEnabled(): boolean {
  return hapticsEnabled;
}

/** Fire a vocabulary haptic. Failures are swallowed (haptics are best-effort). */
export async function triggerHaptic(type: HapticType): Promise<void> {
  if (!hapticsEnabled) return;
  try {
    switch (type) {
      case 'selection':
        await Haptics.selectionAsync();
        return;
      case 'success':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        return;
      case 'warning':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        return;
      case 'error':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
    }
  } catch {
    // Haptics unavailable (simulator, disabled) — never let feedback throw.
  }
}

/**
 * Haptic feedback patterns for location alert states.
 * Part 5 triggers these; this module defines the patterns.
 */

/** Fire haptic feedback for a given location state */
export async function triggerLocationHaptic(state: LocationState): Promise<void> {
  if (!hapticsEnabled) return;
  switch (state) {
    case 'onTrail':
    case 'noGps':
    case 'drifting':
      // No haptic for these states
      return;
    case 'warning':
      // Single light tap
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      return;
    case 'offTrail':
      // Medium impact, repeats once after 2s
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setTimeout(() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }, durations.hapticRepeat);
      return;
  }
}
