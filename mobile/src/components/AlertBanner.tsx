import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { springConfigs, timingConfigs } from '../tokens/motion';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';

export type AlertLevel = 'info' | 'warning' | 'error';

interface AlertBannerProps {
  /** Whether the banner is visible */
  visible: boolean;
  /** Alert severity level */
  level: AlertLevel;
  /** Alert message text */
  message: string;
  /** Called when the banner is tapped (e.g. to show snooze menu) */
  onPress?: () => void;
  /** Called when the banner finishes hiding */
  onHidden?: () => void;
}

/**
 * Slide-down alert banner from the top of the screen.
 * Uses spring animation (damping: 15, stiffness: 150) per spec.
 * Components accept state as props — Part 5 implements detection logic.
 */
export function AlertBanner({ visible, level, message, onPress, onHidden }: AlertBannerProps) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const translateY = useSharedValue(-100);

  const backgroundColor =
    level === 'error' ? colors.danger :
    level === 'warning' ? colors.alertAmber :
    colors.info;

  useEffect(() => {
    if (visible) {
      translateY.value = reduceMotion
        ? 0
        : withSpring(0, springConfigs.alertSlide);
    } else {
      translateY.value = reduceMotion
        ? -100
        : withTiming(-100, timingConfigs.slideIn, (finished) => {
            if (finished && onHidden) {
              runOnJS(onHidden)();
            }
          });
    }
  }, [visible, translateY, reduceMotion, onHidden]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  const levelIcon =
    level === 'error' ? '⛔' :
    level === 'warning' ? '⚠️' :
    'ℹ️';

  const content = (
    <View style={styles.content}>
      <Text style={styles.icon}>{levelIcon}</Text>
      <Text style={[styles.message, { color: colors.textInverse }]} numberOfLines={2}>
        {message}
      </Text>
    </View>
  );

  return (
    <Animated.View
      style={[
        styles.container,
        { paddingTop: insets.top + spacing.sm, backgroundColor },
        animatedStyle,
      ]}
      accessibilityRole="alert"
      accessibilityLabel={`${level} alert: ${message}`}
    >
      {onPress ? (
        <Pressable onPress={onPress} accessibilityRole="button" accessibilityHint="Tap to snooze alerts">
          {content}
        </Pressable>
      ) : (
        content
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  icon: {
    fontSize: 18,
  },
  message: {
    ...typography.body,
    flex: 1,
    fontWeight: '600',
  },
});
