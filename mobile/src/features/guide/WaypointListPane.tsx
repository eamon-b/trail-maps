/**
 * Waypoint list pane — a FarOut-style datasheet.
 *
 * Rows are ordered by cumulative distance and show type, name, and either a
 * plain km (no GPS) or a signed, unit-aware distance-from-me ("12.4 km ahead" /
 * "3.1 km behind") once a fix is available. A sticky row of category filter
 * chips scopes the list by family (water / camp / town / shelter / all), and a
 * "scroll to me" button jumps to the hiker's position within the filtered list.
 *
 * Water waypoints also carry a freshness-ranked status chip ("Flowing · 3d")
 * when the comment cache holds recent reports — see `water-aggregate` for the
 * ranking and `use-water-status` for the read.
 *
 * The trail's OpenStreetMap points of interest are interleaved between the
 * waypoints at their own kilometre (see `list-rows`), badged "OSM" and scoped by
 * the same chips through `poiCategoriesForFamily`. They stay a separate kind of
 * row throughout — no favourite, no water status, no comments — and the list
 * carries the OSM credit line as a footer whenever one is on screen.
 *
 * The rows on screen are also this pane's contribution to the guide's shared
 * focus window (see guide-focus): leaving the list reports the km range they
 * span, and arriving scrolls to the first row in the incoming range.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewToken,
} from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { OSM_ATTRIBUTION, poiRouteKey } from '@lib/poi-display';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { useFavoritesStore } from '../../state/favorites-store';
import type { TrailJson } from '../../services/trail-loader';
import { useGuide } from './GuideContext';
import { useGuidePaneFocus } from './GuideFocusContext';
import { firstIndexInFocus, focusFromItems } from './guide-focus';
import { orderedWaypoints } from './guide-trail';
import {
  interleaveListRows,
  rowKm,
  toWaypointRows,
  type ListRow,
} from './list-rows';
import { PoiRow } from './PoiRow';
import { useVisiblePois } from './use-visible-pois';
import { useGuidePositionContext } from './GuidePositionContext';
import { useWaterStatus } from './use-water-status';
import { isWaterFamily, waterStatusMeta } from './waypoint-detail';
import {
  formatWaterStatusChip,
  waterStatusAccessibilityLabel,
  type WaterAggregate,
} from './water-aggregate';
import {
  FILTER_FAMILIES,
  formatSignedDistance,
  matchesFamily,
  matchesPoiFamily,
  type WaypointFamily,
} from './waypoint-filters';

type Waypoint = TrailJson['waypoints'][number];

export function WaypointListPane({ trail }: { trail: TrailJson }) {
  const { colors } = useTheme();
  const { trailId } = useGuide();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { currentKm } = useGuidePositionContext();
  const favoriteIds = useFavoritesStore((s) => s.byTrail[trailId]);
  // Freshness-ranked water verdicts, keyed by the *bundled* waypoint id (the id
  // comments are filed against; legacy waypoints without one carry no reports).
  const waterByWaypoint = useWaterStatus(trailId);
  const [family, setFamily] = useState<WaypointFamily>('all');
  const listRef = useRef<FlatList<ListRow>>(null);
  // Already filtered by the global POI switches; the chips narrow it further.
  const visiblePois = useVisiblePois(trail);

  const favoriteSet = useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);

  const data = useMemo(() => {
    const waypointRows = toWaypointRows(orderedWaypoints(trail)).filter((row) =>
      matchesFamily(row.waypoint.type, family, favoriteSet.has(row.key)),
    );
    // A POI row is never a favourite, so the 'favorites' chip drops them all —
    // `poiCategoriesForFamily` already says so, via `matchesPoiFamily`.
    const pois = visiblePois.filter((poi) => matchesPoiFamily(poi.category, family));
    return interleaveListRows(waypointRows, pois);
  }, [trail, family, favoriteSet, visiblePois]);

  const hasPoiRows = useMemo(() => data.some((row) => row.kind === 'poi'), [data]);

  const openWaypoint = useCallback(
    (id: string) => {
      router.push({
        pathname: '/guide/[trailId]/waypoint/[waypointId]',
        params: { trailId, waypointId: id },
      });
    },
    [router, trailId],
  );

  const openPoi = useCallback(
    (poiKey: string) => {
      router.push({
        pathname: '/guide/[trailId]/poi/[poiKey]',
        params: { trailId, poiKey },
      });
    },
    [router, trailId],
  );

  // First row at/after the hiker — the scroll-to-me target within the filter.
  const currentIndex = useMemo(() => {
    if (currentKm == null) return -1;
    const idx = data.findIndex((row) => row.km >= currentKm);
    return idx === -1 ? data.length - 1 : idx;
  }, [data, currentKm]);

  const scrollToMe = useCallback(() => {
    if (currentIndex < 0) return;
    listRef.current?.scrollToIndex({ index: currentIndex, viewPosition: 0.3, animated: true });
  }, [currentIndex]);

  // --- Pane focus ----------------------------------------------------------
  // The rows currently on screen, tracked through FlatList's viewability
  // callback. `onViewableItemsChanged` must keep one identity for the list's
  // lifetime (FlatList throws otherwise), hence the ref-held handler.
  const visibleItemsRef = useRef<ListRow[]>([]);
  const dataRef = useRef(data);
  dataRef.current = data;
  // Optional-chained: the pane only ever reads distances off the rows, so a
  // trail handed in without track geometry still lists fine (focusFromItems
  // falls back to the last row's distance when it has no total to clamp to).
  const totalKm = trail.track?.totalDistance || 0;

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    visibleItemsRef.current = viewableItems
      .map((token) => token.item as ListRow)
      .filter((item): item is ListRow => item != null);
  }).current;

  useGuidePaneFocus('list', {
    capture: () => focusFromItems(visibleItemsRef.current, totalKm, undefined, rowKm),
    apply: (focus) => {
      const rows = dataRef.current;
      const index = firstIndexInFocus(rows, focus, rowKm);
      if (index < 0) return;
      // Not animated: this lands while the pane is being revealed, and an
      // animated scroll from the old offset would be a distracting fly-past.
      listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
    },
  });

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
        keyExtractor={(row) => row.key}
        onViewableItemsChanged={onViewableItemsChanged}
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
        renderItem={({ item: row }) => {
          if (row.kind === 'poi') {
            return (
              <PoiRow
                poi={row.poi}
                units={units}
                currentKm={currentKm}
                onPress={() => openPoi(poiRouteKey(row.poi))}
              />
            );
          }
          const waypoint = row.waypoint;
          return (
            <Pressable
              onPress={() => openWaypoint(row.key)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${waypoint.name}`}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <WaypointRow
                waypoint={waypoint}
                units={units}
                currentKm={currentKm}
                favorite={favoriteSet.has(row.key)}
                water={
                  waypoint.id && isWaterFamily(waypoint.type)
                    ? waterByWaypoint.get(waypoint.id) ?? null
                    : null
                }
              />
            </Pressable>
          );
        }}
        ItemSeparatorComponent={() => (
          <View style={[styles.separator, { backgroundColor: colors.border }]} />
        )}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {family === 'favorites'
              ? 'No favorites yet. Tap the heart on a waypoint to save it here.'
              : 'No waypoints match this filter.'}
          </Text>
        }
        // The credit line rides with the rows: it only owes OSM a mention when
        // OSM data is actually on screen.
        ListFooterComponent={
          hasPoiRows ? (
            <Text style={[styles.footerText, { color: colors.textSecondary }]}>
              {`Rows marked OSM are OpenStreetMap points of interest · ${OSM_ATTRIBUTION}`}
            </Text>
          ) : null
        }
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
  favorite,
  water,
}: {
  waypoint: Waypoint;
  units: 'km' | 'mi';
  currentKm: number | null;
  favorite: boolean;
  /** Aggregated water verdict, for water waypoints with recent reports. */
  water?: WaterAggregate | null;
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
        <View style={styles.nameRow}>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {waypoint.name}
          </Text>
          {favorite && (
            <Text
              accessibilityLabel="Favorite"
              style={[styles.favoriteBadge, { color: colors.waypointFavorite }]}
            >
              ♥
            </Text>
          )}
          {water && <WaterStatusChip aggregate={water} />}
        </View>
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
            {formatElevation(waypoint.elevation, units)}
          </Text>
        )}
      </View>
    </View>
  );
}

/**
 * The aggregated water verdict as an inline chip — status label plus how stale
 * the winning report is ("Flowing · 3d"). Outlined rather than filled (the same
 * treatment the waypoint detail screen gives a single report's badge) so the
 * status colour reads without competing with the row's name.
 */
function WaterStatusChip({ aggregate }: { aggregate: WaterAggregate }) {
  const { colors } = useTheme();
  const color = colors[waterStatusMeta(aggregate.status).colorToken];
  return (
    <View
      accessible
      accessibilityLabel={waterStatusAccessibilityLabel(aggregate)}
      style={[styles.waterChip, { borderColor: color }]}
    >
      <Text style={[styles.waterChipText, { color }]} numberOfLines={1}>
        {formatWaterStatusChip(aggregate)}
      </Text>
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
  emptyText: {
    ...typography.bodySmall,
    paddingVertical: spacing.xl,
    textAlign: 'center',
  },
  footerText: {
    ...typography.caption,
    paddingTop: spacing.lg,
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
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  favoriteBadge: {
    fontSize: glyphSizes.xs,
  },
  waterChip: {
    flexShrink: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  waterChipText: {
    ...typography.caption,
    fontWeight: '600',
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
    flexShrink: 1,
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
