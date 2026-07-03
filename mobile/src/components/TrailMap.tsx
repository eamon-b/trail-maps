import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import MapLibreGL, { type CameraRef, type MapViewRef, type OnPressEvent } from '@maplibre/maplibre-react-native';
import type { TrackPoint, TrailWaypoint, RouteVariant } from '../lib/trail-utils';
import { useTheme } from '../theme';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { getOnlineStyleWithContours } from '../services/online-style-service';

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
  focusedWaypointId?: string | null;
  /** Called when a waypoint marker is tapped */
  onWaypointPress?: (waypoint: TrailWaypoint) => void;
  /** Whether camera should follow the user */
  isFollowingUser?: boolean;
  /** Called when user manually pans the map */
  onMapPan?: () => void;
  /** Called when user taps an empty area of the map (not a waypoint) */
  onMapPress?: () => void;
  /** Called when user taps re-center button */
  onRecenter?: () => void;
  /** Current position along trail in km (for display chip) */
  currentKm?: number | null;
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

/** Imperative handle for one-shot camera actions (pan, fit). */
export interface TrailMapHandle {
  panTo: (latitude: number, longitude: number, zoomLevel?: number) => void;
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
  const features = waypoints.map((wp) => ({
    type: 'Feature' as const,
    geometry: {
      type: 'Point' as const,
      coordinates: [wp.lon, wp.lat],
    },
    properties: {
      id: wp.id,
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

// --- Static MapLibre layer styles (avoid re-creating on every render) ---

const trailLineStyle = {
  lineColor: '#e53935',
  lineWidth: 3,
  lineOpacity: 0.9,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
};

const alternatesLineStyle = {
  lineColor: '#ff9800',
  lineWidth: 3,
  lineOpacity: 0.8,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
  lineDasharray: [2, 1],
};

const sideTripsLineStyle = {
  lineColor: '#9c27b0',
  lineWidth: 3,
  lineOpacity: 0.8,
  lineCap: 'round' as const,
  lineJoin: 'round' as const,
  lineDasharray: [2, 1],
};

const customPinsCircleStyle = {
  circleRadius: 7,
  circleColor: ['get', 'color'] as unknown as string,
  circleStrokeColor: '#ffffff',
  circleStrokeWidth: 2,
};

const userDotStyle = {
  circleRadius: 6,
  circleColor: '#2196F3',
  circleStrokeColor: '#ffffff',
  circleStrokeWidth: 2,
};

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

export const TrailMap = forwardRef<TrailMapHandle, TrailMapProps>(function TrailMap({
  displayPoints,
  alternates,
  sideTrips,
  waypoints,
  userLocation,
  focusedWaypointId,
  onWaypointPress,
  isFollowingUser,
  onMapPan,
  onMapPress,
  onRecenter,
  currentKm,
  mapStyleOverride,
  onVisibleBoundsChange,
  trackPoints,
  highlightedSegment,
  onLongPress,
  customPins,
}, ref) {
  const { colors } = useTheme();

  // Fetch online style with contour overlay when no offline style is set
  const [onlineStyle, setOnlineStyle] = useState<object | null>(null);
  useEffect(() => {
    if (!mapStyleOverride) {
      getOnlineStyleWithContours().then(setOnlineStyle).catch(() => {});
    }
  }, [mapStyleOverride]);

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

  // Memoize so the Camera component sees a stable reference (prevents re-application on re-renders)
  const cameraDefaultSettings = useMemo(() => {
    if (bounds) {
      return { bounds: { ne: bounds.ne, sw: bounds.sw, paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40 } };
    }
    return { centerCoordinate: [135, -28] as [number, number], zoomLevel: 4 };
  }, [bounds]);

  // Theme-dependent styles (memoized since they depend on colors.accent)
  const highlightGlowStyle = useMemo(() => ({
    lineColor: colors.accent,
    lineWidth: 8,
    lineOpacity: 0.3,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
  }), [colors.accent]);

  const highlightSolidStyle = useMemo(() => ({
    lineColor: colors.accent,
    lineWidth: 4,
    lineOpacity: 1,
    lineCap: 'round' as const,
    lineJoin: 'round' as const,
  }), [colors.accent]);

  const waypointCircleStyle = useMemo(() => {
    const focusId = focusedWaypointId ?? '';
    return {
      circleRadius: [
        'case',
        ['==', ['get', 'id'], focusId],
        8,
        5,
      ] as unknown as number,
      circleColor: ['get', 'color'] as unknown as string,
      circleStrokeColor: [
        'case',
        ['==', ['get', 'id'], focusId],
        colors.accent,
        '#ffffff',
      ] as unknown as string,
      circleStrokeWidth: [
        'case',
        ['==', ['get', 'id'], focusId],
        3,
        1.5,
      ] as unknown as number,
    };
  }, [focusedWaypointId, colors.accent]);

  const symbolLabelStyle = useMemo(() => ({
    textField: ['get', 'name'] as unknown as string,
    textFont: labelFont,
    textSize: 13,
    textColor: '#1a1a1a',
    textHaloColor: '#ffffff',
    textHaloWidth: 2.5,
    textOffset: [0, 1.2] as [number, number],
    textAnchor: 'top' as const,
    textMaxWidth: 15,
    textAllowOverlap: false,
  }), [labelFont]);

  const customPinLabelStyle = useMemo(() => ({
    textField: ['get', 'label'] as unknown as string,
    textFont: labelFont,
    textSize: 13,
    textColor: '#1a1a1a',
    textHaloColor: '#ffffff',
    textHaloWidth: 2.5,
    textOffset: [0, 1.4] as [number, number],
    textAnchor: 'top' as const,
    textMaxWidth: 15,
    textAllowOverlap: false,
  }), [labelFont]);

  const userAccuracyStyle = useMemo(() => ({
    circleRadius: accuracyRadius as unknown as number,
    circleColor: 'rgba(33, 150, 243, 0.1)',
    circleStrokeColor: 'rgba(33, 150, 243, 0.3)',
    circleStrokeWidth: 1,
    circlePitchAlignment: 'map' as const,
  }), [accuracyRadius]);

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

  // Expose imperative camera actions to parents. Pan is a one-shot action,
  // not synchronised state — there is nothing to "re-apply" on re-render.
  useImperativeHandle(ref, () => ({
    panTo: (latitude: number, longitude: number, zoomLevel = 14) => {
      cameraRef.current?.setCamera({
        centerCoordinate: [longitude, latitude],
        zoomLevel,
        animationDuration: 500,
      });
    },
  }), []);

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
      const id = feature?.properties?.id as string | undefined;
      if (id == null) return;
      const wp = waypoints.find(w => w.id === id);
      if (wp) onWaypointPress(wp);
    },
    [onWaypointPress, waypoints],
  );

  const regionChangeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear the debounce timer on unmount to prevent state updates after cleanup
  useEffect(() => {
    return () => {
      if (regionChangeTimer.current) {
        clearTimeout(regionChangeTimer.current);
      }
    };
  }, []);

  const handleRegionDidChange = useCallback(() => {
    if (!onVisibleBoundsChange || !trackPoints || trackPoints.length === 0 || !mapRef.current) return;
    // Debounce to avoid excessive state updates during rapid pans
    if (regionChangeTimer.current) clearTimeout(regionChangeTimer.current);
    regionChangeTimer.current = setTimeout(async () => {
      try {
        if (!mapRef.current) return;
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
    }, 150);
  }, [onVisibleBoundsChange, trackPoints]);

  const showRecenter = !isFollowingUser && userLocation != null;

  return (
    <View style={styles.container}>
      <MapLibreGL.MapView
        ref={mapRef}
        style={styles.map}
        mapStyle={mapStyleOverride ?? onlineStyle ?? STYLE_URL}
        logoEnabled={false}
        attributionEnabled={false}
        onPress={onMapPress}
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
          defaultSettings={cameraDefaultSettings}
          minZoomLevel={mapStyleOverride ? 9 : 4}
        />

        {/* Main trail line */}
        {trailGeoJSON && (
          <MapLibreGL.ShapeSource id="trail-line" shape={trailGeoJSON}>
            <MapLibreGL.LineLayer
              id="trail-line-layer"
              style={trailLineStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Highlighted segment (day segment, measure selection) */}
        {highlightGeoJSON && (
          <MapLibreGL.ShapeSource id="highlight-segment" shape={highlightGeoJSON}>
            <MapLibreGL.LineLayer
              id="highlight-glow"
              style={highlightGlowStyle}
            />
            <MapLibreGL.LineLayer
              id="highlight-solid"
              style={highlightSolidStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Custom pins */}
        {customPinsGeoJSON && (
          <MapLibreGL.ShapeSource id="custom-pins" shape={customPinsGeoJSON}>
            <MapLibreGL.CircleLayer
              id="custom-pins-circles"
              style={customPinsCircleStyle}
            />
            <MapLibreGL.SymbolLayer
              id="custom-pins-labels"
              minZoomLevel={10}
              style={customPinLabelStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Alternate routes */}
        {alternatesGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource id="alternates" shape={alternatesGeoJSON}>
            <MapLibreGL.LineLayer
              id="alternates-layer"
              style={alternatesLineStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Side trips */}
        {sideTripsGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource id="side-trips" shape={sideTripsGeoJSON}>
            <MapLibreGL.LineLayer
              id="side-trips-layer"
              style={sideTripsLineStyle}
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
              style={waypointCircleStyle}
            />

            {/* Labels at zoom >= 11 */}
            <MapLibreGL.SymbolLayer
              id="waypoints-labels"
              minZoomLevel={11}
              style={symbolLabelStyle}
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
                style={userAccuracyStyle}
              />
            )}
            {/* Blue dot */}
            <MapLibreGL.CircleLayer
              id="user-dot"
              style={userDotStyle}
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
});

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
