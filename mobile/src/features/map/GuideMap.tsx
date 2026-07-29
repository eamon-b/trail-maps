/**
 * The guide's MapLibre map pane (view-only core).
 *
 * Renders one trail: the main track polyline, dashed alternate/side-trip
 * overlays, and clustered, data-driven waypoint markers with labels at hiking
 * zooms. Plan/route/measure interactions from the old app are intentionally
 * absent — this is the read-only guide view.
 *
 * Style resolution follows the old app's "resolve before mount" rule: the
 * concrete style *object* is fetched in JS and only then handed to a freshly
 * keyed <MapView>. Swapping a live map's style object mid-flight can crash the
 * native renderer, so the map is remounted (via `mapRemountKey`) whenever the
 * source flips between online and offline.
 *
 * GPS puck is deliberately out for now (location wiring is a later phase);
 * `currentPosition` is plumbed so that phase has a seam and nothing else needs
 * to change here.
 */

import React, {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import MapLibreGL, {
  Camera,
  CircleLayer,
  LineLayer,
  MapView,
  ShapeSource,
  SymbolLayer,
  type CameraRef,
  type Expression,
  type OnPressEvent,
} from '@maplibre/maplibre-react-native';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { tileManager } from '../../services/tile-manager';
import { getOnlineMapStyle } from '../../services/online-style-service';
import { waypointColor } from '../elevation/waypoint-category';
import {
  buildTrailLine,
  buildVariantCollection,
  buildWaypointCollection,
  trailCameraBounds,
  type LatLon,
  type MapVariant,
  type MapWaypoint,
} from './map-geojson';
import {
  FALLBACK_MAP_STYLE,
  isBasemapGeometryNoise,
  isContourTileLoadFailure,
  labelFontForSource,
  mapRemountKey,
  type MapStyleSource,
} from './map-style';

// A null access token keeps MapLibre from expecting Mapbox credentials.
MapLibreGL.setAccessToken(null);

// Silence the expected "missing contour tile" native logs so an optional
// overlay's absence never becomes a red-box error. Registered once at module
// load, mirroring the old app.
let hasWarnedAboutContourTiles = false;
MapLibreGL.Logger.setLogCallback((log: { level: string; message: string; tag?: string }) => {
  if (isBasemapGeometryNoise(log)) return true;
  if (!isContourTileLoadFailure(log)) return false;
  if (!hasWarnedAboutContourTiles) {
    console.warn('Contour overlay is temporarily unavailable; the trail map remains usable.');
    hasWarnedAboutContourTiles = true;
  }
  return true;
});

/**
 * Cartographic paint values for the marker/label overlays. These are MapLibre
 * paint properties (not RN styles) chosen for legibility against the light
 * basemap in either app theme, so they are intentionally fixed rather than
 * routed through the theme. The design-token lint targets RN styles only.
 */
const MARKER_STROKE = '#ffffff';
const LABEL_TEXT = '#1a1a1a';
const LABEL_HALO = '#ffffff';

/** Waypoints cluster only at/below this zoom (unreadable overview levels). */
export const WAYPOINT_CLUSTER_MAX_ZOOM = 10;
/** Individual waypoint labels appear at/above this zoom (above the cluster ceiling). */
export const WAYPOINT_LABEL_MIN_ZOOM = 11;

const CLUSTER_FILTER = ['has', 'point_count'] as Expression;
const INDIVIDUAL_FILTER = ['!', ['has', 'point_count']] as Expression;

const CAMERA_PADDING = { top: 48, right: 32, bottom: 48, left: 32 };

export interface GuideMapHandle {
  /** Re-fit the camera to the full trail bounds. */
  recenter: () => void;
}

export interface GuideMapProps {
  trailId: string;
  /** Which base map to render; also the map's remount key. */
  styleSource: MapStyleSource;
  /** Main-track display points for the trail polyline. */
  displayPoints: LatLon[];
  /** Alternate routes (dashed overlay). */
  alternates?: MapVariant[];
  /** Side trips (dashed overlay). */
  sideTrips?: MapVariant[];
  /** Waypoint markers. */
  waypoints?: MapWaypoint[];
  /** Current GPS position — plumbed for a later phase; no puck is drawn yet. */
  currentPosition?: { lat: number; lon: number } | null;
  /** Tapped waypoint's stable id. */
  onWaypointTap?: (id: string) => void;
}

export const GuideMap = memo(
  forwardRef<GuideMapHandle, GuideMapProps>(function GuideMap(
    { trailId, styleSource, displayPoints, alternates, sideTrips, waypoints, onWaypointTap },
    ref,
  ) {
    const { colors } = useTheme();
    const cameraRef = useRef<CameraRef>(null);

    // Resolve the concrete style object before mounting the map. The source is
    // the remount key, so this effect re-runs (and the map remounts) whenever a
    // download completing flips offline/online.
    const [resolvedStyle, setResolvedStyle] = useState<object | null>(null);
    useEffect(() => {
      let cancelled = false;
      setResolvedStyle(null);

      const resolve = async (): Promise<object> => {
        if (styleSource === 'offline') {
          const offline = await tileManager.getOfflineStyle(trailId);
          if (offline) return offline;
          // Pack vanished between the store read and here — fall back online.
        }
        return getOnlineMapStyle();
      };

      resolve()
        .then((style) => {
          if (!cancelled) setResolvedStyle(style);
        })
        .catch((error) => {
          console.warn('Failed to resolve map style; using fallback:', error);
          if (!cancelled) setResolvedStyle(FALLBACK_MAP_STYLE);
        });

      return () => {
        cancelled = true;
      };
    }, [trailId, styleSource]);

    const labelFont = useMemo(() => labelFontForSource(styleSource), [styleSource]);

    // --- GeoJSON sources ---------------------------------------------------
    const trailLine = useMemo(() => buildTrailLine(displayPoints), [displayPoints]);
    const alternatesCollection = useMemo(
      () => buildVariantCollection(alternates ?? []),
      [alternates],
    );
    const sideTripsCollection = useMemo(
      () => buildVariantCollection(sideTrips ?? []),
      [sideTrips],
    );
    const waypointCollection = useMemo(
      () => buildWaypointCollection(waypoints ?? [], (type) => waypointColor(type, colors)),
      [waypoints, colors],
    );

    // --- Camera ------------------------------------------------------------
    const bounds = useMemo(() => trailCameraBounds(displayPoints), [displayPoints]);

    const cameraDefaultSettings = useMemo(() => {
      if (bounds) {
        return {
          bounds: {
            ne: bounds.ne,
            sw: bounds.sw,
            paddingTop: CAMERA_PADDING.top,
            paddingBottom: CAMERA_PADDING.bottom,
            paddingLeft: CAMERA_PADDING.left,
            paddingRight: CAMERA_PADDING.right,
          },
        };
      }
      return { centerCoordinate: [135, -28] as [number, number], zoomLevel: 4 };
    }, [bounds]);

    useImperativeHandle(
      ref,
      () => ({
        recenter: () => {
          if (!bounds) return;
          cameraRef.current?.fitBounds(bounds.ne, bounds.sw, CAMERA_PADDING.top, 500);
        },
      }),
      [bounds],
    );

    // --- Layer paint (theme-routed line colors, data-driven marker colors) --
    const trailLineStyle = useMemo(
      () => ({
        lineColor: colors.accent,
        lineWidth: 3,
        lineOpacity: 0.9,
        lineCap: 'round' as const,
        lineJoin: 'round' as const,
      }),
      [colors.accent],
    );

    const alternatesLineStyle = useMemo(
      () => ({
        lineColor: colors.accentMuted,
        lineWidth: 2.5,
        lineOpacity: 0.85,
        lineCap: 'round' as const,
        lineJoin: 'round' as const,
        lineDasharray: [2, 1],
      }),
      [colors.accentMuted],
    );

    const sideTripsLineStyle = useMemo(
      () => ({
        lineColor: colors.info,
        lineWidth: 2.5,
        lineOpacity: 0.85,
        lineCap: 'round' as const,
        lineJoin: 'round' as const,
        lineDasharray: [2, 1],
      }),
      [colors.info],
    );

    const waypointCircleStyle = useMemo(
      () => ({
        circleRadius: 5,
        circleColor: ['get', 'color'] as unknown as string,
        circleStrokeColor: MARKER_STROKE,
        circleStrokeWidth: 1.5,
      }),
      [],
    );

    const clusterCircleStyle = useMemo(
      () => ({
        circleColor: colors.accent,
        circleOpacity: 0.85,
        circleRadius: ['step', ['get', 'point_count'], 14, 10, 18, 25, 22] as unknown as number,
        circleStrokeColor: MARKER_STROKE,
        circleStrokeWidth: 2,
      }),
      [colors.accent],
    );

    const clusterCountStyle = useMemo(
      () => ({
        textField: ['get', 'point_count_abbreviated'] as unknown as string,
        textFont: labelFont,
        textSize: 12,
        textColor: colors.accentText,
        textAllowOverlap: true,
      }),
      [labelFont, colors.accentText],
    );

    const labelStyle = useMemo(
      () => ({
        textField: ['get', 'name'] as unknown as string,
        textFont: labelFont,
        textSize: 13,
        textColor: LABEL_TEXT,
        textHaloColor: LABEL_HALO,
        textHaloWidth: 2.5,
        textOffset: [0, 1.2] as [number, number],
        textAnchor: 'top' as const,
        textMaxWidth: 15,
        textAllowOverlap: false,
      }),
      [labelFont],
    );

    // --- Interaction -------------------------------------------------------
    const handleWaypointPress = useCallback(
      async (event: OnPressEvent) => {
        const feature = event.features?.[0];
        // A cluster bubble zooms in to expand instead of selecting.
        if (feature?.properties?.point_count != null) {
          const coords =
            feature.geometry?.type === 'Point'
              ? (feature.geometry as GeoJSON.Point).coordinates
              : null;
          if (coords && coords.length >= 2 && cameraRef.current) {
            cameraRef.current.setCamera({
              centerCoordinate: [coords[0], coords[1]],
              zoomLevel: WAYPOINT_CLUSTER_MAX_ZOOM + 2,
              animationDuration: 400,
            });
          }
          return;
        }
        const id = feature?.properties?.id as string | undefined;
        if (id != null) onWaypointTap?.(id);
      },
      [onWaypointTap],
    );

    if (!resolvedStyle) {
      return (
        <View style={[styles.loading, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading map…</Text>
        </View>
      );
    }

    return (
      <MapView
        key={mapRemountKey(styleSource)}
        style={styles.map}
        mapStyle={resolvedStyle}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled
      >
        <Camera ref={cameraRef} defaultSettings={cameraDefaultSettings} />

        {/* Alternate routes (dashed) */}
        {alternatesCollection.features.length > 0 && (
          <ShapeSource id="guide-alternates" shape={alternatesCollection}>
            <LineLayer id="guide-alternates-layer" style={alternatesLineStyle} />
          </ShapeSource>
        )}

        {/* Side trips (dashed) */}
        {sideTripsCollection.features.length > 0 && (
          <ShapeSource id="guide-side-trips" shape={sideTripsCollection}>
            <LineLayer id="guide-side-trips-layer" style={sideTripsLineStyle} />
          </ShapeSource>
        )}

        {/* Main trail line */}
        {trailLine && (
          <ShapeSource id="guide-trail-line" shape={trailLine}>
            <LineLayer id="guide-trail-line-layer" style={trailLineStyle} />
          </ShapeSource>
        )}

        {/* Waypoint markers — clustered at overview zooms, labelled at hiking zooms */}
        {waypointCollection.features.length > 0 && (
          <ShapeSource
            id="guide-waypoints"
            shape={waypointCollection}
            onPress={handleWaypointPress}
            hitbox={{ width: 30, height: 30 }}
            cluster
            clusterRadius={40}
            clusterMaxZoomLevel={WAYPOINT_CLUSTER_MAX_ZOOM}
          >
            <CircleLayer id="guide-waypoints-clusters" filter={CLUSTER_FILTER} style={clusterCircleStyle} />
            <SymbolLayer
              id="guide-waypoints-cluster-counts"
              filter={CLUSTER_FILTER}
              style={clusterCountStyle}
            />
            <CircleLayer
              id="guide-waypoints-circles"
              filter={INDIVIDUAL_FILTER}
              style={waypointCircleStyle}
            />
            <SymbolLayer
              id="guide-waypoints-labels"
              minZoomLevel={WAYPOINT_LABEL_MIN_ZOOM}
              filter={INDIVIDUAL_FILTER}
              style={labelStyle}
            />
          </ShapeSource>
        )}
      </MapView>
    );
  }),
);

const styles = StyleSheet.create({
  map: {
    flex: 1,
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    ...typography.bodySmall,
  },
});
