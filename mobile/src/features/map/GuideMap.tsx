/**
 * The guide's MapLibre map pane (view-only core).
 *
 * Renders one trail as three visually distinct track classes — solid red main
 * track (over a white casing), long-dashed violet alternates, finely dotted teal
 * side trips — plus clustered, data-driven waypoint markers with labels at
 * hiking zooms. Track paint lives in map-style's TRACK_COLORS/TRACK_DASH.
 * Plan/measure interactions from the old app are intentionally absent — this is
 * the read-only guide view.
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
  accuracyCircleRadiusExpression,
  buildTrailLine,
  buildUserLocationGeoJSON,
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
  TRACK_COLORS,
  TRACK_DASH,
  TRACK_WIDTHS,
  trackWidthExpression,
  type MapStyleResolution,
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
/** Puck ring/dot stroke against the basemap (paint prop, not an RN style). */
const PUCK_STROKE = '#ffffff';
/** Zoom below which the accuracy circle is hidden (unreadable at overview). */
const ACCURACY_CIRCLE_MIN_ZOOM = 8;
/** Only draw the accuracy circle when the fix is this uncertain (metres). */
const ACCURACY_CIRCLE_MIN_METERS = 20;

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
  /** Center + zoom the camera on the current GPS position (no-op without one). */
  centerOnMe: () => void;
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
  /** Current GPS position — draws the user-location puck when present. */
  currentPosition?: { lat: number; lon: number } | null;
  /** GPS accuracy in metres — sizes the puck's accuracy circle. */
  accuracy?: number | null;
  /** Starred waypoint ids — enlarged and ringed in the favorite color. */
  favoriteIds?: ReadonlySet<string>;
  /** Tapped waypoint's stable id. */
  onWaypointTap?: (id: string) => void;
  /**
   * Custom-route overlay (the active saved route, or the in-progress builder
   * route). Mixed geometry: LineString features (`straight` property → dashed)
   * for legs, plus optional Point features (route vertices) for the builder.
   */
  routeOverlay?: GeoJSON.FeatureCollection;
  /** In builder mode, map taps report a coordinate via `onMapPress`. */
  builderMode?: boolean;
  /** A raw map tap (lat/lon) while in builder mode. */
  onMapPress?: (lat: number, lon: number) => void;
  /**
   * Reports what actually mounted each time the style is resolved, so the pane
   * can surface a degraded basemap to the user. Fired on every resolution,
   * including the healthy one (so a fixed map clears any banner).
   */
  onStyleResolved?: (resolution: MapStyleResolution) => void;
}

// Route-overlay layer filters: split the single mixed ShapeSource into
// on-trail spans (solid), straight/off-trail legs (dashed), and builder
// vertices (dots) by geometry type + the `straight` property.
const ROUTE_SPAN_FILTER = [
  'all',
  ['==', ['geometry-type'], 'LineString'],
  ['!=', ['get', 'straight'], true],
] as Expression;
const ROUTE_STRAIGHT_FILTER = [
  'all',
  ['==', ['geometry-type'], 'LineString'],
  ['==', ['get', 'straight'], true],
] as Expression;
const ROUTE_VERTEX_FILTER = ['==', ['geometry-type'], 'Point'] as Expression;

// --- Track paint --------------------------------------------------------------
// The three track classes are theme-independent map cartography (see
// TRACK_COLORS in map-style): main = solid red over a white casing, alternates =
// long-dashed violet, side trips = finely dotted teal. Defined at module level
// because nothing here depends on the app theme or on props, so the layers never
// re-paint.

/** White outline under the main track; makes the red read over any basemap. */
const MAIN_TRACK_CASING_STYLE = {
  lineColor: TRACK_COLORS.mainCasing,
  lineWidth: trackWidthExpression(TRACK_WIDTHS.mainCasing) as unknown as number,
  lineOpacity: 0.8,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
};

const MAIN_TRACK_STYLE = {
  lineColor: TRACK_COLORS.main,
  lineWidth: trackWidthExpression(TRACK_WIDTHS.main) as unknown as number,
  lineOpacity: 1,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
};

const ALTERNATE_TRACK_STYLE = {
  lineColor: TRACK_COLORS.alternate,
  lineWidth: trackWidthExpression(TRACK_WIDTHS.alternate) as unknown as number,
  lineOpacity: 1,
  lineCap: 'butt' as const,
  lineJoin: 'round' as const,
  lineDasharray: TRACK_DASH.alternate as unknown as number[],
};

const SIDE_TRIP_TRACK_STYLE = {
  lineColor: TRACK_COLORS.sideTrip,
  lineWidth: trackWidthExpression(TRACK_WIDTHS.sideTrip) as unknown as number,
  lineOpacity: 1,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
  lineDasharray: TRACK_DASH.sideTrip as unknown as number[],
};

