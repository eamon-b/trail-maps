import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import type { TrailWaypoint } from '../lib/trail-utils';
import { waypointEmojis } from './WaypointList';
import { spacing, touchTarget, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface StopSelectorProps {
  waypoints: TrailWaypoint[];
  /** Set of km positions that are currently selected as stops */
  selectedStopKms: Set<number>;
  onToggleStop: (waypoint: TrailWaypoint) => void;
}

/**
 * List of eligible waypoints for stop selection.
 * Includes search/filter by name. Selected stops are highlighted.
 * Tap toggles selection.
 */
export function StopSelector({
  waypoints,
  selectedStopKms,
  onToggleStop,
}: StopSelectorProps) {
  const { colors } = useTheme();
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    if (!search.trim()) return waypoints;
    const q = search.trim().toLowerCase();
    return waypoints.filter(wp => wp.name.toLowerCase().includes(q));
  }, [waypoints, search]);

  const renderItem = useCallback(
    ({ item, index }: { item: TrailWaypoint; index: number }) => {
      const km = item.totalDistance ?? 0;
      const isSelected = selectedStopKms.has(km);
      const emoji = waypointEmojis[item.type] ?? waypointEmojis.poi;

      // Distance from previous waypoint in the filtered list
      const prevKm = index > 0 ? (filtered[index - 1].totalDistance ?? 0) : 0;
      const gapKm = km - prevKm;

      return (
        <Pressable
          onPress={() => onToggleStop(item)}
          style={[
            styles.row,
            {
              backgroundColor: isSelected ? colors.accentSubtle : 'transparent',
              borderColor: isSelected ? colors.accent : colors.border,
            },
          ]}
          accessibilityLabel={`${item.name}, ${km.toFixed(1)} km${isSelected ? ', selected' : ''}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: isSelected }}
        >
          <Text style={styles.emoji}>{emoji}</Text>
          <View style={styles.content}>
            <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
              {item.name}
            </Text>
            <View style={styles.meta}>
              <Text style={[styles.km, { color: colors.textSecondary }]}>
                km {km.toFixed(1)}
              </Text>
              {index > 0 && (
                <Text style={[styles.gap, { color: colors.textSecondary }]}>
                  +{gapKm.toFixed(1)} km
                </Text>
              )}
            </View>
          </View>
          {isSelected && (
            <Text style={[styles.check, { color: colors.accent }]}>✓</Text>
          )}
        </Pressable>
      );
    },
    [filtered, selectedStopKms, onToggleStop, colors],
  );

  return (
    <View>
      <Text style={[styles.header, { color: colors.textPrimary }]}>Select Stops</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        Tap to toggle overnight stops. Days are computed automatically.
      </Text>
      <TextInput
        style={[
          styles.searchInput,
          {
            color: colors.textPrimary,
            backgroundColor: colors.surface,
            borderColor: colors.border,
          },
        ]}
        value={search}
        onChangeText={setSearch}
        placeholder="Filter by name..."
        placeholderTextColor={colors.textSecondary}
        autoCorrect={false}
        clearButtonMode="while-editing"
        accessibilityLabel="Filter waypoints"
      />
      {filtered.length === 0 && search.trim() ? (
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          No stops matching &quot;{search.trim()}&quot;
        </Text>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => `${item.name}-${item.totalDistance ?? 0}`}
          renderItem={renderItem}
          scrollEnabled={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    ...typography.titleLarge,
    marginBottom: spacing.xs,
  },
  subtitle: {
    ...typography.caption,
    marginBottom: spacing.sm,
  },
  searchInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    marginBottom: spacing.md,
  },
  emptyText: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: spacing.xs,
  },
  emoji: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  content: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  name: {
    ...typography.body,
  },
  meta: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 2,
  },
  km: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  gap: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  check: {
    fontSize: 20,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },
});
