import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import MapLibreGL, { type CameraRef, type MapViewRef, type OnPressEvent } from '@maplibre/maplibre-react-native';
import type { TrackPoint, TrailWaypoint, RouteVariant } from '../lib/trail-utils';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

MapLibreGL.setAccessToken(null);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Color mapping for waypoint types on the map */
const WAYPOINT_COLORS: Record<string, string> = {
  campsite: '#4CAF50',
  water: '#2196F3',
  'water-tank': '#2196F3',
  town: '#FF9800',
  shelter: '#795548',
  hut: '#795548',
  accommodation: '#795548',
  'caravan-park': '#795548',
  mountain: '#607D8B',
  summit: '#607D8B',
  trailhead: '#9C27B0',
  endpoint: '#9C27B0',
  food: '#FF5722',
  resupply: '#FF5722',
  'road-crossing': '#757575',
  'inlet-crossing': '#00BCD4',
  beach: '#00BCD4',
  poi: '#FFC107',
  'side-trip': '#9C27B0',
};

function getWaypointColor(type: string): string {
  return WAYPOINT_COLORS[type] ?? '#757575';
}

interface LocationCoords {
  latitude: number;
  longitude: number;
  accuracy?: number;
  heading?: number;
}

export interface TrailMapProps {
  /** Track display points for the main trail line */
  displayPoints: TrackPoint[];
  /** Track points for alternates */
  alternates?: RouteVariant[];
  /** Track points for side trips */
  sideTrips?: RouteVariant[];
  /** Waypoints to show as markers */
  waypoints?: TrailWaypoint[];
  /** User's current GPS location */
  userLocation?: LocationCoords | null;
  /** ID of focused waypoint to highlight */
  focusedWaypointId?: string | number | null;
  /** Called when a waypoint marker is tapped */
  onWaypointPress?: (waypoint: TrailWaypoint, index: number) => void;
  /** Whether camera should follow the user */
  isFollowingUser?: boolean;
  /** Called when user manually pans the map */
  onMapPan?: () => void;
  /** Called when user taps re-center button */
  onRecenter?: () => void;
  /** Current position along trail in km (for display chip) */
  currentKm?: number | null;
  /** Coordinate to pan camera to (from profile tap or other navigation). Increment counter to re-trigger same coordinate. */
  panTarget?: { longitude: number; latitude: number; key: number } | null;
  /** Override the default MapTiler Cloud style with a custom style (e.g. offline MBTiles) */
  mapStyleOverride?: object | null;
  /** Called when map viewport changes, with the visible km range along the trail */
  onVisibleBoundsChange?: (minKm: number, maxKm: number) => void;
  /** Full-resolution track points for viewport km calculation */
  trackPoints?: TrackPoint[];
  /** Highlighted segment to show on the trail (e.g., a day's hike) */
  highlightedSegment?: { startKm: number; endKm: number } | null;
  /** Called on long press with the nearest trail coordinate */
  onLongPress?: (coordinate: { latitude: number; longitude: number; nearestKm: number }) => void;
  /** Custom marker pins (for stop locations, measure points, etc.) */
  customPins?: { latitude: number; longitude: number; label: string; color?: string }[];
}

function buildTrailGeoJSON(points: TrackPoint[]) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: points.map(p => [p.lon, p.lat]),
    },
    properties: {},
  };
}

function buildVariantGeoJSON(variants: RouteVariant[], variantType: string) {
  const features = variants
    .filter(v => v.points && v.points.length >= 2)
    .map(v => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: v.points!.map(p => [p.lon, p.lat]),
      },
      properties: { name: v.name, type: variantType },
    }));
  return { type: 'FeatureCollection' as const, features };
}

function buildWaypointsGeoJSON(waypoints: TrailWaypoint[]) {
  const features = waypoints.map((wp, index) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [wp.lon, wp.lat],
    },
    properties: {
      id: index,
      name: wp.name,
      type: wp.type,
      color: getWaypointColor(wp.type),
      totalDistance: wp.totalDistance ?? 0,
    },
  }));
  return { type: 'FeatureCollection' as const, features };
}

