import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailMap } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { ScreenHeader } from '../../src/components/ScreenHeader';
import { PlanService } from '../../src/services/plan-service';
import { TrailDataService } from '../../src/services/trail-data-service';
import { createReversedTrail, findNearestByDistance, type Trail } from '../../src/lib/trail-utils';
import type { StopData } from '../../src/services/plan-calculator-types';
import { generateId, migrateStopsJson } from '../../src/services/plan-utils';
import {
  parsePickerRequest,
  buildSinglePointResultParams,
  type PickerRequest,
} from '../../src/lib/point-picker-contract';
import { spacing } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/**
 * MapPointPicker — the single map-picking screen (decision 6 of the P2 plan),
 * merging the old plan/map.tsx and plan/section-map.tsx.
 *
 * Modes (see src/lib/point-picker-contract.ts):
 * - 'add'      — long-press to add a plan stop; persists and goes back
 * - 'relocate' — long-press to move an existing stop; persists and goes back
 * - 'day'      — day segment highlighted; long-press adds a stop
 * - 'section'  — two-tap start/end range; Apply persists the plan section
 * - 'single'   — one point; Apply returns it to `returnTo` using the typed
 *                pickerRequestId/pickerResultId contract
 */

/**
 * Find the nearest waypoint to a given km position.
 * Returns the name and type if one is within maxDistKm, otherwise defaults.
 */
function findNearestWaypoint(
  trail: Trail,
  km: number,
  maxDistKm = 0.5,
): { name: string | null; type: string } {
  let bestName: string | null = null;
  let bestType = 'campsite';
  let bestDist = Infinity;
  for (const wp of trail.waypoints) {
    const wpKm = wp.totalDistance ?? 0;
    const d = Math.abs(wpKm - km);
    if (d < bestDist && d <= maxDistKm) {
      bestDist = d;
      bestName = wp.name;
      bestType = wp.type;
    }
  }
  return { name: bestName, type: bestType };
}

const MODE_TITLES: Record<PickerRequest['mode'], string> = {
  add: 'Add Stop',
  relocate: 'Move Stop',
  day: 'Day View',
  section: 'Select Section',
  single: 'Select Point',
};

