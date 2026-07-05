import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { waypointEmojis } from './WaypointList';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { isCustomWaypointId, type TrailWaypoint } from '../lib/trail-utils';

/** Height of the collapsed ElevationProfileDrawer (first snap point) */
const ELEVATION_DRAWER_COLLAPSED = 80;

interface WaypointDetailSheetProps {
  /** The waypoint to display, or null to hide the card */
  waypoint: TrailWaypoint | null;
  /** Called when the card is dismissed */
  onDismiss: () => void;
  /** Distance from current GPS position in km (if available) */
  distanceFromUser?: number | null;
  /** Called when "Show on elevation profile" is tapped */
  onShowOnProfile?: (waypoint: TrailWaypoint) => void;
  /** Called when "Edit waypoint" is tapped (custom waypoints only) */
  onEdit?: (waypoint: TrailWaypoint) => void;
  /** Called when "Delete waypoint" is tapped (custom waypoints only) */
  onDelete?: (waypoint: TrailWaypoint) => void;
}

export function WaypointDetailSheet({
  waypoint,
  onDismiss,
  distanceFromUser,
  onShowOnProfile,
  onEdit,
  onDelete,
}: WaypointDetailSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(300)).current;
  // Snapshot of what to render. Captured from the prop on open, cleared
  // only when the exit animation completes, so the view has content to
  // animate out even after the parent has dropped the waypoint.
  const [displayWaypoint, setDisplayWaypoint] = useState<TrailWaypoint | null>(null);

  useEffect(() => {
    if (waypoint) {
      setDisplayWaypoint(waypoint);
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start();
    } else if (displayWaypoint) {
      Animated.timing(translateY, {
        toValue: 300,
        duration: 200,
        useNativeDriver: true,
      }).start(() => {
        setDisplayWaypoint(null);
      });
    }
    // displayWaypoint intentionally excluded — the exit branch reads it
    // only at the moment the prop goes null, and we don't want setState
    // callbacks to re-trigger the effect while the animation is running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waypoint, translateY]);

  if (!displayWaypoint) return null;

  const emoji = waypointEmojis[displayWaypoint.type] ?? waypointEmojis.poi ?? '📍';
  const isCustom = isCustomWaypointId(displayWaypoint.id);

  return (
    <Animated.View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          bottom: ELEVATION_DRAWER_COLLAPSED + spacing.sm + insets.bottom,
          transform: [{ translateY }],
        },
      ]}
      pointerEvents={waypoint ? 'auto' : 'none'}
    >
      <View style={styles.header}>
        <Text style={styles.emoji}>{emoji}</Text>
        <View style={styles.headerText}>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {displayWaypoint.name}
          </Text>
          <Text style={[styles.type, { color: colors.textSecondary }]}>{displayWaypoint.type}</Text>
        </View>
        <Pressable
          onPress={onDismiss}
          style={styles.closeButton}
          accessibilityLabel="Dismiss waypoint info"
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={[styles.closeIcon, { color: colors.textSecondary }]}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.stats}>
        {displayWaypoint.totalDistance != null && (
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {displayWaypoint.totalDistance.toFixed(1)} km
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>along trail</Text>
          </View>
        )}

        {displayWaypoint.elevation != null && (
          <View style={styles.statItem}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {Math.round(displayWaypoint.elevation)} m
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

      {displayWaypoint.description ? (
        <Text style={[styles.description, { color: colors.textPrimary }]} numberOfLines={2}>
          {displayWaypoint.description}
        </Text>
      ) : null}

      {/* A waypoint without a trail km can't be placed on the profile */}
      {onShowOnProfile && displayWaypoint.totalDistance != null && (
        <Pressable
          onPress={() => onShowOnProfile(displayWaypoint)}
          style={[styles.profileButton, { borderColor: colors.accent }]}
          accessibilityLabel="Show on elevation profile"
          accessibilityRole="button"
        >
          <Text style={[styles.profileButtonText, { color: colors.accent }]}>
            Show on elevation profile
          </Text>
        </Pressable>
      )}

      {/* User-created waypoints can be edited or deleted */}
      {isCustom && (onEdit || onDelete) && (
        <View style={styles.customActions}>
          {onEdit && (
            <Pressable
              onPress={() => onEdit(displayWaypoint)}
              style={[styles.customActionButton, { borderColor: colors.accent }]}
              accessibilityLabel="Edit waypoint"
              accessibilityRole="button"
            >
              <Text style={[styles.customActionText, { color: colors.accent }]}>
                Edit waypoint
              </Text>
            </Pressable>
          )}
          {onDelete && (
            <Pressable
              onPress={() => onDelete(displayWaypoint)}
              style={[styles.customActionButton, { borderColor: colors.alertRed }]}
              accessibilityLabel="Delete waypoint"
              accessibilityRole="button"
            >
              <Text style={[styles.customActionText, { color: colors.alertRed }]}>
                Delete waypoint
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  emoji: {
    fontSize: 28,
    marginRight: spacing.sm,
  },
  headerText: {
    flex: 1,
  },
  name: {
    ...typography.body,
    fontWeight: '600',
  },
  type: {
    ...typography.caption,
    marginTop: 2,
  },
  closeButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: spacing.sm,
  },
  closeIcon: {
    fontSize: 18,
    fontWeight: '600',
  },
  stats: {
    flexDirection: 'row',
    gap: spacing.xl,
    marginBottom: spacing.md,
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
    ...typography.caption,
    marginBottom: spacing.md,
    lineHeight: 20,
  },
  profileButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  profileButtonText: {
    ...typography.caption,
    fontWeight: '600',
  },
  customActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  customActionButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  customActionText: {
    ...typography.caption,
    fontWeight: '600',
  },
});
