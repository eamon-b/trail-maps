/**
 * Map key for the guide's track classes, and for the OSM points of interest.
 *
 * Colour and stroke alone tell the three classes apart on the map; this names
 * them, the way FarOut's map key does. Only the classes actually present on the
 * trail get a row, so a trail with no side trips never advertises one.
 *
 * The POI row is the exception to "colour + stroke": POIs are drawn in six
 * category colours, so the swatch is a hollow ring — the shape that tells a
 * POI badge from a curated waypoint's filled one — rather than any one hue.
 *
 * The swatches reuse the map's own paint constants (trackColors / TRACK_DASH)
 * rather than theme tokens, so the key can never drift from the lines it
 * describes — including in dark mode, where the map switches to the tinted
 * track palette and these swatches switch with it.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { trackColors } from './map-style';

/** Swatch stroke: `solid` bar, or N short segments approximating the dash. */
type Stroke = 'solid' | 'dashed' | 'dotted';

const SEGMENTS: Record<Stroke, number> = { solid: 1, dashed: 3, dotted: 5 };

export interface TrackLegendProps {
  /** Show the alternates row (trail has at least one drawn alternate). */
  hasAlternates?: boolean;
  /** Show the side-trips row (trail has at least one drawn side trip). */
  hasSideTrips?: boolean;
  /** Show the points-of-interest row (POI markers are currently drawn). */
  hasPois?: boolean;
}

export function TrackLegend({ hasAlternates, hasSideTrips, hasPois }: TrackLegendProps) {
  const { colors, isDark } = useTheme();
  const track = trackColors(isDark ? 'dark' : 'light');

  // With no variant class and no POIs there is nothing to disambiguate — the
  // only thing on the map is the trail, so the key would be noise.
  if (!hasAlternates && !hasSideTrips && !hasPois) return null;

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
      <LegendRow color={track.main} stroke="solid" label="Trail" />
      {hasAlternates && (
        <LegendRow color={track.alternate} stroke="dashed" label="Alternate" />
      )}
      {hasSideTrips && (
        <LegendRow color={track.sideTrip} stroke="dotted" label="Side trip" />
      )}
      {hasPois && <LegendDot label="Points of interest" />}
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

/**
 * A hollow ring in the swatch column, for the POI markers: they carry six
 * different category colours, so what identifies them is the shape — a thin
 * ring around a hole, against the filled badge a curated waypoint gets. The
 * ring is drawn in the chrome's own border ink for the same reason.
 */
function LegendDot({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.swatch, styles.dotSwatch]}>
        <View style={[styles.ring, { borderColor: colors.textSecondary }]} />
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
  dotSwatch: {
    justifyContent: 'center',
  },
  ring: {
    width: 10,
    height: 10,
    borderRadius: radii.full,
    borderWidth: 1.5,
  },
  label: {
    ...typography.caption,
    fontWeight: '600',
  },
});
