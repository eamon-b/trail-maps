/**
 * "From your location" card for the waypoint and POI detail screens: how far
 * the place is along the trail from the hiker's GPS position, the climb and
 * descent in the direction walked, and a Naismith time at the trail's pace.
 *
 * It only measures the trail. When the hiker is off it, or the place is, the
 * card says how far rather than folding a walk it cannot measure into the
 * time — and it never says "You are here" unless both are on the line.
 *
 * Renders nothing without a usable fix.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import type { AccessMode } from '@lib/types';
import { routeBreakStarts } from '@lib/route-breaks';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useSettingsStore } from '../../state/settings-store';
import { formatEtaMinutes } from '../../services/distance-calculator';
import { selectPaceBaseKmh, usePlanInputsStore } from '../plan/plan-inputs-store';
import { useGuide } from './GuideContext';
import { useGuidePositionContext } from './GuidePositionContext';
import { isPlaceOffTrail, tripToWaypoint } from './waypoint-detail';

export function TripCard({
  placeKm,
  placeOffTrailM,
  placeAccessMode,
}: {
  /** The place's km on the guide's direction-applied scale. */
  placeKm: number;
  /** How far the place sits from the trail line, in metres (null: unknown). */
  placeOffTrailM: number | null;
  /** How the data says that distance is covered, when it says (a turn-off's `accessMode`). */
  placeAccessMode?: AccessMode;
}) {
  const { colors } = useTheme();
  const { trailId, trail } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const baseKmh = usePlanInputsStore(selectPaceBaseKmh(trailId));
  const { status, currentKm, offTrailMeters } = useGuidePositionContext();

  const hasFix = status === 'fix' || status === 'off-trail';
  const trip = useMemo(
    () =>
      hasFix && currentKm != null
        ? tripToWaypoint(
            currentKm,
            placeKm,
            trail.track.points,
            baseKmh,
            routeBreakStarts(trail.track.breaks, 'points'),
          )
        : null,
    [hasFix, currentKm, placeKm, trail, baseKmh],
  );

  if (!hasFix || currentKm == null) return null;

  const hikerOff = status === 'off-trail' && offTrailMeters != null;
  const placeOff = isPlaceOffTrail(placeOffTrailM);
  const heading = hikerOff ? 'From the nearest point on the trail' : 'From your location';
  // Level on the trail is only "here" when neither of you is off it.
  const levelLabel = hikerOff
    ? 'Level with you on the trail'
    : placeOff
      ? 'At its nearest point on the trail'
      : 'You are here';

  return (
    <View
      accessible
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.gps }]}
    >
      <Text style={[styles.label, { color: colors.textSecondary }]}>{heading}</Text>
      {trip ? (
        <View style={styles.row}>
          <Text style={[styles.distance, { color: colors.textPrimary }]}>
            {`${formatDistance(trip.distanceKm, units)} ${trip.direction}`}
          </Text>
          <Text
            style={[styles.value, { color: colors.textPrimary }]}
            accessibilityLabel={`${formatElevation(trip.ascentM, units)} up`}
          >
            {`↑ ${formatElevation(trip.ascentM, units)}`}
          </Text>
          <Text
            style={[styles.value, { color: colors.textPrimary }]}
            accessibilityLabel={`${formatElevation(trip.descentM, units)} down`}
          >
            {`↓ ${formatElevation(trip.descentM, units)}`}
          </Text>
          <Text style={[styles.value, { color: colors.textSecondary }]}>
            {formatEtaMinutes(trip.etaMinutes)}
          </Text>
        </View>
      ) : (
        <Text style={[styles.distance, { color: colors.textPrimary }]}>{levelLabel}</Text>
      )}
      {hikerOff && (
        <Text style={[styles.note, { color: colors.textSecondary }]}>
          {`You are ${formatDistance(offTrailMeters / 1000, units, { decimals: 2 })} off the trail`}
        </Text>
      )}
      {placeOff && placeOffTrailM != null && (
        <Text style={[styles.note, { color: colors.textSecondary }]}>
          {`Then ${formatDistance(placeOffTrailM / 1000, units, { decimals: 2 })} ${beyondWord(placeAccessMode)} to reach it`}
        </Text>
      )}
    </View>
  );
}

/** "off the trail" on foot (or unsaid); "by hitch", "by shuttle", "by boat" otherwise. */
function beyondWord(mode: AccessMode | undefined): string {
  return mode === 'hitch' || mode === 'shuttle' || mode === 'boat' ? `by ${mode}` : 'off the trail';
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
  },
  label: { ...typography.caption },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: spacing.md,
    rowGap: spacing.xs,
  },
  distance: { ...typography.titleLarge, fontVariant: ['tabular-nums'] },
  value: { ...typography.titleSmall, fontVariant: ['tabular-nums'] },
  note: { ...typography.caption },
});
