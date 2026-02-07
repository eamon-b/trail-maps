import React from 'react';
import { StyleSheet, Text, View, Pressable } from 'react-native';
import { AppBottomSheet } from './AppBottomSheet';
import { waypointEmojis } from './WaypointList';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { TrailWaypoint } from '../lib/trail-utils';

interface WaypointDetailSheetProps {
  /** The waypoint to display, or null to hide the sheet */
  waypoint: TrailWaypoint | null;
  /** Called when the sheet is dismissed */
  onDismiss: () => void;
  /** Distance from current GPS position in km (if available) */
  distanceFromUser?: number | null;
  /** Called when "Show on elevation profile" is tapped */
  onShowOnProfile?: (waypoint: TrailWaypoint) => void;
}

export function WaypointDetailSheet({
  waypoint,
  onDismiss,
  distanceFromUser,
  onShowOnProfile,
}: WaypointDetailSheetProps) {
  const { colors } = useTheme();

  if (!waypoint) return null;

  const emoji = waypointEmojis[waypoint.type] ?? waypointEmojis.poi ?? '📍';

  return (
    <AppBottomSheet isOpen={!!waypoint} onDismiss={onDismiss} initialSnap={0}>
      <View style={styles.header}>
        <Text style={styles.emoji}>{emoji}</Text>
        <View style={styles.headerText}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{waypoint.name}</Text>
          <Text style={[styles.type, { color: colors.textSecondary }]}>{waypoint.type}</Text>
        </View>
      </View>

      <View style={styles.stats}>
        {waypoint.totalDistance != null && (
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {waypoint.totalDistance.toFixed(1)} km
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>along trail</Text>
          </View>
        )}

        {waypoint.elevation != null && (
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {Math.round(waypoint.elevation)} m
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>elevation</Text>
          </View>
        )}

        {distanceFromUser != null && (
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: colors.accent }]}>
              {distanceFromUser.toFixed(1)} km
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>from you</Text>
          </View>
        )}
      </View>

      {waypoint.description && (
        <Text style={[styles.description, { color: colors.textPrimary }]}>
          {waypoint.description}
        </Text>
      )}

      {onShowOnProfile && (
        <Pressable
          onPress={() => onShowOnProfile(waypoint)}
          style={[styles.profileButton, { borderColor: colors.accent }]}
          accessibilityLabel="Show on elevation profile"
          accessibilityRole="button"
        >
          <Text style={[styles.profileButtonText, { color: colors.accent }]}>
            Show on elevation profile
          </Text>
        </Pressable>
      )}
    </AppBottomSheet>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  emoji: {
    fontSize: 32,
    marginRight: spacing.md,
  },
  headerText: {
    flex: 1,
  },
  name: {
    ...typography.displaySmall,
    fontWeight: '600',
  },
  type: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginBottom: spacing.lg,
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    ...typography.caption,
  },
  description: {
    ...typography.body,
    marginBottom: spacing.lg,
    lineHeight: 22,
  },
  profileButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  profileButtonText: {
    ...typography.body,
    fontWeight: '600',
  },
});
