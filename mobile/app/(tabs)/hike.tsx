import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View, Text, Pressable } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme';
import { HikeDashboard, type DashboardData } from '../../src/components';
import { LocationStatusBar } from '../../src/components/LocationStatusBar';
import { AlertBanner } from '../../src/components/AlertBanner';
import { SunriseCountdown } from '../../src/components/SunriseCountdown';
import type { WaypointListItem } from '../../src/components/WaypointList';
import { useLocation } from '../../src/hooks/useLocation';
import { useOffTrailAlert } from '../../src/hooks/useOffTrailAlert';
import { triggerLocationHaptic } from '../../src/components/haptics';
import { TrailDataService } from '../../src/services/trail-data-service';
import { PlanService, type Plan } from '../../src/services/plan-service';
import {
  trailJsonToTrail,
  createReversedTrail,
  type Trail,
} from '../../src/lib/trail-utils';
import {
  getNextWaypointsByType,
  calculateDistancesToWaypoints,
  type WaypointDistance,
} from '../../src/services/distance-calculator';
import { computeDays } from '../../src/services/day-calculator';
import type { StopData, ComputedDay } from '../../src/services/plan-calculator-types';
import { ACTIVE_TRAIL_KEY } from '../trail/[id]';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';
import type { LocationState } from '../../src/components/LocationStatusBar';
import type { SnoozeDuration } from '../../src/services/off-trail-alert-service';

const DIRECTION_PREF_KEY = 'trail_direction_prefs';

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
  return distances.slice(0, limit).map((wd, i) => ({
    id: `${i}-${wd.waypoint.name}`,
    name: wd.waypoint.name,
    type: wd.waypoint.type,
    distanceAhead: formatDistance(wd.trailDistanceKm),
  }));
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

  const trackPoints = useMemo(() => trail?.track.points ?? [], [trail]);
  const { location, accuracy } = useLocation(trackPoints);

  const currentKm = location?.trailKm ?? null;

  // Off-trail alert with debouncing and snooze
  const { alertState, alertDetail, isSnoozed, snooze, clearSnooze } = useOffTrailAlert(
    location,
    accuracy,
    trackPoints,
    { thresholdPreset: 'normal', enabled: !!trail },
  );

  // Haptic feedback when state escalates to warning or offTrail
  const prevAlertState = useRef<LocationState>('noGps');
  useEffect(() => {
    const prev = prevAlertState.current;
    prevAlertState.current = alertState;
    if (alertState !== prev && (alertState === 'warning' || alertState === 'offTrail')) {
      triggerLocationHaptic(alertState);
    }
  }, [alertState]);

  // Load the active trail
  useEffect(() => {
    async function load() {
      try {
        const trailId = await AsyncStorage.getItem(ACTIVE_TRAIL_KEY);
        if (!trailId) {
          setLoading(false);
          return;
        }
        setActiveTrailId(trailId);

        const service = await TrailDataService.create();
        const json = await service.getTrailTrackData(trailId);
        if (!json) {
          setLoading(false);
          return;
        }

        let parsed = trailJsonToTrail(json);

        // Respect saved direction preference
        const prefsStr = await AsyncStorage.getItem(DIRECTION_PREF_KEY);
        const prefs = prefsStr ? JSON.parse(prefsStr) : {};
        if (prefs[trailId]) {
          parsed = createReversedTrail(parsed);
        }

        setTrail(parsed);

        // Load active plan for this trail
        try {
          const planService = await PlanService.create();
          const plan = await planService.getActivePlanForTrail(trailId);
          setActivePlan(plan);
        } catch {
          // No plan — that's fine
        }

        setLoading(false);
      } catch {
        setLoading(false);
      }
    }
    load();
  }, []);

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

    const next = getNextWaypointsByType(km, waypoints, trail.track.points);
    const allDistances = calculateDistancesToWaypoints(km, waypoints, trail.track.points);

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
        ? { name: next.campsite.waypoint.name, distance: formatDistance(next.campsite.trailDistanceKm), elevation: formatElevation(next.campsite) }
        : undefined,
      nextWater: next.water
        ? { name: next.water.waypoint.name, distance: formatDistance(next.water.trailDistanceKm) }
        : undefined,
      nextWaterKm: next.water?.trailDistanceKm,
      nextTown: next.town
        ? { name: next.town.waypoint.name, distance: formatDistance(next.town.trailDistanceKm), elevation: formatElevation(next.town) }
        : undefined,
      nextShelter: next.shelter
        ? { name: next.shelter.waypoint.name, distance: formatDistance(next.shelter.trailDistanceKm) }
        : undefined,
      today,
      upcoming: toUpcomingList(allDistances, 8),
    };
  }, [trail, currentKm, planDays]);

  const dashboardState = loading ? 'loading' : trail ? 'normal' : 'empty';
  const gpsState = (accuracy ?? 0) > 100 ? 'degraded' as const : 'normal' as const;

  const handleWaypointSelect = useCallback((wp: WaypointListItem) => {
    if (activeTrailId) {
      router.push(`/trail/${activeTrailId}`);
    }
  }, [activeTrailId, router]);

  const handleAlertBannerPress = useCallback(() => {
    if (alertState === 'offTrail') {
      setShowSnoozeMenu(prev => !prev);
    }
  }, [alertState]);

  const handleSnooze = useCallback((duration: SnoozeDuration) => {
    snooze(duration);
    setShowSnoozeMenu(false);
  }, [snooze]);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Location status bar — always visible when trail is loaded */}
      {trail && (
        <LocationStatusBar
          state={alertState}
          detail={alertDetail}
        />
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

      <HikeDashboard
        data={dashboardData}
        state={dashboardState}
        gpsState={gpsState}
        onSeeAllWaypoints={() => {
          if (activeTrailId) router.push(`/trail/${activeTrailId}`);
        }}
        onWaypointSelect={handleWaypointSelect}
      />

      {activeTrailId && (
        <View style={styles.datasheetRow}>
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

      {/* Off-trail alert banner (slides down from top) */}
      {trail && (
        <AlertBanner
          visible={alertState === 'offTrail' && !isSnoozed}
          level="error"
          message={alertDetail ? `Off trail — ${alertDetail}` : 'Off trail'}
          onHidden={() => setShowSnoozeMenu(false)}
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
  datasheetRow: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  datasheetLink: {
    borderRadius: radii.lg,
    borderWidth: 1.5,
    paddingVertical: spacing.sm,
    alignItems: 'center',
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
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  snoozeOptionText: {
    ...typography.body,
  },
});
