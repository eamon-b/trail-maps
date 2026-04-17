import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { View, StyleSheet, Text, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrailMap, type TrailMapHandle } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { ElevationProfileDrawer, type ElevationProfileDrawerHandle } from '../../src/components/ElevationProfileDrawer';
import { WaypointDetailSheet } from '../../src/components/WaypointDetailSheet';
import { LocationStatusBar, type LocationState } from '../../src/components';
import { useTheme } from '../../src/theme';
import { useFocusedWaypoint } from '../../src/theme/FocusedWaypointContext';
import { useLocation } from '../../src/hooks/useLocation';
import { useTrailData } from '../../src/contexts/TrailDataContext';
import {
  findNearestByDistance,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { useDirectionalTrail } from '../../src/hooks/useDirectionalTrail';
import { tileManager } from '../../src/services/tile-manager';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export const DIRECTION_PREF_KEY = 'trail_direction_prefs';
export const ACTIVE_TRAIL_KEY = 'active_trail_id';

// ---------------------------------------------------------------------------
// Selection reducer
// ---------------------------------------------------------------------------
//
// Unifies the two pieces of waypoint-selection state (detail sheet + focus
// highlight) so they can never get out of sync. Every user action becomes a
// single dispatch, which eliminates an entire class of "sheet shows but
// highlight cleared" / "highlight lingers after dismiss" bugs.

interface SelectionState {
  /** Waypoint displayed in the bottom detail sheet (null = sheet hidden). */
  sheetWaypoint: TrailWaypoint | null;
  /** Id of the waypoint highlighted on map + elevation profile. */
  focusedId: string | null;
}

type SelectionAction =
  | { type: 'selectFromMap'; waypoint: TrailWaypoint }
  | { type: 'hydrateFromPendingPan'; waypoint: TrailWaypoint }
  | { type: 'deselect' }
  | { type: 'showOnProfile'; waypoint: TrailWaypoint };

const EMPTY_SELECTION: SelectionState = { sheetWaypoint: null, focusedId: null };

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'selectFromMap':
    case 'hydrateFromPendingPan':
      return { sheetWaypoint: action.waypoint, focusedId: action.waypoint.id };
    case 'showOnProfile':
      return { sheetWaypoint: null, focusedId: action.waypoint.id };
    case 'deselect':
      return EMPTY_SELECTION;
  }
}

