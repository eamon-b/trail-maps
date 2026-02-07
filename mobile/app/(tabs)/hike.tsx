import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View, Text } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme';
import { HikeDashboard, type DashboardData } from '../../src/components';
import type { WaypointListItem } from '../../src/components/WaypointList';
import { useLocation } from '../../src/hooks/useLocation';
import { TrailDataService } from '../../src/services/trail-data-service';
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
import { ACTIVE_TRAIL_KEY } from '../trail/[id]';
import { spacing } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const DIRECTION_PREF_KEY = 'trail_direction_prefs';

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

export default function HikeScreen() {
  const { colors } = useTheme();
  const router = useRouter();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [activeTrailId, setActiveTrailId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const trackPoints = useMemo(() => trail?.track.points ?? [], [trail]);
  const { location, accuracy } = useLocation(trackPoints);

  const currentKm = location?.trailKm ?? null;

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
        const json = service.getTrailTrackData(trailId);
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
        setLoading(false);
      } catch {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Build dashboard data from real trail + GPS
  const dashboardData = useMemo((): DashboardData | null => {
    if (!trail) return null;

    const waypoints = trail.waypoints ?? [];
    const km = currentKm ?? 0;
    const dirConfig = trail.config.direction;
    const direction = dirConfig ? dirConfig.default : 'Default';

    const next = getNextWaypointsByType(km, waypoints, trail.track.points);
    const allDistances = calculateDistancesToWaypoints(km, waypoints, trail.track.points);

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
      nextTown: next.town
        ? { name: next.town.waypoint.name, distance: formatDistance(next.town.trailDistanceKm), elevation: formatElevation(next.town) }
        : undefined,
      nextShelter: next.shelter
        ? { name: next.shelter.waypoint.name, distance: formatDistance(next.shelter.trailDistanceKm) }
        : undefined,
      upcoming: toUpcomingList(allDistances, 8),
    };
  }, [trail, currentKm]);

  const dashboardState = loading ? 'loading' : trail ? 'normal' : 'empty';
  const gpsState = (accuracy ?? 0) > 100 ? 'degraded' as const : 'normal' as const;

  const handleWaypointSelect = useCallback((wp: WaypointListItem) => {
    if (activeTrailId) {
      router.push(`/trail/${activeTrailId}`);
    }
  }, [activeTrailId, router]);

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

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <HikeDashboard
        data={dashboardData}
        state={dashboardState}
        gpsState={gpsState}
        onSeeAllWaypoints={() => {
          if (activeTrailId) router.push(`/trail/${activeTrailId}`);
        }}
        onWaypointSelect={handleWaypointSelect}
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
});
