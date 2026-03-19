import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';
import { ProgressBar } from './ProgressBar';
import { WaypointCard } from './WaypointCard';
import { WaypointList, WaypointListItem } from './WaypointList';
import { Card, CardState } from './Card';
import { WaterCountdown } from './WaterCountdown';

export interface DashboardData {
  /** Trail info */
  trailName: string;
  direction: string;
  currentKm: number;
  totalKm: number;

  /** Next waypoints by type */
  nextCampsite?: { name: string; distance: string; elevation?: string };
  nextWater?: { name: string; distance: string };
  nextTown?: { name: string; distance: string; elevation?: string };
  nextShelter?: { name: string; distance: string };

  /** Today's plan */
  today?: {
    dayNumber: number;
    totalDays: number;
    startName: string;
    endName: string;
    distanceKm: number;
    ascentM: number;
    descentM: number;
    estimatedHours: number;
    completedKm: number;
    /** Estimated remaining hours for today's section (from current position) */
    remainingHours?: number;
  };

  /** Distance to next water source in km (for WaterCountdown) */
  nextWaterKm?: number;

  /** Upcoming waypoints */
  upcoming?: WaypointListItem[];
}

interface HikeDashboardProps {
  data: DashboardData | null;
  /** Overall loading state */
  state?: CardState;
  /** GPS state — when 'degraded' or 'searching', show absolute positions */
  gpsState?: 'normal' | 'degraded' | 'searching';
  /** Callback when "See all waypoints" is tapped */
  onSeeAllWaypoints?: () => void;
  /** Callback when a waypoint in the upcoming list is tapped */
  onWaypointSelect?: (waypoint: WaypointListItem) => void;
  style?: ViewStyle;
}

/**
 * Format estimated arrival time: now + remainingHours → "HH:MM"
 */