export default function TrailViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { setFocusedWaypointId, pendingPan, setPendingPan } = useFocusedWaypoint();
  const { trail: contextTrail, loading: contextLoading, error: contextError, loadTrail } = useTrailData();

  const [isReversed, setIsReversed] = useState(false);
  const [isFollowingUser, setIsFollowingUser] = useState(true);
  const [selection, dispatchSelection] = useReducer(selectionReducer, EMPTY_SELECTION);
  const { sheetWaypoint: selectedWaypoint, focusedId: focusedWaypointId } = selection;
  const mapRef = useRef<TrailMapHandle>(null);
  const elevationDrawerRef = useRef<ElevationProfileDrawerHandle>(null);
  const [offlineMapStyle, setOfflineMapStyle] = useState<object | null>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);

  // Mirror focus to context so any other tree consumer (future) can read it.
  useEffect(() => {
    setFocusedWaypointId(focusedWaypointId);
  }, [focusedWaypointId, setFocusedWaypointId]);

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
  }, [id, loadTrail]);

  // Consume pending pan from external navigation (e.g. datasheet "Show on map").
  // Don't clear pendingPan until the trail is ready — otherwise a cold-start
  // from the datasheet would drop the pan on the first render where
  // activeTrail is still null.
  useEffect(() => {
    if (!pendingPan || !activeTrail) return;
    const wp = activeTrail.waypoints.find(w => w.id === pendingPan.waypointId);
    if (wp) {
      dispatchSelection({ type: 'hydrateFromPendingPan', waypoint: wp });
      mapRef.current?.panTo(pendingPan.latitude, pendingPan.longitude);
      setIsFollowingUser(false);
    }
    setPendingPan(null);
  }, [pendingPan, activeTrail, setPendingPan]);

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
    if (currentKm == null || !selectedWaypoint?.totalDistance) return null;
    return selectedWaypoint.totalDistance - currentKm;
  }, [currentKm, selectedWaypoint]);

  // Handlers — each user intent becomes a single dispatch + side effects
  const handleWaypointPress = useCallback((wp: TrailWaypoint) => {
    dispatchSelection({ type: 'selectFromMap', waypoint: wp });
    setIsFollowingUser(false);
  }, []);

  const handleDismissWaypoint = useCallback(() => {
    dispatchSelection({ type: 'deselect' });
  }, []);

  const handleMapPan = useCallback(() => {
    setIsFollowingUser(false);
  }, []);

  const handleMapPress = useCallback(() => {
    if (selectedWaypoint) {
      dispatchSelection({ type: 'deselect' });
    }
  }, [selectedWaypoint]);

  const handleRecenter = useCallback(() => {
    setIsFollowingUser(true);
  }, []);

  const handleVisibleBoundsChange = useCallback((minKm: number, maxKm: number) => {
    setVisibleRange([minKm, maxKm]);
  }, []);

  const handleProfileDistanceTap = useCallback((km: number) => {
    if (trackPoints.length === 0) return;
    const idx = findNearestByDistance(trackPoints, km);
    const point = trackPoints[idx];
    if (!point) return;
    mapRef.current?.panTo(point.lat, point.lon);
    setIsFollowingUser(false);
  }, [trackPoints]);

  // Queue an action to run after the waypoint sheet's exit animation
  // completes. Sequencing on the animation end avoids visual jank from the
  // expand starting while the sheet is still sliding out.
  const onSheetExitRef = useRef<(() => void) | null>(null);

  const handleSheetExitComplete = useCallback(() => {
    const action = onSheetExitRef.current;
    onSheetExitRef.current = null;
    action?.();
  }, []);

  const handleShowOnProfile = useCallback((wp: TrailWaypoint) => {
    onSheetExitRef.current = () => elevationDrawerRef.current?.expand();
    dispatchSelection({ type: 'showOnProfile', waypoint: wp });
  }, []);

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

        <Pressable
          onPress={isTracking ? stopTracking : startTracking}
          style={[styles.gpsButton, { backgroundColor: isTracking ? colors.accent : colors.surface, borderColor: colors.accent }]}
          accessibilityLabel={isTracking ? 'Stop GPS tracking' : 'Start GPS tracking'}
          accessibilityRole="button"
        >
          <Text style={[styles.gpsButtonText, { color: isTracking ? '#fff' : colors.accent }]}>
            GPS
          </Text>
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
            isFollowingUser={isFollowingUser}
            onMapPan={handleMapPan}
            onMapPress={handleMapPress}
            onRecenter={handleRecenter}
            currentKm={currentKm}
            mapStyleOverride={offlineMapStyle}
            trackPoints={trackPoints}
            onVisibleBoundsChange={handleVisibleBoundsChange}
          />
        </MapErrorBoundary>
      </View>

      {/* Elevation profile drawer */}
      <ElevationProfileDrawer
        ref={elevationDrawerRef}
        trackPoints={activeTrail.track.points}
        waypoints={activeTrail.waypoints}
        currentKm={currentKm}
        currentElevation={currentElevation}
        focusedWaypointId={focusedWaypointId}
        onDistanceTap={handleProfileDistanceTap}
        visibleRange={visibleRange}
      />

      {/* Waypoint detail sheet */}
      <WaypointDetailSheet
        waypoint={selectedWaypoint}
        onDismiss={handleDismissWaypoint}
        onExitComplete={handleSheetExitComplete}
        distanceFromUser={distanceToSelected}
        onShowOnProfile={handleShowOnProfile}
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
});
