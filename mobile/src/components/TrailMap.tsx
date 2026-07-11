import React, { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import MapLibreGL, { type CameraRef, type MapViewRef, type OnPressEvent } from '@maplibre/maplibre-react-native';
import { findNearestByDistance, isCustomWaypointId, type TrackPoint, type TrailWaypoint, type RouteVariant } from '../lib/trail-utils';
import { getWaypointColor } from '../lib/waypoint-type-meta';
import { haversineDistance } from '@lib/distance';
import { useTheme } from '../theme';
import { useReduceMotion } from '../theme/useReduceMotion';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { getOnlineStyleWithContours } from '../services/online-style-service';

MapLibreGL.setAccessToken(null);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Distinct marker color for user-created waypoints (see isCustomWaypointId) */
const CUSTOM_WAYPOINT_COLOR = '#E91E63';

/**
 * Waypoints cluster only at or below this zoom — zoomed-out overview levels
 * where individual circles are unreadable anyway. At hiking zooms (labels
 * gate at >=11, follow-mode zoom is 14) every waypoint renders individually,
 * so clustering can never hide the next water source or campsite in the field.
 */
export const WAYPOINT_CLUSTER_MAX_ZOOM = 10;

/** Whether waypoints are clustered at a given zoom level. */
export function isClusteredZoom(zoom: number): boolean {
  return zoom <= WAYPOINT_CLUSTER_MAX_ZOOM;
}

/**
 * A custom waypoint whose true position is more than this many metres from
 * its snapped track point gets a thin connector line from pin to track, so
 * the raw pin and the km used by distance math can't silently disagree.
 */
const CONNECTOR_THRESHOLD_M = 25;

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
  /**
   * Waypoint-sequence route overlay (P1 PR D): on-track legs highlight their
   * track spans (same styling as highlightedSegment); off-track legs render
   * as straight dashed lines — visually distinct so their estimates are
   * never read as trail-accurate.
   */
  routeOverlay?: {
    spans: { startKm: number; endKm: number }[];
    straightLegs: { from: [number, number]; to: [number, number] }[];
  } | null;
  /** Called on long press with the nearest trail coordinate (latitude/longitude
   * are snapped to the track; pressedLatitude/pressedLongitude are the raw
   * touch location, e.g. for placing off-track custom waypoints) */
  onLongPress?: (coordinate: {
    latitude: number;
    longitude: number;
    nearestKm: number;
    pressedLatitude: number;
    pressedLongitude: number;
  }) => void;
  /** Custom marker pins (for stop locations, measure points, etc.) */
  customPins?: { latitude: number; longitude: number; label: string; color?: string }[];
}

/** Imperative handle for one-shot camera actions (pan, fit) and queries. */
export interface TrailMapHandle {
  panTo: (latitude: number, longitude: number, zoomLevel?: number) => void;
  /** Current map center as [latitude, longitude], or null if unavailable. */
  getCenter: () => Promise<[number, number] | null>;
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
      color: isCustomWaypointId(wp.id) ? CUSTOM_WAYPOINT_COLOR : getWaypointColor(wp.type),
      totalDistance: wp.totalDistance ?? 0,
    },
  }));
  return { type: 'FeatureCollection' as const, features };
}

/**
 * Connector lines from off-track custom waypoints to their snapped track
 * point (decision 5: free-floating pins allowed, snap annotated). Drawn only
 * when the stored off_track_m exceeds CONNECTOR_THRESHOLD_M.
 */
function buildConnectorGeoJSON(waypoints: TrailWaypoint[], trackPoints: TrackPoint[]) {
  const features: GeoJSON.Feature[] = [];
  if (trackPoints.length === 0) return null;
  for (const wp of waypoints) {
    if (!isCustomWaypointId(wp.id)) continue;
    if ((wp.offTrackM ?? 0) <= CONNECTOR_THRESHOLD_M) continue;
    if (wp.totalDistance == null) continue;
    const idx = findNearestByDistance(trackPoints, wp.totalDistance);
    const snapped = trackPoints[idx];
    if (!snapped) continue;
    // Guard against stale off_track_m (e.g. after a position edit): only draw
    // when the pin really is away from the snapped point.
    if (haversineDistance(wp.lat, wp.lon, snapped.lat, snapped.lon) <= CONNECTOR_THRESHOLD_M) continue;
    features.push({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [wp.lon, wp.lat],
          [snapped.lon, snapped.lat],
        ],
      },
      properties: { id: wp.id },
    });
  }
  if (features.length === 0) return null;
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

