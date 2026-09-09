/**
 * One OpenStreetMap point of interest in the datasheet.
 *
 * Deliberately close to a waypoint row in layout — same two columns, same
 * signed distance-from-me — and deliberately unmistakable in content: an "OSM"
 * pill sits where the waypoint type goes, the category label carries the map's
 * category colour, and the meta column shows how far off the trail the place is
 * instead of an elevation. A POI is a lead the walker checks, not a waypoint the
 * trail data stands behind, so it carries no favourite heart, no water chip and
 * no comment count.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance, type DistanceUnit } from '@lib/format-distance';
import { poiCategoryLabel, poiDisplayName } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { poiColor } from '../elevation/waypoint-category';
import { formatSignedDistance } from './waypoint-filters';

export function PoiRow({
  poi,
  units,
  currentKm,
  onPress,
}: {
  poi: TrailPOI;
  units: DistanceUnit;
  currentKm: number | null;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const name = poiDisplayName(poi);
  const color = poiColor(poi.category, colors);

  // With a fix: signed distance from me. Without: the plain cumulative km.
  // Same read as the waypoint rows, so a mixed list stays scannable.
  const signed =
    currentKm != null ? formatSignedDistance(poi.distanceAlongTrail - currentKm, units) : null;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${name} (OpenStreetMap)`}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <View style={styles.row}>
        <View style={styles.rowMain}>
          <View style={styles.typeRow}>
            <View style={[styles.osmPill, { borderColor: colors.textSecondary }]}>
              <Text style={[styles.osmPillText, { color: colors.textSecondary }]}>OSM</Text>
            </View>
            <Text style={[styles.type, { color }]} numberOfLines={1}>
              {poiCategoryLabel(poi.category)}
            </Text>
          </View>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {name}
          </Text>
        </View>
        <View style={styles.rowMeta}>
          {signed ? (
            <Text
              style={[
                styles.distance,
                { color: signed.direction === 'behind' ? colors.textSecondary : colors.textPrimary },
              ]}
            >
              {signed.label}
            </Text>
          ) : (
            <Text style={[styles.distance, { color: colors.textPrimary }]}>
              {formatDistance(poi.distanceAlongTrail, units)}
            </Text>
          )}
          <Text style={[styles.offTrail, { color: colors.textSecondary }]}>
            {`${formatDistance(poi.distanceFromTrail, units)} off trail`}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    gap: spacing.md,
    borderRadius: radii.sm,
  },
  rowMain: {
    flex: 1,
    gap: spacing.xs,
  },
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  osmPill: {
    flexShrink: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  osmPillText: {
    ...typography.caption,
    fontWeight: '600',
  },
  type: {
    ...typography.titleSmall,
    flexShrink: 1,
  },
  name: {
    ...typography.body,
    flexShrink: 1,
  },
  rowMeta: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  distance: {
    ...typography.dataSmall,
  },
  offTrail: {
    ...typography.caption,
  },
  pressed: {
    opacity: 0.6,
  },
});
