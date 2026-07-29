/**
 * Guide map pane: the MapLibre map plus its chrome.
 *
 * Owns the online/offline decision (subscribed to the downloads store so a
 * finished download flips the base map), a status pill, a recenter button, and
 * the FarOut-style route builder. In builder mode the pane switches the map
 * into tap-to-add-point mode, overlays the in-progress route, and swaps the FAB
 * stack for a builder toolbar; otherwise it overlays the trail's active saved
 * route (if any). The map itself lives in GuideMap.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';
import { useDownloadsStore } from '../../state/downloads-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { useSettingsStore } from '../../state/settings-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { useRoutesStore } from '../routes/routes-store';
import { RouteBuilderBar } from '../routes/RouteBuilderBar';
import {
  buildRouteOverlayGeoJSON,
  classifyTap,
  computeRouteStats,
  type RoutePointInput,
  type RouteTrackPoint,
} from '../routes/route-geometry';
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
  const units = useSettingsStore((s) => s.units);

  const { position, accuracy, status, start } = useGuidePositionContext();

  const mapRef = useRef<GuideMapHandle>(null);
  const router = useRouter();

  // Alternates/side trips live on the trail JSON but sit behind the loose
  // index signature on TrailJson, so widen to the map's structural shapes.
  const alternates = trail.alternates as MapVariant[] | undefined;
  const sideTrips = trail.sideTrips as MapVariant[] | undefined;
  const waypoints = trail.waypoints as MapWaypoint[];
  const displayPoints = trail.track.displayPoints;
  const routeTrack = displayPoints as RouteTrackPoint[];

  // --- Route builder + active-route overlay --------------------------------
  const [building, setBuilding] = useState(false);
  const [builderPoints, setBuilderPoints] = useState<RoutePointInput[]>([]);
  const activePoints = useRoutesStore((s) => s.activePointsByTrail[trailId]);
  const saveRoute = useRoutesStore((s) => s.save);
  const activateRoute = useRoutesStore((s) => s.activate);

  const routeOverlay = useMemo(() => {
    if (building) {
      return buildRouteOverlayGeoJSON(builderPoints, routeTrack, { includeVertices: true });
    }
    if (activePoints && activePoints.length > 0) {
      return buildRouteOverlayGeoJSON(activePoints, routeTrack);
    }
    return undefined;
  }, [building, builderPoints, activePoints, routeTrack]);

  const builderStats = useMemo(
    () => computeRouteStats(builderPoints, routeTrack),
    [builderPoints, routeTrack],
  );

  const onMapPress = useCallback(
    (lat: number, lon: number) => {
      setBuilderPoints((prev) => [...prev, classifyTap(lat, lon, routeTrack)]);
    },
    [routeTrack],
  );

  const startBuilding = useCallback(() => {
    void activateRoute(trailId, null); // hide any active-route overlay while drawing
    setBuilderPoints([]);
    setBuilding(true);
  }, [activateRoute, trailId]);

  const cancelBuilding = useCallback(() => {
    setBuilding(false);
    setBuilderPoints([]);
  }, []);

  const undoPoint = useCallback(() => {
    setBuilderPoints((prev) => prev.slice(0, -1));
  }, []);

  const onSaveRoute = useCallback(
    (name: string) => {
      const stats = computeRouteStats(builderPoints, routeTrack);
      void (async () => {
        const route = await saveRoute({
          trailId,
          name,
          totalKm: stats.totalKm,
          ascentM: stats.ascentM,
          descentM: stats.descentM,
          points: builderPoints.map((p) => ({
            kind: p.kind,
            lat: p.lat,
            lon: p.lon,
            km: p.km,
          })),
        });
        await activateRoute(trailId, route.id);
        setBuilding(false);
        setBuilderPoints([]);
      })();
    },
    [builderPoints, routeTrack, saveRoute, activateRoute, trailId],
  );

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
          routeOverlay={routeOverlay}
          builderMode={building}
          onMapPress={onMapPress}
        />
      </MapErrorBoundary>

      {/* Base-map status / builder hint pill */}
      <View
        style={[styles.pill, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
        pointerEvents="none"
      >
        {building ? (
          <Text style={[styles.pillText, { color: colors.textPrimary }]}>
            Tap the map to add route points
          </Text>
        ) : (
          <>
            <View
              style={[styles.dot, { backgroundColor: offline ? colors.downloadDone : colors.info }]}
            />
            <Text style={[styles.pillText, { color: colors.textPrimary }]}>
              {offline ? 'Offline maps ready' : 'Online'}
            </Text>
          </>
        )}
      </View>

      {building ? (
        <RouteBuilderBar
          totalKm={builderStats.totalKm}
          pointCount={builderPoints.length}
          unit={units}
          onUndo={undoPoint}
          onCancel={cancelBuilding}
          onSave={onSaveRoute}
        />
      ) : (
        <>
          {/* Draw route: enter the tap-to-add-point builder */}
          <Pressable
            onPress={startBuilding}
            accessibilityRole="button"
            accessibilityLabel="Draw a route"
            style={({ pressed }) => [
              styles.drawRoute,
              { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.drawIcon, { color: colors.warning }]}>✎</Text>
          </Pressable>

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
              style={[styles.buttonIcon, { color: position ? colors.gps : colors.textSecondary }]}
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
        </>
      )}
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
  drawRoute: {
    position: 'absolute',
    bottom: spacing.xl + (44 + spacing.sm) * 2,
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
  drawIcon: {
    fontSize: glyphSizes.lg,
  },
  buttonIcon: {
    fontSize: glyphSizes.lg,
  },
  pressed: {
    opacity: 0.6,
  },
});