function buildRouteSpansGeoJSON(
  points: TrackPoint[],
  spans: { startKm: number; endKm: number }[],
) {
  const features: GeoJSON.Feature[] = [];
  for (const span of spans) {
    const segment = buildSegmentGeoJSON(points, span.startKm, span.endKm);
    if (segment) features.push(segment);
  }
  if (features.length === 0) return null;
  return { type: 'FeatureCollection' as const, features };
}

function buildStraightLegsGeoJSON(legs: { from: [number, number]; to: [number, number] }[]) {
  if (legs.length === 0) return null;
  return {
    type: 'FeatureCollection' as const,
    features: legs.map((leg, i) => ({
      type: 'Feature' as const,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [leg.from[1], leg.from[0]],
          [leg.to[1], leg.to[0]],
        ],
      },
      properties: { id: i },
    })),
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

const connectorLineStyle = {
  lineColor: CUSTOM_WAYPOINT_COLOR,
  lineWidth: 1.5,
  lineOpacity: 0.7,
  lineDasharray: [1, 1],
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

// memo: parents re-render on every GPS tick and drawer move; the map only
// needs to re-render when its own (mostly memoized) props change.
export const TrailMap = memo(forwardRef<TrailMapHandle, TrailMapProps>(function TrailMap({
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
  routeOverlay,
  onLongPress,
  customPins,
}, ref) {
  const { colors } = useTheme();
  const reduceMotion = useReduceMotion();

  // Fetch online style with contour overlay when no offline style is set
  const [onlineStyle, setOnlineStyle] = useState<object | null>(null);
  useEffect(() => {
    if (!mapStyleOverride) {
      getOnlineStyleWithContours().then(setOnlineStyle).catch(() => {});
    }
  }, [mapStyleOverride]);

  // Match overlay text font to the active base style's available glyphs.
  // Liberty (online) serves Noto Sans; our offline style bundles Open Sans.
  const labelFont = useMemo(
    () => (mapStyleOverride ? ['Open Sans Regular'] : ['Noto Sans Regular']),
    [mapStyleOverride],
  );
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

  const connectorGeoJSON = useMemo(
    () => buildConnectorGeoJSON(waypoints ?? [], trackPoints ?? []),
    [waypoints, trackPoints],
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

  const routeSpansGeoJSON = useMemo(() => {
    if (!routeOverlay || displayPoints.length === 0) return null;
    return buildRouteSpansGeoJSON(displayPoints, routeOverlay.spans);
  }, [routeOverlay, displayPoints]);

  const routeStraightLegsGeoJSON = useMemo(() => {
    if (!routeOverlay) return null;
    return buildStraightLegsGeoJSON(routeOverlay.straightLegs);
  }, [routeOverlay]);

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

  // Off-track route legs: dashed straight line — must read differently from
  // the on-track highlight so estimates aren't taken as trail-accurate.
  const routeStraightLegStyle = useMemo(() => ({
    lineColor: colors.accent,
    lineWidth: 3,
    lineOpacity: 0.9,
    lineDasharray: [1.5, 1.5],
    lineCap: 'round' as const,
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

  const clusterCircleStyle = useMemo(() => ({
    circleColor: colors.accent,
    circleOpacity: 0.85,
    circleRadius: [
      'step', ['get', 'point_count'],
      14, 10, 18, 25, 22,
    ] as unknown as number,
    circleStrokeColor: '#ffffff',
    circleStrokeWidth: 2,
  }), [colors.accent]);

  const clusterCountStyle = useMemo(() => ({
    textField: ['get', 'point_count_abbreviated'] as unknown as string,
    textFont: labelFont,
    textSize: 12,
    textColor: '#ffffff',
    textAllowOverlap: true,
  }), [labelFont]);

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

  // Follow user when tracking. The first re-center after following turns on
  // sets a sensible zoom; subsequent GPS ticks keep whatever zoom the user has
  // chosen since (omitting zoomLevel preserves the current zoom).
  const followZoomApplied = useRef(false);
  useEffect(() => {
    if (!isFollowingUser) {
      followZoomApplied.current = false;
      return;
    }
    if (userLocation && cameraRef.current) {
      cameraRef.current.setCamera({
        centerCoordinate: [userLocation.longitude, userLocation.latitude],
        ...(followZoomApplied.current ? {} : { zoomLevel: 14 }),
        animationDuration: 500,
      });
      followZoomApplied.current = true;
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
    getCenter: async () => {
      try {
        const center = await mapRef.current?.getCenter();
        if (!center || center.length < 2) return null;
        // MapLibre returns [lon, lat]
        return [center[1], center[0]];
      } catch {
        return null;
      }
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
        pressedLatitude: lat,
        pressedLongitude: lon,
      });
    },
    [onLongPress, displayPoints],
  );

  const handleWaypointPress = useCallback(
    async (event: OnPressEvent) => {
      const feature = event.features?.[0];
      // Tapping a cluster zooms in to expand it instead of selecting
      if (feature?.properties?.point_count != null) {
        const coords = feature.geometry?.type === 'Point'
          ? (feature.geometry as GeoJSON.Point).coordinates
          : null;
        if (coords && coords.length >= 2 && cameraRef.current) {
          let zoom = WAYPOINT_CLUSTER_MAX_ZOOM;
          try {
            zoom = (await mapRef.current?.getZoom()) ?? zoom;
          } catch { /* fall back to the cluster ceiling */ }
          cameraRef.current.setCamera({
            centerCoordinate: [coords[0], coords[1]],
            zoomLevel: Math.max(zoom + 2, WAYPOINT_CLUSTER_MAX_ZOOM + 1),
            animationDuration: reduceMotion ? 0 : 400,
          });
        }
        return;
      }
      if (!onWaypointPress || !waypoints) return;
      const id = feature?.properties?.id as string | undefined;
      if (id == null) return;
      const wp = waypoints.find(w => w.id === id);
      if (wp) onWaypointPress(wp);
    },
    [onWaypointPress, waypoints, reduceMotion],
  );

  // One-handed/gloved zoom: camera zoom ±1 with animation (reduce-motion aware)
  const handleZoom = useCallback(async (delta: number) => {
    try {
      const zoom = await mapRef.current?.getZoom();
      if (zoom == null || !cameraRef.current) return;
      cameraRef.current.zoomTo(zoom + delta, reduceMotion ? 0 : 300);
    } catch {
      // getZoom can fail during init — ignore
    }
  }, [reduceMotion]);

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

  // Single authority for "user panned": a drag detected in the touch stream.
  // MapLibre's isUserInteraction flag on region events is unreliable across
  // versions (it can miss real pans, leaving follow mode to fight the user)
  // and it also fires for gestures that shouldn't break follow, like
  // double-tap zoom — so it is deliberately not used. Touch events on the
  // wrapping View are passive observers (they never claim the responder), so
  // the map's native gestures are unaffected. Only a moved touch counts — a
  // plain tap (waypoint select / dismiss) should not break follow mode.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const handleTouchStart = useCallback((e: { nativeEvent: { pageX: number; pageY: number } }) => {
    touchStart.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
  }, []);
  const handleTouchMove = useCallback((e: { nativeEvent: { pageX: number; pageY: number } }) => {
    if (!onMapPan || !touchStart.current) return;
    const dx = e.nativeEvent.pageX - touchStart.current.x;
    const dy = e.nativeEvent.pageY - touchStart.current.y;
    if (dx * dx + dy * dy > 100) { // >10px of movement = a deliberate drag
      touchStart.current = null;
      onMapPan();
    }
  }, [onMapPan]);

  return (
    <View
      style={styles.container}
      onTouchStart={handleTouchStart}
      onTouchMove={isFollowingUser ? handleTouchMove : undefined}
    >
      <MapLibreGL.MapView
        ref={mapRef}
        style={styles.map}
        mapStyle={mapStyleOverride ?? onlineStyle ?? STYLE_URL}
        logoEnabled={false}
        attributionEnabled={false}
        onPress={onMapPress}
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

        {/* Route overlay: on-track spans (highlight styling) */}
        {routeSpansGeoJSON && (
          <MapLibreGL.ShapeSource id="route-spans" shape={routeSpansGeoJSON}>
            <MapLibreGL.LineLayer
              id="route-spans-glow"
              style={highlightGlowStyle}
            />
            <MapLibreGL.LineLayer
              id="route-spans-solid"
              style={highlightSolidStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Route overlay: off-track legs (dashed straight lines) */}
        {routeStraightLegsGeoJSON && (
          <MapLibreGL.ShapeSource id="route-straight-legs" shape={routeStraightLegsGeoJSON}>
            <MapLibreGL.LineLayer
              id="route-straight-legs-layer"
              style={routeStraightLegStyle}
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

        {/* Connector lines from off-track custom pins to their snapped track point */}
        {connectorGeoJSON && (
          <MapLibreGL.ShapeSource id="waypoint-connectors" shape={connectorGeoJSON}>
            <MapLibreGL.LineLayer
              id="waypoint-connectors-layer"
              style={connectorLineStyle}
            />
          </MapLibreGL.ShapeSource>
        )}

        {/* Waypoint markers — clustered only at zoomed-out levels (never at
            hiking zooms; see WAYPOINT_CLUSTER_MAX_ZOOM) */}
        {waypointsGeoJSON.features.length > 0 && (
          <MapLibreGL.ShapeSource
            id="waypoints"
            shape={waypointsGeoJSON}
            onPress={handleWaypointPress}
            hitbox={{ width: 30, height: 30 }}
            cluster
            clusterRadius={40}
            clusterMaxZoomLevel={WAYPOINT_CLUSTER_MAX_ZOOM}
          >
            {/* Cluster bubbles + counts (tap to expand) */}
            <MapLibreGL.CircleLayer
              id="waypoints-clusters"
              filter={['has', 'point_count']}
              style={clusterCircleStyle}
            />
            <MapLibreGL.SymbolLayer
              id="waypoints-cluster-counts"
              filter={['has', 'point_count']}
              style={clusterCountStyle}
            />

            {/* Individual circles (unclustered points) */}
            <MapLibreGL.CircleLayer
              id="waypoints-circles"
              filter={['!', ['has', 'point_count']]}
              style={waypointCircleStyle}
            />

            {/* Labels at zoom >= 11 */}
            <MapLibreGL.SymbolLayer
              id="waypoints-labels"
              minZoomLevel={11}
              filter={['!', ['has', 'point_count']]}
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

      {/* Zoom buttons — one-handed/gloved essential */}
      <View style={styles.zoomControls}>
        <Pressable
          onPress={() => handleZoom(1)}
          style={[styles.zoomButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel="Zoom in"
          accessibilityRole="button"
        >
          <Text style={[styles.zoomIcon, { color: colors.textPrimary }]}>+</Text>
        </Pressable>
        <Pressable
          onPress={() => handleZoom(-1)}
          style={[styles.zoomButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
          accessibilityLabel="Zoom out"
          accessibilityRole="button"
        >
          <Text style={[styles.zoomIcon, { color: colors.textPrimary }]}>−</Text>
        </Pressable>
      </View>

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
}));

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
  zoomControls: {
    position: 'absolute',
    top: '35%',
    right: spacing.lg,
    gap: spacing.sm,
  },
  zoomButton: {
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
  zoomIcon: {
    ...typography.displaySmall,
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
