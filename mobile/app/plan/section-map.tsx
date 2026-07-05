import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text, Pressable, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailMap } from '../../src/components/TrailMap';
import { MapErrorBoundary } from '../../src/components/MapErrorBoundary';
import { PlanService } from '../../src/services/plan-service';
import { TrailDataService } from '../../src/services/trail-data-service';
import { createReversedTrail, findNearestByDistance, type Trail } from '../../src/lib/trail-utils';
import { spacing, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

/**
 * Map screen for selecting points on the trail.
 *
 * Modes:
 * - "section": Two-tap workflow — first tap sets start, second tap sets end.
 *   Persists section to the plan's sectionJson on Apply.
 * - "single": Single-tap workflow — tap to select one point.
 *   Persists selected km to plan's measureJson (a transient field read by parent).
 */
export default function SectionMapScreen() {
  const {
    trailId,
    planId,
    direction,
    mode: modeParam,
    currentStartKm,
    currentEndKm,
    // For single-point mode: which picker target (start/end) and return path
    target,
  } = useLocalSearchParams<{
    trailId: string;
    planId?: string;
    direction?: string;
    mode?: string;
    currentStartKm?: string;
    currentEndKm?: string;
    target?: string;
  }>();

  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const planServiceRef = useRef<PlanService | null>(null);

  const mode = modeParam === 'single' ? 'single' : 'section';

  const [trail, setTrail] = useState<Trail | null>(null);
  const [loading, setLoading] = useState(true);

  // Selected points (section mode)
  const [startKm, setStartKm] = useState<number | null>(
    currentStartKm ? parseFloat(currentStartKm) : null,
  );
  const [endKm, setEndKm] = useState<number | null>(
    currentEndKm ? parseFloat(currentEndKm) : null,
  );
  const [startName, setStartName] = useState<string | null>(null);
  const [endName, setEndName] = useState<string | null>(null);

  // Selected point (single mode)
  const [selectedKm, setSelectedKm] = useState<number | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);

  // Load trail data
  useEffect(() => {
    async function load() {
      if (!trailId) return;
      try {
        const trailService = await TrailDataService.create();
        let parsed = await trailService.getMergedTrail(trailId);
        if (!parsed) {
          setLoading(false);
          return;
        }
        if (direction === 'SOBO') {
          parsed = createReversedTrail(parsed);
        }
        setTrail(parsed);

        if (planId) {
          const service = await PlanService.create();
          planServiceRef.current = service;
        }
      } catch (e) {
        console.warn('Failed to load trail for section map:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [trailId, planId, direction]);

  // Find nearest waypoint name for a km position
  const findNearestName = useCallback(
    (km: number): string => {
      if (!trail) return `km ${km.toFixed(1)}`;
      let bestName = `km ${km.toFixed(1)}`;
      let bestDist = 0.5;
      for (const wp of trail.waypoints) {
        const d = Math.abs((wp.totalDistance ?? 0) - km);
        if (d < bestDist) {
          bestDist = d;
          bestName = wp.name;
        }
      }
      return bestName;
    },
    [trail],
  );

  // Handle long press on trail
  const handleLongPress = useCallback(
    (coordinate: { latitude: number; longitude: number; nearestKm: number }) => {
      const km = Math.round(coordinate.nearestKm * 10) / 10;
      const name = findNearestName(km);

      if (mode === 'single') {
        setSelectedKm(km);
        setSelectedName(name);
        return;
      }

      // Section mode: first tap = start, second tap = end
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
    },
    [mode, startKm, endKm, startName, findNearestName],
  );

  // Custom pins for selected points
  const customPins = useMemo(() => {
    if (!trail) return [];
    const pins: { latitude: number; longitude: number; label: string; color: string }[] = [];
    const points = trail.track.points;

    const findCoords = (km: number) => {
      const bestIdx = findNearestByDistance(points, km);
      return { latitude: points[bestIdx].lat, longitude: points[bestIdx].lon };
    };

    if (mode === 'single' && selectedKm !== null) {
      const coords = findCoords(selectedKm);
      pins.push({ ...coords, label: selectedName ?? `km ${selectedKm.toFixed(1)}`, color: '#4CAF50' });
    }

    if (mode === 'section') {
      if (startKm !== null) {
        const coords = findCoords(startKm);
        pins.push({ ...coords, label: `Start: ${startName ?? `km ${startKm.toFixed(1)}`}`, color: '#4CAF50' });
      }
      if (endKm !== null) {
        const coords = findCoords(endKm);
        pins.push({ ...coords, label: `End: ${endName ?? `km ${endKm.toFixed(1)}`}`, color: '#FF5722' });
      }
    }

    return pins;
  }, [trail, mode, startKm, endKm, startName, endName, selectedKm, selectedName]);

  // Highlighted segment
  const highlightedSegment = useMemo(() => {
    if (mode === 'section' && startKm !== null && endKm !== null) {
      return { startKm, endKm };
    }
    return null;
  }, [mode, startKm, endKm]);

  // Apply selection — persist to DB and go back
  const handleApply = useCallback(async () => {
    if (mode === 'section' && startKm !== null && endKm !== null && planId) {
      const sectionConfig = {
        startKm,
        endKm,
        startName: startName ?? `km ${startKm.toFixed(1)}`,
        endName: endName ?? `km ${endKm.toFixed(1)}`,
      };
      try {
        const service = planServiceRef.current ?? await PlanService.create();
        await service.updatePlan(planId, { sectionJson: JSON.stringify(sectionConfig) });
      } catch (e) {
        console.warn('Failed to persist section from map:', e);
      }
      router.back();
      return;
    }

    if (mode === 'single' && selectedKm !== null) {
      // Navigate back to the measure screen with the selected point as params
      router.navigate({
        pathname: '/plan/measure',
        params: {
          trailId: trailId ?? '',
          [`mapSelected_${target ?? 'start'}_km`]: String(selectedKm),
          [`mapSelected_${target ?? 'start'}_name`]: selectedName ?? `km ${selectedKm.toFixed(1)}`,
        },
      });
    }
  }, [mode, startKm, endKm, startName, endName, planId, selectedKm, selectedName, target, trailId, router]);

  const canApply =
    (mode === 'single' && selectedKm !== null) ||
    (mode === 'section' && startKm !== null && endKm !== null);

  const instructionText = useMemo(() => {
    if (mode === 'single') {
      return selectedKm !== null
        ? `Selected: ${selectedName ?? `km ${selectedKm.toFixed(1)}`}`
        : 'Long-press the trail to select a point';
    }
    if (startKm === null) return 'Long-press the trail to set the start point';
    if (endKm === null) return `Start: ${startName ?? `km ${startKm.toFixed(1)}`} — now set the end point`;
    return `${startName ?? `km ${startKm.toFixed(1)}`} → ${endName ?? `km ${endKm.toFixed(1)}`}`;
  }, [mode, startKm, endKm, startName, endName, selectedKm, selectedName]);

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
        <Text style={[styles.errorText, { color: colors.textSecondary }]}>Trail data unavailable</Text>
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
      <View style={[styles.headerOverlay, { paddingTop: insets.top }]}>
        <View style={[styles.header, { backgroundColor: colors.surface }]}>
          <Pressable
            onPress={() => router.back()}
            style={styles.headerButton}
            accessibilityLabel="Cancel"
            accessibilityRole="button"
          >
            <Text style={[styles.headerButtonText, { color: colors.accent }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
            {mode === 'single' ? 'Select Point' : 'Select Section'}
          </Text>
          <Pressable
            onPress={handleApply}
            disabled={!canApply}
            style={styles.headerButton}
            accessibilityLabel="Apply selection"
            accessibilityRole="button"
          >
            <Text
              style={[
                styles.headerButtonText,
                { color: canApply ? colors.accent : colors.textSecondary },
              ]}
            >
              Apply
            </Text>
          </Pressable>
        </View>
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
  headerButton: {
    minWidth: 60,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  headerButtonText: {
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
