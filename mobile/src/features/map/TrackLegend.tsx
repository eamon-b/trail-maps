/**
 * Map key for the guide's track classes.
 *
 * Colour and stroke alone tell the three classes apart on the map; this names
 * them, the way FarOut's map key does. Only the classes actually present on the
 * trail get a row, so a trail with no side trips never advertises one.
 *
 * The swatches reuse the map's own paint constants (TRACK_COLORS / TRACK_DASH)
 * rather than theme tokens, so the key can never drift from the lines it
 * describes — those colours are deliberately theme-independent because both
 * base maps are light in either app theme.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { TRACK_COLORS } from './map-style';

/** Swatch stroke: `solid` bar, or N short segments approximating the dash. */
type Stroke = 'solid' | 'dashed' | 'dotted';

const SEGMENTS: Record<Stroke, number> = { solid: 1, dashed: 3, dotted: 5 };

export interface TrackLegendProps {
  /** Show the alternates row (trail has at least one drawn alternate). */
  hasAlternates?: boolean;
  /** Show the side-trips row (trail has at least one drawn side trip). */
  hasSideTrips?: boolean;
}

export function TrackLegend({ hasAlternates, hasSideTrips }: TrackLegendProps) {
  const { colors } = useTheme();

  // With neither variant class there is nothing to disambiguate — the only line
  // on the map is the trail, so the key would be noise.
  if (!hasAlternates && !hasSideTrips) return null;

  return (
    <View
      style={[
        styles.root,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
      ]}
      pointerEvents="none"
      accessibilityRole="summary"
      accessibilityLabel="Map key"
    >
      <LegendRow color={TRACK_COLORS.main} stroke="solid" label="Trail" />
      {hasAlternates && (
        <LegendRow color={TRACK_COLORS.alternate} stroke="dashed" label="Alternate" />
      )}
      {hasSideTrips && (
        <LegendRow color={TRACK_COLORS.sideTrip} stroke="dotted" label="Side trip" />
      )}
    </View>
  );
}

function LegendRow({
  color,
  stroke,
  label,
}: {
  color: string;
  stroke: Stroke;
  label: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.swatch}>
        {Array.from({ length: SEGMENTS[stroke] }, (_, i) => (
          <View key={i} style={[styles.segment, { backgroundColor: color }]} />
        ))}
      </View>
      <Text style={[styles.label, { color: colors.textPrimary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  swatch: {
    width: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  segment: {
    flex: 1,
    height: 3,
    borderRadius: radii.full,
  },
  label: {
    ...typography.caption,
    fontWeight: '600',
  },
});
