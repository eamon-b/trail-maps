/**
 * Guide map pane: the MapLibre map plus its chrome.
 *
 * Owns the online/offline decision (subscribed to the downloads store so a
 * finished download flips the base map), a status pill, and a recenter button.
 * The map itself lives in GuideMap; this wrapper keeps the store/theme wiring
 * and overlays out of the render-heavy map component.
 */

import React, { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useDownloadsStore } from '../../state/downloads-store';
import { useGuide } from '../guide/GuideContext';
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

  const mapRef = useRef<GuideMapHandle>(null);

  // Alternates/side trips live on the trail JSON but sit behind the loose
  // index signature on TrailJson, so widen to the map's structural shapes.
  const alternates = trail.alternates as MapVariant[] | undefined;
  const sideTrips = trail.sideTrips as MapVariant[] | undefined;
  const waypoints = trail.waypoints as MapWaypoint[];
  const displayPoints = trail.track.displayPoints;

  // TODO(waypoint detail): route to the datasheet, mirroring the elevation pane.
  const onWaypointTap = useMemo(() => (_id: string) => {}, []);

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
  recenterIcon: {
    ...typography.titleLarge,
  },
  pressed: {
    opacity: 0.6,
  },
});
