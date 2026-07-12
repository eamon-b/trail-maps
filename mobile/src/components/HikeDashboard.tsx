import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { useTheme } from '../theme';
import { spacing } from '../tokens/spacing';
import { typography, glyphSizes } from '../tokens/typography';
import { ProgressBar } from './ProgressBar';
import { WaypointCard } from './WaypointCard';
import { WaypointList, WaypointListItem } from './WaypointList';
import { Card, CardState } from './Card';
import { WaterCountdown } from './WaterCountdown';
import { BearingIndicator } from './BearingIndicator';
import { PressableRow } from './PressableRow';

/** A "NEXT X" card's data (id enables deep-linking to the waypoint on the map) */
export interface NextWaypointData {
  id?: string;
  name: string;
  distance: string;
  elevation?: string;
  /** Naismith ETA text (e.g. "~50 min") */
  eta?: string;
  /** Bearing from the current position to the waypoint, degrees from north */
  bearing?: number;
  /** One-line context note (e.g. the water description's first line) */
  note?: string;
}

/** GPS course data that gates the bearing arrows (decision 8) */
export interface GpsCourse {
  heading: number | null;
  speed: number | null;
  fixTimestamp: number | null;
}

export interface DashboardData {
  /** Trail info */
  trailName: string;
  direction: string;
  currentKm: number;
  totalKm: number;

  /** Next waypoints by type */
  nextCampsite?: NextWaypointData;
  nextWater?: NextWaypointData;
  nextTown?: NextWaypointData;
  nextShelter?: NextWaypointData;

  /** GPS course for the bearing arrows */
  gpsCourse?: GpsCourse;

  /** Naismith minutes to the next water source (time-to-water) */
  nextWaterEtaMinutes?: number;

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
  /** Callback when a "NEXT X" card is tapped (deep-link to the waypoint) */
  onNextWaypointPress?: (waypointId: string) => void;
  style?: ViewStyle;
}

/**
 * Format estimated arrival time: now + remainingHours → "HH:MM".
 * `nowMs` is passed in (not read inline) so the caller can recompute on an
 * interval — a Date.now() at render silently goes stale during breaks.
 */
