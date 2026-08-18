/**
 * A compact, presentational share affordance — a single glyph button used both
 * in the guide distance strip and on the waypoint detail hero. Colour comes
 * from the caller (theme-resolved) so it can sit on a surface or a header.
 */

import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { glyphSizes, spacing } from '../../tokens';

export function ShareIconButton({
  onPress,
  color,
  size = glyphSizes.lg,
  accessibilityLabel = 'Share check-in',
}: {
  onPress: () => void;
  color: string;
  size?: number;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={spacing.sm}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Text style={[styles.icon, { color, fontSize: size }]}>⤴</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { padding: spacing.xs },
  pressed: { opacity: 0.6 },
  icon: { includeFontPadding: false },
});