function buildSegmentGeoJSON(points: TrackPoint[], startKm: number, endKm: number) {
  const segmentPoints = points.filter(p => p.dist >= startKm && p.dist <= endKm);
  if (segmentPoints.length < 2) return null;
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'LineString' as const,
      coordinates: segmentPoints.map(p => [p.lon, p.lat]),
    },
    properties: {},
  };
}

function buildCustomPinsGeoJSON(pins: { latitude: number; longitude: number; label: string; color?: string }[]) {
  const features = pins.map((pin, i) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [pin.longitude, pin.latitude],
    },
    properties: { id: i, label: pin.label, color: pin.color ?? '#FF5722' },
  }));
  return { type: 'FeatureCollection' as const, features };
}

function buildUserLocationGeoJSON(loc: LocationCoords) {
  return {
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [loc.longitude, loc.latitude],
    },
    properties: { accuracy: loc.accuracy ?? 0, latitude: loc.latitude },
  };
}

/**
 * Build a MapLibre expression that converts accuracy in meters to pixel radius
 * accounting for zoom level. With circlePitchAlignment: 'map', circles are
 * rendered on the map plane, but radius is still in screen pixels at the
 * current zoom. Formula: pixels = meters / metersPerPixel where
 * metersPerPixel = cos(lat_rad) * 40075017 / (256 * 2^zoom).
 *
 * We precompute at discrete zoom levels to keep the expression manageable.
 */
