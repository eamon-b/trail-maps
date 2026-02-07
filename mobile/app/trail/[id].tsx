import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, Text, Pressable, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TrailMap } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { ElevationProfileDrawer } from '../../src/components/ElevationProfileDrawer';
import { WaypointDetailSheet } from '../../src/components/WaypointDetailSheet';
import { LocationStatusBar, type LocationState } from '../../src/components';
import { useTheme } from '../../src/theme';
import { useFocusedWaypoint } from '../../src/theme/FocusedWaypointContext';
import { useLocation } from '../../src/hooks/useLocation';
import { TrailDataService } from '../../src/services/trail-data-service';
import {
  trailJsonToTrail,
  createReversedTrail,
  findNearestByDistance,
  type Trail,
  type TrailWaypoint,
} from '../../src/lib/trail-utils';
import { tileManager } from '../../src/services/tile-manager';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const DIRECTION_PREF_KEY = 'trail_direction_prefs';
export const ACTIVE_TRAIL_KEY = 'active_trail_id';

export default function TrailViewerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { focusedWaypointId, setFocusedWaypointId } = useFocusedWaypoint();

  const [isReversed, setIsReversed] = useState(false);
  const [isFollowingUser, setIsFollowingUser] = useState(true);
  const [selectedWaypoint, setSelectedWaypoint] = useState<TrailWaypoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [panTarget, setPanTarget] = useState<{ longitude: number; latitude: number; key: number } | null>(null);
  const panKeyRef = useRef(0);
  const [offlineMapStyle, setOfflineMapStyle] = useState<object | null>(null);
  const [visibleRange, setVisibleRange] = useState<[number, number] | null>(null);

  // Active trail data (respects direction)
  const [originalTrail, setOriginalTrail] = useState<Trail | null>(null);
  const [reversedTrail, setReversedTrail] = useState<Trail | null>(null);

  const activeTrail = isReversed ? reversedTrail : originalTrail;
  const trackPoints = useMemo(() => activeTrail?.track.points ?? [], [activeTrail]);

  const { location, accuracy, isTracking, startTracking, stopTracking } =
    useLocation(trackPoints);

  // Load trail data
  useEffect(() => {
    async function load() {
      if (!id) return;
      try {
        const service = await TrailDataService.create();
        const json = service.getTrailTrackData(id);
        if (!json) {
          setError('Trail not found');
          setLoading(false);
          return;
        }

        const parsed = trailJsonToTrail(json);
        setOriginalTrail(parsed);

        // Load saved direction preference
        const prefsStr = await AsyncStorage.getItem(DIRECTION_PREF_KEY);
        const prefs = prefsStr ? JSON.parse(prefsStr) : {};
        if (prefs[id]) {
          const rev = createReversedTrail(parsed);
          setReversedTrail(rev);
          setIsReversed(true);
        }

        // Persist as the active trail for the Hike tab
        AsyncStorage.setItem(ACTIVE_TRAIL_KEY, id).catch(() => {});

        // Check for offline tiles and build style if available
        tileManager.getOfflineStyle(id).then((style) => {
          if (style) setOfflineMapStyle(style);
        }).catch(() => {});

        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load trail');
        setLoading(false);
      }
    }
    load();
  }, [id]);

  // Direction toggle
  const toggleDirection = useCallback(async () => {
    if (!originalTrail || !id) return;

    const newReversed = !isReversed;

    if (newReversed && !reversedTrail) {
      const rev = createReversedTrail(originalTrail);
      setReversedTrail(rev);
    }

    setIsReversed(newReversed);

    // Persist preference
    try {
      const prefsStr = await AsyncStorage.getItem(DIRECTION_PREF_KEY);
      const prefs = prefsStr ? JSON.parse(prefsStr) : {};
      prefs[id] = newReversed;
      await AsyncStorage.setItem(DIRECTION_PREF_KEY, JSON.stringify(prefs));
    } catch {
      // Non-critical
    }
  }, [isReversed, originalTrail, reversedTrail, id]);

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
    // Focus the waypoint on the profile (handled via focusedWaypointId)
    if (wp.totalDistance != null) {
      const index = activeTrail?.waypoints?.findIndex(w => w.name === wp.name && w.totalDistance === wp.totalDistance);
      if (index != null && index >= 0) {
        setFocusedWaypointId(index);
      }
    }
  }, [activeTrail, setFocusedWaypointId]);

  // Direction label
  const directionLabel = useMemo(() => {
    const dir = activeTrail?.config.direction;
    if (dir) return isReversed ? dir.reversed : dir.default;
    return isReversed ? 'Reversed' : 'Default';
  }, [activeTrail, isReversed]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading trail...</Text>
      </View>
    );
  }

  if (error || !activeTrail) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.errorText, { color: colors.alertRed }]}>{error ?? 'Trail not found'}</Text>
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

      {/* Direction toggle + GPS toggle bar */}
      <View style={[styles.toolbar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Pressable
          onPress={() => router.back()}
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
          <Pressable
            onPress={toggleDirection}
            accessibilityLabel={`Direction: ${directionLabel}. Tap to toggle.`}
            accessibilityRole="button"
          >
            <Text style={[styles.directionLabel, { color: colors.accent }]}>
              {directionLabel} ↔
            </Text>
          </Pressable>
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
      </View>

      {/* Trail stats bar */}
      <View style={[styles.statsBar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          {Math.round(activeTrail.track.totalDistance)} km
        </Text>
        <Text style={[styles.statDivider, { color: colors.border }]}>|</Text>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          +{Math.round(activeTrail.track.totalAscent)}m
        </Text>
        <Text style={[styles.statDivider, { color: colors.border }]}>|</Text>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          -{Math.round(activeTrail.track.totalDescent)}m
        </Text>
        <Text style={[styles.statDivider, { color: colors.border }]}>|</Text>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          {activeTrail.waypoints?.length ?? 0} waypoints
        </Text>
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
  directionLabel: {
    ...typography.caption,
    fontWeight: '500',
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
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
  },
  stat: {
    fontSize: 11,
    fontVariant: ['tabular-nums'] as const,
  },
  statDivider: {
    fontSize: 11,
  },
  mapContainer: {
    flex: 1,
  },
});
