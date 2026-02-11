import React, { useCallback, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import BottomSheet from '@gorhom/bottom-sheet';
import { ElevationProfile } from './ElevationProfile';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import type { TrackPoint, TrailWaypoint } from '../lib/trail-utils';

interface ElevationProfileDrawerProps {
  trackPoints: TrackPoint[];
  waypoints?: TrailWaypoint[];
  currentKm?: number | null;
  currentElevation?: number | null;
  focusedWaypointId?: number | null;
  /** Called when user taps a distance on the profile */
  onDistanceTap?: (km: number) => void;
  /** Visible km range from the map viewport */
  visibleRange?: [number, number] | null;
  /** Highlighted km range (e.g., a day's segment) */
  highlightedRange?: { startKm: number; endKm: number } | null;
  /** Water source km positions */
  waterSourceKms?: number[];
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
}: ElevationProfileDrawerProps) {
  const { colors } = useTheme();
  const bottomSheetRef = useRef<BottomSheet>(null);

  const snapPoints = useMemo(() => [80, '40%', '70%'], []);

  const handleSheetChanges = useCallback((_index: number) => {
    // No-op — drawer stays visible at all snap points
  }, []);

  return (
    <BottomSheet
      ref={bottomSheetRef}
      index={0}
      snapPoints={snapPoints}
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
          Pull up for profile
        </Text>
      </View>

      {/* Elevation profile chart */}
      <View style={styles.chartContainer}>
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
});
