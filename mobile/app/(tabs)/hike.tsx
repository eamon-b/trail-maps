import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState, Linking, StyleSheet, View, Text, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme } from '../../src/theme';
import { HikeDashboard, type DashboardData } from '../../src/components';
import { LocationStatusBar } from '../../src/components/LocationStatusBar';
import { AlertBanner } from '../../src/components/AlertBanner';
import { SunriseCountdown } from '../../src/components/SunriseCountdown';
import { CoordinatesRow } from '../../src/components/CoordinatesRow';
import { OfflineReadinessRow } from '../../src/components/OfflineReadinessRow';
import type { WaypointListItem } from '../../src/components/WaypointList';
import { useLocation } from '../../src/hooks/useLocation';
import { useOffTrailAlert } from '../../src/hooks/useOffTrailAlert';
import { triggerLocationHaptic } from '../../src/components/haptics';
import { TrailDataService, type CustomWaypoint } from '../../src/services/trail-data-service';
import { deleteWaypointPhoto } from '../../src/services/waypoint-photo-service';
import { markedWaypointName, accuracyPreamble, isFixStale } from '../../src/services/mark-location';
import { AddWaypointSheet, type AddWaypointValues } from '../../src/components/AddWaypointSheet';
import { UndoToast } from '../../src/components/UndoToast';
import {
  createReversedTrail,
  nearestTrackPointToLatLon,
  type Trail,
} from '../../src/lib/trail-utils';
import { PlanService, type Plan } from '../../src/services/plan-service';
import {
  getNextWaypointsByType,
  calculateDistancesToWaypoints,
  formatEtaMinutes,
  type WaypointDistance,
} from '../../src/services/distance-calculator';
import { bearingBetween } from '../../src/lib/bearing';
import { BearingIndicator } from '../../src/components/BearingIndicator';
import { computeDays } from '@lib/day-calculator';
import type { StopData, ComputedDay } from '../../src/services/plan-calculator-types';
import { ACTIVE_TRAIL_KEY, DIRECTION_PREF_KEY } from '../trail/[id]';
import { ALERT_THRESHOLD_KEY, BACKGROUND_TRACKING_KEY, TRACKING_PROFILE_KEY } from '../settings';
import {
  setTrackingPreference,
  getActiveProfile,
  onProfileChange,
  type TrackingProfile,
  type TrackingProfilePreference,
} from '../../src/services/location-service';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';
import type { LocationState } from '../../src/components/LocationStatusBar';
import type { AlertThresholdPreset, SnoozeDuration } from '../../src/services/off-trail-alert-service';

/** Snooze options shown when the off-trail alert banner is tapped */
const SNOOZE_OPTIONS: { label: string; value: SnoozeDuration }[] = [
  { label: '15 min', value: '15min' },
  { label: '30 min', value: '30min' },
  { label: '1 hour', value: '60min' },
];

function formatDistance(km: number): string {
  return `${km.toFixed(1)} km`;
}

function formatElevation(wd: WaypointDistance): string | undefined {
  if (wd.elevationGain === 0 && wd.elevationLoss === 0) return undefined;
  return `+${wd.elevationGain}m`;
}

function toUpcomingList(distances: WaypointDistance[], limit: number): WaypointListItem[] {
  return distances.slice(0, limit).map(wd => ({
    // Real waypoint id (incl. the `custom-` prefix for user waypoints) so a
    // tap can deep-link to this waypoint on the map.
    id: wd.waypoint.id,
    name: wd.waypoint.name,
    type: wd.waypoint.type,
    distanceAhead: formatDistance(wd.trailDistanceKm),
    eta: formatEtaMinutes(wd.etaMinutes),
  }));
}

/** First line of a waypoint description (tank condition etc.), or undefined */
function descriptionFirstLine(description?: string): string | undefined {
  const line = description?.split('\n')[0]?.trim();
  return line || undefined;
}

/** Format a snooze expiry as HH:MM for the snooze chip */
function formatSnoozeTime(until: Date): string {
  const h = until.getHours().toString().padStart(2, '0');
  const m = until.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}


/**
 * Estimate remaining hiking hours for today's segment using simple distance scaling.
 * Uses the day's total Naismith estimate scaled to the remaining fraction.
 */
function estimateRemainingHours(completedKm: number, totalDistanceKm: number, totalHours: number): number {
  if (totalDistanceKm <= 0) return 0;
  const remaining = Math.max(0, totalDistanceKm - completedKm);
  return (remaining / totalDistanceKm) * totalHours;
}

