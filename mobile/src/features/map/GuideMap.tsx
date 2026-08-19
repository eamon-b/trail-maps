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
 * Markers are FarOut-style badges: a white disc ringed in the waypoint's
 * category colour with a per-type ink glyph on top (see waypoint-icons). The
 * glyphs are bundled PNGs registered through <Images>, because the map has to
 * work offline and the bundled glyph pbfs carry no pictographs.
 *
 * Two overlays are tappable, and which one wins is decided natively by style
 * order (the native map picks the touched source whose layers sit highest): the
 * waypoint source is declared last, so a marker tap always beats the variant
 * line underneath it. A tap that hits neither reaches <Map onPress>, which is
 * what dismisses the variant selection — and because MapLibre RN 11 bubbles a
 * source press up to the map, the source handlers stop propagation so a marker
 * tap does not also count as a background tap.
 *
 * Style resolution follows the old app's "resolve before mount" rule: the
 * concrete style *object* is fetched in JS and only then handed to a freshly
 * keyed <Map>. Swapping a live map's style object mid-flight can crash the
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
import { ActivityIndicator, StyleSheet, Text, View, type NativeSyntheticEvent } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Images,
  Layer,
  LogManager,
  Map as MapLibreMap,
  type CameraRef,
  type FilterSpecification,
  type InitialViewState,
  type PressEvent,
  type PressEventWithFeatures,
  type StyleSpecification,
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
  type WaterStatusLookup,
} from './map-geojson';
import { WAYPOINT_ICON_IMAGES } from './waypoint-icon-images';
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

// (MapLibre RN 11 dropped setAccessToken/getAccessToken with no replacement —
// MapLibre never wanted a Mapbox token, so nothing takes its place here.)

