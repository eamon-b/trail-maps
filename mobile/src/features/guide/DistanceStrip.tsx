/**
 * Compact one-line "what's next" strip shown above every guide pane.
 *
 * Reads the shared guide position and renders one of four states:
 *   no-permission — a single unobtrusive "Show my location" pill (starts GPS)
 *   acquiring     — a quiet "Locating…" hint
 *   fix           — horizontally-scrollable chips: next water / camp / waypoint,
 *                   each with distance and a Naismith ETA (direction-aware)
 *   off-trail     — a leading "X m off trail" chip, then the same next chips
 *
 * All distances/ETAs come from the shared `distance-calculator`; the trail is
 * already direction-applied by the guide, so "next" always means ahead.
 */

import React, { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
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
  const { status, currentKm, offTrailMeters, position, start } = useGuidePositionContext();
  const shareCheckIn = useCheckInShare();

  const chips = useMemo(() => {
    if (currentKm == null) return [];
    const waypoints = orderedWaypoints(trail);
    const trackPoints = trail.track.points;
    const distances = calculateDistancesToWaypoints(currentKm, waypoints, trackPoints, baseKmh);
    const byType = getNextWaypointsByType(currentKm, waypoints, trackPoints, distances);

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
    // "Next waypoint" is the closest upcoming point of any type.
    push('next', 'Next waypoint', distances[0]);
    return items;
  }, [trail, currentKm, units, baseKmh]);

  // --- No fix yet: a single "Show my location" pill / locating hint --------
  if (status === 'no-permission') {
    return (
      <View style={styles.host}>
        <Pressable
          onPress={start}
          accessibilityRole="button"
          accessibilityLabel="Show my location"
          style={({ pressed }) => [
            styles.pill,
            { backgroundColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.pillIcon, { color: colors.accentText }]}>◎</Text>
          <Text style={[styles.pillText, { color: colors.accentText }]}>Show my location</Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'acquiring') {
    return (
      <View style={styles.host}>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>Locating…</Text>
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
            <Text style={[styles.chipLabel, { color: colors.textSecondary }]}>{chip.label}</Text>
            <Text style={[styles.chipValue, { color: colors.textPrimary }]}>{chip.value}</Text>
          </View>
        ))}
      </ScrollView>
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
