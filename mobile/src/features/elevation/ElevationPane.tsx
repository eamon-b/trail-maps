/**
 * Full-height elevation pane for the guide shell.
 *
 * Owns the visible km window (the profile is controlled), surfaces the scrub
 * readout in a fixed chip, and shows a reset-zoom affordance whenever the user
 * has zoomed in. Fed entirely from `useGuide()`.
 *
 * That km window doubles as this pane's focus window (see guide-focus): arriving
 * from the map zooms the profile to the section that was on screen, and leaving
 * hands the same range to whichever pane comes next.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePaneFocus } from '../guide/GuideFocusContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { isSameFocus } from '../guide/guide-focus';
import { orderedWaypoints } from '../guide/guide-trail';
import { useRoutesStore } from '../routes/routes-store';
import { routeHighlightRanges, type RouteTrackPoint } from '../routes/route-geometry';
import { ElevationProfile, type ProfileReadout, type ProfileWaypoint } from './ElevationProfile';
import { clampWindow, type KmWindow } from './geometry';
import type { ProfilePoint } from './lod';

const ZOOM_EPSILON_KM = 0.01;

export function ElevationPane() {
  const { colors } = useTheme();
  const { trail, trailId } = useGuide();
  const { currentKm } = useGuidePositionContext();
  const units = useSettingsStore((s) => s.units);
  const favoriteIds = useFavoritesStore((s) => s.byTrail[trailId]);
  const favoriteSet = useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);
  const router = useRouter();

  const totalKm = trail.track.totalDistance || 0;
  const points = trail.track.displayPoints as ProfilePoint[];

  const waypoints = useMemo<ProfileWaypoint[]>(
    () =>
      orderedWaypoints(trail).map((wp, i) => ({
        id: wp.id ?? `${wp.name}-${i}`,
        type: wp.type,
        totalDistance: wp.totalDistance,
        elevation: wp.elevation,
      })),
    [trail],
  );

  // Active custom route → shade its on-trail spans on the profile.
  const activePoints = useRoutesStore((s) => s.activePointsByTrail[trailId]);
  const highlightRanges = useMemo(
    () =>
      activePoints && activePoints.length > 0
        ? routeHighlightRanges(activePoints, points as RouteTrackPoint[])
        : undefined,
    [activePoints, points],
  );

  const [window, setWindow] = useState<KmWindow>({ startKm: 0, endKm: totalKm });
  const [readout, setReadout] = useState<ProfileReadout | null>(null);

  // A different (or newly loaded) trail invalidates the km window — refit it to
  // the full new length rather than leaving the zoom parked off the end.
  const fittedTotalRef = useRef(totalKm);
  useEffect(() => {
    if (fittedTotalRef.current === totalKm) return;
    fittedTotalRef.current = totalKm;
    setWindow({ startKm: 0, endKm: totalKm });
  }, [totalKm]);

  const isZoomed = window.startKm > ZOOM_EPSILON_KM || window.endKm < totalKm - ZOOM_EPSILON_KM;

  const resetZoom = useCallback(() => {
    setWindow({ startKm: 0, endKm: totalKm });
  }, [totalKm]);

  const onWaypointTap = useCallback(
    (id: string) => {
      router.push({
        pathname: '/guide/[trailId]/waypoint/[waypointId]',
        params: { trailId, waypointId: id },
      });
    },
    [router, trailId],
  );

  // --- Pane focus ----------------------------------------------------------
  // The profile's zoom window is already a focus window, so leaving hands it
  // over as-is; arriving zooms to the incoming section unless the profile is
  // effectively there already (which would fight a zoom the user just made).
  const windowRef = useRef(window);
  windowRef.current = window;
  useGuidePaneFocus('elevation', {
    capture: () => windowRef.current,
    apply: (focus) => {
      const next = clampWindow(focus.startKm, focus.endKm, totalKm);
      if (isSameFocus(windowRef.current, next)) return;
      setWindow(next);
    },
  });

  if (points.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: colors.surface }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>Elevation</Text>
        <Text style={[styles.emptyHint, { color: colors.textSecondary }]}>
          This trail has no elevation data.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.topBar} pointerEvents="box-none">
        <View
          style={[
            styles.chip,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          {readout ? (
            <Text style={[styles.chipText, { color: colors.textPrimary }]}>
              {formatDistance(readout.km, units)} · {formatElevation(readout.ele, units)}
            </Text>
          ) : (
            <Text style={[styles.chipHint, { color: colors.textSecondary }]}>
              Tap to read off · pinch to zoom · drag to pan
            </Text>
          )}
        </View>

        {isZoomed && (
          <Pressable
            onPress={resetZoom}
            accessibilityRole="button"
            accessibilityLabel="Reset zoom"
            style={({ pressed }) => [
              styles.resetButton,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.resetText, { color: colors.accent }]}>Reset zoom</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.profile}>
        <ElevationProfile
          points={points}
          totalKm={totalKm}
          waypoints={waypoints}
          favoriteIds={favoriteSet}
          unit={units}
          currentKm={currentKm}
          window={window}
          onWindowChange={setWindow}
          highlightRanges={highlightRanges}
          onWaypointTap={onWaypointTap}
          onScrub={setReadout}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  chip: {
    flexShrink: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipText: {
    ...typography.dataSmall,
    fontVariant: ['tabular-nums'],
  },
  chipHint: {
    ...typography.caption,
  },
  resetButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  resetText: {
    ...typography.titleSmall,
  },
  pressed: {
    opacity: 0.6,
  },
  profile: {
    flex: 1,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.md,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.displaySmall,
  },
  emptyHint: {
    ...typography.bodySmall,
    textAlign: 'center',
  },
});
