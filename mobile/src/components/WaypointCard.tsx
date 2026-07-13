import React from 'react';
import { StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing } from '../tokens/spacing';
import { glyphSizes, typography } from '../tokens/typography';
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
  /** Naismith ETA text (e.g., "~50 min") */
  eta?: string;
  /** One-line context note (e.g., a water waypoint's tank condition) */
  note?: string;
  /** Which-way indicator (BearingIndicator), rendered at the card's right */
  bearing?: React.ReactNode;
  /** Emoji icon for waypoint type */
  icon?: string;
  /** Whether to use compact (2-column) layout */
  compact?: boolean;
  /** Message for empty state */
  emptyMessage?: string;
  /** Message for degraded state */
  degradedMessage?: string;
  /** Makes the card tappable (e.g. deep-link to the waypoint on the map) */
  onPress?: () => void;
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
  eta,
  note,
  bearing,
  icon,
  compact = false,
  emptyMessage,
  degradedMessage,
  onPress,
  style,
}: WaypointCardProps) {
  const { colors } = useTheme();

  const accessibilityLabel = state === 'normal' || state === 'degraded'
    ? `${label}: ${name ?? 'Unknown'}, ${distance ?? ''}${elevation ? `, ${elevation} elevation gain` : ''}${eta ? `, about ${eta.replace('~', '')}` : ''}`
    : undefined;

  // Tappable whenever there is a real waypoint target to open, regardless of
  // GPS state — a degraded fix (poor accuracy under canopy) must not disable
  // the deep-link tap. Undefined only when there's genuinely nothing to open.
  const cardOnPress = name ? onPress : undefined;

  return (
    <Card
      state={state}
      label={label}
      emptyMessage={emptyMessage ?? `No ${label.toLowerCase().replace('next ', '')} ahead`}
      degradedMessage={degradedMessage}
      style={style}
      accessibilityLabel={accessibilityLabel}
      onPress={cardOnPress}
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
          {eta && (
            <Text style={[styles.eta, { color: colors.textSecondary }]}>
              {eta}
            </Text>
          )}
          {note && (
            <Text
              style={[styles.note, { color: colors.textSecondary }]}
              numberOfLines={1}
            >
              {note}
            </Text>
          )}
        </View>
        {bearing && <View style={styles.bearing}>{bearing}</View>}
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
    fontSize: glyphSizes.xl,
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
  eta: {
    ...typography.caption,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginTop: spacing.xs,
  },
  note: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  bearing: {
    alignSelf: 'center',
  },
});