// Silence the expected "missing contour tile" native logs so an optional
// overlay's absence never becomes a red-box error. Registered once at module
// load, mirroring the old app.
let hasWarnedAboutContourTiles = false;
LogManager.onLog((log: { level: string; message: string; tag?: string }) => {
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
/**
 * Marker badge fill. The glyph PNGs are dark ink on transparency, so the disc
 * behind them is white in either app theme — the category colour moves to the
 * ring (circleStrokeColor), which is still theme-resolved.
 */
const MARKER_BADGE = '#ffffff';
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

/**
 * Marker badge geometry, in screen px. The badge grew from the old Ø13 dot to
 * Ø23 (radius + ring) so a glyph fits inside it and still reads at arm's length
 * in sunlight; the tap target is the source hitbox below, not this.
 */
const MARKER_RADIUS = 9;
const MARKER_RING_WIDTH = 2.5;
/** Favorites keep their pink ring, one size up so a star stands out. */
const FAVORITE_MARKER_RADIUS = 11;
const FAVORITE_MARKER_RING_WIDTH = 3.5;
/**
 * Icon scale for the 96 px glyph PNGs. 0.165 lands the glyph's ~76 px content
 * box at ~12.5 px on screen, whose diagonal just fits inside the Ø18 white
 * badge — bigger and the corners of the wider glyphs spill over the ring.
 */
const MARKER_ICON_SIZE = 0.165;

const CLUSTER_FILTER = ['has', 'point_count'] as FilterSpecification;
const INDIVIDUAL_FILTER = ['!', ['has', 'point_count']] as FilterSpecification;

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
  /**
   * Aggregated water status per bundled waypoint id (see the guide's
   * `useWaterStatus`). Tints a water source's marker ring by its status; markers
   * without an entry keep their category ring.
   */
  waterStatusById?: WaterStatusLookup;
  /** Tapped waypoint's stable id. */
  onWaypointTap?: (id: string) => void;
  /**
   * Tapped variant's feature id ("alternate-2" / "side-trip-0", see
   * variantFeatureId). Omit to leave the variant lines inert.
   */
  onVariantTap?: (id: string) => void;
  /** Variant feature id to highlight (the one whose info card is open). */
  selectedVariantId?: string | null;
  /**
   * A tap that hit no overlay. Only fires outside builder mode (where every tap
   * is a route point instead) — used to dismiss the variant selection.
   */
  onBackgroundPress?: () => void;
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

// Route-overlay layer filters: split the single mixed GeoJSONSource into
// on-trail spans (solid), straight/off-trail legs (dashed), and builder
// vertices (dots) by geometry type + the `straight` property.
const ROUTE_SPAN_FILTER = [
  'all',
  ['==', ['geometry-type'], 'LineString'],
  ['!=', ['get', 'straight'], true],
] as FilterSpecification;
const ROUTE_STRAIGHT_FILTER = [
  'all',
  ['==', ['geometry-type'], 'LineString'],
  ['==', ['get', 'straight'], true],
] as FilterSpecification;
const ROUTE_VERTEX_FILTER = ['==', ['geometry-type'], 'Point'] as FilterSpecification;

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

/**
 * Invisible fat line over each variant, purely as a tap target: a 3 px dotted
 * spur is impossible to hit precisely with a thumb. The source's hitbox already
 * adds slop around the touch point, and this widens the *line* the query tests
 * against — MapLibre buffers a line's query geometry by its rendered width, and
 * `line-opacity: 0` suppresses drawing without removing the feature from the
 * index the tap query walks.
 */
const VARIANT_HIT_WIDTH = 20;
const VARIANT_HIT_STYLE = {
  lineColor: TRACK_COLORS.alternate,
  lineWidth: VARIANT_HIT_WIDTH,
  lineOpacity: 0,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
};

/**
 * Hit slop around the touch point for the variant sources (±22 px). MapLibre RN
 * 11 takes the hitbox as edge insets rather than v10's {width, height} box, so
 * these are the half-extents of the same 44 x 44 target.
 */
const VARIANT_HITBOX = { top: 22, right: 22, bottom: 22, left: 22 };
/** Waypoint markers are bigger now, so their hitbox grew with them. */
const WAYPOINT_HITBOX = { top: 22, right: 22, bottom: 22, left: 22 };

/**
 * Halo drawn under the selected variant's dashes while its info card is open —
 * wide, solid, and semi-transparent, so the dash pattern still reads on top and
 * the highlight cannot be mistaken for a different track class.
 */
function variantHighlightStyle(color: string, baseWidth: number) {
  return {
    lineColor: color,
    lineWidth: trackWidthExpression(baseWidth * 3) as unknown as number,
    lineOpacity: 0.4,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
  };
}

const ALTERNATE_HIGHLIGHT_STYLE = variantHighlightStyle(
  TRACK_COLORS.alternate,
  TRACK_WIDTHS.alternate,
);
const SIDE_TRIP_HIGHLIGHT_STYLE = variantHighlightStyle(
  TRACK_COLORS.sideTrip,
  TRACK_WIDTHS.sideTrip,
);

/** Matches only the selected variant; matches nothing when none is selected. */
function selectedVariantFilter(
  selectedVariantId: string | null | undefined,
): FilterSpecification {
  return ['==', ['get', 'id'], selectedVariantId ?? ''] as FilterSpecification;
}

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
      waterStatusById,
      onWaypointTap,
      onVariantTap,
      selectedVariantId,
      onBackgroundPress,
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
      () => buildVariantCollection(alternates ?? [], 'alternate'),
      [alternates],
    );
    const sideTripsCollection = useMemo(
      () => buildVariantCollection(sideTrips ?? [], 'side-trip'),
      [sideTrips],
    );
    const highlightFilter = useMemo(
      () => selectedVariantFilter(selectedVariantId),
      [selectedVariantId],
    );
    const waypointCollection = useMemo(
      () =>
        buildWaypointCollection(
          waypoints ?? [],
          (type) => waypointColor(type, colors),
          favoriteIds,
          waterStatusById,
        ),
      [waypoints, colors, favoriteIds, waterStatusById],
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

    const cameraInitialViewState = useMemo<InitialViewState>(() => {
      if (bounds) return { bounds, padding: CAMERA_PADDING };
      return { center: [135, -28], zoom: 4 };
    }, [bounds]);

    useImperativeHandle(
      ref,
      () => ({
        recenter: () => {
          if (!bounds) return;
          cameraRef.current?.fitBounds(bounds, { padding: CAMERA_PADDING, duration: 500 });
        },
        centerOnMe: () => {
          if (!currentPosition) return;
          cameraRef.current?.easeTo({
            center: [currentPosition.lon, currentPosition.lat],
            zoom: 14,
            duration: 500,
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

    // The badge: a white disc ringed in the waypoint's category color, with the
    // per-type glyph drawn over it by the icon layer below. Favorites read as a
    // data-driven `case` on the feature's `favorite` flag — one size up and
    // ringed in the theme favorite color — so a single circle layer paints both
    // states and clustering is untouched.
    //
    // Water sources with an aggregated status swap that category ring for the
    // status colour (flowing/low/dry), so a glance at the map shows which
    // sources were last reported dry. Deliberately ring-only: no extra layer, no
    // new glyph, and a starred waypoint still wins (the favorite ring is what the
    // hiker asked to see).
    const waypointCircleStyle = useMemo(
      () => ({
        circleRadius: [
          'case',
          ['get', 'favorite'],
          FAVORITE_MARKER_RADIUS,
          MARKER_RADIUS,
        ] as unknown as number,
        circleColor: MARKER_BADGE,
        circleStrokeColor: [
          'case',
          ['get', 'favorite'],
          colors.waypointFavorite,
          [
            'match',
            ['get', 'waterStatus'],
            'flowing',
            colors.waterFlowing,
            'low',
            colors.waterLow,
            'dry',
            colors.waterDry,
            ['get', 'color'],
          ],
        ] as unknown as string,
        circleStrokeWidth: [
          'case',
          ['get', 'favorite'],
          FAVORITE_MARKER_RING_WIDTH,
          MARKER_RING_WIDTH,
        ] as unknown as number,
      }),
      [colors.waypointFavorite, colors.waterFlowing, colors.waterLow, colors.waterDry],
    );

    // Per-type glyph over the badge. `iconAllowOverlap` + `iconIgnorePlacement`
    // keep every marker's glyph drawn (and keep symbol collision from hiding a
    // glyph while its circle stays visible); labels still collide normally.
    const waypointIconStyle = useMemo(
      () => ({
        iconImage: ['get', 'icon'] as unknown as string,
        iconSize: MARKER_ICON_SIZE,
        iconAllowOverlap: true,
        iconIgnorePlacement: true,
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
        // In ems; clears the taller badge (favorites reach 14.5 px from center).
        textOffset: [0, 1.5] as [number, number],
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
    // MapLibre RN 11 bubbles a source press up to <Map onPress> unless the
    // source handler stops it. Every handler below therefore calls
    // stopPropagation() first: without it a marker or variant tap would *also*
    // run handleMapPress, which clears the variant selection the tap just made
    // (and, in builder mode, would drop a route point under the marker).
    const handleWaypointPress = useCallback(
      (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
        event.stopPropagation();
        const feature = event.nativeEvent.features?.[0];
        // A cluster bubble zooms in to expand instead of selecting.
        if (feature?.properties?.point_count != null) {
          const coords =
            feature.geometry?.type === 'Point'
              ? (feature.geometry as GeoJSON.Point).coordinates
              : null;
          if (coords && coords.length >= 2 && cameraRef.current) {
            cameraRef.current.easeTo({
              center: [coords[0], coords[1]],
              zoom: WAYPOINT_CLUSTER_MAX_ZOOM + 2,
              duration: 400,
            });
          }
          return;
        }
        const id = feature?.properties?.id as string | undefined;
        if (id != null) onWaypointTap?.(id);
      },
      [onWaypointTap],
    );

    // A tapped variant line. The hit layer and the visible dashes both belong to
    // the source, so a tap can return either; both carry the same feature `id`.
    const handleVariantPress = useCallback(
      (event: NativeSyntheticEvent<PressEventWithFeatures>) => {
        event.stopPropagation();
        const id = event.nativeEvent.features?.[0]?.properties?.id as string | undefined;
        if (id != null) onVariantTap?.(id);
      },
      [onVariantTap],
    );

    // In builder mode, every map tap adds a route point (overlay selection is
    // suppressed below so taps flow through to the raw coordinate). Outside it,
    // a tap that hit no overlay is a request to clear the current selection.
    const handleMapPress = useCallback(
      (event: NativeSyntheticEvent<PressEvent> | NativeSyntheticEvent<PressEventWithFeatures>) => {
        if (!builderMode) {
          onBackgroundPress?.();
          return;
        }
        if (!onMapPress) return;
        const lngLat = event.nativeEvent.lngLat;
        if (!lngLat) return;
        const [lon, lat] = lngLat;
        onMapPress(lat, lon);
      },
      [builderMode, onMapPress, onBackgroundPress],
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
      <MapLibreMap
        key={mapRemountKey(resolved.source)}
        style={styles.map}
        mapStyle={resolved.style as StyleSpecification}
        logo={false}
        attribution={false}
        compass
        onPress={builderMode || onBackgroundPress ? handleMapPress : undefined}
      >
        <Camera ref={cameraRef} initialViewState={cameraInitialViewState} />

        {/* Marker glyphs. Registered inside the map, so a style flip (which
            remounts the map) re-registers them with the new style. */}
        <Images images={WAYPOINT_ICON_IMAGES} />

        {/* Alternate routes: long-dashed violet, under the main track */}
        {alternatesCollection.features.length > 0 && (
          <GeoJSONSource
            id="guide-alternates"
            data={alternatesCollection}
            onPress={builderMode ? undefined : handleVariantPress}
            hitbox={VARIANT_HITBOX}
          >
            <Layer type="line" id="guide-alternates-hit" style={VARIANT_HIT_STYLE} />
            <Layer
              type="line"
              id="guide-alternates-highlight"
              filter={highlightFilter}
              style={ALTERNATE_HIGHLIGHT_STYLE}
            />
            <Layer type="line" id="guide-alternates-layer" style={ALTERNATE_TRACK_STYLE} />
          </GeoJSONSource>
        )}

        {/* Side trips: finely dotted teal, under the main track */}
        {sideTripsCollection.features.length > 0 && (
          <GeoJSONSource
            id="guide-side-trips"
            data={sideTripsCollection}
            onPress={builderMode ? undefined : handleVariantPress}
            hitbox={VARIANT_HITBOX}
          >
            <Layer type="line" id="guide-side-trips-hit" style={VARIANT_HIT_STYLE} />
            <Layer
              type="line"
              id="guide-side-trips-highlight"
              filter={highlightFilter}
              style={SIDE_TRIP_HIGHLIGHT_STYLE}
            />
            <Layer type="line" id="guide-side-trips-layer" style={SIDE_TRIP_TRACK_STYLE} />
          </GeoJSONSource>
        )}

        {/* Main trail line: white casing + solid red core, drawn last so the
            trail itself always wins where the three classes overlap */}
        {trailLine && (
          <GeoJSONSource id="guide-trail-line" data={trailLine}>
            <Layer type="line" id="guide-trail-line-casing" style={MAIN_TRACK_CASING_STYLE} />
            <Layer type="line" id="guide-trail-line-layer" style={MAIN_TRACK_STYLE} />
          </GeoJSONSource>
        )}

        {/* Custom route overlay (active route or in-progress builder), above
            the trail line: solid on-trail spans, dashed off-trail legs, dots
            for builder vertices. */}
        {routeOverlay && routeOverlay.features.length > 0 && (
          <GeoJSONSource id="guide-route" data={routeOverlay}>
            <Layer
              type="line"
              id="guide-route-spans"
              filter={ROUTE_SPAN_FILTER}
              style={routeSpanStyle}
            />
            <Layer
              type="line"
              id="guide-route-straight"
              filter={ROUTE_STRAIGHT_FILTER}
              style={routeStraightStyle}
            />
            <Layer
              type="circle"
              id="guide-route-vertices"
              filter={ROUTE_VERTEX_FILTER}
              style={routeVertexStyle}
            />
          </GeoJSONSource>
        )}

        {/* Waypoint markers — clustered at overview zooms, labelled at hiking zooms */}
        {waypointCollection.features.length > 0 && (
          <GeoJSONSource
            id="guide-waypoints"
            data={waypointCollection}
            onPress={builderMode ? undefined : handleWaypointPress}
            hitbox={WAYPOINT_HITBOX}
            cluster
            clusterRadius={40}
            clusterMaxZoom={WAYPOINT_CLUSTER_MAX_ZOOM}
          >
            <Layer
              type="circle"
              id="guide-waypoints-clusters"
              filter={CLUSTER_FILTER}
              style={clusterCircleStyle}
            />
            <Layer
              type="symbol"
              id="guide-waypoints-cluster-counts"
              filter={CLUSTER_FILTER}
              style={clusterCountStyle}
            />
            <Layer
              type="circle"
              id="guide-waypoints-circles"
              filter={INDIVIDUAL_FILTER}
              style={waypointCircleStyle}
            />
            <Layer
              type="symbol"
              id="guide-waypoints-icons"
              filter={INDIVIDUAL_FILTER}
              style={waypointIconStyle}
            />
            <Layer
              type="symbol"
              id="guide-waypoints-labels"
              minzoom={WAYPOINT_LABEL_MIN_ZOOM}
              filter={INDIVIDUAL_FILTER}
              style={labelStyle}
            />
          </GeoJSONSource>
        )}

        {/* User-location puck: accuracy circle (when uncertain) + dot */}
        {userLocationFeature && (
          <GeoJSONSource id="guide-user-location" data={userLocationFeature}>
            {(accuracy ?? 0) > ACCURACY_CIRCLE_MIN_METERS && (
              <Layer
                type="circle"
                id="guide-user-accuracy"
                minzoom={ACCURACY_CIRCLE_MIN_ZOOM}
                style={userAccuracyStyle}
              />
            )}
            <Layer type="circle" id="guide-user-dot" style={userDotStyle} />
          </GeoJSONSource>
        )}
      </MapLibreMap>
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