export default function HikeScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [activeTrailId, setActiveTrailId] = useState<string | null>(null);
  const [activePlan, setActivePlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
  const [alertPreset, setAlertPreset] = useState<AlertThresholdPreset>('normal');
  const [backgroundTracking, setBackgroundTracking] = useState(false);
  // Active tracking cadence — disclosed in the status line so a degraded fix
  // rate (battery saver) is never mysterious. Seeded from the service and kept
  // in sync via onProfileChange, so auto battery switches that happen while the
  // screen is mounted are reflected here immediately.
  const [activeProfile, setActiveProfile] = useState<TrackingProfile>(() => getActiveProfile());
  // Ticks every 15 s so time-derived UI (the stale-fix guard on the Mark
  // button) re-evaluates even when no new GPS fix is arriving.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Warning-state banner dismissal (snooze-lite: the status bar stays amber)
  const [warningDismissed, setWarningDismissed] = useState(false);
  // Whether the displayed trail is reversed (plan SOBO or direction pref) —
  // needed to convert active-direction km back to stored base-direction km.
  const [isTrailReversed, setIsTrailReversed] = useState(false);
  // Bump to reload the merged trail after a custom waypoint changes.
  const [trailRefreshKey, setTrailRefreshKey] = useState(0);
  // "Mark my location": row written first (write-first-edit-after), then the
  // sheet opens prefilled and an undo toast covers accidental taps.
  const [markedWaypoint, setMarkedWaypoint] = useState<CustomWaypoint | null>(null);
  const [markToastVisible, setMarkToastVisible] = useState(false);
  const [markSheetOpen, setMarkSheetOpen] = useState(false);
  const [savingMarked, setSavingMarked] = useState(false);
  const markingRef = useRef(false);

  const trackPoints = useMemo(() => trail?.track.points ?? [], [trail]);
  const { location, accuracy, error: locationError, isTracking, startTracking, stopTracking } =
    useLocation(trackPoints, { background: backgroundTracking });

  // Track while the Hike tab is focused — the dashboard's distances are
  // meaningless without a live position. Foreground sessions stop on blur to
  // save battery; background sessions (explicit opt-in) keep running through
  // blur and screen lock. startTracking is idempotent, and useLocation owns
  // restarting when the background preference changes.
  useFocusEffect(
    useCallback(() => {
      if (!trail) return;
      startTracking();
      return () => {
        if (!backgroundTracking) stopTracking();
      };
    }, [trail, backgroundTracking, startTracking, stopTracking]),
  );

  // Retry when the app returns to the foreground — covers the user granting
  // location permission in OS settings and switching back.
  useEffect(() => {
    if (!trail || isTracking) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') startTracking();
    });
    return () => sub.remove();
  }, [trail, isTracking, startTracking]);

  const currentKm = location?.trailKm ?? null;

  // Keep the disclosed profile in sync with the running GPS session, including
  // auto battery auto-switches that fire while this screen is mounted.
  useEffect(() => onProfileChange(setActiveProfile), []);

  // 15 s clock for the Mark button's stale-fix guard.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // Off-trail alert with debouncing and snooze
  const { alertState, alertDetail, bearingToTrail, isSnoozed, snoozeUntil, snooze, clearSnooze } = useOffTrailAlert(
    location,
    accuracy,
    trackPoints,
    { thresholdPreset: alertPreset, enabled: !!trail },
  );

  // Haptic feedback when state escalates to warning or offTrail
  const prevAlertState = useRef<LocationState>('noGps');
  useEffect(() => {
    const prev = prevAlertState.current;
    prevAlertState.current = alertState;
    if (alertState !== prev && (alertState === 'warning' || alertState === 'offTrail')) {
      triggerLocationHaptic(alertState);
    }
    // A dismissed warning banner comes back on the next warning episode
    if (alertState !== 'warning') {
      setWarningDismissed(false);
    }
  }, [alertState]);

  // Load the active trail — reload when tab regains focus
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      async function load() {
        try {
          // Load alert threshold preference
          const savedThreshold = await AsyncStorage.getItem(ALERT_THRESHOLD_KEY);
          if (!cancelled && savedThreshold && ['tight', 'normal', 'loose'].includes(savedThreshold)) {
            setAlertPreset(savedThreshold as AlertThresholdPreset);
          }

          // Load background tracking preference
          const savedBackground = await AsyncStorage.getItem(BACKGROUND_TRACKING_KEY);
          if (!cancelled) {
            setBackgroundTracking(savedBackground === 'true');
          }

          // Apply the tracking power profile. For 'auto' the service resolves
          // the battery level now and keeps watching for the rest of the
          // session; onProfileChange keeps activeProfile in sync.
          const savedProfile = await AsyncStorage.getItem(TRACKING_PROFILE_KEY);
          const pref: TrackingProfilePreference =
            savedProfile === 'standard' || savedProfile === 'saver' ? savedProfile : 'auto';
          if (!cancelled) {
            // Restarts a live watch when the cadence changed
            setTrackingPreference(pref).catch(() => {});
          }

          const trailId = await AsyncStorage.getItem(ACTIVE_TRAIL_KEY);
          if (cancelled) return;
          if (!trailId) {
            setTrail(null);
            setActiveTrailId(null);
            setActivePlan(null);
            setLoading(false);
            return;
          }
          setActiveTrailId(trailId);

          const service = await TrailDataService.create();
          let parsed = await service.getMergedTrail(trailId);
          if (cancelled) return;
          if (!parsed) {
            setLoading(false);
            return;
          }

          // Load active plan for this trail
          let plan: Plan | null = null;
          try {
            const planService = await PlanService.create();
            plan = await planService.getActivePlanForTrail(trailId);
          } catch {
            // No plan — that's fine
          }
          if (cancelled) return;

          // Use plan direction if available, otherwise fall back to direction preference
          let reversed = false;
          if (plan?.direction === 'SOBO') {
            parsed = createReversedTrail(parsed);
            reversed = true;
          } else if (!plan) {
            const prefsStr = await AsyncStorage.getItem(DIRECTION_PREF_KEY);
            const prefs = prefsStr ? JSON.parse(prefsStr) : {};
            if (prefs[trailId]) {
              parsed = createReversedTrail(parsed);
              reversed = true;
            }
          }

          setTrail(parsed);
          setIsTrailReversed(reversed);
          setActivePlan(plan);
          setLoading(false);
        } catch {
          if (!cancelled) setLoading(false);
        }
      }
      load();
      return () => { cancelled = true; };
      // trailRefreshKey re-runs the load after a custom waypoint add/edit/undo
    }, [trailRefreshKey]),
  );

  // Compute plan days for the "today" section
  const planDays = useMemo((): ComputedDay[] => {
    if (!trail || !activePlan) return [];
    const stops: StopData[] = activePlan.stopsJson
      ? JSON.parse(activePlan.stopsJson)
      : [];
    if (stops.length === 0) return [];
    return computeDays(trail, stops, activePlan.startDate);
  }, [trail, activePlan]);

  // Build dashboard data from real trail + GPS
  const dashboardData = useMemo((): DashboardData | null => {
    if (!trail) return null;

    const waypoints = trail.waypoints ?? [];
    const km = currentKm ?? 0;
    const dirConfig = trail.config.direction;
    const direction = dirConfig ? dirConfig.default : 'Default';

    const allDistances = calculateDistancesToWaypoints(km, waypoints, trail.track.points);
    const next = getNextWaypointsByType(km, waypoints, trail.track.points, allDistances);

    // Bearing from the current raw position to a waypoint (for the arrow)
    const raw = location?.raw;
    const bearingTo = (wd?: WaypointDistance) =>
      raw && wd ? bearingBetween(raw.latitude, raw.longitude, wd.waypoint.lat, wd.waypoint.lon) : undefined;

    // Find current day from plan
    let today: DashboardData['today'] | undefined;
    if (planDays.length > 0) {
      const currentDay = planDays.find(d => km >= d.startKm && km < d.endKm)
        ?? planDays[planDays.length - 1];
      if (currentDay) {
        const completedKm = Math.max(0, km - currentDay.startKm);
        today = {
          dayNumber: currentDay.dayNumber,
          totalDays: planDays.length,
          startName: currentDay.startName,
          endName: currentDay.endName,
          distanceKm: currentDay.distanceKm,
          ascentM: currentDay.ascentM,
          descentM: currentDay.descentM,
          estimatedHours: currentDay.estimatedHours,
          completedKm,
          remainingHours: estimateRemainingHours(
            completedKm,
            currentDay.distanceKm,
            currentDay.estimatedHours,
          ),
        };
      }
    }

    return {
      trailName: trail.config.name.toUpperCase(),
      direction,
      currentKm: km,
      totalKm: trail.track.totalDistance,
      nextCampsite: next.campsite
        ? {
            id: next.campsite.waypoint.id,
            name: next.campsite.waypoint.name,
            distance: formatDistance(next.campsite.trailDistanceKm),
            elevation: formatElevation(next.campsite),
            eta: formatEtaMinutes(next.campsite.etaMinutes),
            bearing: bearingTo(next.campsite),
          }
        : undefined,
      nextWater: next.water
        ? {
            id: next.water.waypoint.id,
            name: next.water.waypoint.name,
            distance: formatDistance(next.water.trailDistanceKm),
            eta: formatEtaMinutes(next.water.etaMinutes),
            bearing: bearingTo(next.water),
            note: descriptionFirstLine(next.water.waypoint.description),
          }
        : undefined,
      nextWaterKm: next.water?.trailDistanceKm,
      nextWaterEtaMinutes: next.water?.etaMinutes,
      nextTown: next.town
        ? {
            id: next.town.waypoint.id,
            name: next.town.waypoint.name,
            distance: formatDistance(next.town.trailDistanceKm),
            elevation: formatElevation(next.town),
            eta: formatEtaMinutes(next.town.etaMinutes),
          }
        : undefined,
      nextShelter: next.shelter
        ? {
            id: next.shelter.waypoint.id,
            name: next.shelter.waypoint.name,
            distance: formatDistance(next.shelter.trailDistanceKm),
            eta: formatEtaMinutes(next.shelter.etaMinutes),
          }
        : undefined,
      gpsCourse: raw
        ? { heading: raw.heading, speed: raw.speed, fixTimestamp: raw.timestamp }
        : undefined,
      today,
      upcoming: toUpcomingList(allDistances, 8),
    };
  }, [trail, currentKm, planDays, location]);

  const dashboardState = loading ? 'loading' : trail ? 'normal' : 'empty';
  const gpsState = accuracy === null ? 'searching' as const : accuracy > 100 ? 'degraded' as const : 'normal' as const;

  // Deep-link to the tapped waypoint: the map viewer opens its detail sheet
  // and pans to it via the focusWaypointId param.
  const openWaypointOnMap = useCallback((waypointId: string) => {
    if (activeTrailId) {
      router.push({
        pathname: '/trail/[id]',
        params: { id: activeTrailId, focusWaypointId: waypointId },
      });
    }
  }, [activeTrailId, router]);

  const handleWaypointSelect = useCallback((wp: WaypointListItem) => {
    openWaypointOnMap(String(wp.id));
  }, [openWaypointOnMap]);

  const handleAlertBannerPress = useCallback(() => {
    if (alertState === 'offTrail') {
      setShowSnoozeMenu(prev => !prev);
    } else if (alertState === 'warning') {
      // Dismiss the warning banner; the status bar stays amber
      setWarningDismissed(true);
    }
  }, [alertState]);

  const handleSnooze = useCallback((duration: SnoozeDuration) => {
    snooze(duration);
    setShowSnoozeMenu(false);
  }, [snooze]);

  // --- Mark my location (decision 4: write first, edit after) --------------
  // The GPS fix is the valuable part; a form that can be backgrounded or
  // abandoned must not lose it, so the row is inserted immediately and the
  // sheet opens as an edit of the already-persisted waypoint.

  const handleMarkLocation = useCallback(async () => {
    const raw = location?.raw;
    if (!raw || !trail || !activeTrailId) return;
    // Guard against a stale fix: after an app resume or GPS loss the last fix
    // can be hours old, so refuse to record a position we can't trust.
    const fixAgeMs = Date.now() - raw.timestamp;
    if (isFixStale(raw.timestamp)) return;
    if (markingRef.current) return;
    markingRef.current = true;
    try {
      // Snapped km in the active direction: prefer the live snap, fall back
      // to a direct nearest-point search against the loaded track.
      let activeKm = location.trailKm;
      let offTrackM = location.distanceFromTrail;
      if (activeKm == null) {
        const nearest = nearestTrackPointToLatLon(trail.track.points, raw.latitude, raw.longitude);
        activeKm = nearest ? trail.track.points[nearest.index].dist : 0;
        offTrackM = nearest?.distanceM ?? null;
      }
      const baseKm = isTrailReversed ? trail.track.totalDistance - activeKm : activeKm;

      const service = await TrailDataService.create();
      const row = await service.addCustomWaypoint({
        trailId: activeTrailId,
        name: markedWaypointName(),
        type: 'poi',
        lat: raw.latitude,
        lon: raw.longitude,
        ele: raw.altitude,
        kmPosition: baseKm,
        offTrackM,
        description: accuracyPreamble(accuracy, fixAgeMs),
      });
      setMarkedWaypoint(row);
      setMarkToastVisible(true);
      setMarkSheetOpen(true);
      setTrailRefreshKey(k => k + 1);
    } catch (e) {
      console.warn('Failed to mark location:', e);
      Alert.alert('Mark failed', 'Could not save your location. Please try again.');
    } finally {
      markingRef.current = false;
    }
  }, [location, accuracy, trail, activeTrailId, isTrailReversed]);

  const handleUndoMark = useCallback(async () => {
    const row = markedWaypoint;
    setMarkToastVisible(false);
    setMarkSheetOpen(false);
    setMarkedWaypoint(null);
    if (!row) return;
    try {
      const service = await TrailDataService.create();
      await service.deleteCustomWaypoint(row.id);
      deleteWaypointPhoto(row.photoUri);
      setTrailRefreshKey(k => k + 1);
    } catch (e) {
      console.warn('Failed to undo mark:', e);
    }
  }, [markedWaypoint]);

  const handleSaveMarked = useCallback(async (values: AddWaypointValues) => {
    const row = markedWaypoint;
    if (!row) return;
    setSavingMarked(true);
    try {
      const service = await TrailDataService.create();
      await service.updateCustomWaypoint(row.id, {
        name: values.name,
        type: values.type,
        description: values.description || null,
        photoUri: values.photoUri,
      });
      if (row.photoUri && row.photoUri !== values.photoUri) {
        deleteWaypointPhoto(row.photoUri);
      }
      setMarkSheetOpen(false);
      setMarkedWaypoint(null);
      setMarkToastVisible(false);
      setTrailRefreshKey(k => k + 1);
    } catch (e) {
      console.warn('Failed to save marked waypoint:', e);
      Alert.alert('Save failed', 'Could not save the waypoint. Please try again.');
    } finally {
      setSavingMarked(false);
    }
  }, [markedWaypoint]);

  const handleDismissMarkSheet = useCallback(() => {
    // Keeping the auto-named waypoint is fine — the fix was the point.
    setMarkSheetOpen(false);
  }, []);

  // No active trail — prompt user to select one
  if (!loading && !trail) {
    return (
      <View style={[styles.container, styles.emptyContainer, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No active trail</Text>
        <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
          Open a trail from the Plan tab to start tracking your hike.
        </Text>
      </View>
    );
  }

  const rawLocation = location?.raw;
  // The last fix is too old to mark (e.g. after an app resume or GPS loss).
  // Recomputed against nowMs so the button disables itself even while no new
  // fix arrives.
  const fixStale = !!rawLocation && isFixStale(rawLocation.timestamp, nowMs);
  const canMark = !!rawLocation && !fixStale;

  // Location failed to start (permission denied, provider error) and we have
  // no fix to fall back to — the "Searching for GPS" card would be a dead end.
  const showLocationError = !!locationError && !location;
  const permissionDenied = !!locationError && locationError.toLowerCase().includes('permission');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Location status bar — always visible when trail is loaded */}
      {trail && (
        <LocationStatusBar
          state={alertState}
          detail={showLocationError
            ? (permissionDenied ? 'Permission needed' : 'Location unavailable')
            : (activeProfile === 'saver'
                ? (alertDetail ? `${alertDetail} · Battery saver` : 'Battery saver')
                : alertDetail)}
        />
      )}

      {/* Snooze indicator — persistent while alerts are snoozed, tap to resume */}
      {trail && isSnoozed && snoozeUntil && (
        <Pressable
          onPress={clearSnooze}
          style={[styles.snoozeChip, { backgroundColor: colors.surface, borderColor: colors.alertAmber }]}
          accessibilityRole="button"
          accessibilityLabel={`Off-trail alerts snoozed until ${formatSnoozeTime(snoozeUntil)}. Tap to resume alerts.`}
        >
          <Text style={styles.snoozeChipIcon}>🔕</Text>
          <Text style={[styles.snoozeChipText, { color: colors.textPrimary }]}>
            Alerts snoozed until {formatSnoozeTime(snoozeUntil)} — tap to resume
          </Text>
        </Pressable>
      )}

      {/* Sunrise/sunset indicator */}
      {trail && rawLocation && (
        <View style={styles.sunriseRow}>
          <SunriseCountdown
            latitude={rawLocation.latitude}
            longitude={rawLocation.longitude}
          />
        </View>
      )}

      {/* Mark my location — the killer field action ("water here", "track
          washed out") is one tap from the dashboard. ≥56 pt target; enabled
          only with a GPS fix. */}
      {trail && !showLocationError && (
        <Pressable
          onPress={handleMarkLocation}
          disabled={!canMark}
          style={[
            styles.markButton,
            {
              backgroundColor: canMark ? colors.accent : colors.surface,
              borderColor: canMark ? colors.accent : colors.border,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Mark my location as a waypoint"
          accessibilityState={{ disabled: !canMark }}
        >
          <Text style={styles.markButtonIcon}>📍</Text>
          <Text
            style={[
              styles.markButtonText,
              { color: canMark ? colors.textInverse : colors.textSecondary },
            ]}
          >
            {canMark
              ? 'Mark my location'
              : fixStale
                ? 'Mark my location (GPS fix stale)'
                : 'Mark my location (waiting for GPS)'}
          </Text>
        </Pressable>
      )}

      {trail && showLocationError ? (
        /* Location error state — explain the problem and offer a way out
           instead of the eternal "Searching for GPS signal..." card */
        <View style={styles.locationErrorContainer}>
          <Text style={[styles.locationErrorTitle, { color: colors.textPrimary }]}>
            {permissionDenied ? 'Location permission needed' : 'GPS unavailable'}
          </Text>
          <Text style={[styles.locationErrorBody, { color: colors.textSecondary }]}>
            {permissionDenied
              ? "Trail Companion can't show distances or off-trail alerts without access to your location. Allow location access in your device settings, then retry."
              : `GPS tracking couldn't start: ${locationError}. Check that location services are enabled, then retry.`}
          </Text>
          <Pressable
            onPress={() => { Linking.openSettings().catch(() => {}); }}
            style={[styles.locationErrorButton, { backgroundColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Open device settings"
          >
            <Text style={[styles.locationErrorButtonText, { color: colors.textInverse }]}>
              Open Settings
            </Text>
          </Pressable>
          <Pressable
            onPress={() => { startTracking(); }}
            style={[styles.locationErrorButton, styles.locationErrorRetry, { borderColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Retry GPS tracking"
          >
            <Text style={[styles.locationErrorButtonText, { color: colors.accent }]}>
              Retry
            </Text>
          </Pressable>
        </View>
      ) : (
        <HikeDashboard
          data={dashboardData}
          state={dashboardState}
          gpsState={gpsState}
          onSeeAllWaypoints={() => {
            if (activeTrailId) router.push(`/trail/${activeTrailId}`);
          }}
          onWaypointSelect={handleWaypointSelect}
          onNextWaypointPress={openWaypointOnMap}
        />
      )}

      {activeTrailId && !showLocationError && (
        <View style={styles.datasheetRow}>
          {rawLocation && (
            <CoordinatesRow
              latitude={rawLocation.latitude}
              longitude={rawLocation.longitude}
              style={styles.coordinatesRow}
            />
          )}
          {/* Offline readiness — one honest line with a download affordance */}
          <OfflineReadinessRow trailId={activeTrailId} style={styles.offlineRow} />
          <Pressable
            onPress={() => {
              const km = currentKm ?? 0;
              router.push(`/trail/datasheet?id=${activeTrailId}&fromKm=${km}`);
            }}
            style={[styles.datasheetLink, { borderColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel="View trail datasheet"
          >
            <Text style={[styles.datasheetLinkText, { color: colors.accent }]}>Datasheet</Text>
          </Pressable>
        </View>
      )}

      {/* Off-trail / warning alert banner (slides down from top). Warning is
          dismissible (snooze-lite); off-trail opens the snooze menu. */}
      {trail && (
        <AlertBanner
          visible={alertState === 'offTrail' || (alertState === 'warning' && !warningDismissed)}
          level={alertState === 'offTrail' ? 'error' : 'warning'}
          message={
            alertState === 'offTrail'
              ? (alertDetail ? `Off trail — ${alertDetail}` : 'Off trail')
              : (alertDetail ? `Leaving trail — ${alertDetail} · tap to dismiss` : 'Leaving trail — tap to dismiss')
          }
          onPress={handleAlertBannerPress}
          onHidden={() => setShowSnoozeMenu(false)}
          accessibilityHint={
            alertState === 'offTrail' ? 'Tap to snooze alerts' : 'Tap to dismiss'
          }
          accessory={
            alertState === 'offTrail' && bearingToTrail != null && rawLocation ? (
              // Device-relative arrow back to the trail (upgrades the static
              // "head 247° WSW" text; degrades to cardinal text standing still)
              <BearingIndicator
                targetBearing={bearingToTrail}
                heading={rawLocation.heading}
                speed={rawLocation.speed}
                fixTimestamp={rawLocation.timestamp}
              />
            ) : undefined
          }
        />
      )}

      {/* Snooze menu — shown when off-trail banner is tapped */}
      {showSnoozeMenu && alertState === 'offTrail' && (
        <View style={[styles.snoozeMenu, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.snoozeTitle, { color: colors.textPrimary }]}>
            Snooze alerts for:
          </Text>
          {SNOOZE_OPTIONS.map(opt => (
            <Pressable
              key={opt.value}
              onPress={() => handleSnooze(opt.value)}
              style={[styles.snoozeOption, { borderTopColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel={`Snooze off-trail alerts for ${opt.label}`}
            >
              <Text style={[styles.snoozeOptionText, { color: colors.textPrimary }]}>
                {opt.label}
              </Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setShowSnoozeMenu(false)}
            style={[styles.snoozeOption, { borderTopColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Cancel snooze"
          >
            <Text style={[styles.snoozeOptionText, { color: colors.textSecondary }]}>
              Cancel
            </Text>
          </Pressable>
        </View>
      )}

      {/* Edit sheet for the just-marked waypoint (write-first-edit-after) */}
      <AddWaypointSheet
        isOpen={markSheetOpen && markedWaypoint != null}
        mode="edit"
        kmPosition={
          markedWaypoint && trail
            ? (isTrailReversed
                ? trail.track.totalDistance - markedWaypoint.kmPosition
                : markedWaypoint.kmPosition)
            : null
        }
        offTrackM={markedWaypoint?.offTrackM ?? null}
        initialValues={
          markedWaypoint
            ? {
                name: markedWaypoint.name,
                type: markedWaypoint.type,
                description: markedWaypoint.description ?? undefined,
                photoUri: markedWaypoint.photoUri,
              }
            : null
        }
        onDismiss={handleDismissMarkSheet}
        onSave={handleSaveMarked}
        saving={savingMarked}
      />

      {/* Undo toast for an accidental "Mark my location" tap */}
      <UndoToast
        visible={markToastVisible}
        message="Waypoint marked"
        onUndo={handleUndoMark}
        onDismiss={() => setMarkToastVisible(false)}
        durationMs={5000}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    ...typography.body,
    textAlign: 'center',
  },
  sunriseRow: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
  },
  markButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget.field,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    borderRadius: radii.lg,
    borderWidth: 1.5,
  },
  markButtonIcon: {
    fontSize: 18,
  },
  markButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  snoozeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: touchTarget.min,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1.5,
  },
  snoozeChipIcon: {
    fontSize: 14,
  },
  snoozeChipText: {
    ...typography.caption,
    fontWeight: '600',
  },
  locationErrorContainer: {
    flex: 1,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  locationErrorTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  locationErrorBody: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.xl,
  },
  locationErrorButton: {
    minHeight: touchTarget.min,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  locationErrorRetry: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
  },
  locationErrorButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  datasheetRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  coordinatesRow: {
    marginBottom: spacing.sm,
  },
  offlineRow: {
    marginBottom: spacing.sm,
  },
  datasheetLink: {
    borderRadius: radii.lg,
    borderWidth: 1.5,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  datasheetLinkText: {
    ...typography.caption,
    fontWeight: '700',
  },
  snoozeMenu: {
    position: 'absolute',
    top: 80,
    left: spacing.lg,
    right: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    zIndex: 200,
    overflow: 'hidden',
  },
  snoozeTitle: {
    ...typography.caption,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  snoozeOption: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  snoozeOptionText: {
    ...typography.body,
  },
});