function formatETA(remainingHours: number): string {
  const arrivalMs = Date.now() + remainingHours * 3_600_000;
  const d = new Date(arrivalMs);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Glanceable Hike Dashboard layout.
 * Designed for 390pt minimum width (iPhone 15).
 *
 * Above the fold: trail progress, Next Campsite (full-width), Next Water (full-width),
 *   Next Town + Next Shelter (2-column grid)
 * Below the fold: TODAY section (collapsible), UPCOMING waypoints
 */
export function HikeDashboard({
  data,
  state = 'normal',
  gpsState = 'normal',
  onSeeAllWaypoints,
  onWaypointSelect,
  style,
}: HikeDashboardProps) {
  const { colors } = useTheme();
  const [todayExpanded, setTodayExpanded] = useState(true);

  const isLoading = state === 'loading';
  const cardState: CardState = isLoading ? 'loading' : (gpsState === 'degraded' || gpsState === 'searching') ? 'degraded' : 'normal';

  const degradedMsg = gpsState === 'searching'
    ? 'Searching for GPS signal...'
    : gpsState === 'degraded'
    ? `Last known: km ${data?.currentKm?.toFixed(1) ?? '?'} (no GPS)`
    : undefined;

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }, style]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* Trail progress header */}
      {data && (
        <ProgressBar
          progress={data.currentKm / data.totalKm}
          label={`${data.trailName}  ${data.direction}`}
          detail={`km ${Math.round(data.currentKm)} / ${Math.round(data.totalKm)}`}
          style={styles.progressBar}
        />
      )}
      {isLoading && !data && (
        <ProgressBar
          progress={0}
          label="Loading..."
          style={styles.progressBar}
        />
      )}

      {/* === ABOVE THE FOLD === */}

      {/* Next Campsite — full width, large text */}
      <WaypointCard
        state={cardState}
        label="NEXT CAMPSITE"
        icon="⛺"
        name={data?.nextCampsite?.name}
        distance={data?.nextCampsite?.distance}
        elevation={data?.nextCampsite?.elevation}
        emptyMessage="No campsites ahead on today's section"
        degradedMessage={degradedMsg}
      />

      {/* Next Water — full width, large text */}
      <WaypointCard
        state={cardState}
        label="NEXT WATER"
        icon="💧"
        name={data?.nextWater?.name}
        distance={data?.nextWater?.distance}
        emptyMessage="No water sources ahead on today's section"
        degradedMessage={degradedMsg}
      />

      {/* Next Town + Next Shelter — 2-column grid */}
      <View style={styles.gridRow}>
        <WaypointCard
          state={cardState}
          label="NEXT TOWN"
          icon="🏘️"
          name={data?.nextTown?.name}
          distance={data?.nextTown?.distance}
          elevation={data?.nextTown?.elevation}
          compact
          emptyMessage="No towns ahead"
          degradedMessage={degradedMsg}
          style={styles.gridCard}
        />
        <WaypointCard
          state={cardState}
          label="NEXT SHELTER"
          icon="🛖"
          name={data?.nextShelter?.name}
          distance={data?.nextShelter?.distance}
          compact
          emptyMessage="No shelters ahead"
          degradedMessage={degradedMsg}
          style={styles.gridCard}
        />
      </View>

      {/* === BELOW THE FOLD === */}

      {/* TODAY section — collapsible */}
      {(data?.today || isLoading) && (
        <Card
          state={isLoading ? 'loading' : 'normal'}
          label={`TODAY${data?.today ? ` (Day ${data.today.dayNumber} of ${data.today.totalDays})` : ''}`}
        >
          {data?.today && (
            <Pressable
              onPress={() => setTodayExpanded(!todayExpanded)}
              accessibilityLabel={todayExpanded ? 'Collapse today section' : 'Expand today section'}
              accessibilityRole="button"
            >
              {todayExpanded && (
                <View>
                  <Text style={[styles.todayRoute, { color: colors.textPrimary }]}>
                    {data.today.startName} → {data.today.endName}
                  </Text>
                  <Text style={[styles.todayStats, { color: colors.textPrimary }]}>
                    {data.today.distanceKm.toFixed(1)} km  +{data.today.ascentM}m/-{data.today.descentM}m  ~{Math.floor(data.today.estimatedHours)}h {Math.round((data.today.estimatedHours % 1) * 60)}m
                  </Text>
                  <View style={styles.todayProgress}>
                    <Text style={[styles.todayProgressText, { color: colors.textSecondary }]}>
                      Done: {data.today.completedKm.toFixed(1)} km ({data.today.distanceKm > 0 ? Math.round((data.today.completedKm / data.today.distanceKm) * 100) : 0}%)
                    </Text>
                    <ProgressBar
                      progress={data.today.distanceKm > 0 ? data.today.completedKm / data.today.distanceKm : 0}
                      height={4}
                      style={styles.todayProgressBar}
                    />
                  </View>
                  {/* Remaining distance + ETA */}
                  {data.today.remainingHours != null && (
                    <View style={styles.todayEtaRow}>
                      <Text style={[styles.todayEtaText, { color: colors.textSecondary }]}>
                        {(data.today.distanceKm - data.today.completedKm).toFixed(1)} km remaining
                      </Text>
                      <Text style={[styles.todayEtaText, { color: colors.textSecondary }]}>
                        {'ETA: '}
                        {formatETA(data.today.remainingHours)}
                      </Text>
                    </View>
                  )}
                  {/* Next water countdown */}
                  {data.nextWaterKm != null && (
                    <WaterCountdown nextWaterKm={data.nextWaterKm} style={styles.waterCountdown} />
                  )}
                </View>
              )}
              {!todayExpanded && (
                <Text style={[styles.todayCollapsed, { color: colors.textSecondary }]}>
                  Tap to expand
                </Text>
              )}
            </Pressable>
          )}
        </Card>
      )}

      {/* No-plan today section: show water countdown when no plan is set */}
      {!data?.today && !isLoading && data?.nextWaterKm != null && (
        <Card state="normal" label="TODAY">
          <WaterCountdown nextWaterKm={data.nextWaterKm} />
        </Card>
      )}

      {/* UPCOMING waypoints */}
      {(data?.upcoming || isLoading) && (
        <Card
          state={isLoading ? 'loading' : data?.upcoming?.length ? 'normal' : 'empty'}
          label="UPCOMING"
          emptyMessage="No waypoints ahead"
        >
          {data?.upcoming && data.upcoming.length > 0 && (
            <WaypointList
              waypoints={data.upcoming}
              maxItems={5}
              onSelect={onWaypointSelect}
              onSeeAll={onSeeAllWaypoints}
            />
          )}
        </Card>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  progressBar: {
    marginBottom: spacing.lg,
  },
  gridRow: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  gridCard: {
    flex: 1,
  },
  todayRoute: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  todayStats: {
    ...typography.body,
    fontVariant: ['tabular-nums'],
    marginBottom: spacing.sm,
  },
  todayProgress: {
    marginTop: spacing.xs,
  },
  todayProgressText: {
    ...typography.caption,
    marginBottom: spacing.xs,
  },
  todayProgressBar: {
    marginTop: spacing.xs,
  },
  todayCollapsed: {
    ...typography.caption,
    fontStyle: 'italic',
  },
  todayEtaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  todayEtaText: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  waterCountdown: {
    marginTop: spacing.sm,
  },
});
