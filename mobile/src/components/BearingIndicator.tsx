import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { glyphSizes, typography } from '../tokens/typography';
import {
  cardinalDirection,
  isHeadingUsable,
  relativeRotation,
} from '../lib/bearing';

interface BearingIndicatorProps {
  /** Bearing from the current position to the target, degrees from north */
  targetBearing: number;
  /** GPS course-over-ground heading (degrees from north), or null */
  heading?: number | null;
  /** Ground speed in m/s (gates whether the heading is trustworthy) */
  speed?: number | null;
  /** Timestamp of the last GPS fix (ms epoch) */
  fixTimestamp?: number | null;
  style?: ViewStyle;
}

/**
 * Which-way indicator for the next-waypoint cards and the off-trail banner
 * (P1 PR C, decision 8).
 *
 * GPS heading is course-over-ground: valid while moving, garbage standing
 * still. The rotating arrow renders only when the user is moving
 * (speed > 0.5 m/s) with a fresh fix (< 60 s); otherwise it degrades to the
 * absolute cardinal text ("NE"), which needs no device orientation. This
 * gating is a hard requirement — a stale arrow is worse than none.
 */
export function BearingIndicator({
  targetBearing,
  heading,
  speed,
  fixTimestamp,
  style,
}: BearingIndicatorProps) {
  const { colors } = useTheme();

  const cardinal = cardinalDirection(targetBearing);
  const useArrow = heading != null && isHeadingUsable(speed, fixTimestamp);

  if (!useArrow) {
    return (
      <View
        style={[styles.container, style]}
        accessibilityLabel={`Direction: ${cardinal}, bearing ${Math.round(targetBearing)} degrees`}
      >
        <Text style={[styles.cardinalText, { color: colors.textSecondary }]}>{cardinal}</Text>
      </View>
    );
  }

  const rotation = relativeRotation(targetBearing, heading);

  return (
    <View
      style={[styles.container, style]}
      accessibilityLabel={`Direction: ${cardinal}, ${Math.round(Math.abs(rotation))} degrees ${rotation >= 0 ? 'right' : 'left'} of your course`}
    >
      <Text
        style={[
          styles.arrow,
          { color: colors.accent, transform: [{ rotate: `${rotation}deg` }] },
        ]}
      >
        ↑
      </Text>
      <Text style={[styles.cardinalText, { color: colors.textSecondary }]}>{cardinal}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 36,
  },
  arrow: {
    fontSize: glyphSizes.lg,
    fontWeight: '700',
  },
  cardinalText: {
    ...typography.caption,
    fontWeight: '700',
  },
});
