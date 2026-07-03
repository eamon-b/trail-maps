import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing, touchTarget, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

/** Emoji icons for waypoint types — leveraging existing 14 types from the web app */
export const waypointEmojis: Record<string, string> = {
  town: '🏘️',
  hut: '🛖',
  campsite: '⛺',
  water: '💧',
  shelter: '🏚️',
  road: '🛣️',
  trailhead: '🥾',
  summit: '⛰️',
  lookout: '👁️',
  bridge: '🌉',
  carpark: '🅿️',
  information: 'ℹ️',
  danger: '⚠️',
  poi: '📍',
};

export interface WaypointListItem {
  id: string | number;
  name: string;
  type: string;
  /** Distance along trail in km */
  kmPosition?: number;
  /** Relative distance from current position */
  distanceAhead?: string;
}

interface WaypointListProps {
  waypoints: WaypointListItem[];
  /** ID of the currently focused waypoint */
  focusedId?: string | number;
  /** Called when a waypoint is tapped */
  onSelect?: (waypoint: WaypointListItem) => void;
  /** Maximum items to show before "See all" */
  maxItems?: number;
  /** Called when "See all" is tapped */
  onSeeAll?: () => void;
  style?: ViewStyle;
}

// Fixed row height: minHeight(44) + marginBottom(2)
const ITEM_HEIGHT = touchTarget.min + 2;

/** Scrollable waypoint list with emoji icons and highlighting */
export function WaypointList({
  waypoints,
  focusedId,
  onSelect,
  maxItems,
  onSeeAll,
  style,
}: WaypointListProps) {
  const { colors } = useTheme();
  const listRef = useRef<FlatList>(null);
  const displayWaypoints = maxItems ? waypoints.slice(0, maxItems) : waypoints;
  const isFullList = !maxItems;

  const getItemLayout = useMemo(() => {
    if (!isFullList) return undefined;
    return (_data: unknown, index: number) => ({
      length: ITEM_HEIGHT,
      offset: ITEM_HEIGHT * index,
      index,
    });
  }, [isFullList]);

  // Scroll to focused waypoint when it changes
  useEffect(() => {
    if (focusedId != null && listRef.current) {
      const index = displayWaypoints.findIndex((w) => w.id === focusedId);
      if (index >= 0) {
        listRef.current.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
      }
    }
  }, [focusedId, displayWaypoints]);

  const renderItem = useCallback(
    ({ item }: { item: WaypointListItem }) => {
      const isFocused = item.id === focusedId;
      const emoji = waypointEmojis[item.type] ?? waypointEmojis.poi;

      return (
        <Pressable
          onPress={() => onSelect?.(item)}
          style={[
            styles.row,
            {
              backgroundColor: isFocused ? colors.accentSubtle : 'transparent',
              borderColor: isFocused ? colors.accent : 'transparent',
            },
          ]}
          accessibilityLabel={`${emoji} ${item.name}${item.distanceAhead ? `, ${item.distanceAhead}` : ''}`}
          accessibilityRole="button"
          accessibilityState={{ selected: isFocused }}
        >
          <Text style={styles.emoji}>{emoji}</Text>
          <View style={styles.rowContent}>
            {item.distanceAhead && (
              <Text style={[styles.distance, { color: colors.textSecondary }]}>
                {item.distanceAhead}
              </Text>
            )}
            <Text
              style={[styles.name, { color: colors.textPrimary }]}
              numberOfLines={1}
            >
              {item.name}
            </Text>
          </View>
        </Pressable>
      );
    },
    [focusedId, colors, onSelect],
  );

  return (
    <View style={style}>
      <FlatList
        ref={listRef}
        data={displayWaypoints}
        keyExtractor={(item) => String(item.id)}
        renderItem={renderItem}
        scrollEnabled={!maxItems}
        getItemLayout={getItemLayout}
        removeClippedSubviews={isFullList}
        initialNumToRender={isFullList ? 15 : undefined}
        onScrollToIndexFailed={(info) => {
          // Fallback: scroll to approximate offset when index isn't laid out yet
          listRef.current?.scrollToOffset({
            offset: info.index * ITEM_HEIGHT,
            animated: true,
          });
        }}
      />
      {maxItems && waypoints.length > maxItems && onSeeAll && (
        <Pressable
          onPress={onSeeAll}
          style={[styles.seeAllButton, { borderColor: colors.border }]}
          accessibilityLabel="See all waypoints"
          accessibilityRole="button"
        >
          <Text style={[styles.seeAllText, { color: colors.accent }]}>
            See all waypoints
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: 2,
  },
  emoji: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  rowContent: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    marginLeft: spacing.sm,
    gap: spacing.sm,
  },
  distance: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    minWidth: 50,
  },
  name: {
    ...typography.body,
    flex: 1,
  },
  seeAllButton: {
    minHeight: touchTarget.min,
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: spacing.sm,
  },
  seeAllText: {
    ...typography.body,
    fontWeight: '600',
  },
});
