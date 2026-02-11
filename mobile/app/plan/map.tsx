import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, Pressable, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailMap } from '../../src/components/TrailMap';
import { PlanService } from '../../src/services/plan-service';
import { TrailDataService } from '../../src/services/trail-data-service';
import { trailJsonToTrail, createReversedTrail, type Trail } from '../../src/lib/trail-utils';
import type { StopData } from '../../src/services/plan-calculator-types';
import { generateId, migrateStopsJson } from '../../src/services/plan-utils';
import { spacing, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/**
 * Find the nearest waypoint to a given km position.
 * Returns the waypoint name if one is within 0.5 km, otherwise null.
 */
function findNearestWaypointName(
  trail: Trail,
  km: number,
  maxDistKm = 0.5,
): string | null {
  let bestName: string | null = null;
  let bestDist = Infinity;
  for (const wp of trail.waypoints) {
    const wpKm = wp.totalDistance ?? 0;
    const d = Math.abs(wpKm - km);
    if (d < bestDist && d <= maxDistKm) {
      bestDist = d;
      bestName = wp.name;
    }
  }
  return bestName;
}

/**
 * Find the nearest waypoint type for a given km position.
 * Returns the type if one is within 0.5 km, otherwise 'campsite' as default.
 */
function findNearestWaypointType(
  trail: Trail,
  km: number,
  maxDistKm = 0.5,
): string {
  let bestType = 'campsite';
  let bestDist = Infinity;
  for (const wp of trail.waypoints) {
    const wpKm = wp.totalDistance ?? 0;
    const d = Math.abs(wpKm - km);
    if (d < bestDist && d <= maxDistKm) {
      bestDist = d;
      bestType = wp.type;
    }
  }
  return bestType;
}

export default function PlanMapScreen() {
  const {
    trailId,
    planId,
    stopId,
    currentKm: currentKmParam,
    highlightStartKm: highlightStartParam,
    highlightEndKm: highlightEndParam,
    dayLabel,
  } = useLocalSearchParams<{
      trailId: string;
      planId: string;
      stopId?: string;
      currentKm?: string;
      highlightStartKm?: string;
      highlightEndKm?: string;
      dayLabel?: string;
    }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [stops, setStops] = useState<StopData[]>([]);
  const [loading, setLoading] = useState(true);

  const planServiceRef = useRef<PlanService | null>(null);

  const isRelocationMode = !!stopId;
  const isDayViewMode = !!highlightStartParam && !!highlightEndParam;
  const initialKm = currentKmParam ? parseFloat(currentKmParam) : undefined;

  // Load trail data and plan stops
  useEffect(() => {
    async function load() {
      if (!trailId || !planId) return;
      try {
        const planService = await PlanService.create();
        planServiceRef.current = planService;
        const plan = await planService.getPlan(planId);
        if (!plan) {
          Alert.alert('Error', 'Plan not found');
          router.back();
          return;
        }

        const trailService = await TrailDataService.create();
        const json = trailService.getTrailTrackData(trailId);
        if (!json) {
          Alert.alert('Error', 'Trail data not found');
          router.back();
          return;
        }

        let parsed = trailJsonToTrail(json);
        if (plan.direction === 'SOBO') {
          parsed = createReversedTrail(parsed);
        }
        setTrail(parsed);

        const parsedStops = migrateStopsJson(plan.stopsJson);
        setStops(parsedStops);

        setLoading(false);
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Failed to load data');
        setLoading(false);
      }
    }
    load();
  }, [trailId, planId, router]);

  // Build custom pins from stops
  const customPins = useMemo(() => {
    if (!trail) return [];
    return stops.map((stop) => {
      const isTargetStop = isRelocationMode && stop.id === stopId;
      // Find coordinates for this stop's km position
      let lat = 0;
      let lon = 0;
      if (stop.customLocation) {
        lat = stop.customLocation.lat;
        lon = stop.customLocation.lon;
      } else {
        // Find nearest track point for this km
        const points = trail.track.points;
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < points.length; i++) {
          const d = Math.abs(points[i].dist - stop.km);
          if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
          }
        }
        lat = points[bestIdx].lat;
        lon = points[bestIdx].lon;
      }
      const label = stop.customLocation?.name ?? stop.waypointName ?? `km ${stop.km.toFixed(1)}`;
      return {
        latitude: lat,
        longitude: lon,
        label,
        color: isTargetStop ? '#FF5722' : '#4CAF50',
      };
    });
  }, [trail, stops, isRelocationMode, stopId]);

  // Highlighted segment — day view or stop relocation
  const highlightedSegment = useMemo(() => {
    if (isDayViewMode) {
      return {
        startKm: parseFloat(highlightStartParam!),
        endKm: parseFloat(highlightEndParam!),
      };
    }
    if (!isRelocationMode || initialKm == null || !trail) return null;
    const margin = 5; // 5 km on either side
    return {
      startKm: Math.max(0, initialKm - margin),
      endKm: Math.min(trail.track.totalDistance, initialKm + margin),
    };
  }, [isDayViewMode, highlightStartParam, highlightEndParam, isRelocationMode, initialKm, trail]);

  // Handle long press on map
  const handleLongPress = useCallback(
    (coordinate: { latitude: number; longitude: number; nearestKm: number }) => {
      if (!trail || !planId) return;

      const km = Math.round(coordinate.nearestKm * 10) / 10;

      if (isRelocationMode) {
        Alert.alert(
          'Move stop',
          `Move stop to km ${km.toFixed(1)}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Move',
              onPress: async () => {
                const nearestName = findNearestWaypointName(trail, km);
                const nearestType = findNearestWaypointType(trail, km);

                const updatedStops = stops.map((s) => {
                  if (s.id !== stopId) return s;
                  if (nearestName) {
                    // Snap to nearest waypoint
                    return {
                      ...s,
                      km,
                      waypointName: nearestName,
                      waypointType: nearestType,
                      customLocation: undefined,
                    };
                  }
                  // Custom location on trail
                  return {
                    ...s,
                    km,
                    waypointName: null,
                    waypointType: 'campsite',
                    customLocation: {
                      lat: coordinate.latitude,
                      lon: coordinate.longitude,
                      name: `km ${km.toFixed(1)}`,
                    },
                  };
                });

                // Re-sort by km after relocation
                updatedStops.sort((a, b) => a.km - b.km);

                try {
                  const service = planServiceRef.current ?? await PlanService.create();
                  await service.updatePlan(planId, {
                    stopsJson: JSON.stringify(updatedStops),
                  });
                  router.back();
                } catch {
                  Alert.alert('Error', 'Failed to save stop location');
                }
              },
            },
          ],
        );
      } else {
        Alert.alert(
          'Add stop',
          `Add stop at km ${km.toFixed(1)}?`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Add',
              onPress: async () => {
                const nearestName = findNearestWaypointName(trail, km);
                const nearestType = findNearestWaypointType(trail, km);

                const newStop: StopData = {
                  id: generateId(),
                  waypointName: nearestName,
                  waypointType: nearestType,
                  km,
                  customLocation: nearestName
                    ? undefined
                    : {
                        lat: coordinate.latitude,
                        lon: coordinate.longitude,
                        name: `km ${km.toFixed(1)}`,
                      },
                };

                // Insert in sorted order
                const updatedStops = [...stops];
                const idx = updatedStops.findIndex((s) => s.km > newStop.km);
                if (idx === -1) {
                  updatedStops.push(newStop);
                } else {
                  updatedStops.splice(idx, 0, newStop);
                }

                try {
                  const service = planServiceRef.current ?? await PlanService.create();
                  await service.updatePlan(planId, {
                    stopsJson: JSON.stringify(updatedStops),
                  });
                  router.back();
                } catch {
                  Alert.alert('Error', 'Failed to save new stop');
                }
              },
            },
          ],
        );
      }
    },
    [trail, planId, stops, stopId, isRelocationMode, router],
  );

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!trail) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.errorText, { color: colors.textSecondary }]}>
          Trail data unavailable
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Full-screen map */}
      <TrailMap
        displayPoints={trail.track.displayPoints ?? trail.track.points}
        trackPoints={trail.track.points}
        waypoints={trail.waypoints}
        alternates={trail.alternates}
        sideTrips={trail.sideTrips}
        customPins={customPins}
        highlightedSegment={highlightedSegment}
        onLongPress={handleLongPress}
      />

      {/* Header overlay */}
      <View style={[styles.headerOverlay, { paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface }]}>
          <Pressable
            onPress={() => router.back()}
            style={styles.cancelButton}
            accessibilityLabel="Cancel"
            accessibilityRole="button"
          >
            <Text style={[styles.cancelText, { color: colors.accent }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
            {isRelocationMode ? 'Move Stop' : isDayViewMode ? (dayLabel ?? 'Day View') : 'Add Stop'}
          </Text>
          <View style={styles.cancelButton} />
        </View>
      </View>

      {/* Instruction chip at bottom */}
      <View style={[styles.instructionContainer, { bottom: insets.bottom + spacing.lg }]}>
        <View style={[styles.instructionChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.instructionText, { color: colors.textPrimary }]}>
            {isRelocationMode
              ? 'Long-press the trail to move this stop'
              : isDayViewMode
                ? 'Long-press the trail to add a new stop'
                : 'Long-press the trail to place a new stop'}
          </Text>
        </View>
      </View>
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
  },
  errorText: {
    ...typography.body,
    textAlign: 'center',
  },
  headerOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  cancelButton: {
    minWidth: 60,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  cancelText: {
    ...typography.body,
    fontWeight: '600',
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
    textAlign: 'center',
  },
  instructionContainer: {
    position: 'absolute',
    left: spacing.lg,
    right: spacing.lg,
    alignItems: 'center',
  },
  instructionChip: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 2,
    elevation: 3,
  },
  instructionText: {
    ...typography.caption,
    fontWeight: '600',
    textAlign: 'center',
  },
});