function accuracyCircleRadiusExpression(latDegrees: number): unknown[] {
  const latRad = (latDegrees * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  // metersPerPixel at zoom z = cosLat * 40075017 / (256 * 2^z)
  // pixelsPerMeter at zoom z = 1 / metersPerPixel = 256 * 2^z / (cosLat * 40075017)
  const base = (256 / (cosLat * 40075017));
  // Build interpolate stops: at each zoom, pixelsPerMeter = base * 2^z
  // radius = accuracy * pixelsPerMeter, but we clamp radius to [2, 200]
  const stops: [number, unknown[]][] = [];
  for (let z = 5; z <= 20; z++) {
    const ppm = base * Math.pow(2, z);
    stops.push([z, ['min', 200, ['max', 2, ['*', ['get', 'accuracy'], ppm]]]]);
  }
  return [
    'interpolate', ['linear'], ['zoom'],
    ...stops.flat(),
  ];
}

function computeBounds(points: TrackPoint[]): { ne: [number, number]; sw: [number, number] } {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return {
    ne: [maxLon, maxLat],
    sw: [minLon, minLat],
  };
}

export function TrailMap({
  displayPoints,
  alternates,
  sideTrips,
  waypoints,
  userLocation,
  focusedWaypointId,
  onWaypointPress,
  isFollowingUser,
  onMapPan,
  onRecenter,
  currentKm,
  panTarget,
  mapStyleOverride,
  onVisibleBoundsChange,
  trackPoints,
  highlightedSegment,
  onLongPress,
  customPins,
}: TrailMapProps) {
  const { colors } = useTheme();

  // Match overlay text font to the active base style's available glyphs.
  // Liberty (online) serves Noto Sans; our offline style bundles Open Sans.
  const labelFont = mapStyleOverride ? ['Open Sans Regular'] : ['Noto Sans Regular'];
  const cameraRef = useRef<CameraRef>(null);
  const mapRef = useRef<MapViewRef>(null);
  const hasSetInitialBounds = useRef(false);

  const trailGeoJSON = useMemo(() => {
    if (displayPoints.length < 2) return null;
    return buildTrailGeoJSON(displayPoints);
  }, [displayPoints]);

  const alternatesGeoJSON = useMemo(
    () => buildVariantGeoJSON(alternates ?? [], 'alternate'),
    [alternates],
  );

  const sideTripsGeoJSON = useMemo(
    () => buildVariantGeoJSON(sideTrips ?? [], 'side-trip'),
    [sideTrips],
  );

  const waypointsGeoJSON = useMemo(
    () => buildWaypointsGeoJSON(waypoints ?? []),
    [waypoints],
  );

  const userLocationGeoJSON = useMemo(
    () => (userLocation ? buildUserLocationGeoJSON(userLocation) : null),
    [userLocation],
  );

  const highlightGeoJSON = useMemo(() => {
    if (!highlightedSegment || displayPoints.length === 0) return null;
    return buildSegmentGeoJSON(displayPoints, highlightedSegment.startKm, highlightedSegment.endKm);
  }, [highlightedSegment, displayPoints]);

  const customPinsGeoJSON = useMemo(
    () => (customPins && customPins.length > 0 ? buildCustomPinsGeoJSON(customPins) : null),
    [customPins],
  );

  const accuracyRadius = useMemo(
    () => accuracyCircleRadiusExpression(userLocation?.latitude ?? -33),
    [userLocation?.latitude],
  );

  const bounds = useMemo(() => {
    if (displayPoints.length === 0) return null;
    return computeBounds(displayPoints);
  }, [displayPoints]);

  // Fit camera to trail bounds on initial load
  useEffect(() => {
    if (bounds && cameraRef.current && !hasSetInitialBounds.current) {
      hasSetInitialBounds.current = true;
    }
  }, [bounds]);

  // Follow user when tracking
  useEffect(() => {
    if (isFollowingUser && userLocation && cameraRef.current) {
      cameraRef.current.setCamera({
        centerCoordinate: [userLocation.longitude, userLocation.latitude],
        zoomLevel: 14,
        animationDuration: 500,
      });
    }
  }, [isFollowingUser, userLocation]);

  // Pan to coordinate from external navigation (waypoint tap, profile tap, etc.)
  useEffect(() => {
    if (panTarget && cameraRef.current) {
      cameraRef.current.setCamera({
        centerCoordinate: [panTarget.longitude, panTarget.latitude],
        zoomLevel: 14,
        animationDuration: 500,
      });
    }
  }, [panTarget]);

  // Fit camera to highlighted segment
  useEffect(() => {
    if (highlightedSegment && cameraRef.current && displayPoints.length > 0) {
      const segmentPoints = displayPoints.filter(
        p => p.dist >= highlightedSegment.startKm && p.dist <= highlightedSegment.endKm,
      );
      if (segmentPoints.length >= 2) {
        const segBounds = computeBounds(segmentPoints);
        cameraRef.current.fitBounds(segBounds.ne, segBounds.sw, 50, 500);
      }
    }
  }, [highlightedSegment, displayPoints]);

  const handleLongPress = useCallback(
    (feature: GeoJSON.Feature) => {
      if (!onLongPress || displayPoints.length === 0) return;
      const coords = feature.geometry?.type === 'Point'
        ? (feature.geometry as GeoJSON.Point).coordinates
        : null;
      if (!coords || coords.length < 2) return;
      const [lon, lat] = coords;

      // Find nearest track point
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < displayPoints.length; i++) {
        const p = displayPoints[i];
        const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
        if (d < nearestDist) {
          nearestDist = d;
          nearestIdx = i;
        }
      }
      const nearest = displayPoints[nearestIdx];
      onLongPress({
        latitude: nearest.lat,
        longitude: nearest.lon,
        nearestKm: nearest.dist,
      });
    },
    [onLongPress, displayPoints],
  );

  const handleWaypointPress = useCallback(
    (event: OnPressEvent) => {
      if (!onWaypointPress || !waypoints) return;
      const feature = event.features?.[0];
      const index = feature?.properties?.id as number | undefined;
      if (index != null && waypoints[index]) {
        onWaypointPress(waypoints[index], index);
      }
    },
    [onWaypointPress, waypoints],
  );

  const handleRegionDidChange = useCallback(async () => {
    if (!onVisibleBoundsChange || !trackPoints || trackPoints.length === 0 || !mapRef.current) return;
    try {
      const bounds = await mapRef.current.getVisibleBounds();
      if (!bounds || bounds.length < 2) return;
      // bounds is [[neLon, neLat], [swLon, swLat]]
      const [ne, sw] = bounds;
      const minLon = sw[0], maxLon = ne[0];
      const minLat = sw[1], maxLat = ne[1];

      // Find the km range of track points within the visible bounds
      let minKm = Infinity;
      let maxKm = -Infinity;
      // Sample for efficiency
      const step = Math.max(1, Math.floor(trackPoints.length / 200));
      for (let i = 0; i < trackPoints.length; i += step) {
        const p = trackPoints[i];
        if (p.lat >= minLat && p.lat <= maxLat && p.lon >= minLon && p.lon <= maxLon) {
          if (p.dist < minKm) minKm = p.dist;
          if (p.dist > maxKm) maxKm = p.dist;
        }
      }
      if (minKm <= maxKm) {
        onVisibleBoundsChange(minKm, maxKm);
      }
    } catch {
      // getVisibleBounds can fail during init
    }
  }, [onVisibleBoundsChange, trackPoints]);

  const showRecenter = !isFollowingUser && userLocation != null;

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView
        ref={mapRef}
        style={styles.map}
        mapStyle={mapStyleOverride ?? STYLE_URL}
        logoEnabled={false}
        attributionEnabled={false}
        onRegionWillChange={(feature) => {
          if (feature.properties?.isUserInteraction && onMapPan) {
            onMapPan();
          }
        }}
        onRegionDidChange={handleRegionDidChange}
        onLongPress={onLongPress ? handleLongPress : undefined}
      >
        <MapLibreGL.Camera
          ref={cameraRef}
          defaultSettings={
            bounds
              ? { bounds: { ne: bounds.ne, sw: bounds.sw, paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40 } }
              : { centerCoordinate: [135, -28], zoomLevel: 4 }
          }
        />

        {/* Main trail line */}
        {trailGeoJSON && (
          <MapLibreGL.ShapeSource id="trail-line" shape={trailGeoJSON}>
            <MapLibreGL.LineLayer
              id="trail-line-layer"
              style={{
                lineColor: '#e53935',
                lineWidth: 3,
                lineOpacity: 0.9,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Highlighted segment (day segment, measure selection) */}
        {highlightGeoJSON && (
          <MapLibreGL.ShapeSource id="highlight-segment" shape={highlightGeoJSON}>
            <MapLibreGL.LineLayer
              id="highlight-glow"
              style={{
                lineColor: colors.accent,
                lineWidth: 8,
                lineOpacity: 0.3,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
            <MapLibreGL.LineLayer
              id="highlight-solid"
              style={{
                lineColor: colors.accent,
                lineWidth: 4,
                lineOpacity: 1,
                lineCap: 'round',
                lineJoin: 'round',
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Custom pins */}
        {customPinsGeoJSON && (
          <MapLibreGL.ShapeSource id="custom-pins" shape={customPinsGeoJSON}>
            <MapLibreGL.CircleLayer
              id="custom-pins-circles"
              style={{
                circleRadius: 7,
                circleColor: ['get', 'color'],
                circleStrokeColor: '#ffffff',
                circleStrokeWidth: 2,
              }}
            />
            <MapLibreGL.SymbolLayer
              id="custom-pins-labels"
              minZoomLevel={10}
              style={{
                textField: ['get', 'label'],
                textFont: labelFont,
                textSize: 12,
                textColor: colors.textPrimary,
                textHaloColor: '#ffffff',
                textHaloWidth: 1.5,
                textOffset: [0, 1.4],
                textAnchor: 'top',
                textMaxWidth: 15,
                textAllowOverlap: false,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Alternate routes */}
        {alternatesGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource id="alternates" shape={alternatesGeoJSON}>
            <MapLibreGL.LineLayer
              id="alternates-layer"
              style={{
                lineColor: '#ff9800',
                lineWidth: 3,
                lineOpacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round',
                lineDasharray: [2, 1],
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Side trips */}
        {sideTripsGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource id="side-trips" shape={sideTripsGeoJSON}>
            <MapLibreGL.LineLayer
              id="side-trips-layer"
              style={{
                lineColor: '#9c27b0',
                lineWidth: 3,
                lineOpacity: 0.8,
                lineCap: 'round',
                lineJoin: 'round',
                lineDasharray: [2, 1],
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Waypoint markers */}
        {waypointsGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource
            id="waypoints"
            shape={waypointsGeoJSON}
            onPress={handleWaypointPress}
            hitbox={{ width: 30, height: 30 }}
          >
            {/* Circles always visible */}
            <MapLibreGL.CircleLayer
              id="waypoints-circles"
              style={{
                circleRadius: [
                  'case',
                  ['==', ['get', 'id'], focusedWaypointId ?? -1],
                  8,
                  5,
                ],
                circleColor: ['get', 'color'],
                circleStrokeColor: [
                  'case',
                  ['==', ['get', 'id'], focusedWaypointId ?? -1],
                  colors.accent,
                  '#ffffff',
                ],
                circleStrokeWidth: [
                  'case',
                  ['==', ['get', 'id'], focusedWaypointId ?? -1],
                  3,
                  1.5,
                ],
              }}
            />

            {/* Labels at zoom >= 11 */}
            <MapLibreGL.SymbolLayer
              id="waypoints-labels"
              minZoomLevel={11}
              style={{
                textField: ['get', 'name'],
                textFont: labelFont,
                textSize: 12,
                textColor: colors.textPrimary,
                textHaloColor: '#ffffff',
                textHaloWidth: 1.5,
                textOffset: [0, 1.2],
                textAnchor: 'top',
                textMaxWidth: 15,
                textAllowOverlap: false,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* User location */}
        {userLocationGeoJSON && (
          <MapLibreGL.ShapeSource id="user-location" shape={userLocationGeoJSON}>
            {/* Accuracy circle — radius converted from meters to pixels at current zoom */}
            {(userLocation?.accuracy ?? 0) > 20 && (
              <MapLibreGL.CircleLayer
                id="user-accuracy"
                style={{
                  circleRadius: accuracyRadius as unknown as number,
                  circleColor: 'rgba(33, 150, 243, 0.1)',
                  circleStrokeColor: 'rgba(33, 150, 243, 0.3)',
                  circleStrokeWidth: 1,
                  circlePitchAlignment: 'map',
                }}
              />
            )}
            {/* Blue dot */}
            <MapLibreGL.CircleLayer
              id="user-dot"
              style={{
                circleRadius: 6,
                circleColor: '#2196F3',
                circleStrokeColor: '#ffffff',
                circleStrokeWidth: 2,
              }}
            />
          </MapLibreGL.ShapeSource>
        )}
      </MapLibreGL.MapView>

      {/* Current km position chip */}
      {currentKm != null && (
        <View style={[styles.kmChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.kmText, { color: colors.textPrimary }]}>
            km {currentKm.toFixed(1)}
          </Text>
        </View>
      )}

      {/* Re-center button */}
      {showRecenter && (
        <Pressable
          onPress={onRecenter}
          style={[styles.recenterButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel="Re-center map on your location"
          accessibilityRole="button"
        >
          <Text style={[styles.recenterIcon, { color: colors.accent }]}>◎</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  map: {
    flex: 1,
  },
  kmChip: {
    position: 'absolute',
    top: spacing.lg,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  kmText: {
    ...typography.caption,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  recenterButton: {
    position: 'absolute',
    bottom: spacing.xl,
    right: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 4,
  },
  recenterIcon: {
    fontSize: 22,
  },
});
