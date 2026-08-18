/**
 * Read-out for the variant (alternate / side trip) the user tapped on the map.
 *
 * A pinned bottom card rather than a route: an alternate is a decision made
 * while looking at the map, so the map has to stay visible behind it. It sits
 * where the route-builder bar sits, and MapPane hides the map's own bottom
 * chrome (legend + FAB stack) while it is open for the same reason that bar
 * does — the two cannot share that corner.
 *
 * All wording/unit handling lives in `variant-info`; this file only lays it out.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { DistanceUnit } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import { TRACK_COLORS } from './map-style';
import {
  variantElevationLine,
  variantJunctionLine,
  variantKindLabel,
  variantLengthLine,
  variantWaypointLine,
  type VariantInfo,
} from './variant-info';

export interface VariantInfoCardProps {
  info: VariantInfo;
  unit: DistanceUnit;
  onDismiss: () => void;
}

export function VariantInfoCard({ info, unit, onDismiss }: VariantInfoCardProps) {
  const { colors } = useTheme();

  const length = variantLengthLine(info, unit);
  const elevation = variantElevationLine(info, unit);
  const junction = variantJunctionLine(info, unit);
  const waypoints = variantWaypointLine(info);

  // The swatch reuses the map's own track colours (not theme tokens) so the
  // card can never disagree with the line the user just tapped.
  const swatchColor =
    info.kind === 'alternate' ? TRACK_COLORS.alternate : TRACK_COLORS.sideTrip;

  return (
    <View
      accessibilityRole="summary"
      accessibilityLabel={`${variantKindLabel(info.kind)}: ${info.name}`}
      style={[
        styles.card,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.heading}>
          <View style={styles.kindRow}>
            <View style={[styles.swatch, { backgroundColor: swatchColor }]} />
            <Text style={[styles.kind, { color: colors.textSecondary }]}>
              {variantKindLabel(info.kind)}
            </Text>
          </View>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={2}>
            {info.name}
          </Text>
        </View>

        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss route details"
          hitSlop={spacing.sm}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}
        >
          <Text style={[styles.closeIcon, { color: colors.textSecondary }]}>✕</Text>
        </Pressable>
      </View>

      {(length || elevation) && (
        <View style={styles.stats}>
          {length && (
            <Text style={[styles.stat, { color: colors.textPrimary }]}>{length}</Text>
          )}
          {elevation && (
            <Text style={[styles.stat, { color: colors.textSecondary }]}>{elevation}</Text>
          )}
        </View>
      )}

      {junction && (
        <Text style={[styles.detail, { color: colors.textSecondary }]}>{junction}</Text>
      )}
      {waypoints && (
        <Text style={[styles.detail, { color: colors.textSecondary }]}>{waypoints}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.xl,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  heading: {
    flex: 1,
    gap: 2,
  },
  kindRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  swatch: {
    width: 14,
    height: 3,
    borderRadius: radii.full,
  },
  kind: {
    ...typography.titleSmall,
  },
  name: {
    ...typography.body,
    fontWeight: '600',
  },
  close: {
    minWidth: touchTarget.min,
    minHeight: touchTarget.min,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  closeIcon: {
    fontSize: glyphSizes.md,
  },
  stats: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.md,
  },
  stat: {
    ...typography.displaySmall,
    fontVariant: ['tabular-nums'],
  },
  detail: {
    ...typography.bodySmall,
    fontVariant: ['tabular-nums'],
  },
  pressed: {
    opacity: 0.6,
  },
});
