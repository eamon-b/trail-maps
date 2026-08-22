/**
 * Guide map pane: the MapLibre map plus its chrome.
 *
 * Owns the online/offline decision (subscribed to the downloads store so a
 * finished download flips the base map), a status pill, a degraded-map banner,
 * a recenter button, and the FarOut-style route builder. In builder mode the
 * pane switches the map into tap-to-add-point mode, overlays the in-progress
 * route, and swaps the FAB stack for a builder toolbar; otherwise it overlays
 * the trail's active saved route (if any). The map itself lives in GuideMap.
 *
 * Tapping an alternate or side trip opens VariantInfoCard over the map. The card
 * shares the bottom of the screen with the legend and the FAB stack, so those
 * hide while it is open — the same trade the route-builder bar makes.
 *
 * The pane also translates its viewport to and from the guide's shared focus
 * window (see guide-focus): leaving the map reports the km range on screen, and
 * arriving fits the camera to whatever range the previous pane was showing.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import { resolveOfflinePack } from '../../services/offline-pack-resolver';
import { useDownloadsStore } from '../../state/downloads-store';
import { useFavoritesStore } from '../../state/favorites-store';
import { useSettingsStore } from '../../state/settings-store';
import { useGuide } from '../guide/GuideContext';
import { useGuidePaneFocus } from '../guide/GuideFocusContext';
import { useGuidePositionContext } from '../guide/GuidePositionContext';
import { boundsForKmRange, isSameFocus, kmRangeInBounds } from '../guide/guide-focus';
import { useWaterStatus } from '../guide/use-water-status';
import { useRoutesStore } from '../routes/routes-store';
import { RouteBuilderBar } from '../routes/RouteBuilderBar';
import {
  buildRouteOverlayGeoJSON,
  classifyTap,
  computeRouteStats,
  type RoutePointInput,
  type RouteTrackPoint,
} from '../routes/route-geometry';
import { GuideMap, type GuideMapHandle, type ViewportBounds } from './GuideMap';
import { MapErrorBoundary } from './MapErrorBoundary';
import {
  degradationMessage,
  isRedownloadFixable,
  mapDegradation,
  resolveStyleSource,
  type MapDegradation,
  type MapStyleResolution,
} from './map-style';
import { TrackLegend } from './TrackLegend';
import {
  hasDrawableVariant,
  variantFeatureId,
  type MapVariant,
  type MapWaypoint,
  type VariantKind,
} from './map-geojson';
import { variantInfo, type VariantInfo } from './variant-info';
import { VariantInfoCard } from './VariantInfoCard';

/** Same env var the Offline Maps screen uses; empty disables re-download. */
const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

