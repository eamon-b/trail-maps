import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { View, StyleSheet, Text, Pressable, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haversineDistance } from '@lib/distance';
import { TrailMap, type TrailMapHandle } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { ElevationProfileDrawer } from '../../src/components/ElevationProfileDrawer';
import { WaypointDetailSheet } from '../../src/components/WaypointDetailSheet';
import { AddWaypointSheet, type AddWaypointValues } from '../../src/components/AddWaypointSheet';
import { UndoToast } from '../../src/components/UndoToast';
import { LocationStatusBar, type LocationState } from '../../src/components';
import { useTheme } from '../../src/theme';
import { useFocusedWaypoint } from '../../src/theme/FocusedWaypointContext';
import { useLocation } from '../../src/hooks/useLocation';
import { useTrailData } from '../../src/contexts/TrailDataContext';
import {
  findNearestByDistance,
  nearestTrackPointToLatLon,
  customWaypointRowId,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { useDirectionalTrail } from '../../src/hooks/useDirectionalTrail';
import { TrailDataService, type CustomWaypoint } from '../../src/services/trail-data-service';
import { deleteWaypointPhoto } from '../../src/services/waypoint-photo-service';
import {
  RouteService,
  assembleRouteMetrics,
  resolveRoutePoints,
  routeOverlayGeometry,
  waypointToRoutePoint,
  type Route,
  type RouteLeg,
} from '../../src/services/route-service';
import { RoutePanel } from '../../src/components/RoutePanel';
import { routeToGpx } from '../../src/lib/gpx-writer';
import { shareGpxFile, gpxFilename } from '../../src/services/gpx-export-service';
import { tileManager } from '../../src/services/tile-manager';
import { useTileDownloads } from '../../src/hooks/useTileDownloads';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/** A long-pressed location pending confirmation in the AddWaypointSheet. */
interface PendingWaypoint {
  /** Raw pressed location (where the marker will render) */
  lat: number;
  lon: number;
  /** Track elevation at the snapped km */
  ele: number | null;
  /** Snapped km in the trail's base (as-stored) direction */
  baseKm: number;
  /** Snapped km in the currently displayed direction (for the sheet's label) */
  activeKm: number;
  /** Metres from the pressed location to the track point at the snapped km */
  offTrackM: number;
}

export const DIRECTION_PREF_KEY = 'trail_direction_prefs';
export const ACTIVE_TRAIL_KEY = 'active_trail_id';

/**
 * Crosshair placement mode: pan the map under a fixed center crosshair, then
 * Confirm (decision 6 — re-drop instead of drag, which fights the pan gesture
 * and the follow camera). Used both for the toolbar "+" create flow and the
 * edit-mode "Move pin" flow.
 */
type CrosshairMode =
  | { kind: 'create' }
  | { kind: 'move'; waypoint: TrailWaypoint };

// ---------------------------------------------------------------------------
// Viewer reducer
// ---------------------------------------------------------------------------
//
// Single owner for every piece of interaction state on this screen: waypoint
// selection, the elevation drawer's snap position, and the camera mode. Each
// user intent is one dispatch that atomically produces the whole next UI
// state, so the sheet, drawer, highlight, and camera can never disagree —
// there is no cross-component sequencing (animation callbacks, imperative
// expands) left to get out of order.

interface ViewerState {
  /** Waypoint displayed in the bottom detail sheet (null = sheet hidden). */
  sheetWaypoint: TrailWaypoint | null;
  /** Id of the waypoint highlighted on map + elevation profile. */
  focusedId: string | null;
  /** Elevation drawer snap index (0 = collapsed, 1 = 40%, 2 = 70%). */
  drawerIndex: number;
  /** 'follow' re-centers on each GPS tick; 'free' leaves the camera alone. */
  cameraMode: 'follow' | 'free';
}

type ViewerAction =
  | { type: 'selectWaypoint'; waypoint: TrailWaypoint }
  | { type: 'deselect' }
  | { type: 'showOnProfile'; waypoint: TrailWaypoint }
  | { type: 'userPanned' }
  | { type: 'recenter' }
  | { type: 'drawerMoved'; index: number };

const INITIAL_VIEWER_STATE: ViewerState = {
  sheetWaypoint: null,
  focusedId: null,
  drawerIndex: 0,
  cameraMode: 'follow',
};

function viewerReducer(state: ViewerState, action: ViewerAction): ViewerState {
  switch (action.type) {
    case 'selectWaypoint':
      // Camera goes free so a GPS tick can't yank the map away from the
      // waypoint the user is inspecting.
      return { ...state, sheetWaypoint: action.waypoint, focusedId: action.waypoint.id, cameraMode: 'free' };
    case 'deselect':
      return { ...state, sheetWaypoint: null, focusedId: null };
    case 'showOnProfile':
      // Close the detail sheet and open the drawer in the same state change.
      // The sheet animates itself out from its own snapshot; nothing waits on
      // its exit animation.
      return {
        ...state,
        sheetWaypoint: null,
        focusedId: action.waypoint.id,
        drawerIndex: Math.max(1, state.drawerIndex),
      };
    case 'userPanned':
      return state.cameraMode === 'free' ? state : { ...state, cameraMode: 'free' };
    case 'recenter':
      return { ...state, cameraMode: 'follow' };
    case 'drawerMoved':
      return state.drawerIndex === action.index ? state : { ...state, drawerIndex: action.index };
  }
}

export default function TrailViewerScreen() {
  const { id, focusWaypointId, routeId } = useLocalSearchParams<{ id: string; focusWaypointId?: string; routeId?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { pendingPan, setPendingPan } = useFocusedWaypoint();
  const isFocused = useIsFocused();
  const { trail: contextTrail, loading: contextLoading, error: contextError, loadTrail, refreshCustomWaypoints } = useTrailData();

  const [isReversed, setIsReversed] = useState(false);
  const [viewer, dispatch] = useReducer(viewerReducer, INITIAL_VIEWER_STATE);
  // Custom waypoint add/edit state (null = sheet closed)
  const [pendingWaypoint, setPendingWaypoint] = useState<PendingWaypoint | null>(null);
  const [editingWaypoint, setEditingWaypoint] = useState<TrailWaypoint | null>(null);
  // In-flight guard so a double-tap on Save can't insert the waypoint twice.
  const [savingWaypoint, setSavingWaypoint] = useState(false);
  const savingRef = useRef(false);
  // Crosshair placement mode (toolbar "+" create, or edit-mode "Move pin")
  const [crosshair, setCrosshair] = useState<CrosshairMode | null>(null);
  // Deleted custom waypoint held for undo. Photo file deletion is deferred
  // until the toast expires so undo restores the photo too.
  const [deletedWaypoint, setDeletedWaypoint] = useState<CustomWaypoint | null>(null);
  // Route builder: ordered waypoints tapped on the map (null = not building)
  const [routeDraft, setRouteDraft] = useState<TrailWaypoint[] | null>(null);
  const [savingRoute, setSavingRoute] = useState(false);
  // Saved route being viewed (deep-linked via the routeId param)
  const [routeView, setRouteView] = useState<{ route: Route; legs: RouteLeg[] } | null>(null);
  const { sheetWaypoint: selectedWaypoint, focusedId: focusedWaypointId, drawerIndex, cameraMode } = viewer;
  const mapRef = useRef<TrailMapHandle>(null);
  const [offlineMapStyle, setOfflineMapStyle] = useState<object | null>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);

  // Offline-tile download from the map toolbar (shared Plan-tab workflow).
  // When tiles land, swap the map onto the offline style immediately.
  const refreshOfflineStyle = useCallback((trailId: string) => {
    tileManager.getOfflineStyle(trailId).then((style) => {
      if (style) setOfflineMapStyle(style);
    }).catch(() => {});
  }, []);
  const { downloadingTrailId, download: downloadTiles } = useTileDownloads(refreshOfflineStyle);
  const [trailIsCustom, setTrailIsCustom] = useState(false);

  // Active trail data (respects direction — recomputes when trail or direction changes)
  const activeTrail = useDirectionalTrail(contextTrail, isReversed);
  const trackPoints = useMemo(() => activeTrail?.track.points ?? [], [activeTrail]);

  const { location, accuracy, isTracking, startTracking, stopTracking } =
    useLocation(trackPoints);

  // Load trail data via shared context
  useEffect(() => {
    if (!id) return;
    loadTrail(id);

    // Load saved direction preference
    AsyncStorage.getItem(DIRECTION_PREF_KEY).then(prefsStr => {
      const prefs = prefsStr ? JSON.parse(prefsStr) : {};
      if (prefs[id]) setIsReversed(true);
    }).catch(() => {});

    // Persist as the active trail for the Hike tab
    AsyncStorage.setItem(ACTIVE_TRAIL_KEY, id).catch(() => {});

    // Check for offline tiles
    tileManager.getOfflineStyle(id).then((style) => {
      if (style) setOfflineMapStyle(style);
    }).catch(() => {});

    // isCustom drives the download path (built-in manifest vs grid tiles)
    TrailDataService.create()
      .then((service) => service.getTrail(id))
      .then((row) => setTrailIsCustom(row?.isCustom ?? false))
      .catch(() => {});
  }, [id, loadTrail]);

  // Consume pending pan from external navigation (e.g. datasheet "Show on
  // map"). The datasheet navigates back to this existing instance (it never
  // creates a second one), but keep the isFocused gate so the pan is only
  // consumed when this screen is actually visible. Don't clear pendingPan
  // until the trail is ready — otherwise a cold-start from the datasheet
  // would drop the pan on the first render where activeTrail is still null.
  useEffect(() => {
    if (!isFocused) return;
    if (!pendingPan || !activeTrail) return;
    const wp = activeTrail.waypoints.find(w => w.id === pendingPan.waypointId);
    if (wp) {
      dispatch({ type: 'selectWaypoint', waypoint: wp });
      mapRef.current?.panTo(pendingPan.latitude, pendingPan.longitude);
    }
    setPendingPan(null);
  }, [isFocused, pendingPan, activeTrail, setPendingPan]);

  // Consume the focusWaypointId route param (deep link from the Hike
  // dashboard): open the waypoint's detail sheet and pan the camera to it.
  // Waypoint ids in the merged trail already carry the `custom-` prefix for
  // user waypoints, so an exact id match covers both bundled and custom
  // waypoints. Consumed once per param value; an unknown id is a no-op.
  const consumedFocusIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusWaypointId || !activeTrail) return;
    if (consumedFocusIdRef.current === focusWaypointId) return;
    consumedFocusIdRef.current = focusWaypointId;
    const wp = activeTrail.waypoints.find(w => w.id === focusWaypointId);
    if (!wp) return; // waypoint not found — no focus, no crash
    dispatch({ type: 'selectWaypoint', waypoint: wp });
    mapRef.current?.panTo(wp.lat, wp.lon);
  }, [focusWaypointId, activeTrail]);

  // GPS state for LocationStatusBar
  const locationState = useMemo((): LocationState => {
    if (!isTracking) return 'noGps';
    if (!location) return 'noGps';
    if ((location.distanceFromTrail ?? Infinity) > 500) return 'offTrail';
    if ((accuracy ?? Infinity) > 100) return 'warning';
    if ((location.distanceFromTrail ?? Infinity) > 100) return 'drifting';
    return 'onTrail';
  }, [isTracking, location, accuracy]);

  const currentKm = location?.trailKm ?? null;

  // User location for map
  const userLocationForMap = useMemo(() => {
    if (!location?.raw) return null;
    return {
      latitude: location.raw.latitude,
      longitude: location.raw.longitude,
      accuracy: location.raw.accuracy ?? undefined,
      heading: location.raw.heading ?? undefined,
    };
  }, [location]);

  // Current elevation
  const currentElevation = useMemo(() => {
    if (currentKm == null || trackPoints.length === 0) return null;
    const idx = findNearestByDistance(trackPoints, currentKm);
    return trackPoints[idx]?.ele ?? null;
  }, [currentKm, trackPoints]);

  // Distance from user to selected waypoint
  const distanceToSelected = useMemo(() => {
    if (currentKm == null || selectedWaypoint?.totalDistance == null) return null;
    return selectedWaypoint.totalDistance - currentKm;
  }, [currentKm, selectedWaypoint]);

  // Consume the routeId route param (deep link from My routes): load the
  // saved route and show it on the map. Consumed once per param value.
  const consumedRouteIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!routeId) return;
    if (consumedRouteIdRef.current === routeId) return;
    consumedRouteIdRef.current = routeId;
    (async () => {
      try {
        const service = await RouteService.create();
        const route = await service.getRoute(routeId);
        if (!route) return;
        const legs = await service.getRouteLegs(routeId);
        setRouteDraft(null);
        setRouteView({ route, legs });
      } catch (e) {
        console.warn('Failed to load route:', e);
      }
    })();
  }, [routeId]);

  // Resolve the viewed route's legs against the (direction-aware) trail
  const routeViewPoints = useMemo(() => {
    if (!routeView || !activeTrail) return null;
    return resolveRoutePoints(activeTrail, routeView.legs, { reversed: isReversed });
  }, [routeView, activeTrail, isReversed]);

  // Builder points → resolved shape shared with the viewer
  const routeDraftPoints = useMemo(() => {
    if (!routeDraft) return null;
    return routeDraft.map((wp, i) => waypointToRoutePoint(wp, i));
  }, [routeDraft]);

  const activeRoutePoints = routeDraftPoints ?? routeViewPoints;

  const routeMetrics = useMemo(() => {
    if (!activeTrail || !activeRoutePoints) return null;
    return assembleRouteMetrics(activeTrail, activeRoutePoints);
  }, [activeTrail, activeRoutePoints]);

  const routeOverlay = useMemo(() => {
    if (!activeRoutePoints || activeRoutePoints.length < 2) return null;
    return routeOverlayGeometry(activeRoutePoints);
  }, [activeRoutePoints]);

  // Handlers — each user intent is a single dispatch (+ at most a one-shot
  // imperative pan, which is fire-and-forget and never re-applied)
  const handleWaypointPress = useCallback((wp: TrailWaypoint) => {
    // In route-builder mode a waypoint tap appends to the route instead of
    // opening the detail sheet (consecutive duplicates ignored).
    if (routeDraft) {
      setRouteDraft(prev => {
        if (!prev) return prev;
        if (prev.length > 0 && prev[prev.length - 1].id === wp.id) return prev;
        return [...prev, wp];
      });
      return;
    }
    dispatch({ type: 'selectWaypoint', waypoint: wp });
  }, [routeDraft]);

  const handleDismissWaypoint = useCallback(() => {
    dispatch({ type: 'deselect' });
  }, []);

  const handleMapPan = useCallback(() => {
    dispatch({ type: 'userPanned' });
  }, []);

  const handleMapPress = useCallback(() => {
    if (selectedWaypoint) {
      dispatch({ type: 'deselect' });
    }
  }, [selectedWaypoint]);

  const handleRecenter = useCallback(() => {
    dispatch({ type: 'recenter' });
  }, []);

  const handleVisibleBoundsChange = useCallback((minKm: number, maxKm: number) => {
    setVisibleRange([minKm, maxKm]);
  }, []);

  const handleProfileDistanceTap = useCallback((km: number) => {
    if (trackPoints.length === 0) return;
    const idx = findNearestByDistance(trackPoints, km);
    const point = trackPoints[idx];
    if (!point) return;
    dispatch({ type: 'userPanned' });
    mapRef.current?.panTo(point.lat, point.lon);
  }, [trackPoints]);

  const handleShowOnProfile = useCallback((wp: TrailWaypoint) => {
    dispatch({ type: 'showOnProfile', waypoint: wp });
  }, []);

  const handleDrawerIndexChange = useCallback((index: number) => {
    dispatch({ type: 'drawerMoved', index });
  }, []);

  // --- Custom waypoints -----------------------------------------------------

  // Long-press on the map opens the Add Waypoint sheet at the pressed spot.
  const handleMapLongPress = useCallback((coord: {
    latitude: number;
    longitude: number;
    nearestKm: number;
    pressedLatitude: number;
    pressedLongitude: number;
  }) => {
    const trail = activeTrail;
    if (!trail) return;

    const pressedLat = coord.pressedLatitude ?? coord.latitude;
    const pressedLon = coord.pressedLongitude ?? coord.longitude;

    // Snap against the full-resolution track (the map long-press snaps to
    // display points, which are lower resolution).
    const points = trail.track.points;
    const idx = findNearestByDistance(points, coord.nearestKm);
    const trackPt = points[idx];
    const offTrackM = trackPt
      ? haversineDistance(pressedLat, pressedLon, trackPt.lat, trackPt.lon)
      : 0;

    // km_position is stored in the trail's base direction so the merge at the
    // load boundary (which happens pre-reversal) places it correctly.
    const baseKm = isReversed
      ? trail.track.totalDistance - coord.nearestKm
      : coord.nearestKm;

    setEditingWaypoint(null);
    setPendingWaypoint({
      lat: pressedLat,
      lon: pressedLon,
      ele: trackPt?.ele ?? null,
      baseKm,
      activeKm: coord.nearestKm,
      offTrackM,
    });
  }, [activeTrail, isReversed]);

  const closeWaypointSheet = useCallback(() => {
    setPendingWaypoint(null);
    setEditingWaypoint(null);
  }, []);

  const handleSaveWaypoint = useCallback(async (values: AddWaypointValues) => {
    if (!id) return;
    // Guard against a double-tap on Save inserting the waypoint twice.
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingWaypoint(true);
    try {
      const service = await TrailDataService.create();
      if (editingWaypoint) {
        await service.updateCustomWaypoint(customWaypointRowId(editingWaypoint.id), {
          name: values.name,
          type: values.type,
          description: values.description || null,
          photoUri: values.photoUri,
        });
        // A replaced/removed photo's old file is no longer referenced.
        if (editingWaypoint.photoUri && editingWaypoint.photoUri !== values.photoUri) {
          deleteWaypointPhoto(editingWaypoint.photoUri);
        }
      } else if (pendingWaypoint) {
        await service.addCustomWaypoint({
          trailId: id,
          name: values.name,
          type: values.type,
          lat: pendingWaypoint.lat,
          lon: pendingWaypoint.lon,
          ele: pendingWaypoint.ele,
          kmPosition: pendingWaypoint.baseKm,
          offTrackM: pendingWaypoint.offTrackM,
          description: values.description || null,
          photoUri: values.photoUri,
        });
      }
      closeWaypointSheet();
      dispatch({ type: 'deselect' });
      await refreshCustomWaypoints();
    } catch (e) {
      console.warn('Failed to save custom waypoint:', e);
      Alert.alert('Save failed', 'Could not save the waypoint. Please try again.');
    } finally {
      savingRef.current = false;
      setSavingWaypoint(false);
    }
  }, [id, editingWaypoint, pendingWaypoint, closeWaypointSheet, refreshCustomWaypoints]);

  const handleEditWaypoint = useCallback((wp: TrailWaypoint) => {
    dispatch({ type: 'deselect' });
    setPendingWaypoint(null);
    setEditingWaypoint(wp);
  }, []);

  // Delete is immediate with an undo toast (replaces the old confirm Alert —
  // both safer and faster in the field). The full row is kept in memory and
  // re-inserted with the same id on undo, so merged `custom-` references stay
  // stable. Photo file deletion is deferred until the toast expires.
  const handleDeleteWaypoint = useCallback(async (wp: TrailWaypoint) => {
    try {
      const service = await TrailDataService.create();
      const rowId = customWaypointRowId(wp.id);
      const row = await service.getCustomWaypoint(rowId);
      await service.deleteCustomWaypoint(rowId);
      dispatch({ type: 'deselect' });
      setDeletedWaypoint(row);
      await refreshCustomWaypoints();
    } catch (e) {
      console.warn('Failed to delete custom waypoint:', e);
      Alert.alert('Delete failed', 'Could not delete the waypoint. Please try again.');
    }
  }, [refreshCustomWaypoints]);

  const handleUndoDelete = useCallback(async () => {
    const row = deletedWaypoint;
    setDeletedWaypoint(null);
    if (!row) return;
    try {
      const service = await TrailDataService.create();
      await service.restoreCustomWaypoint(row);
      await refreshCustomWaypoints();
    } catch (e) {
      console.warn('Failed to restore custom waypoint:', e);
      Alert.alert('Undo failed', 'Could not restore the waypoint.');
    }
  }, [deletedWaypoint, refreshCustomWaypoints]);

  const handleDeleteToastDismiss = useCallback(() => {
    // Toast expired without undo — the photo file is now orphaned.
    if (deletedWaypoint?.photoUri) {
      deleteWaypointPhoto(deletedWaypoint.photoUri);
    }
    setDeletedWaypoint(null);
  }, [deletedWaypoint]);

  // --- Route builder (toolbar "Route" — P1 PR D) ----------------------------

  const enterRouteBuilder = useCallback(() => {
    setCrosshair(null);
    setPendingWaypoint(null);
    setEditingWaypoint(null);
    setRouteView(null);
    dispatch({ type: 'deselect' });
    setRouteDraft([]);
  }, []);

  const exitRoutePanel = useCallback(() => {
    setRouteDraft(null);
    setRouteView(null);
  }, []);

  const handleRemoveRoutePoint = useCallback((index: number) => {
    setRouteDraft(prev => (prev ? prev.filter((_, i) => i !== index) : prev));
  }, []);

  const handleMoveRoutePoint = useCallback((index: number, direction: -1 | 1) => {
    setRouteDraft(prev => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }, []);

  const handleSaveRoute = useCallback(async (name: string) => {
    const trail = activeTrail;
    if (!id || !trail || !routeDraft || routeDraft.length < 2) return;
    setSavingRoute(true);
    try {
      const service = await RouteService.create();
      // km_position is stored in the trail's base direction (same convention
      // as custom_waypoints) so it stays valid whichever way the trail is
      // later displayed.
      const legs = routeDraft.map(wp => {
        const activeKm = wp.totalDistance ?? 0;
        return {
          waypointRef: wp.id,
          kmPosition: isReversed ? trail.track.totalDistance - activeKm : activeKm,
        };
      });
      const route = await service.createRoute(id, name, legs);
      // Switch straight into viewing the saved route
      const savedLegs = await service.getRouteLegs(route.id);
      setRouteDraft(null);
      setRouteView({ route, legs: savedLegs });
    } catch (e) {
      console.warn('Failed to save route:', e);
      Alert.alert('Save failed', 'Could not save the route. Please try again.');
    } finally {
      setSavingRoute(false);
    }
  }, [id, activeTrail, routeDraft, isReversed]);

  const handleExportRoute = useCallback(async () => {
    if (!routeView || !routeViewPoints) return;
    try {
      const gpx = routeToGpx(
        routeView.route.name,
        routeViewPoints.map(pt => ({ lat: pt.lat, lon: pt.lon, ele: pt.ele, name: pt.name })),
      );
      await shareGpxFile(gpxFilename(routeView.route.name), gpx);
    } catch (e) {
      console.warn('Failed to export route:', e);
      Alert.alert('Export failed', 'Could not export the GPX file.');
    }
  }, [routeView, routeViewPoints]);

  // --- Crosshair placement (toolbar "+" create, edit-mode "Move pin") -------

  const enterCreateCrosshair = useCallback(() => {
    setPendingWaypoint(null);
    setEditingWaypoint(null);
    setRouteDraft(null);
    setRouteView(null);
    dispatch({ type: 'deselect' });
    // Free the camera so a GPS tick can't drag the map out from under the
    // crosshair while the user is lining up the spot.
    dispatch({ type: 'userPanned' });
    setCrosshair({ kind: 'create' });
  }, []);

  const handleMovePin = useCallback(() => {
    const wp = editingWaypoint;
    if (!wp) return;
    setEditingWaypoint(null);
    dispatch({ type: 'userPanned' });
    setCrosshair({ kind: 'move', waypoint: wp });
    // Start the crosshair on the pin being moved.
    mapRef.current?.panTo(wp.lat, wp.lon);
  }, [editingWaypoint]);

  const cancelCrosshair = useCallback(() => {
    const mode = crosshair;
    setCrosshair(null);
    // Cancelling a move returns to the edit sheet it came from.
    if (mode?.kind === 'move') {
      setEditingWaypoint(mode.waypoint);
    }
  }, [crosshair]);

  const confirmCrosshair = useCallback(async () => {
    const mode = crosshair;
    const trail = activeTrail;
    if (!mode || !trail) return;

    const center = await mapRef.current?.getCenter();
    if (!center) {
      Alert.alert('Placement failed', 'Could not read the map position. Please try again.');
      return;
    }
    const [lat, lon] = center;

    // Snap against the full-resolution track (same as the long-press path).
    const points = trail.track.points;
    const nearest = nearestTrackPointToLatLon(points, lat, lon);
    if (!nearest) return;
    const trackPt = points[nearest.index];
    const activeKm = trackPt.dist;
    const offTrackM = nearest.distanceM;
    // km_position is stored in the trail's base direction so the merge at the
    // load boundary (which happens pre-reversal) places it correctly.
    const baseKm = isReversed ? trail.track.totalDistance - activeKm : activeKm;

    if (mode.kind === 'create') {
      setCrosshair(null);
      setPendingWaypoint({
        lat,
        lon,
        ele: trackPt.ele ?? null,
        baseKm,
        activeKm,
        offTrackM,
      });
      return;
    }

    // Move: persist the new position (lat/lon/ele/km/off-track together).
    try {
      const service = await TrailDataService.create();
      await service.updateCustomWaypoint(customWaypointRowId(mode.waypoint.id), {
        lat,
        lon,
        ele: trackPt.ele ?? null,
        kmPosition: baseKm,
        offTrackM,
      });
      setCrosshair(null);
      await refreshCustomWaypoints();
    } catch (e) {
      console.warn('Failed to move custom waypoint:', e);
      Alert.alert('Move failed', 'Could not move the waypoint. Please try again.');
    }
  }, [crosshair, activeTrail, isReversed, refreshCustomWaypoints]);

  if (contextLoading || (!activeTrail && !contextError)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading trail...</Text>
      </View>
    );
  }

  if (contextError || !activeTrail) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.alertRed }]}>{contextError ?? 'Trail not found'}</Text>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={[styles.backText, { color: colors.accent }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Location status bar */}
      <View style={{ paddingTop: insets.top }}>
        <LocationStatusBar
          state={locationState}
          detail={
            locationState === 'offTrail' && location?.distanceFromTrail
              ? `${Math.round(location.distanceFromTrail)}m from trail`
              : undefined
          }
        />
      </View>

      {/* Toolbar */}
      <View style={[styles.toolbar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Pressable
          onPress={() => {
            if (router.canGoBack()) {
              router.back();
            } else {
              router.replace('/(tabs)/plan');
            }
          }}
          style={styles.toolbarButton}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Text style={[styles.toolbarButtonText, { color: colors.accent }]}>←</Text>
        </Pressable>

        <View style={styles.toolbarCenter}>
          <Text style={[styles.trailName, { color: colors.textPrimary }]} numberOfLines={1}>
            {activeTrail.config.name}
          </Text>
        </View>

        {/* Offline maps download — only when no offline style is available */}
        {!offlineMapStyle && id && (
          <Pressable
            onPress={() => { if (downloadingTrailId !== id) downloadTiles(id, trailIsCustom); }}
            style={styles.toolbarButton}
            accessibilityLabel={downloadingTrailId === id ? 'Downloading offline maps' : 'Download offline maps'}
            accessibilityRole="button"
          >
            {downloadingTrailId === id ? (
              <ActivityIndicator size="small" color={colors.accent} />
            ) : (
              <Text style={[styles.toolbarButtonText, { color: colors.accent }]}>⭳</Text>
            )}
          </Pressable>
        )}

        <Pressable
          onPress={isTracking ? stopTracking : startTracking}
          style={[styles.gpsButton, { backgroundColor: isTracking ? colors.accent : colors.surface, borderColor: colors.accent }]}
          accessibilityLabel={isTracking ? 'Stop GPS tracking' : 'Start GPS tracking'}
          accessibilityRole="button"
        >
          <Text style={[styles.gpsButtonText, { color: isTracking ? colors.textInverse : colors.accent }]}>
            GPS
          </Text>
        </Pressable>

        <Pressable
          onPress={enterCreateCrosshair}
          style={styles.toolbarButton}
          accessibilityLabel="Add waypoint"
          accessibilityRole="button"
        >
          <Text style={[styles.toolbarButtonText, { color: colors.accent }]}>＋</Text>
        </Pressable>

        <Pressable
          onPress={routeDraft ? exitRoutePanel : enterRouteBuilder}
          style={styles.toolbarButton}
          accessibilityLabel={routeDraft ? 'Exit route builder' : 'Build a route'}
          accessibilityRole="button"
          accessibilityState={{ selected: routeDraft != null }}
        >
          <Text style={[styles.toolbarButtonText, { color: routeDraft ? colors.textPrimary : colors.accent }]}>⚑</Text>
        </Pressable>

        <Pressable
          onPress={() => {
            const params: Record<string, string> = { id: id! };
            if (currentKm != null) params.fromKm = currentKm.toFixed(1);
            router.push({ pathname: '/trail/datasheet', params });
          }}
          style={styles.toolbarButton}
          accessibilityLabel="View waypoint datasheet"
          accessibilityRole="button"
        >
          <Text style={[styles.toolbarButtonText, { color: colors.accent }]}>☰</Text>
        </Pressable>
      </View>

      {/* Map */}
      <View style={styles.mapContainer}>
        <MapErrorBoundary>
          <TrailMap
            ref={mapRef}
            displayPoints={activeTrail.track.displayPoints ?? activeTrail.track.points}
            alternates={activeTrail.alternates}
            sideTrips={activeTrail.sideTrips}
            waypoints={activeTrail.waypoints}
            userLocation={userLocationForMap}
            focusedWaypointId={focusedWaypointId}
            onWaypointPress={handleWaypointPress}
            isFollowingUser={cameraMode === 'follow'}
            onMapPan={handleMapPan}
            onMapPress={handleMapPress}
            onRecenter={handleRecenter}
            currentKm={currentKm}
            mapStyleOverride={offlineMapStyle}
            trackPoints={trackPoints}
            onVisibleBoundsChange={handleVisibleBoundsChange}
            onLongPress={crosshair || routeDraft ? undefined : handleMapLongPress}
            routeOverlay={routeOverlay}
          />
        </MapErrorBoundary>

        {/* Crosshair placement overlay — fixed center marker, pan the map
            under it (decision 6). pointerEvents="none" on the crosshair so
            map gestures pass through; only Confirm/Cancel capture touches. */}
        {crosshair && (
          <>
            <View style={styles.crosshairOverlay} pointerEvents="none">
              <Text style={[styles.crosshairGlyph, { color: colors.accent }]}>✛</Text>
            </View>
            <View style={[styles.crosshairChip, { backgroundColor: colors.surface, borderColor: colors.border }]} pointerEvents="none">
              <Text style={[styles.crosshairChipText, { color: colors.textPrimary }]}>
                {crosshair.kind === 'move'
                  ? `Pan the map to reposition "${crosshair.waypoint.name}"`
                  : 'Pan the map to place the waypoint'}
              </Text>
            </View>
            <View style={styles.crosshairActions}>
              <Pressable
                onPress={cancelCrosshair}
                style={[styles.crosshairButton, { backgroundColor: colors.surface, borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Cancel placement"
              >
                <Text style={[styles.crosshairButtonText, { color: colors.textSecondary }]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirmCrosshair}
                style={[styles.crosshairButton, { backgroundColor: colors.accent, borderColor: colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel={crosshair.kind === 'move' ? 'Confirm new position' : 'Confirm waypoint position'}
              >
                <Text style={[styles.crosshairButtonText, { color: colors.textInverse }]}>Confirm</Text>
              </Pressable>
            </View>
          </>
        )}
      </View>

      {/* Elevation profile drawer */}
      <ElevationProfileDrawer
        trackPoints={activeTrail.track.points}
        waypoints={activeTrail.waypoints}
        currentKm={currentKm}
        currentElevation={currentElevation}
        focusedWaypointId={focusedWaypointId}
        onDistanceTap={handleProfileDistanceTap}
        visibleRange={visibleRange}
        index={drawerIndex}
        onIndexChange={handleDrawerIndexChange}
      />

      {/* Waypoint detail sheet */}
      <WaypointDetailSheet
        waypoint={selectedWaypoint}
        onDismiss={handleDismissWaypoint}
        distanceFromUser={distanceToSelected}
        onShowOnProfile={handleShowOnProfile}
        onEdit={handleEditWaypoint}
        onDelete={handleDeleteWaypoint}
      />

      {/* Add / edit custom waypoint sheet (opened by map long-press or Edit) */}
      <AddWaypointSheet
        isOpen={pendingWaypoint != null || editingWaypoint != null}
        mode={editingWaypoint ? 'edit' : 'add'}
        kmPosition={
          editingWaypoint
            ? editingWaypoint.totalDistance ?? null
            : pendingWaypoint?.activeKm ?? null
        }
        offTrackM={editingWaypoint ? null : pendingWaypoint?.offTrackM ?? null}
        initialValues={
          editingWaypoint
            ? {
                name: editingWaypoint.name,
                type: editingWaypoint.type,
                description: editingWaypoint.description,
                photoUri: editingWaypoint.photoUri ?? null,
              }
            : null
        }
        onDismiss={closeWaypointSheet}
        onSave={handleSaveWaypoint}
        saving={savingWaypoint}
        onMovePin={editingWaypoint ? handleMovePin : undefined}
      />

      {/* Route builder / viewer panel (P1 PR D) */}
      {activeRoutePoints && routeMetrics && (
        <RoutePanel
          mode={routeDraft ? 'build' : 'view'}
          routeName={routeView?.route.name}
          points={activeRoutePoints}
          metrics={routeMetrics}
          onRemovePoint={handleRemoveRoutePoint}
          onMovePoint={handleMoveRoutePoint}
          onSave={handleSaveRoute}
          onExport={routeView ? handleExportRoute : undefined}
          onClose={exitRoutePanel}
          saving={savingRoute}
        />
      )}

      {/* Undo toast for waypoint deletion (5 s window) */}
      <UndoToast
        visible={deletedWaypoint != null}
        message={deletedWaypoint ? `Deleted "${deletedWaypoint.name}"` : ''}
        onUndo={handleUndoDelete}
        onDismiss={handleDeleteToastDismiss}
        durationMs={5000}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  loadingText: {
    ...typography.body,
    marginTop: spacing.md,
  },
  errorText: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  backButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  backText: {
    ...typography.body,
    fontWeight: '600',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
  },
  toolbarButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarButtonText: {
    fontSize: 22,
    fontWeight: '600',
  },
  toolbarCenter: {
    flex: 1,
    alignItems: 'center',
  },
  trailName: {
    ...typography.caption,
    fontWeight: '600',
  },
  gpsButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: 1,
  },
  gpsButtonText: {
    ...typography.caption,
    fontWeight: '700',
  },
  mapContainer: {
    flex: 1,
  },
  crosshairOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  crosshairGlyph: {
    fontSize: 36,
    fontWeight: '300',
    textShadowColor: '#fff',
    textShadowRadius: 4,
  },
  crosshairChip: {
    position: 'absolute',
    top: spacing.lg,
    alignSelf: 'center',
    maxWidth: '85%',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
    elevation: 3,
  },
  crosshairChipText: {
    ...typography.caption,
    fontWeight: '600',
    textAlign: 'center',
  },
  crosshairActions: {
    position: 'absolute',
    bottom: spacing.xl,
    left: spacing.lg,
    right: spacing.lg,
    flexDirection: 'row',
    gap: spacing.md,
  },
  crosshairButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: radii.lg,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  crosshairButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
});
