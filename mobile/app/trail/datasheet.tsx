import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { useTrailData } from '../../src/contexts/TrailDataContext';
import type { TrailWaypoint } from '../../src/lib/trail-utils';
import { calculateElevationBetween } from '../../src/services/distance-calculator';
import { waypointEmojis } from '../../src/components/WaypointList';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

interface WaypointRow {
  waypoint: TrailWaypoint;
  distanceFromRef: number;
  elevationGain: number;
  elevationLoss: number;
  isPast: boolean;
}

const TYPE_LABELS: Record<string, string> = {
  town: 'Town',
  hut: 'Hut',
  shelter: 'Shelter',
  campsite: 'Camp',
  trailhead: 'Trailhead',
};

export default function DatasheetScreen() {
  const { id, fromKm } = useLocalSearchParams<{ id: string; fromKm?: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { trail, loading, error, loadTrail } = useTrailData();

  const [showPast, setShowPast] = useState(false);

  const referenceKm = fromKm ? parseFloat(fromKm) : 0;

  useEffect(() => {
    if (id) loadTrail(id);
  }, [id, loadTrail]);

  const rows = useMemo((): WaypointRow[] => {
    if (!trail) return [];
    const trackPoints = trail.track.points;

    return trail.waypoints
      .filter(wp => wp.totalDistance != null)
      .map(wp => {
        const wpKm = wp.totalDistance ?? 0;
        const isPast = wpKm < referenceKm;
        const { gain, loss } = calculateElevationBetween(referenceKm, wpKm, trackPoints);
        return {
          waypoint: wp,
          distanceFromRef: wpKm - referenceKm,
          elevationGain: gain,
          elevationLoss: loss,
          isPast,
        };
      });
  }, [trail, referenceKm]);

  const visibleRows = useMemo(() => {
    if (showPast) return rows;
    return rows.filter(r => !r.isPast);
  }, [rows, showPast]);

  const summary = useMemo(() => {
    if (!trail) return null;
    const totalDist = trail.track.totalDistance - referenceKm;
    const { gain } = calculateElevationBetween(
      referenceKm,
      trail.track.totalDistance,
      trail.track.points,
    );
    return { remainingKm: Math.max(0, totalDist), remainingGain: gain };
  }, [trail, referenceKm]);

  const hasPastWaypoints = rows.some(r => r.isPast);

  if (loading || (!trail && !error)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (error || !trail) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.errorText, { color: colors.alertRed }]}>{error ?? 'Trail not found'}</Text>
        <Pressable onPress={() => router.back()} style={styles.backPressable}>
          <Text style={[styles.backLabel, { color: colors.accent }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Fixed header */}
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm, borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()} style={styles.backRow} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={[styles.backArrow, { color: colors.accent }]}>←</Text>
          <Text style={[styles.backLabel, { color: colors.accent }]}>Back</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>
          {trail.config.name} — Datasheet
        </Text>
      </View>

      <FlatList
        data={visibleRows}
        keyExtractor={(item, index) => `${index}-${item.waypoint.name}`}
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            {/* Summary card */}
            {summary && (
              <View style={[styles.summaryCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.summaryRow}>
                  <View style={styles.summaryItem}>
                    <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
                      {summary.remainingKm.toFixed(1)}
                    </Text>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>km remaining</Text>
                  </View>
                  <View style={[styles.summaryDivider, { backgroundColor: colors.border }]} />
                  <View style={styles.summaryItem}>
                    <Text style={[styles.summaryValue, { color: colors.textPrimary }]}>
                      +{summary.remainingGain}
                    </Text>
                    <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>m gain remaining</Text>
                  </View>
                </View>
                {referenceKm > 0 && (
                  <Text style={[styles.refNote, { color: colors.textSecondary }]}>
                    From km {referenceKm.toFixed(1)}
                  </Text>
                )}
              </View>
            )}

            {/* Past waypoints toggle */}
            {hasPastWaypoints && (
              <Pressable
                onPress={() => setShowPast(!showPast)}
                style={styles.toggleRow}
                accessibilityRole="button"
              >
                <Text style={[styles.toggleText, { color: colors.accent }]}>
                  {showPast ? 'Hide passed waypoints' : `Show ${rows.filter(r => r.isPast).length} passed waypoints`}
                </Text>
              </Pressable>
            )}
          </View>
        }
        renderItem={({ item }) => {
          const wp = item.waypoint;
          const emoji = waypointEmojis[wp.type] ?? waypointEmojis.poi ?? '📍';
          const typeLabel = TYPE_LABELS[wp.type];
          const dimmed = item.isPast;

          return (
            <View style={[styles.row, { borderBottomColor: colors.border }]}>
              <View style={styles.rowLeft}>
                <Text style={styles.emoji}>{emoji}</Text>
                <View style={styles.nameCol}>
                  <Text
                    style={[
                      styles.wpName,
                      { color: dimmed ? colors.textSecondary : colors.textPrimary },
                    ]}
                    numberOfLines={1}
                  >
                    {wp.name}
                  </Text>
                  {typeLabel && (
                    <Text style={[styles.typeLabel, { color: colors.textSecondary }]}>
                      {typeLabel}
                      {wp.elevation != null ? ` · ${Math.round(wp.elevation)}m` : ''}
                    </Text>
                  )}
                </View>
              </View>
              <View style={styles.rowRight}>
                <Text
                  style={[
                    styles.distValue,
                    { color: dimmed ? colors.textSecondary : colors.textPrimary },
                  ]}
                >
                  {item.distanceFromRef >= 0 ? '' : '-'}{Math.abs(item.distanceFromRef).toFixed(1)} km
                </Text>
                <Text style={[styles.elevValue, { color: colors.textSecondary }]}>
                  +{item.elevationGain}m
                </Text>
              </View>
            </View>
          );
        }}
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
  errorText: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  backPressable: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  backArrow: {
    fontSize: 22,
    fontWeight: '600',
  },
  backLabel: {
    ...typography.body,
    fontWeight: '600',
  },
  headerTitle: {
    ...typography.titleSmall,
    marginBottom: spacing.xs,
  },
  listHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  summaryCard: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  summaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  summaryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 36,
  },
  summaryValue: {
    ...typography.displaySmall,
    fontVariant: ['tabular-nums'],
  },
  summaryLabel: {
    ...typography.caption,
    marginTop: 2,
  },
  refNote: {
    ...typography.caption,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  toggleRow: {
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  },
  toggleText: {
    ...typography.caption,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: spacing.sm,
    marginRight: spacing.md,
  },
  emoji: {
    fontSize: 20,
    width: 28,
    textAlign: 'center',
  },
  nameCol: {
    flex: 1,
  },
  wpName: {
    ...typography.body,
    fontWeight: '500',
  },
  typeLabel: {
    ...typography.caption,
  },
  rowRight: {
    alignItems: 'flex-end',
  },
  distValue: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  elevValue: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
});
