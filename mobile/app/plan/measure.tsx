import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailDataService } from '../../src/services/trail-data-service';
import { trailJsonToTrail, type Trail, type TrailWaypoint } from '../../src/lib/trail-utils';
import { measureBetweenPoints, type MeasureResult } from '../../src/services/measure-service';
import { waypointEmojis } from '../../src/components/WaypointList';
import { ElevationProfile } from '../../src/components/ElevationProfile';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

export default function MeasureScreen() {
  const params = useLocalSearchParams<{
    trailId: string;
    mapSelected_start_km?: string;
    mapSelected_start_name?: string;
    mapSelected_end_km?: string;
    mapSelected_end_name?: string;
  }>();
  const trailId = params.trailId;
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [loading, setLoading] = useState(true);
  const [startPoint, setStartPoint] = useState<TrailWaypoint | null>(null);
  const [endPoint, setEndPoint] = useState<TrailWaypoint | null>(null);
  const [startSearch, setStartSearch] = useState('');
  const [endSearch, setEndSearch] = useState('');

  // Load trail data
  useEffect(() => {
    async function load() {
      if (!trailId) return;
      try {
        const trailService = await TrailDataService.create();
        const json = await trailService.getTrailTrackData(trailId);
        if (!json) {
          setLoading(false);
          return;
        }
        setTrail(trailJsonToTrail(json));
      } catch (e) {
        console.warn('Failed to load trail for measure:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [trailId]);

  // Handle map selection results from section-map screen
  useEffect(() => {
    if (!trail) return;
    if (params.mapSelected_start_km) {
      const km = parseFloat(params.mapSelected_start_km);
      const name = params.mapSelected_start_name ?? `km ${km.toFixed(1)}`;
      setStartPoint({
        id: 'measure-start',
        name,
        lat: 0,
        lon: 0,
        type: 'poi',
        totalDistance: km,
      });
    }
    if (params.mapSelected_end_km) {
      const km = parseFloat(params.mapSelected_end_km);
      const name = params.mapSelected_end_name ?? `km ${km.toFixed(1)}`;
      setEndPoint({
        id: 'measure-end',
        name,
        lat: 0,
        lon: 0,
        type: 'poi',
        totalDistance: km,
      });
    }
  }, [trail, params.mapSelected_start_km, params.mapSelected_end_km, params.mapSelected_start_name, params.mapSelected_end_name]);

  // Filtered waypoints for each picker
  const filteredStartWaypoints = useMemo(() => {
    if (!trail) return [];
    if (!startSearch.trim()) return trail.waypoints;
    const q = startSearch.trim().toLowerCase();
    return trail.waypoints.filter(wp => wp.name.toLowerCase().includes(q));
  }, [trail, startSearch]);

  const filteredEndWaypoints = useMemo(() => {
    if (!trail) return [];
    if (!endSearch.trim()) return trail.waypoints;
    const q = endSearch.trim().toLowerCase();
    return trail.waypoints.filter(wp => wp.name.toLowerCase().includes(q));
  }, [trail, endSearch]);

  // Compute measurement when both points selected
  const result: MeasureResult | null = useMemo(() => {
    if (!trail || !startPoint || !endPoint) return null;
    const startKm = startPoint.totalDistance ?? 0;
    const endKm = endPoint.totalDistance ?? 0;
    if (startKm === endKm) return null;
    return measureBetweenPoints(trail, startKm, endKm);
  }, [trail, startPoint, endPoint]);

  // Extract track points between measured segment for mini elevation profile
  const segmentTrackPoints = useMemo(() => {
    if (!trail || !startPoint || !endPoint) return [];
    const startKm = Math.min(startPoint.totalDistance ?? 0, endPoint.totalDistance ?? 0);
    const endKm = Math.max(startPoint.totalDistance ?? 0, endPoint.totalDistance ?? 0);
    return trail.track.points.filter(p => p.dist >= startKm && p.dist <= endKm);
  }, [trail, startPoint, endPoint]);

  // Water source kms in the measured segment
  const segmentWaterKms = useMemo(() => {
    if (!trail || !startPoint || !endPoint) return [];
    const startKm = Math.min(startPoint.totalDistance ?? 0, endPoint.totalDistance ?? 0);
    const endKm = Math.max(startPoint.totalDistance ?? 0, endPoint.totalDistance ?? 0);
    return trail.waypoints
      .filter(wp => (wp.type === 'water' || wp.type === 'water-tank') && (wp.totalDistance ?? 0) > startKm && (wp.totalDistance ?? 0) <= endKm)
      .map(wp => wp.totalDistance ?? 0);
  }, [trail, startPoint, endPoint]);

  // Swap start and end
  const handleSwap = useCallback(() => {
    const prevStart = startPoint;
    const prevEnd = endPoint;
    setStartPoint(prevEnd);
    setEndPoint(prevStart);
  }, [startPoint, endPoint]);

  const formatHours = (hours: number): string => {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  };

  const renderWaypointItem = useCallback(
    (item: TrailWaypoint, selected: TrailWaypoint | null, onSelect: (wp: TrailWaypoint) => void) => {
      const km = item.totalDistance ?? 0;
      const isSelected = selected !== null && (selected.totalDistance ?? 0) === km && selected.name === item.name;
      const emoji = waypointEmojis[item.type] ?? waypointEmojis.poi;

      return (
        <Pressable
          onPress={() => onSelect(item)}
          style={[
            styles.waypointRow,
            {
              backgroundColor: isSelected ? colors.accentSubtle : 'transparent',
              borderColor: isSelected ? colors.accent : colors.border,
            },
          ]}
          accessibilityLabel={`${item.name}, ${km.toFixed(1)} km${isSelected ? ', selected' : ''}`}
          accessibilityRole="radio"
          accessibilityState={{ selected: isSelected }}
        >
          <Text style={styles.waypointEmoji}>{emoji}</Text>
          <View style={styles.waypointContent}>
            <Text style={[styles.waypointName, { color: colors.textPrimary }]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.waypointKm, { color: colors.textSecondary }]}>
              km {km.toFixed(1)}
            </Text>
          </View>
          {isSelected && (
            <Text style={[styles.check, { color: colors.accent }]}>&#x2713;</Text>
          )}
        </Pressable>
      );
    },
    [colors],
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
        <Text style={[styles.errorText, { color: colors.textSecondary }]}>Trail data not found</Text>
        <Pressable onPress={() => router.back()} style={styles.errorBackButton}>
          <Text style={[styles.backText, { color: colors.accent }]}>Go Back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.backButton}
          accessibilityLabel="Go back"
          accessibilityRole="button"
        >
          <Text style={[styles.backText, { color: colors.accent }]}>Back</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          Measure
        </Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.scrollContainer}
        contentContainerStyle={[styles.scrollContent, { paddingBottom: insets.bottom + spacing.xl }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Start Point Picker */}
        <View style={styles.pickerSection}>
          <View style={styles.pickerHeader}>
            <Text style={[styles.pickerLabel, { color: colors.textPrimary }]}>Start Point</Text>
            {startPoint && (
              <Text style={[styles.pickerSelection, { color: colors.accent }]} numberOfLines={1}>
                {startPoint.name}
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              router.push({
                pathname: '/plan/section-map',
                params: { trailId: trailId ?? '', mode: 'single', target: 'start' },
              });
            }}
            style={[styles.selectOnMapButton, { borderColor: colors.accent }]}
            accessibilityLabel="Select start point on map"
            accessibilityRole="button"
          >
            <Text style={[styles.selectOnMapText, { color: colors.accent }]}>Select on Map</Text>
          </Pressable>
          <TextInput
            style={[
              styles.searchInput,
              {
                color: colors.textPrimary,
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
            value={startSearch}
            onChangeText={setStartSearch}
            placeholder="Search waypoints..."
            placeholderTextColor={colors.textSecondary}
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Search start point"
          />
          {filteredStartWaypoints.length === 0 && startSearch.trim() ? (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No waypoints matching &quot;{startSearch.trim()}&quot;
            </Text>
          ) : (
            <View style={styles.waypointList}>
              {filteredStartWaypoints.map((item) => (
                <React.Fragment key={`start-${item.name}-${item.totalDistance ?? 0}`}>
                  {renderWaypointItem(item, startPoint, setStartPoint)}
                </React.Fragment>
              ))}
            </View>
          )}
        </View>

        {/* Swap Button */}
        {startPoint && endPoint && (
          <Pressable
            onPress={handleSwap}
            style={[styles.swapButton, { borderColor: colors.border }]}
            accessibilityLabel="Swap start and end points"
            accessibilityRole="button"
          >
            <Text style={[styles.swapText, { color: colors.accent }]}>Swap</Text>
          </Pressable>
        )}

        {/* End Point Picker */}
        <View style={styles.pickerSection}>
          <View style={styles.pickerHeader}>
            <Text style={[styles.pickerLabel, { color: colors.textPrimary }]}>End Point</Text>
            {endPoint && (
              <Text style={[styles.pickerSelection, { color: colors.accent }]} numberOfLines={1}>
                {endPoint.name}
              </Text>
            )}
          </View>
          <Pressable
            onPress={() => {
              router.push({
                pathname: '/plan/section-map',
                params: { trailId: trailId ?? '', mode: 'single', target: 'end' },
              });
            }}
            style={[styles.selectOnMapButton, { borderColor: colors.accent }]}
            accessibilityLabel="Select end point on map"
            accessibilityRole="button"
          >
            <Text style={[styles.selectOnMapText, { color: colors.accent }]}>Select on Map</Text>
          </Pressable>
          <TextInput
            style={[
              styles.searchInput,
              {
                color: colors.textPrimary,
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
            value={endSearch}
            onChangeText={setEndSearch}
            placeholder="Search waypoints..."
            placeholderTextColor={colors.textSecondary}
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Search end point"
          />
          {filteredEndWaypoints.length === 0 && endSearch.trim() ? (
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No waypoints matching &quot;{endSearch.trim()}&quot;
            </Text>
          ) : (
            <View style={styles.waypointList}>
              {filteredEndWaypoints.map((item) => (
                <React.Fragment key={`end-${item.name}-${item.totalDistance ?? 0}`}>
                  {renderWaypointItem(item, endPoint, setEndPoint)}
                </React.Fragment>
              ))}
            </View>
          )}
        </View>

        {/* Result Panel */}
        {result && (
          <View style={[styles.resultPanel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.resultTitle, { color: colors.textPrimary }]}>Measurement</Text>

            {/* Distance */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Along-trail distance</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                {result.distanceKm.toFixed(1)} km
              </Text>
            </View>

            {/* Elevation gain */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Elevation gain</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                +{Math.round(result.ascentM)} m
              </Text>
            </View>

            {/* Elevation loss */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Elevation loss</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                -{Math.round(result.descentM)} m
              </Text>
            </View>

            {/* Net elevation */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Net elevation change</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                {result.netElevationM >= 0 ? '+' : ''}{Math.round(result.netElevationM)} m
              </Text>
            </View>

            {/* Estimated time */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Estimated hiking time</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                {formatHours(result.estimatedHours)}
              </Text>
            </View>

            {/* Water sources */}
            <View style={styles.resultRow}>
              <Text style={[styles.resultLabel, { color: colors.textSecondary }]}>Water sources</Text>
              <Text style={[styles.resultValue, { color: colors.textPrimary }]}>
                {result.waterSourceCount}
              </Text>
            </View>

            {/* Mini elevation profile */}
            {segmentTrackPoints.length > 1 && (
              <View style={styles.miniProfile}>
                <ElevationProfile
                  trackPoints={segmentTrackPoints}
                  waterSourceKms={segmentWaterKms}
                  compact
                />
              </View>
            )}

            {/* Waypoints between */}
            {result.waypointsBetween.length > 0 && (
              <View style={styles.waypointsBetween}>
                <Text style={[styles.waypointsBetweenTitle, { color: colors.textPrimary }]}>
                  Waypoints Between ({result.waypointsBetween.length})
                </Text>
                <ScrollView
                  horizontal={false}
                  nestedScrollEnabled
                  style={styles.waypointsBetweenList}
                >
                  {result.waypointsBetween.map((wp, idx) => {
                    const emoji = waypointEmojis[wp.type] ?? waypointEmojis.poi;
                    return (
                      <View key={`between-${wp.name}-${idx}`} style={styles.betweenRow}>
                        <Text style={styles.betweenEmoji}>{emoji}</Text>
                        <Text style={[styles.betweenName, { color: colors.textPrimary }]} numberOfLines={1}>
                          {wp.name}
                        </Text>
                        <Text style={[styles.betweenKm, { color: colors.textSecondary }]}>
                          km {(wp.totalDistance ?? 0).toFixed(1)}
                        </Text>
                      </View>
                    );
                  })}
                </ScrollView>
              </View>
            )}
          </View>
        )}
      </ScrollView>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backButton: {
    minWidth: 50,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  backText: {
    ...typography.body,
    fontWeight: '600',
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
    textAlign: 'center',
  },
  errorText: {
    ...typography.body,
    marginBottom: spacing.lg,
  },
  errorBackButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  scrollContainer: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.lg,
  },
  pickerSection: {
    marginBottom: spacing.lg,
  },
  pickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  pickerLabel: {
    ...typography.titleLarge,
  },
  pickerSelection: {
    ...typography.body,
    fontWeight: '600',
    flexShrink: 1,
    marginLeft: spacing.md,
  },
  selectOnMapButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: touchTarget.min,
    marginBottom: spacing.sm,
  },
  selectOnMapText: {
    ...typography.body,
    fontWeight: '600',
  },
  searchInput: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    marginBottom: spacing.md,
  },
  emptyText: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  waypointList: {
    maxHeight: 220,
  },
  waypointRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    marginBottom: spacing.xs,
  },
  waypointEmoji: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  waypointContent: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  waypointName: {
    ...typography.body,
  },
  waypointKm: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  check: {
    fontSize: 20,
    fontWeight: '700',
    marginLeft: spacing.sm,
  },
  swapButton: {
    alignSelf: 'center',
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  swapText: {
    ...typography.body,
    fontWeight: '600',
    textAlign: 'center',
  },
  resultPanel: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
    marginTop: spacing.md,
  },
  resultTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.md,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  resultLabel: {
    ...typography.body,
    flex: 1,
  },
  resultValue: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.md,
  },
  miniProfile: {
    marginTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.2)',
    paddingTop: spacing.md,
  },
  waypointsBetween: {
    marginTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.2)',
    paddingTop: spacing.md,
  },
  waypointsBetweenTitle: {
    ...typography.titleSmall,
    marginBottom: spacing.sm,
  },
  waypointsBetweenList: {
    maxHeight: 200,
  },
  betweenRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  betweenEmoji: {
    fontSize: 14,
    width: 24,
    textAlign: 'center',
  },
  betweenName: {
    ...typography.caption,
    flex: 1,
    marginLeft: spacing.sm,
  },
  betweenKm: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
    marginLeft: spacing.sm,
  },
});
