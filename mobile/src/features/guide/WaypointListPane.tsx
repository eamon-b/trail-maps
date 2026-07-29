/**
 * Waypoint list pane — a real (if basic) FarOut-style datasheet.
 *
 * Rows are ordered by cumulative distance and show type, name, distance
 * (unit-aware), and elevation. No filters yet — that's a later phase.
 */

import React, { useMemo } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import type { TrailJson } from '../../services/trail-loader';
import { orderedWaypoints } from './guide-trail';

type Waypoint = TrailJson['waypoints'][number];

export function WaypointListPane({ trail }: { trail: TrailJson }) {
  const { colors } = useTheme();
  const units = useSettingsStore((s) => s.units);
  const data = useMemo(() => orderedWaypoints(trail), [trail]);

  return (
    <FlatList
      data={data}
      keyExtractor={(w, i) => w.id ?? `${w.name}-${i}`}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      renderItem={({ item }) => <WaypointRow waypoint={item} units={units} />}
      ItemSeparatorComponent={() => (
        <View style={[styles.separator, { backgroundColor: colors.border }]} />
      )}
    />
  );
}

function WaypointRow({ waypoint, units }: { waypoint: Waypoint; units: 'km' | 'mi' }) {
  const { colors } = useTheme();
  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text
          style={[styles.type, { color: colors.accent }]}
          numberOfLines={1}
        >
          {waypoint.type}
        </Text>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {waypoint.name}
        </Text>
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.distance, { color: colors.textPrimary }]}>
          {formatDistance(waypoint.totalDistance ?? 0, units)}
        </Text>
        {waypoint.elevation != null && (
          <Text style={[styles.elevation, { color: colors.textSecondary }]}>
            {Math.round(waypoint.elevation)} m
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
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
  rowMeta: {
    alignItems: 'flex-end',
    gap: spacing.xs,
  },
  type: {
    ...typography.titleSmall,
  },
  name: {
    ...typography.body,
  },
  distance: {
    ...typography.dataSmall,
  },
  elevation: {
    ...typography.caption,
  },
});
