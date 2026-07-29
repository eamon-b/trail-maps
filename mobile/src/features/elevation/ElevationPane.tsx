/**
 * Full-height elevation pane for the guide shell.
 *
 * Owns the visible km window (the profile is controlled), surfaces the scrub
 * readout in a fixed chip, and shows a reset-zoom affordance whenever the user
 * has zoomed in. Fed entirely from `useGuide()`.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { orderedWaypoints } from '../guide/guide-trail';
import { ElevationProfile, type ProfileReadout, type ProfileWaypoint } from './ElevationProfile';
import type { KmWindow } from './geometry';
import type { ProfilePoint } from './lod';

const ZOOM_EPSILON_KM = 0.01;

export function ElevationPane() {
  const { colors } = useTheme();
  const { trail, trailId } = useGuide();
  const { currentKm } = useGuidePositionContext();
  const units = useSettingsStore((s) => s.units);
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

  const [window, setWindow] = useState<KmWindow>({ startKm: 0, endKm: totalKm });
  const [readout, setReadout] = useState<ProfileReadout | null>(null);

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
              {formatDistance(readout.km, units)} · {Math.round(readout.ele)} m
            </Text>
          ) : (
            <Text style={[styles.chipHint, { color: colors.textSecondary }]}>
              Tap the profile to read off distance & elevation
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
          currentKm={currentKm}
          window={window}
          onWindowChange={setWindow}
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
