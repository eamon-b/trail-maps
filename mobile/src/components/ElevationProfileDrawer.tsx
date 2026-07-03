import React, { useCallback, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { ElevationProfile } from './ElevationProfile';
import { hasElevationData } from '../services/datasheet-service';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { TrackPoint, TrailWaypoint } from '../lib/trail-utils';

interface ElevationProfileDrawerProps {
  trackPoints: TrackPoint[];
  waypoints?: TrailWaypoint[];
  currentKm?: number | null;
  currentElevation?: number | null;
  focusedWaypointId?: string | null;
  /** Called when user taps a distance on the profile */
  onDistanceTap?: (km: number) => void;
  /** Visible km range from the map viewport */
  visibleRange?: [number, number] | null;
  /** Highlighted km range (e.g., a day's segment) */
  highlightedRange?: { startKm: number; endKm: number } | null;
  /** Water source km positions */
  waterSourceKms?: number[];
  /** Snap point index the drawer should be at (0 = collapsed, 1 = 40%, 2 = 70%).
   * The drawer animates whenever this changes. */
  index: number;
  /** Reports the actual snap index after any move (user drag or programmatic),
   * so the owner can keep `index` in sync. */
  onIndexChange?: (index: number) => void;
}

export function ElevationProfileDrawer({
  trackPoints,
  waypoints,
  currentKm,
  currentElevation,
  focusedWaypointId,
  onDistanceTap,
  visibleRange,
  highlightedRange,
  waterSourceKms,
  index,
  onIndexChange,
}: ElevationProfileDrawerProps) {
  const { colors } = useTheme();

  const snapPoints = useMemo(() => [80, '40%', '70%'], []);
  const withElevation = useMemo(() => hasElevationData(trackPoints), [trackPoints]);

  // Controlled position: gorhom v5 reacts to `index` prop changes by snapping
  // (its internal effect calls the same handler as the imperative
  // snapToIndex), and onChange reports drags back so the owner stays in sync.
  // Floor at 0 — the collapsed 80px detent is the minimum; -1 (closed) would
  // leave no affordance to reopen the drawer.
  const handleSheetChanges = useCallback((newIndex: number) => {
    onIndexChange?.(Math.max(0, newIndex));
  }, [onIndexChange]);

  return (
    <BottomSheet
      index={index}
      snapPoints={snapPoints}
      // Explicit snap points only — dynamic sizing would splice a
      // content-height snap point into the list and shift every index.
      enableDynamicSizing={false}
      onChange={handleSheetChanges}
      handleIndicatorStyle={[styles.handleIndicator, { backgroundColor: colors.textSecondary }]}
      backgroundStyle={[styles.background, { backgroundColor: colors.surface }]}
      enablePanDownToClose={false}
    >
      {/* Collapsed header summary */}
      <View style={styles.header}>
        <Text style={[styles.headerText, { color: colors.textPrimary }]}>
          {currentElevation != null ? `${Math.round(currentElevation)}m` : 'Elevation Profile'}
        </Text>
        <Text style={[styles.headerHint, { color: colors.textSecondary }]}>
          {!withElevation
            ? 'No elevation data'
            : index > 0
              ? 'Pull down to collapse'
              : 'Pull up for profile'}
        </Text>
      </View>

      {/* Elevation profile chart or no-data message */}
      <View style={styles.chartContainer}>
        {withElevation ? (
          <ElevationProfile
            trackPoints={trackPoints}
            waypoints={waypoints}
            currentKm={currentKm}
            focusedWaypointId={focusedWaypointId}
            onDistanceTap={onDistanceTap}
            visibleRange={visibleRange}
            highlightedRange={highlightedRange}
            waterSourceKms={waterSourceKms}
          />
        ) : (
          <View style={styles.noElevation}>
            <Text style={[styles.noElevationText, { color: colors.textSecondary }]}>
              No elevation data available for this trail
            </Text>
            <Text style={[styles.noElevationHint, { color: colors.textSecondary }]}>
              The imported GPX file did not contain elevation information
            </Text>
          </View>
        )}
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  background: {
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
  },
  handleIndicator: {
    width: 36,
    height: 5,
    borderRadius: 2.5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headerText: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  headerHint: {
    ...typography.caption,
  },
  chartContainer: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.lg,
  },
  noElevation: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  noElevationText: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.xs,
  },
  noElevationHint: {
    ...typography.caption,
    textAlign: 'center',
  },
});
