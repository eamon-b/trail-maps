import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Text, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrailMap } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { ElevationProfileDrawer, type ElevationProfileDrawerHandle } from '../../src/components/ElevationProfileDrawer';
import { WaypointDetailSheet } from '../../src/components/WaypointDetailSheet';
import { LocationStatusBar, type LocationState } from '../../src/components';
import { useTheme } from '../../src/theme';
import { useFocusedWaypoint } from '../../src/theme/FocusedWaypointContext';
import { useLocation } from '../../src/hooks/useLocation';
import { useTrailData } from '../../src/contexts/TrailDataContext';
import {
  createReversedTrail,
  findNearestByDistance,
  type Trail,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { tileManager } from '../../src/services/tile-manager';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export const DIRECTION_PREF_KEY = 'trail_direction_prefs';
export const ACTIVE_TRAIL_KEY = 'active_trail_id';

export default function TrailViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { focusedWaypointId, setFocusedWaypointId } = useFocusedWaypoint();
  const { trail: contextTrail, loading: contextLoading, error: contextError, loadTrail } = useTrailData();

  const [isReversed, setIsReversed] = useState(false);
  const [isFollowingUser, setIsFollowingUser] = useState(true);
  const [selectedWaypoint, setSelectedWaypoint] = useState<TrailWaypoint | null>(null);
  const [panTarget, setPanTarget] = useState<{ longitude: number; latitude: number; key: number } | null>(null);
  const panKeyRef = useRef(0);
  const elevationDrawerRef = useRef<ElevationProfileDrawerHandle>(null);
  const [offlineMapStyle, setOfflineMapStyle] = useState<object | null>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);

  // Active trail data (respects direction)
  const [reversedTrail, setReversedTrail] = useState<Trail | null>(null);

  const originalTrail = contextTrail;
  const activeTrail = isReversed ? reversedTrail : originalTrail;
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

  // Build reversed trail when original loads and direction is reversed
  useEffect(() => {
    if (isReversed && originalTrail && !reversedTrail) {
      setReversedTrail(createReversedTrail(originalTrail));
    }
  }, [isReversed, originalTrail, reversedTrail]);

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

  // Handlers
  const handleWaypointPress = useCallback((wp: TrailWaypoint, index: number) => {
    setSelectedWaypoint(wp);
    setFocusedWaypointId(index);
    // Pan camera to waypoint as a one-shot action (not driven by focusedWaypointId effect)
    panKeyRef.current += 1;
    setPanTarget({ longitude: wp.lon, latitude: wp.lat, key: panKeyRef.current });
    setIsFollowingUser(false);
  }, [setFocusedWaypointId]);

  const handleDismissWaypoint = useCallback(() => {
    setSelectedWaypoint(null);
    setFocusedWaypointId(null);
  }, [setFocusedWaypointId]);

  const handleMapPan = useCallback(() => {
    setIsFollowingUser(false);
  }, []);

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
    panKeyRef.current += 1;
    setPanTarget({ longitude: point.lon, latitude: point.lat, key: panKeyRef.current });
    setIsFollowingUser(false);
  }, [trackPoints]);

  const handleShowOnProfile = useCallback((wp: TrailWaypoint) => {
    // Dismiss the waypoint detail sheet so the profile is visible
    setSelectedWaypoint(null);
    // Use a longer delay to ensure the WaypointDetailSheet's BottomSheet
    // has fully unmounted — having two @gorhom/bottom-sheet instances active
    // simultaneously suppresses snap animations.
    setTimeout(() => {
      if (wp.totalDistance != null) {
        const index = activeTrail?.waypoints?.findIndex(w =>
          w.name === wp.name && Math.abs((w.totalDistance ?? -1) - (wp.totalDistance ?? -2)) < 0.1
        );
        if (index != null && index >= 0) {
          setFocusedWaypointId(index);
        }
      }
      elevationDrawerRef.current?.expand();
    }, 350);
  }, [activeTrail, setFocusedWaypointId]);

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
            displayPoints={activeTrail.track.displayPoints ?? activeTrail.track.points}
            alternates={activeTrail.alternates}
            sideTrips={activeTrail.sideTrips}
            waypoints={activeTrail.waypoints}
            userLocation={userLocationForMap}
            focusedWaypointId={focusedWaypointId as number | null}
            onWaypointPress={handleWaypointPress}
            isFollowingUser={isFollowingUser}
            onMapPan={handleMapPan}
            onRecenter={handleRecenter}
            currentKm={currentKm}
            panTarget={panTarget}
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
        focusedWaypointId={focusedWaypointId as number | null}
        onDistanceTap={handleProfileDistanceTap}
        visibleRange={visibleRange}
      />

      {/* Waypoint detail sheet */}
      <WaypointDetailSheet
        waypoint={selectedWaypoint}
        onDismiss={handleDismissWaypoint}
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
