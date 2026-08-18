import { AccessibilityInfo } from 'react-native';
import { Easing, WithSpringConfig, WithTimingConfig } from 'react-native-reanimated';

/**
 * Standard motion tokens for all animations.
 * All animations must respect isReduceMotionEnabled — when enabled,
 * skip animations and show the final state immediately.
 */

/** Timing-based animation configs */
export const timingConfigs = {
  /** Button press feedback */
  tap: {
    duration: 100,
    easing: Easing.out(Easing.ease),
  } satisfies WithTimingConfig,

  /** Alert banners, toasts slide in */
  slideIn: {
    duration: 250,
    easing: Easing.out(Easing.ease),
  } satisfies WithTimingConfig,

  /** Color/state cross-fades */
  crossfade: {
    duration: 200,
    easing: Easing.inOut(Easing.ease),
  } satisfies WithTimingConfig,
} as const;

/** Spring-based animation configs */
export const springConfigs = {
  /** Bottom sheet open/close */
  sheetOpen: {
    damping: 20,
    stiffness: 200,
  } satisfies WithSpringConfig,

  /** Alert banner slide-down */
  alertSlide: {
    damping: 15,
    stiffness: 150,
  } satisfies WithSpringConfig,

  /** Drag reorder settle */
  cardReorder: {
    damping: 18,
    stiffness: 180,
  } satisfies WithSpringConfig,
} as const;

/** Durations for non-animated delays (toast display, etc.) */
export const durations = {
  /** Undo toast display time */
  undoToast: 3000,
  /** Off-trail haptic repeat delay */
  hapticRepeat: 2000,
} as const;

/**
 * Check if reduce motion is enabled.
 * Call this and use the result to skip animations when true.
 */
export async function isReduceMotionEnabled(): Promise<boolean> {
  return AccessibilityInfo.isReduceMotionEnabled();
}

/**
 * Subscribe to reduce motion preference changes.
 * Returns an unsubscribe function.
 */
export function onReduceMotionChange(callback: (enabled: boolean) => void): () => void {
  const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', callback);
  return () => subscription.remove();
}
