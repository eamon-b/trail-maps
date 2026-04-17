import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { waypointEmojis } from './WaypointList';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { TrailWaypoint } from '../lib/trail-utils';

/** Height of the collapsed ElevationProfileDrawer (first snap point) */
const ELEVATION_DRAWER_COLLAPSED = 80;

interface WaypointDetailSheetProps {
  /** The waypoint to display, or null to hide the card */
  waypoint: TrailWaypoint | null;
  /** Called when the card is dismissed */
  onDismiss: () => void;
  /** Called after the exit animation has finished. Use this to sequence
   * follow-up actions (like expanding another sheet) so they don't clash
   * with an in-flight dismiss animation. */
  onExitComplete?: () => void;
  /** Distance from current GPS position in km (if available) */
  distanceFromUser?: number | null;
  /** Called when "Show on elevation profile" is tapped */
  onShowOnProfile?: (waypoint: TrailWaypoint) => void;
}

export function WaypointDetailSheet({
  waypoint,
  onDismiss,
  onExitComplete,
  distanceFromUser,
  onShowOnProfile,
}: WaypointDetailSheetProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const translateY = useRef(new Animated.Value(300)).current;
  const isVisible = useRef(false);
  // Keep last non-null waypoint so content stays visible during exit animation
  const lastWaypoint = useRef<TrailWaypoint | null>(null);
  if (waypoint) lastWaypoint.current = waypoint;
  const displayWaypoint = waypoint ?? lastWaypoint.current;

  // Hold the latest onExitComplete in a ref so the effect doesn't re-run
  // (and cancel the animation) when the callback identity changes.
  const onExitCompleteRef = useRef(onExitComplete);
  onExitCompleteRef.current = onExitComplete;

  useEffect(() => {
    if (waypoint) {
      isVisible.current = true;
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        damping: 20,
        stiffness: 200,
      }).start();
    } else if (isVisible.current) {
      Animated.timing(translateY, {
        toValue: 300,
        duration: 200,
        useNativeDriver: true,
      }).start(({ finished }) => {
        isVisible.current = false;
        if (finished) onExitCompleteRef.current?.();
      });
    }
  }, [waypoint, translateY]);

  if (!displayWaypoint) return null;

  const emoji = waypointEmojis[displayWaypoint.type] ?? waypointEmojis.poi ?? '📍';

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

      {onShowOnProfile && (
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
});
