/**
 * Guide map pane: the MapLibre map plus its chrome.
 *
 * Owns the online/offline decision (subscribed to the downloads store so a
 * finished download flips the base map), a status pill, and a recenter button.
 * The map itself lives in GuideMap; this wrapper keeps the store/theme wiring
 * and overlays out of the render-heavy map component.
 */

import React, { useCallback, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';
import { useDownloadsStore } from '../../state/downloads-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { GuideMap, type GuideMapHandle } from './GuideMap';
import { MapErrorBoundary } from './MapErrorBoundary';
import { resolveStyleSource } from './map-style';
import type { MapVariant, MapWaypoint } from './map-geojson';

export function MapPane() {
  const { colors } = useTheme();
  const { trail, trailId } = useGuide();
  const download = useDownloadsStore((s) => s.byTrail[trailId]);
  const source = resolveStyleSource(download?.state);
  const offline = source === 'offline';

  const favoriteIds = useFavoritesStore((s) => s.byTrail[trailId]);
  const favoriteSet = useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);

  const { position, accuracy, status, start } = useGuidePositionContext();

  const mapRef = useRef<GuideMapHandle>(null);
  const router = useRouter();

  // Alternates/side trips live on the trail JSON but sit behind the loose
  // index signature on TrailJson, so widen to the map's structural shapes.
  const alternates = trail.alternates as MapVariant[] | undefined;
  const sideTrips = trail.sideTrips as MapVariant[] | undefined;
  const waypoints = trail.waypoints as MapWaypoint[];
  const displayPoints = trail.track.displayPoints;

  const onWaypointTap = useCallback(
    (id: string) => {
      router.push({
        pathname: '/guide/[trailId]/waypoint/[waypointId]',
        params: { trailId, waypointId: id },
      });
    },
    [router, trailId],
  );

  return (
    <View style={styles.root}>
      <MapErrorBoundary>
        <GuideMap
          ref={mapRef}
          trailId={trailId}
          styleSource={source}
          displayPoints={displayPoints}
          alternates={alternates}
          sideTrips={sideTrips}
          waypoints={waypoints}
          currentPosition={position}
          accuracy={accuracy}
          favoriteIds={favoriteSet}
          onWaypointTap={onWaypointTap}
        />
      </MapErrorBoundary>

      {/* Base-map status pill */}
      <View
        style={[styles.pill, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
        pointerEvents="none"
      >
        <View
          style={[styles.dot, { backgroundColor: offline ? colors.downloadDone : colors.info }]}
        />
        <Text style={[styles.pillText, { color: colors.textPrimary }]}>
          {offline ? 'Offline maps ready' : 'Online'}
        </Text>
      </View>

      {/* Center on me: pan to the GPS fix, or start GPS if not yet tracking */}
      <Pressable
        onPress={() => (position ? mapRef.current?.centerOnMe() : start())}
        accessibilityRole="button"
        accessibilityLabel={position ? 'Center map on my location' : 'Show my location'}
        style={({ pressed }) => [
          styles.centerOnMe,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          pressed && styles.pressed,
        ]}
      >
        <Text
          style={[
            styles.buttonIcon,
            { color: position ? colors.gps : colors.textSecondary },
          ]}
        >
          {status === 'acquiring' ? '⋯' : '⦿'}
        </Text>
      </Pressable>

      {/* Recenter: re-fit the camera to the trail bounds */}
      <Pressable
        onPress={() => mapRef.current?.recenter()}
        accessibilityRole="button"
        accessibilityLabel="Recenter map on the trail"
        style={({ pressed }) => [
          styles.recenter,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.recenterIcon, { color: colors.accent }]}>◎</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  pill: {
    position: 'absolute',
    top: spacing.md,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radii.full,
  },
  pillText: {
    ...typography.caption,
    fontWeight: '600',
  },
  recenter: {
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
  centerOnMe: {
    position: 'absolute',
    bottom: spacing.xl + 44 + spacing.sm,
    right: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recenterIcon: {
    ...typography.titleLarge,
  },
  buttonIcon: {
    fontSize: glyphSizes.lg,
  },
  pressed: {
    opacity: 0.6,
  },
});
