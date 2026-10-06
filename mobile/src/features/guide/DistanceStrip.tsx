/**
 * Compact one-line "what's next" strip shown above every guide pane.
 *
 * Reads the shared guide position and renders one of four states:
 *   no-permission — a single unobtrusive "Show my location" pill (starts GPS);
 *                   "Location unavailable · Try again" when the last start failed
 *   acquiring     — a quiet "Locating…" hint
 *   fix           — horizontally-scrollable chips: next water / camp / waypoint,
 *                   each with distance and a Naismith ETA (direction-aware),
 *                   plus a "Next resupply" chip once the hiker has made a
 *                   resupply plan
 *   off-trail     — a leading "X m off trail" chip, then the same next chips
 *
 * While GPS is on (acquiring, fix, off-trail) a "Turn off location" button sits
 * at the end of the row: tracking is opt-in, so it must be as easy to stop.
 *
 * All distances/ETAs come from the shared `distance-calculator`; the trail is
 * already direction-applied by the guide, so "next" always means ahead.
 *
 * The resupply chip only exists while a plan does, and past the last planned
 * stop it says so rather than offering the next unplanned town — quietly
 * undoing the plan on the one screen that matters on the trail would be worse
 * than an empty answer.
 */

import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { routeBreakStarts } from '@lib/route-breaks';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import {
  calculateDistancesToWaypoints,
  formatEtaMinutes,
  getNextWaypointsByType,
  type WaypointDistance,
} from '../../services/distance-calculator';
import { selectPaceBaseKmh, usePlanInputsStore } from '../plan/plan-inputs-store';
import { usePlannedResupplyIds } from '../plan/use-planned-resupply';
import { ShareIconButton } from '../share/ShareIconButton';
import { useCheckInShare } from '../share/use-check-in-share';
import { useGuide } from './GuideContext';
import { orderedWaypoints } from './guide-trail';
import { useGuidePositionContext } from './GuidePositionContext';

export function DistanceStrip() {
  const { colors } = useTheme();
  const { trailId, trail } = useGuide();
  const baseKmh = usePlanInputsStore(selectPaceBaseKmh(trailId));
  const units = useSettingsStore((s) => s.units);
  const { status, currentKm, offTrailMeters, position, error, start, stop } =
    useGuidePositionContext();
  // Null until a resupply plan exists — no chip at all until then.
  const plannedIds = usePlannedResupplyIds(trailId, trail);
  const shareCheckIn = useCheckInShare();

  const chips = useMemo(() => {
    if (currentKm == null) return [];
    const waypoints = orderedWaypoints(trail);
    const trackPoints = trail.track.points;
    const distances = calculateDistancesToWaypoints(
      currentKm,
      waypoints,
      trackPoints,
      baseKmh,
      routeBreakStarts(trail.track.breaks, 'points'),
    );
    const byType = getNextWaypointsByType(
      currentKm,
      waypoints,
      trackPoints,
      distances,
      baseKmh,
      undefined,
      plannedIds ?? undefined,
    );

    const items: { key: string; label: string; value: string }[] = [];
    const push = (key: string, label: string, wd?: WaypointDistance) => {
      if (!wd) return;
      items.push({
        key,
        label,
        value: `${formatDistance(wd.trailDistanceKm, units)} · ${formatEtaMinutes(wd.etaMinutes)}`,
      });
    };
    push('water', 'Next water', byType.water);
    push('camp', 'Next camp', byType.campsite);
    if (plannedIds) {
      if (byType.town) push('resupply', 'Next resupply', byType.town);
      // Label-less: the sentence is the whole chip.
      else items.push({ key: 'resupply', label: '', value: 'No planned resupply ahead' });
    }
    // "Next waypoint" is the closest upcoming point of any type.
    push('next', 'Next waypoint', distances[0]);
    return items;
  }, [trail, currentKm, units, baseKmh, plannedIds]);

  // --- No fix yet: a single "Show my location" pill / locating hint --------
  if (status === 'no-permission') {
    const pillLabel = error ? 'Location unavailable · Try again' : 'Show my location';
    return (
      <View style={styles.host}>
        <Pressable
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel={pillLabel}
          style={({ pressed }) => [
            styles.pill,
            { backgroundColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.pillIcon, { color: colors.accentText }]}>◎</Text>
          <Text style={[styles.pillText, { color: colors.accentText }]}>{pillLabel}</Text>
        </Pressable>
      </View>
    );
  }

  const stopButton = (
    <Pressable
      onPress={stop}
      accessibilityRole="button"
      accessibilityLabel="Turn off location"
      hitSlop={8}
      style={({ pressed }) => [styles.stopButton, pressed && styles.pressed]}
    >
      <Text style={[styles.stopText, { color: colors.textSecondary }]}>Turn off</Text>
    </Pressable>
  );

  if (status === 'acquiring') {
    return (
      <View style={styles.fixRow}>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>Locating…</Text>
        {stopButton}
      </View>
    );
  }

  // --- Have a fix: scrollable chips + a pinned share button ----------------
  // The share button lives OUTSIDE the horizontal scroll so it stays reachable
  // no matter how far the chips run. It only renders here (status fix/off-trail),
  // so a usable position is guaranteed when shared.
  const canShare = position != null && currentKm != null;
  return (
    <View style={styles.fixRow}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.host}
        contentContainerStyle={styles.scrollContent}
      >
        {status === 'off-trail' && offTrailMeters != null && (
          <View style={[styles.chip, { backgroundColor: colors.warning, borderColor: colors.warning }]}>
            <Text style={[styles.chipValue, { color: colors.warningText }]}>
              {Math.round(offTrailMeters)} m off trail
            </Text>
          </View>
        )}
        {chips.map((chip) => (
          <View
            key={chip.key}
            style={[styles.chip, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
          >
            {chip.label !== '' && (
              <Text style={[styles.chipLabel, { color: colors.textSecondary }]}>{chip.label}</Text>
            )}
            <Text style={[styles.chipValue, { color: colors.textPrimary }]}>{chip.value}</Text>
          </View>
        ))}
      </ScrollView>
      {stopButton}
      {canShare && (
        <View style={styles.shareSlot}>
          <ShareIconButton
            color={colors.accent}
            onPress={() =>
              void shareCheckIn({
                trailName: trail.config.name,
                totalKm: trail.track.totalDistance,
                units,
                gps: {
                  lat: position.lat,
                  lon: position.lon,
                  currentKm,
                  offTrail: status === 'off-trail',
                },
              })
            }
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fixRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  host: {
    flexGrow: 0,
    flexShrink: 1,
  },
  shareSlot: {
    paddingRight: spacing.lg,
    paddingBottom: spacing.sm,
  },
  scrollContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  pillIcon: {
    fontSize: glyphSizes.sm,
  },
  pillText: {
    ...typography.dataSmall,
    fontWeight: '600',
  },
  hint: {
    ...typography.caption,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  pressed: {
    opacity: 0.6,
  },
  stopButton: {
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  stopText: {
    ...typography.caption,
    textDecorationLine: 'underline',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipLabel: {
    ...typography.caption,
  },
  chipValue: {
    ...typography.dataSmall,
    fontVariant: ['tabular-nums'],
  },
});