export const GuideMap = memo(
  forwardRef<GuideMapHandle, GuideMapProps>(function GuideMap(
    {
      trailId,
      styleSource,
      displayPoints,
      alternates,
      sideTrips,
      waypoints,
      currentPosition,
      accuracy,
      favoriteIds,
      onWaypointTap,
      routeOverlay,
      builderMode,
      onMapPress,
      onStyleResolved,
    },
    ref,
  ) {
    const { colors } = useTheme();
    const cameraRef = useRef<CameraRef>(null);

    // Held in a ref so a parent re-rendering with a new callback identity does
    // not re-run style resolution (which would remount the native map).
    const onStyleResolvedRef = useRef(onStyleResolved);
    onStyleResolvedRef.current = onStyleResolved;

    // Resolve the concrete style object before mounting the map, and remember
    // which source it actually came from. `styleSource` is only the *request*:
    // an offline request whose pack is damaged resolves online, and everything
    // downstream (label font, remount key) must follow what mounted, not what
    // was asked for — otherwise we hand Liberty's Noto Sans glyph server a
    // request for Open Sans and every label renders as an empty box.
    const [resolved, setResolved] = useState<{ style: object; source: MapStyleSource } | null>(
      null,
    );
    useEffect(() => {
      let cancelled = false;
      setResolved(null);

      const resolve = async (): Promise<{ style: object; resolution: MapStyleResolution }> => {
        if (styleSource === 'offline') {
          const offline = await tileManager.getOfflineStyle(trailId);
          if (offline) {
            return {
              style: offline.style,
              resolution: {
                requested: 'offline',
                resolved: 'offline',
                contoursDropped: offline.contoursDropped,
                fallback: false,
                reason: offline.reason,
              },
            };
          }
          // Pack missing or damaged between the store read and here — the map
          // goes online, and says so.
          return {
            style: await getOnlineMapStyle(),
            resolution: {
              requested: 'offline',
              resolved: 'online',
              contoursDropped: false,
              fallback: false,
            },
          };
        }
        return {
          style: await getOnlineMapStyle(),
          resolution: {
            requested: 'online',
            resolved: 'online',
            contoursDropped: false,
            fallback: false,
          },
        };
      };

      resolve()
        .then(({ style, resolution }) => {
          if (cancelled) return;
          setResolved({ style, source: resolution.resolved });
          onStyleResolvedRef.current?.(resolution);
        })
        .catch((error) => {
          console.warn('Failed to resolve map style; using fallback:', error);
          if (cancelled) return;
          // The bare fallback style ships no glyphs at all, so 'online' here is
          // only about keeping the label stack on a defined value.
          setResolved({ style: FALLBACK_MAP_STYLE, source: 'online' });
          onStyleResolvedRef.current?.({
            requested: styleSource,
            resolved: 'online',
            contoursDropped: false,
            fallback: true,
            reason: error instanceof Error ? error.message : String(error),
          });
        });

      return () => {
        cancelled = true;
      };
    }, [trailId, styleSource]);

    const resolvedSource = resolved?.source ?? styleSource;
    const labelFont = useMemo(() => labelFontForSource(resolvedSource), [resolvedSource]);

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
      () =>
        buildWaypointCollection(waypoints ?? [], (type) => waypointColor(type, colors), favoriteIds),
      [waypoints, colors, favoriteIds],
    );

    // --- User-location puck ------------------------------------------------
    const userLocationFeature = useMemo(
      () =>
        currentPosition
          ? buildUserLocationGeoJSON(currentPosition.lat, currentPosition.lon, accuracy ?? null)
          : null,
      [currentPosition, accuracy],
    );
    const accuracyRadius = useMemo(
      () => accuracyCircleRadiusExpression(currentPosition?.lat ?? -33),
      [currentPosition?.lat],
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
        centerOnMe: () => {
          if (!currentPosition) return;
          cameraRef.current?.setCamera({
            centerCoordinate: [currentPosition.lon, currentPosition.lat],
            zoomLevel: 14,
            animationDuration: 500,
          });
        },
      }),
      [bounds, currentPosition],
    );

    // --- Layer paint (data-driven marker colors; track paint is module-level) --
    // Custom route overlay — a distinct warning/amber hue that reads clearly
    // above the red trail line, violet alternates, and teal side trips. On-trail
    // spans are solid and heavier than the trail; off-trail legs are dashed so
    // they are never read as trail-accurate; builder vertices are amber dots.
    const routeSpanStyle = useMemo(
      () => ({
        lineColor: colors.warning,
        lineWidth: 4,
        lineOpacity: 0.95,
        lineCap: 'round' as const,
        lineJoin: 'round' as const,
      }),
      [colors.warning],
    );

    const routeStraightStyle = useMemo(
      () => ({
        lineColor: colors.warning,
        lineWidth: 3,
        lineOpacity: 0.9,
        lineCap: 'round' as const,
        lineJoin: 'round' as const,
        lineDasharray: [1.5, 1.5],
      }),
      [colors.warning],
    );

    const routeVertexStyle = useMemo(
      () => ({
        circleRadius: 5,
        circleColor: colors.warning,
        circleStrokeColor: MARKER_STROKE,
        circleStrokeWidth: 2,
      }),
      [colors.warning],
    );

    // Favorited markers read as a data-driven `case` on the feature's
    // `favorite` flag: a larger circle ringed in the theme favorite color, so a
    // single CircleLayer paints both states and clustering is untouched.
    const waypointCircleStyle = useMemo(
      () => ({
        circleRadius: ['case', ['get', 'favorite'], 7, 5] as unknown as number,
        circleColor: ['get', 'color'] as unknown as string,
        circleStrokeColor: ['case', ['get', 'favorite'], colors.waypointFavorite, MARKER_STROKE] as unknown as string,
        circleStrokeWidth: ['case', ['get', 'favorite'], 3, 1.5] as unknown as number,
      }),
      [colors.waypointFavorite],
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

    const userDotStyle = useMemo(
      () => ({
        circleRadius: 6,
        circleColor: colors.gps,
        circleStrokeColor: PUCK_STROKE,
        circleStrokeWidth: 2,
      }),
      [colors.gps],
    );

    const userAccuracyStyle = useMemo(
      () => ({
        circleRadius: accuracyRadius as unknown as number,
        circleColor: colors.gps,
        circleOpacity: 0.12,
        circleStrokeColor: colors.gps,
        circleStrokeOpacity: 0.35,
        circleStrokeWidth: 1,
        circlePitchAlignment: 'map' as const,
      }),
      [accuracyRadius, colors.gps],
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

    // In builder mode, every map tap adds a route point (waypoint selection is
    // suppressed below so taps flow through to the raw coordinate).
    const handleMapPress = useCallback(
      (feature: GeoJSON.Feature) => {
        if (!builderMode || !onMapPress) return;
        const geom = feature.geometry;
        if (geom?.type === 'Point') {
          const [lon, lat] = geom.coordinates;
          onMapPress(lat, lon);
        }
      },
      [builderMode, onMapPress],
    );

    if (!resolved) {
      return (
        <View style={[styles.loading, { backgroundColor: colors.background }]}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading map…</Text>
        </View>
      );
    }

    return (
      <MapView
        key={mapRemountKey(resolved.source)}
        style={styles.map}
        mapStyle={resolved.style}
        logoEnabled={false}
        attributionEnabled={false}
        compassEnabled
        onPress={builderMode ? handleMapPress : undefined}
      >
        <Camera ref={cameraRef} defaultSettings={cameraDefaultSettings} />

        {/* Alternate routes: long-dashed violet, under the main track */}
        {alternatesCollection.features.length > 0 && (
          <ShapeSource id="guide-alternates" shape={alternatesCollection}>
            <LineLayer id="guide-alternates-layer" style={ALTERNATE_TRACK_STYLE} />
          </ShapeSource>
        )}

        {/* Side trips: finely dotted teal, under the main track */}
        {sideTripsCollection.features.length > 0 && (
          <ShapeSource id="guide-side-trips" shape={sideTripsCollection}>
            <LineLayer id="guide-side-trips-layer" style={SIDE_TRIP_TRACK_STYLE} />
          </ShapeSource>
        )}

        {/* Main trail line: white casing + solid red core, drawn last so the
            trail itself always wins where the three classes overlap */}
        {trailLine && (
          <ShapeSource id="guide-trail-line" shape={trailLine}>
            <LineLayer id="guide-trail-line-casing" style={MAIN_TRACK_CASING_STYLE} />
            <LineLayer id="guide-trail-line-layer" style={MAIN_TRACK_STYLE} />
          </ShapeSource>
        )}

        {/* Custom route overlay (active route or in-progress builder), above
            the trail line: solid on-trail spans, dashed off-trail legs, dots
            for builder vertices. */}
        {routeOverlay && routeOverlay.features.length > 0 && (
          <ShapeSource id="guide-route" shape={routeOverlay}>
            <LineLayer id="guide-route-spans" filter={ROUTE_SPAN_FILTER} style={routeSpanStyle} />
            <LineLayer
              id="guide-route-straight"
              filter={ROUTE_STRAIGHT_FILTER}
              style={routeStraightStyle}
            />
            <CircleLayer
              id="guide-route-vertices"
              filter={ROUTE_VERTEX_FILTER}
              style={routeVertexStyle}
            />
          </ShapeSource>
        )}

        {/* Waypoint markers — clustered at overview zooms, labelled at hiking zooms */}
        {waypointCollection.features.length > 0 && (
          <ShapeSource
            id="guide-waypoints"
            shape={waypointCollection}
            onPress={builderMode ? undefined : handleWaypointPress}
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

        {/* User-location puck: accuracy circle (when uncertain) + dot */}
        {userLocationFeature && (
          <ShapeSource id="guide-user-location" shape={userLocationFeature}>
            {(accuracy ?? 0) > ACCURACY_CIRCLE_MIN_METERS && (
              <CircleLayer
                id="guide-user-accuracy"
                minZoomLevel={ACCURACY_CIRCLE_MIN_ZOOM}
                style={userAccuracyStyle}
              />
            )}
            <CircleLayer id="guide-user-dot" style={userDotStyle} />
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