function formatETA(remainingHours: number, nowMs: number): string {
  const arrivalMs = nowMs + remainingHours * 3_600_000;
  const d = new Date(arrivalMs);
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

/** Recompute interval for the day-level ETA */
const ETA_TICK_MS = 60_000;

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
  onNextWaypointPress,
  style,
}: HikeDashboardProps) {
  const { colors } = useTheme();
  const [todayExpanded, setTodayExpanded] = useState(true);

  // Recompute the day-level ETA on a 60 s interval — otherwise it freezes at
  // whatever Date.now() was at the last GPS-driven render (e.g. during a
  // lunch break) and silently lies.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), ETA_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const makeNextPress = (id?: string) =>
    onNextWaypointPress && id ? () => onNextWaypointPress(id) : undefined;

  // Bearing arrows for the full-width cards (gated by GPS course validity)
  const makeBearing = (next?: NextWaypointData) =>
    next?.bearing != null && data?.gpsCourse ? (
      <BearingIndicator
        targetBearing={next.bearing}
        heading={data.gpsCourse.heading}
        speed={data.gpsCourse.speed}
        fixTimestamp={data.gpsCourse.fixTimestamp}
      />
    ) : undefined;

  const isLoading = state === 'loading';
  const cardState: CardState = isLoading ? 'loading' : (gpsState === 'degraded' || gpsState === 'searching') ? 'degraded' : 'normal';

  // No fix yet: currentKm is a sentinel 0, so position-relative readouts (water
  // countdown, today progress/ETA, upcoming distances) would present distances
  // measured from the trail start as if live. Show the searching treatment
  // instead — 'degraded' means we still have a last-known km and is fine.
  const gpsSearching = gpsState === 'searching';

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
        eta={data?.nextCampsite?.eta}
        bearing={makeBearing(data?.nextCampsite)}
        emptyMessage="No campsites ahead on today's section"
        degradedMessage={degradedMsg}
        onPress={makeNextPress(data?.nextCampsite?.id)}
      />

      {/* Next Water — full width, large text. The description's first line
          (tank condition) is exactly what a hiker needs pre-tap. */}
      <WaypointCard
        state={cardState}
        label="NEXT WATER"
        icon="💧"
        name={data?.nextWater?.name}
        distance={data?.nextWater?.distance}
        elevation={data?.nextWater?.elevation}
        eta={data?.nextWater?.eta}
        note={data?.nextWater?.note}
        bearing={makeBearing(data?.nextWater)}
        emptyMessage="No water sources ahead on today's section"
        degradedMessage={degradedMsg}
        onPress={makeNextPress(data?.nextWater?.id)}
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
          eta={data?.nextTown?.eta}
          compact
          emptyMessage="No towns ahead"
          degradedMessage={degradedMsg}
          style={styles.gridCard}
          onPress={makeNextPress(data?.nextTown?.id)}
        />
        <WaypointCard
          state={cardState}
          label="NEXT SHELTER"
          icon="🛖"
          name={data?.nextShelter?.name}
          distance={data?.nextShelter?.distance}
          elevation={data?.nextShelter?.elevation}
          eta={data?.nextShelter?.eta}
          compact
          emptyMessage="No shelters ahead"
          degradedMessage={degradedMsg}
          style={styles.gridCard}
          onPress={makeNextPress(data?.nextShelter?.id)}
        />
      </View>

      {/* === BELOW THE FOLD === */}

      {/* TODAY section — collapsible. The card BODY is no longer pressable;
          only the header chevron row toggles collapse, so a tap near the
          water countdown (which now lives inside the body) can't accidentally
          collapse the card. The loading skeleton keeps Card's own label. */}
      {(data?.today || isLoading) && (
        <Card
          state={isLoading ? 'loading' : 'normal'}
          label={isLoading ? 'TODAY' : undefined}
        >
          {data?.today && (
            <>
              {/* Header chevron row — the sole collapse toggle. ≥44pt target
                  (PressableRow), selection-tick haptic (PressableRow default),
                  and a proper expanded accessibility state. */}
              <PressableRow
                onPress={() => setTodayExpanded(!todayExpanded)}
                accessibilityLabel={
                  todayExpanded
                    ? `Collapse today section, day ${data.today.dayNumber} of ${data.today.totalDays}`
                    : `Expand today section, day ${data.today.dayNumber} of ${data.today.totalDays}`
                }
                accessibilityState={{ expanded: todayExpanded }}
                style={styles.todayHeader}
              >
                <Text style={[styles.todayHeaderLabel, { color: colors.textSecondary }]}>
                  {`TODAY (Day ${data.today.dayNumber} of ${data.today.totalDays})`}
                </Text>
                <Text style={[styles.todayChevron, { color: colors.textSecondary }]}>
                  {todayExpanded ? '▾' : '▸'}
                </Text>
              </PressableRow>

              {todayExpanded && (
                <View style={styles.todayBody}>
                  <Text style={[styles.todayRoute, { color: colors.textPrimary }]}>
                    {data.today.startName} → {data.today.endName}
                  </Text>
                  <Text style={[styles.todayStats, { color: colors.textPrimary }]}>
                    {data.today.distanceKm.toFixed(1)} km  +{data.today.ascentM}m/-{data.today.descentM}m  ~{Math.floor(data.today.estimatedHours)}h {Math.round((data.today.estimatedHours % 1) * 60)}m
                  </Text>
                  {/* Position-relative readouts are honest only once we have a
                      fix; before then currentKm is a sentinel 0. */}
                  {gpsSearching ? (
                    <Text style={[styles.todayProgressText, { color: colors.textSecondary }]}>
                      Waiting for GPS to show progress…
                    </Text>
                  ) : (
                    <>
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
                      {/* Remaining distance + ETA (honestly labelled: computed
                          from the plan's Naismith pace, not the live pace) */}
                      {data.today.remainingHours != null && (
                        <View style={styles.todayEtaRow}>
                          <Text style={[styles.todayEtaText, { color: colors.textSecondary }]}>
                            {(data.today.distanceKm - data.today.completedKm).toFixed(1)} km remaining
                          </Text>
                          <Text style={[styles.todayEtaText, { color: colors.textSecondary }]}>
                            {'ETA: '}
                            {formatETA(data.today.remainingHours, nowMs)}
                            {' (at plan pace)'}
                          </Text>
                        </View>
                      )}
                      {/* Next water countdown */}
                      {data.nextWaterKm != null && (
                        <WaterCountdown
                          nextWaterKm={data.nextWaterKm}
                          etaMinutes={data.nextWaterEtaMinutes}
                          style={styles.waterCountdown}
                        />
                      )}
                    </>
                  )}
                </View>
              )}
              {!todayExpanded && (
                <Text style={[styles.todayCollapsed, { color: colors.textSecondary }]}>
                  Tap the header to expand
                </Text>
              )}
            </>
          )}
        </Card>
      )}

      {/* No-plan today section: show water countdown when no plan is set. When
          searching, the km-0 distance would be a lie — WaterCountdown shows the
          searching treatment instead. */}
      {!data?.today && !isLoading && (data?.nextWaterKm != null || gpsSearching) && (
        <Card state="normal" label="TODAY">
          <WaterCountdown
            nextWaterKm={data?.nextWaterKm ?? null}
            etaMinutes={data?.nextWaterEtaMinutes}
            searching={gpsSearching}
          />
        </Card>
      )}

      {/* UPCOMING waypoints. Distances are position-relative, so while
          searching (no fix) we show the searching treatment rather than
          distances measured from the trail start. */}
      {(data?.upcoming || isLoading) && (
        <Card
          state={isLoading ? 'loading' : gpsSearching ? 'degraded' : data?.upcoming?.length ? 'normal' : 'empty'}
          label="UPCOMING"
          emptyMessage="No waypoints ahead"
          degradedMessage={gpsSearching ? 'Searching for GPS signal...' : undefined}
        >
          {!gpsSearching && data?.upcoming && data.upcoming.length > 0 && (
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
  todayHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  // Matches Card's section-label treatment (titleLarge / textSecondary).
  todayHeaderLabel: {
    ...typography.titleLarge,
  },
  todayChevron: {
    fontSize: glyphSizes.md,
  },
  todayBody: {
    marginTop: spacing.sm,
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
  // Field-critical progress numbers — ≥14pt (dataSmall), never caption
  todayProgressText: {
    ...typography.dataSmall,
    fontWeight: '400',
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
  // Field-critical remaining-distance/ETA — ≥14pt (dataSmall)
  todayEtaText: {
    ...typography.dataSmall,
    fontWeight: '400',
  },
  waterCountdown: {
    marginTop: spacing.sm,
  },
});
