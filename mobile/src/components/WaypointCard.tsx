import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { Card, CardState, StatDisplay } from './Card';

interface WaypointCardProps {
  /** Card visual state */
  state?: CardState;
  /** Section label (e.g., "NEXT CAMPSITE", "NEXT WATER") */
  label: string;
  /** Waypoint name */
  name?: string;
  /** Distance text (e.g., "12.4 km") */
  distance?: string;
  /** Elevation text (e.g., "+310m") */
  elevation?: string;
  /** Emoji icon for waypoint type */
  icon?: string;
  /** Whether to use compact (2-column) layout */
  compact?: boolean;
  /** Message for empty state */
  emptyMessage?: string;
  /** Message for degraded state */
  degradedMessage?: string;
  /** Additional styles */
  style?: ViewStyle;
}

/** Card displaying distance to next waypoint of a specific type */
export function WaypointCard({
  state = 'normal',
  label,
  name,
  distance,
  elevation,
  icon,
  compact = false,
  emptyMessage,
  degradedMessage,
  style,
}: WaypointCardProps) {
  const { colors } = useTheme();

  const accessibilityLabel = state === 'normal' || state === 'degraded'
    ? `${label}: ${name ?? 'Unknown'}, ${distance ?? ''}${elevation ? `, ${elevation} elevation gain` : ''}`
    : undefined;

  return (
    <Card
      state={state}
      label={label}
      emptyMessage={emptyMessage ?? `No ${label.toLowerCase().replace('next ', '')} ahead`}
      degradedMessage={degradedMessage}
      style={style}
      accessibilityLabel={accessibilityLabel}
    >
      <View style={styles.content}>
        {icon && !compact && (
          <Text style={styles.icon}>{icon}</Text>
        )}
        <View style={styles.info}>
          <Text
            style={[
              compact ? styles.nameCompact : styles.name,
              { color: colors.textPrimary },
            ]}
            numberOfLines={1}
          >
            {name}
          </Text>
          <StatDisplay
            primary={distance ?? '--'}
            secondary={elevation}
            compact={compact}
          />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  icon: {
    fontSize: 24,
  },
  info: {
    flex: 1,
  },
  name: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  nameCompact: {
    ...typography.caption,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
});