export function MapPane() {
  const { colors } = useTheme();
  const { trail, trailId } = useGuide();
  // An imported guide has no tile pack of its own; it borrows a bundled one
  // when its track sits inside that trail's coverage (see
  // `services/offline-pack-resolver`). Everything tile-shaped below — the
  // download state that decides offline vs online, the style the map mounts,
  // and the banner's re-download — keys on the resolved pack, not on trailId.
  const packTrailId = useMemo(() => {
    const pack = resolveOfflinePack(trailId, trail);
    if (pack.kind === 'own') return trailId;
    return pack.kind === 'bundled' ? pack.packTrailId : null;
  }, [trailId, trail]);

  const download = useDownloadsStore((s) => (packTrailId ? s.byTrail[packTrailId] : undefined));
  // `downloading` forces the map online for the duration: an update replaces
  // the mbtiles while on-disk state is still 'complete', and MapLibre must not
  // be holding those files open while that happens.
  const source = resolveStyleSource(download?.state, { downloading: download?.downloading });
  const offline = source === 'offline';
  const downloading = download?.downloading ?? false;

  const startDownload = useDownloadsStore((s) => s.startDownload);
  const deleteTiles = useDownloadsStore((s) => s.deleteTiles);

  // --- Degraded-basemap reporting ------------------------------------------
  // GuideMap tells us what actually mounted (which may be worse than what we
  // asked for: damaged tiles fall back online, bad contours drop their layers).
  const [resolution, setResolution] = useState<MapStyleResolution | null>(null);
  const onStyleResolved = useCallback((next: MapStyleResolution) => setResolution(next), []);

  const degradation = useMemo(
    () => (resolution ? mapDegradation(resolution) : null),
    [resolution],
  );

  // Dismissal is per-degradation, so a *different* problem still gets a banner,
  // and per-trail, so dismissing on one guide doesn't silence another.
  const [dismissed, setDismissed] = useState<MapDegradation | null>(null);
  useEffect(() => {
    setDismissed(null);
    setResolution(null);
  }, [trailId]);

  const onRedownload = useCallback(() => {
    if (!packTrailId) return;
    setDismissed(null);
    setResolution(null);
    deleteTiles(packTrailId);
    void startDownload(packTrailId, TILE_BASE_URL);
  }, [deleteTiles, startDownload, packTrailId]);

  const favoriteIds = useFavoritesStore((s) => s.byTrail[trailId]);
  const favoriteSet = useMemo(() => new Set(favoriteIds ?? []), [favoriteIds]);
  const units = useSettingsStore((s) => s.units);
  // Freshness-ranked water verdicts — tint the ring of water markers that have
  // recent reports (see GuideMap's waypointCircleStyle).
  const waterStatusById = useWaterStatus(trailId);

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

  // --- Tappable alternates / side trips ------------------------------------
  // Ids are resolved back to the source objects here rather than read off the
  // tapped feature, so the read-out never depends on numeric properties
  // surviving a round trip through native feature properties.
  const variantsById = useMemo(() => {
    const map = new Map<string, VariantInfo>();
    const add = (list: MapVariant[] | undefined, kind: VariantKind) => {
      (list ?? []).forEach((variant, index) => {
        const id = variantFeatureId(kind, index);
        map.set(id, variantInfo(variant, kind, id));
      });
    };
    add(alternates, 'alternate');
    add(sideTrips, 'side-trip');
    return map;
  }, [alternates, sideTrips]);

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const selectedVariant = selectedVariantId ? variantsById.get(selectedVariantId) : undefined;

  const onVariantTap = useCallback(
    (id: string) => setSelectedVariantId(id),
    [],
  );
  const clearVariant = useCallback(() => setSelectedVariantId(null), []);

  // Switching trails must not leave another trail's variant selected.
  useEffect(() => {
    setSelectedVariantId(null);
  }, [trailId]);

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

  // Banner is suppressed while a re-download is already running (it is being
  // fixed) and while the route builder owns the screen.
  const showBanner = degradation != null && degradation !== dismissed && !downloading && !building;

  const onMapPress = useCallback(
    (lat: number, lon: number) => {
      setBuilderPoints((prev) => [...prev, classifyTap(lat, lon, routeTrack)]);
    },
    [routeTrack],
  );

  const startBuilding = useCallback(() => {
    void activateRoute(trailId, null); // hide any active-route overlay while drawing
    setSelectedVariantId(null); // the builder owns the bottom of the screen
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

  // --- Pane focus ----------------------------------------------------------
  // The last settled viewport, kept in a ref: the camera moves constantly and
  // none of this belongs in render. `onRegionDidChange` is MapLibre's idle
  // event, so this is already debounced to "the user stopped moving the map".
  const visibleBoundsRef = useRef<ViewportBounds | null>(null);
  const onVisibleBoundsChange = useCallback((box: ViewportBounds) => {
    visibleBoundsRef.current = box;
  }, []);

  const totalKm = trail.track.totalDistance || 0;
  // Which stretch of trail the viewport covers right now (null before the
  // camera has ever settled, or when the trail is off screen).
  const currentFocus = useCallback(
    () =>
      visibleBoundsRef.current
        ? kmRangeInBounds(displayPoints, visibleBoundsRef.current, totalKm)
        : null,
    [displayPoints, totalKm],
  );

  useGuidePaneFocus('map', {
    capture: currentFocus,
    apply: (focus) => {
      // Already looking at that stretch (typically because this map is where
      // the focus came from) — leave the camera alone rather than re-animating.
      if (isSameFocus(currentFocus(), focus)) return;
      const box = boundsForKmRange(displayPoints, focus);
      if (box) mapRef.current?.fitBounds(box);
    },
  });

  return (
    <View style={styles.root}>
      <MapErrorBoundary>
        <GuideMap
          ref={mapRef}
          trailId={trailId}
          tilePackId={packTrailId ?? undefined}
          styleSource={source}
          displayPoints={displayPoints}
          alternates={alternates}
          sideTrips={sideTrips}
          waypoints={waypoints}
          currentPosition={position}
          accuracy={accuracy}
          favoriteIds={favoriteSet}
          waterStatusById={waterStatusById}
          onWaypointTap={onWaypointTap}
          onVariantTap={onVariantTap}
          selectedVariantId={selectedVariantId}
          onBackgroundPress={clearVariant}
          routeOverlay={routeOverlay}
          builderMode={building}
          onMapPress={onMapPress}
          onStyleResolved={onStyleResolved}
          onVisibleBoundsChange={onVisibleBoundsChange}
        />
      </MapErrorBoundary>

      {/* Top chrome: degraded-map banner over the base-map status pill. */}
      <View style={styles.topStack} pointerEvents="box-none">
        {showBanner && (
          <DegradedMapBanner
            message={degradationMessage(degradation)}
            onRedownload={
              isRedownloadFixable(degradation) && TILE_BASE_URL.length > 0 && packTrailId
                ? onRedownload
                : undefined
            }
            onDismiss={() => setDismissed(degradation)}
          />
        )}

        <View
          style={[
            styles.pill,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
          pointerEvents="none"
        >
          {building ? (
            <Text style={[styles.pillText, { color: colors.textPrimary }]}>
              Tap the map to add route points
            </Text>
          ) : (
            <>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor: downloading
                      ? colors.downloadActive
                      : offline
                        ? colors.downloadDone
                        : colors.info,
                  },
                ]}
              />
              <Text style={[styles.pillText, { color: colors.textPrimary }]}>
                {downloading ? 'Updating offline maps…' : offline ? 'Offline maps ready' : 'Online'}
              </Text>
            </>
          )}
        </View>
      </View>

      {/* Map key for the track classes — suppressed while the builder toolbar or
          a variant's info card owns the bottom of the screen (the card names the
          class it describes anyway). */}
      {!building && !selectedVariant && (
        <TrackLegend
          hasAlternates={hasDrawableVariant(alternates)}
          hasSideTrips={hasDrawableVariant(sideTrips)}
        />
      )}

      {selectedVariant && !building && (
        <VariantInfoCard info={selectedVariant} unit={units} onDismiss={clearVariant} />
      )}

      {building && (
        <RouteBuilderBar
          totalKm={builderStats.totalKm}
          pointCount={builderPoints.length}
          unit={units}
          onUndo={undoPoint}
          onCancel={cancelBuilding}
          onSave={onSaveRoute}
        />
      )}

      {/* FAB stack — hidden whenever something else owns the bottom-right. */}
      {!building && !selectedVariant && (
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

/**
 * Dismissible notice that the mounted basemap is worse than the one the user
 * downloaded. Lives here rather than in a shared component because it is the
 * only banner in the app so far; promote it if a second caller appears.
 */
function DegradedMapBanner({
  message,
  onRedownload,
  onDismiss,
}: {
  message: string;
  /** Omitted when re-downloading can't fix the problem, or tiles are disabled. */
  onRedownload?: () => void;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.banner,
        { backgroundColor: colors.surfaceElevated, borderColor: colors.warning },
      ]}
    >
      <Text style={[styles.bannerText, { color: colors.textPrimary }]}>{message}</Text>
      <View style={styles.bannerActions}>
        {onRedownload && (
          <Pressable
            onPress={onRedownload}
            accessibilityRole="button"
            accessibilityLabel="Re-download offline maps"
            style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
          >
            <Text style={[styles.bannerAction, { color: colors.accent }]}>Re-download</Text>
          </Pressable>
        )}
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Dismiss map warning"
          style={({ pressed }) => [styles.bannerButton, pressed && styles.pressed]}
        >
          <Text style={[styles.bannerAction, { color: colors.textSecondary }]}>Dismiss</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  topStack: {
    position: 'absolute',
    top: spacing.md,
    left: spacing.md,
    right: spacing.md,
    alignItems: 'center',
    gap: spacing.sm,
  },
  banner: {
    alignSelf: 'stretch',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  bannerText: {
    ...typography.bodySmall,
  },
  bannerActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  bannerButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  bannerAction: {
    ...typography.bodySmall,
    fontWeight: '600',
  },
  pill: {
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
