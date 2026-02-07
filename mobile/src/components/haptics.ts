import * as Haptics from 'expo-haptics';
import { durations } from '../tokens/motion';
import type { LocationState } from './LocationStatusBar';

/**
 * Haptic feedback patterns for location alert states.
 * Part 5 triggers these; this module defines the patterns.
 */

/** Fire haptic feedback for a given location state */
export async function triggerLocationHaptic(state: LocationState): Promise<void> {
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