export default function MapPointPickerScreen() {
  const params = useLocalSearchParams<Record<string, string>>();
  const request = useMemo(() => parsePickerRequest(params), [params]);
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const planServiceRef = useRef<PlanService | null>(null);

  const [trail, setTrail] = useState<Trail | null>(null);
  const [stops, setStops] = useState<StopData[]>([]);
  const [loading, setLoading] = useState(true);

  // Section-mode selection
  const [startKm, setStartKm] = useState<number | null>(request?.currentStartKm ?? null);
  const [endKm, setEndKm] = useState<number | null>(request?.currentEndKm ?? null);
  const [startName, setStartName] = useState<string | null>(null);
  const [endName, setEndName] = useState<string | null>(null);

  // Single-mode selection
  const [selectedKm, setSelectedKm] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  const mode = request?.mode;

  // Load trail (and plan stops when a plan is involved)
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!request) {
        setLoading(false);
        return;
      }
      try {
        let direction = request.direction ?? null;
        if (request.planId) {
          const planService = await PlanService.create();
          planServiceRef.current = planService;
          const plan = await planService.getPlan(request.planId);
          if (!plan) {
            Alert.alert('Error', 'Plan not found');
            router.back();
            return;
          }
          direction = direction ?? plan.direction;
          if (!cancelled) setStops(migrateStopsJson(plan.stopsJson));
        }

        const trailService = await TrailDataService.create();
        let parsed = await trailService.getMergedTrail(request.trailId);
        if (!parsed) {
          Alert.alert('Error', 'Trail data not found');
          router.back();
          return;
        }
        if (direction === 'SOBO') {
          parsed = createReversedTrail(parsed);
        }
        if (!cancelled) setTrail(parsed);
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
    // The request is stable for the lifetime of this screen instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.trailId, request?.planId, request?.direction, router]);

  // Find nearest waypoint name for a km position (labels for pins/chips)
  const findNearestName = useCallback(
    (km: number): string => {
      if (!trail) return `km ${km.toFixed(1)}`;
      const nearest = findNearestWaypoint(trail, km);
      return nearest.name ?? `km ${km.toFixed(1)}`;
    },
    [trail],
  );

  // ---------------------------------------------------------------------
  // Stop persistence (add / relocate / day modes)
  // ---------------------------------------------------------------------

  const persistStops = useCallback(async (updatedStops: StopData[]) => {
    if (!request?.planId) return;
    const service = planServiceRef.current ?? await PlanService.create();
    await service.updatePlan(request.planId, { stopsJson: JSON.stringify(updatedStops) });
  }, [request?.planId]);

  const confirmMoveStop = useCallback((km: number, coordinate: { latitude: number; longitude: number }) => {
    if (!trail || !request?.stopId) return;
    Alert.alert('Move stop', `Move stop to km ${km.toFixed(1)}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Move',
        onPress: async () => {
          const nearest = findNearestWaypoint(trail, km);
          const updatedStops = stops.map((s) => {
            if (s.id !== request.stopId) return s;
            if (nearest.name) {
              return {
                ...s,
                km,
                waypointName: nearest.name,
                waypointType: nearest.type,
                customLocation: undefined,
              };
            }
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
          updatedStops.sort((a, b) => a.km - b.km);
          try {
            await persistStops(updatedStops);
            router.back();
          } catch {
            Alert.alert('Error', 'Failed to save stop location');
          }
        },
      },
    ]);
  }, [trail, request?.stopId, stops, persistStops, router]);

  const confirmAddStop = useCallback((km: number, coordinate: { latitude: number; longitude: number }) => {
    if (!trail) return;
    Alert.alert('Add stop', `Add stop at km ${km.toFixed(1)}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Add',
        onPress: async () => {
          const nearest = findNearestWaypoint(trail, km);
          const newStop: StopData = {
            id: generateId(),
            waypointName: nearest.name,
            waypointType: nearest.type,
            km,
            customLocation: nearest.name
              ? undefined
              : {
                  lat: coordinate.latitude,
                  lon: coordinate.longitude,
                  name: `km ${km.toFixed(1)}`,
                },
          };
          const updatedStops = [...stops];
          const idx = updatedStops.findIndex((s) => s.km > newStop.km);
          if (idx === -1) updatedStops.push(newStop);
          else updatedStops.splice(idx, 0, newStop);
          try {
            await persistStops(updatedStops);
            router.back();
          } catch {
            Alert.alert('Error', 'Failed to save new stop');
          }
        },
      },
    ]);
  }, [trail, stops, persistStops, router]);

  // ---------------------------------------------------------------------
  // Long-press dispatch per mode
  // ---------------------------------------------------------------------

  const handleLongPress = useCallback(
    (coordinate: { latitude: number; longitude: number; nearestKm: number }) => {
      if (!trail || !mode) return;
      const km = Math.round(coordinate.nearestKm * 10) / 10;

      switch (mode) {
        case 'single': {
          setSelectedKm(km);
          setSelectedName(findNearestName(km));
          return;
        }
        case 'section': {
          const name = findNearestName(km);
          if (startKm === null) {
            setStartKm(km);
            setStartName(name);
          } else if (endKm === null) {
            if (km < startKm) {
              setEndKm(startKm);
              setEndName(startName);
              setStartKm(km);
              setStartName(name);
            } else {
              setEndKm(km);
              setEndName(name);
            }
          } else {
            // Both set — reset with this tap as new start
            setStartKm(km);
            setStartName(name);
            setEndKm(null);
            setEndName(null);
          }
          return;
        }
        case 'relocate':
          confirmMoveStop(km, coordinate);
          return;
        case 'add':
        case 'day':
          confirmAddStop(km, coordinate);
          return;
      }
    },
    [trail, mode, startKm, endKm, startName, findNearestName, confirmMoveStop, confirmAddStop],
  );

  // ---------------------------------------------------------------------
  // Apply (section persists; single returns via the typed contract)
  // ---------------------------------------------------------------------

  const handleApply = useCallback(async () => {
    if (!request) return;
    if (request.mode === 'section' && startKm !== null && endKm !== null && request.planId) {
      const sectionConfig = {
        startKm,
        endKm,
        startName: startName ?? `km ${startKm.toFixed(1)}`,
        endName: endName ?? `km ${endKm.toFixed(1)}`,
      };
      try {
        const service = planServiceRef.current ?? await PlanService.create();
        await service.updatePlan(request.planId, { sectionJson: JSON.stringify(sectionConfig) });
      } catch (e) {
        console.warn('Failed to persist section from map:', e);
      }
      router.back();
      return;
    }

    if (request.mode === 'single' && selectedKm !== null && request.returnTo && request.pickerRequestId) {
      router.navigate({
        // Caller-supplied route (e.g. '/plan/measure'); params carry the result
        pathname: request.returnTo as never,
        params: {
          trailId: request.trailId,
          ...buildSinglePointResultParams(request.pickerRequestId, {
            target: request.target ?? 'start',
            km: selectedKm,
            name: selectedName ?? `km ${selectedKm.toFixed(1)}`,
          }),
        },
      });
    }
  }, [request, startKm, endKm, startName, endName, selectedKm, selectedName, router]);

  const canApply =
    (mode === 'single' && selectedKm !== null) ||
    (mode === 'section' && startKm !== null && endKm !== null);
  const showApply = mode === 'single' || mode === 'section';

  // ---------------------------------------------------------------------
  // Map decoration
  // ---------------------------------------------------------------------

  const customPins = useMemo(() => {
    if (!trail || !mode) return [];
    const pins: { latitude: number; longitude: number; label: string; color: string }[] = [];
    const points = trail.track.points;
    const findCoords = (km: number) => {
      const bestIdx = findNearestByDistance(points, km);
      return { latitude: points[bestIdx].lat, longitude: points[bestIdx].lon };
    };

    // Plan stops (add/relocate/day modes)
    if (mode === 'add' || mode === 'relocate' || mode === 'day') {
      for (const stop of stops) {
        const isTargetStop = mode === 'relocate' && stop.id === request?.stopId;
        let lat = 0;
        let lon = 0;
        if (stop.customLocation) {
          lat = stop.customLocation.lat;
          lon = stop.customLocation.lon;
        } else {
          const coords = findCoords(stop.km);
          lat = coords.latitude;
          lon = coords.longitude;
        }
        const label = stop.customLocation?.name ?? stop.waypointName ?? `km ${stop.km.toFixed(1)}`;
        pins.push({
          latitude: lat,
          longitude: lon,
          label,
          color: isTargetStop ? colors.alertRed : colors.alertGreen,
        });
      }
    }

    if (mode === 'single' && selectedKm !== null) {
      pins.push({
        ...findCoords(selectedKm),
        label: selectedName ?? `km ${selectedKm.toFixed(1)}`,
        color: colors.alertGreen,
      });
    }

    if (mode === 'section') {
      if (startKm !== null) {
        pins.push({
          ...findCoords(startKm),
          label: `Start: ${startName ?? `km ${startKm.toFixed(1)}`}`,
          color: colors.alertGreen,
        });
      }
      if (endKm !== null) {
        pins.push({
          ...findCoords(endKm),
          label: `End: ${endName ?? `km ${endKm.toFixed(1)}`}`,
          color: colors.alertRed,
        });
      }
    }

    return pins;
  }, [trail, mode, stops, request?.stopId, startKm, endKm, startName, endName, selectedKm, selectedName, colors]);

  const highlightedSegment = useMemo(() => {
    if (mode === 'day' && request?.highlightStartKm != null && request?.highlightEndKm != null) {
      return { startKm: request.highlightStartKm, endKm: request.highlightEndKm };
    }
    if (mode === 'section' && startKm !== null && endKm !== null) {
      return { startKm, endKm };
    }
    if (mode === 'relocate' && request?.currentKm != null && trail) {
      const margin = 5; // 5 km on either side
      return {
        startKm: Math.max(0, request.currentKm - margin),
        endKm: Math.min(trail.track.totalDistance, request.currentKm + margin),
      };
    }
    return null;
  }, [mode, request?.highlightStartKm, request?.highlightEndKm, request?.currentKm, startKm, endKm, trail]);

  const instructionText = useMemo(() => {
    switch (mode) {
      case 'single':
        return selectedKm !== null
          ? `Selected: ${selectedName ?? `km ${selectedKm.toFixed(1)}`}`
          : 'Long-press the trail to select a point';
      case 'section':
        if (startKm === null) return 'Long-press the trail to set the start point';
        if (endKm === null) return `Start: ${startName ?? `km ${startKm.toFixed(1)}`} — now set the end point`;
        return `${startName ?? `km ${startKm.toFixed(1)}`} → ${endName ?? `km ${endKm.toFixed(1)}`}`;
      case 'relocate':
        return 'Long-press the trail to move this stop';
      case 'day':
        return 'Long-press the trail to add a new stop';
      default:
        return 'Long-press the trail to place a new stop';
    }
  }, [mode, startKm, endKm, startName, endName, selectedKm, selectedName]);

  const title = mode === 'day'
    ? (request?.dayLabel ?? MODE_TITLES.day)
    : (mode ? MODE_TITLES[mode] : 'Map');

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (!trail || !request) {
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
      <MapErrorBoundary>
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
      </MapErrorBoundary>

      {/* Header overlay */}
      <View style={styles.headerOverlay}>
        <ScreenHeader
          title={title}
          onBack={() => router.back()}
          backLabel="Cancel"
          variant="surface"
          rightAction={showApply ? {
            label: 'Apply',
            onPress: handleApply,
            disabled: !canApply,
            accessibilityLabel: 'Apply selection',
          } : undefined}
        />
      </View>

      {/* Instruction chip at bottom */}
      <View style={[styles.instructionContainer, { bottom: insets.bottom + spacing.lg }]}>
        <View style={[styles.instructionChip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.instructionText, { color: colors.textPrimary }]}>
            {instructionText}
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
