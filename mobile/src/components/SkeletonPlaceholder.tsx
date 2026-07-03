import React, { useEffect } from 'react';
import { ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { radii } from '../tokens/spacing';

interface SkeletonPlaceholderProps {
  width: number | string;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}

/** Animated shimmer skeleton for loading states */
export function SkeletonPlaceholder({
  width,
  height,
  borderRadius = radii.md,
  style,
}: SkeletonPlaceholderProps) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();
  const opacity = useSharedValue(0.3);

  useEffect(() => {
    if (!reduceMotion) {
      opacity.value = withRepeat(withTiming(0.7, { duration: 1000 }), -1, true);
    }
    return () => cancelAnimation(opacity);
  }, [opacity, reduceMotion]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.5 : opacity.value,
  }));

  return (
    <Animated.View
      accessibilityLabel="Loading"
      style={[
        {
          width: width as number,
          height,
          borderRadius,
          backgroundColor: colors.border,
        },
        animatedStyle,
        style,
      ]}
    />
  );
}
