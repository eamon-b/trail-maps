import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { AppMode, modeLabels, resolveTheme } from '../tokens/themes';
import { timingConfigs } from '../tokens/motion';
import { spacing, touchTarget } from '../tokens/spacing';
import { typography } from '../tokens/typography';

const STRIPE_HEIGHT = 8;
const EXPANDED_HEIGHT = 48;
const MODES: AppMode[] = ['plan', 'hike', 'contribute'];

export function ModeSelector() {
  const { mode, setMode, themeVariant, colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const insets = useSafeAreaInsets();
  const expanded = useSharedValue(0); // 0 = collapsed, 1 = expanded

  const toggle = useCallback(() => {
    'worklet';
    expanded.value = expanded.value === 0
      ? reduceMotion ? 1 : withTiming(1, timingConfigs.modeSwitch)
      : reduceMotion ? 0 : withTiming(0, timingConfigs.modeSwitch);
  }, [expanded, reduceMotion]);

  const selectMode = useCallback((newMode: AppMode) => {
    setMode(newMode);
    expanded.value = reduceMotion ? 0 : withTiming(0, timingConfigs.modeSwitch);
  }, [setMode, expanded, reduceMotion]);

  const containerStyle = useAnimatedStyle(() => ({
    height: STRIPE_HEIGHT + expanded.value * (EXPANDED_HEIGHT - STRIPE_HEIGHT),
    overflow: 'hidden' as const,
  }));

  return (
    <View style={{ paddingTop: insets.top }}>
      <Animated.View style={[styles.container, containerStyle]}>
        {/* Colored stripe — always visible, tap to expand */}
        <Pressable
          onPress={toggle}
          style={[styles.stripe, { backgroundColor: colors.accent }]}
          accessibilityLabel={`Current mode: ${modeLabels[mode]}. Tap to switch modes.`}
          accessibilityRole="button"
        />

        {/* Expanded segmented control */}
        <View style={[styles.segmentedControl, { backgroundColor: colors.surface }]}>
          {MODES.map((m) => {
            const isActive = m === mode;
            const modeColors = resolveTheme(themeVariant, m);
            return (
              <Pressable
                key={m}
                onPress={() => selectMode(m)}
                style={[
                  styles.segment,
                  isActive && { backgroundColor: modeColors.accent },
                ]}
                accessibilityLabel={`Switch to ${modeLabels[m]} mode`}
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <Animated.Text
                  style={[
                    styles.segmentText,
                    { color: isActive ? colors.textInverse : colors.textSecondary },
                  ]}
                >
                  {modeLabels[m]}
                </Animated.Text>
              </Pressable>
            );
          })}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  stripe: {
    height: STRIPE_HEIGHT,
    width: '100%',
  },
  segmentedControl: {
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    gap: spacing.xs,
  },
  segment: {
    flex: 1,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    paddingHorizontal: spacing.md,
  },
  segmentText: {
    ...typography.titleSmall,
  },
});
