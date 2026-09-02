/**
 * Header chrome for the Expo Router stacks — the icon-only actions that sit in
 * `headerRight` on the root header (Import GPX, Settings) and the guide header
 * (Routes, Plan, Offline maps, Settings).
 *
 * Lives in `src/navigation/` rather than a feature slice because the feature
 * slices never import each other, and this is shared by two navigators that
 * belong to no single feature — Settings in particular is deliberately the same
 * affordance in both headers (see app/_layout.tsx).
 *
 * Icons are MaterialCommunityIcons: one family for all six actions, so stroke
 * weight and optical size match across the header, and the set has purpose-drawn
 * glyphs for the trail vocabulary (a branching route) that a generic UI set
 * lacks. Imported by subpath so Metro bundles one icon font, not all of them.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { glyphSizes, spacing } from '../tokens';

export type HeaderIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

type HeaderIconButtonProps = {
  /** MaterialCommunityIcons glyph name. */
  name: HeaderIconName;
  /** Spoken name of the action — the only label a screen reader gets. */
  accessibilityLabel: string;
  onPress: () => void;
};

/**
 * One header action. Padding plus `hitSlop` give the touch target; the icon
 * itself does not grow with the OS font-size setting, so a long title and a
 * large-text setting can no longer collide in the header.
 */
export function HeaderIconButton({ name, accessibilityLabel, onPress }: HeaderIconButtonProps) {
  const { colors } = useTheme();

  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.button}
      hitSlop={spacing.sm}
    >
      <MaterialCommunityIcons
        name={name}
        size={glyphSizes.lg}
        color={colors.accentText}
      />
    </Pressable>
  );
}

/** Row wrapper for a header's actions — keeps the gap consistent everywhere. */
export function HeaderActions({ children }: { children: ReactNode }) {
  return <View style={styles.actions}>{children}</View>;
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  button: {
    paddingHorizontal: spacing.sm,
  },
});
