/**
 * Waypoint list pane — a FarOut-style datasheet.
 *
 * Rows are ordered by cumulative distance and show type, name, and either a
 * plain km (no GPS) or a signed, unit-aware distance-from-me ("12.4 km ahead" /
 * "3.1 km behind") once a fix is available. A sticky row of category filter
 * chips scopes the list by family (water / camp / town / shelter / all), and a
 * "scroll to me" button jumps to the hiker's position within the filtered list.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import type { TrailJson } from '../../services/trail-loader';
import { orderedWaypoints } from './guide-trail';
import { useGuidePositionContext } from './GuidePositionContext';
import {
  FILTER_FAMILIES,
  formatSignedDistance,
  matchesFamily,
  type WaypointFamily,
} from './waypoint-filters';

type Waypoint = TrailJson['waypoints'][number];

export function WaypointListPane({ trail }: { trail: TrailJson }) {
  const { colors } = useTheme();
  const units = useSettingsStore((s) => s.units);
  const { currentKm } = useGuidePositionContext();
  const [family, setFamily] = useState<WaypointFamily>('all');
  const listRef = useRef<FlatList<Waypoint>>(null);

  const data = useMemo(
    () => orderedWaypoints(trail).filter((w) => matchesFamily(w.type, family)),
    [trail, family],
  );

  // First row at/after the hiker — the scroll-to-me target within the filter.
  const currentIndex = useMemo(() => {
    if (currentKm == null) return -1;
    const idx = data.findIndex((w) => (w.totalDistance ?? 0) >= currentKm);
    return idx === -1 ? data.length - 1 : idx;
  }, [data, currentKm]);

  const scrollToMe = useCallback(() => {
    if (currentIndex < 0) return;
    listRef.current?.scrollToIndex({ index: currentIndex, viewPosition: 0.3, animated: true });
  }, [currentIndex]);

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Sticky category filter chips */}
      <View style={[styles.filterBar, { backgroundColor: colors.background, borderBottomColor: colors.border }]}>
        {FILTER_FAMILIES.map((f) => {
          const active = f.value === family;
          return (
            <Pressable
              key={f.value}
              onPress={() => setFamily(f.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.chip,
                { borderColor: colors.border },
                active && { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
            >
              <Text
                style={[
                  styles.chipText,
                  { color: active ? colors.accentText : colors.textSecondary },
                ]}
              >
                {f.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <FlatList
        ref={listRef}
        data={data}
        keyExtractor={(w, i) => w.id ?? `${w.name}-${i}`}
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        renderItem={({ item }) => (
          <WaypointRow waypoint={item} units={units} currentKm={currentKm} />
        )}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: colors.border }]} />
        )}
        // scrollToIndex can fire before variable-height rows are measured; nudge
        // to an offset estimate, then retry once layout settles.
        onScrollToIndexFailed={(info) => {
          listRef.current?.scrollToOffset({
            offset: info.averageItemLength * info.index,
            animated: true,
          });
          setTimeout(() => {
            if (data.length > info.index) {
              listRef.current?.scrollToIndex({ index: info.index, viewPosition: 0.3 });
            }
          }, 120);
        }}
      />

      {/* Scroll to my position */}
      {currentIndex >= 0 && (
        <Pressable
          onPress={scrollToMe}
          accessibilityRole="button"
          accessibilityLabel="Scroll to my position"
          style={({ pressed }) => [
            styles.scrollToMe,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.scrollIcon, { color: colors.gps }]}>⦿</Text>
        </Pressable>
      )}
    </View>
  );
}

function WaypointRow({
  waypoint,
  units,
  currentKm,
}: {
  waypoint: Waypoint;
  units: 'km' | 'mi';
  currentKm: number | null;
}) {
  const { colors } = useTheme();
  const wpKm = waypoint.totalDistance ?? 0;

  // With a fix: signed distance from me. Without: the plain cumulative km.
  const signed =
    currentKm != null ? formatSignedDistance(wpKm - currentKm, units) : null;

  return (
    <View style={styles.row}>
      <View style={styles.rowMain}>
        <Text style={[styles.type, { color: colors.accent }]} numberOfLines={1}>
          {waypoint.type}
        </Text>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {waypoint.name}
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
            {formatDistance(wpKm, units)}
          </Text>
        )}
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
  root: {
    flex: 1,
  },
  filterBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    ...typography.dataSmall,
  },
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
  scrollToMe: {
    position: 'absolute',
    bottom: spacing.xl,
    right: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scrollIcon: {
    fontSize: glyphSizes.lg,
  },
  pressed: {
    opacity: 0.6,
  },
});
