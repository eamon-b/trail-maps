/**
 * An alternate as it bears on one place, on that place's waypoint screen
 * (`waypoint-alternates.ts`): the alternate the place is on, one that leaves
 * or rejoins the main route here, or the one the plan takes past it.
 *
 * Every card says where the alternate leaves the main route and where it comes
 * back — each a link to that junction's own screen when a named place is there
 * — whether the plan takes it, and offers the same "Take this alternate" /
 * "Stay on the main route" choice as the Plan screen's branch card.
 *
 * Presentational: the screen owns the plan and does the edit.
 */

import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import type { JunctionPlace, WaypointAlternate } from './waypoint-alternates';

export interface WaypointAlternateCardProps {
  alternate: WaypointAlternate;
  units: Units;
  /** Id of the waypoint on screen, so its own junction is not a link to itself. */
  currentWaypointId?: string;
  /** Take or drop the alternate. Omitted: no button (it cannot be planned). */
  onAlternate?: (name: string, take: boolean) => void;
  /** Open a junction place's screen. */
  onOpenPlace?: (waypointId: string) => void;
}

/** A name without the "Alternate:" a trail's data often starts it with. */
export function alternateLabel(name: string): string {
  return name.replace(/^\s*alternat(?:e|ive)\s*:\s*/i, '').trim() || name;
}

function titleOf(a: WaypointAlternate): string {
  const name = alternateLabel(a.name);
  switch (a.role) {
    case 'on':
      return `⑂ On an alternate: ${name}`;
    case 'leaves':
      return `⑂ An alternate leaves the main route here: ${name}`;
    case 'rejoins':
      return `↩ An alternate rejoins the main route here: ${name}`;
    case 'bypassed':
      return `⑂ Your plan takes an alternate past here: ${name}`;
  }
}

function statusOf(a: WaypointAlternate): string {
  if (a.role === 'bypassed') {
    return 'This place is on the stretch of main route the alternate replaces, so it is not on the route you planned.';
  }
  if (!a.plannable) {
    return a.parentName ? `It branches off another alternate: ${alternateLabel(a.parentName)}.` : '';
  }
  return a.taken ? 'Your plan takes this alternate.' : 'Your plan stays on the main route here.';
}

export function WaypointAlternateCard({
  alternate: a,
  units,
  currentWaypointId,
  onAlternate,
  onOpenPlace,
}: WaypointAlternateCardProps) {
  const { colors } = useTheme();
  const climb = a.ascentM || a.descentM
    ? ` · ↑ ${formatElevation(a.ascentM, units)} · ↓ ${formatElevation(a.descentM, units)}`
    : '';
  const along =
    a.role === 'on' && a.kmAlong !== null
      ? `${formatDistance(a.kmAlong, units)} along it · `
      : '';
  const delta = a.plannable ? a.plannable.distanceKm - a.plannable.mainDistanceKm : null;
  const deltaText =
    delta === null
      ? ''
      : Math.abs(delta) < 0.05
        ? ' · same distance as the main route'
        : ` · ${formatDistance(Math.abs(delta), units)} ${delta > 0 ? 'longer' : 'shorter'} than the main route`;
  const status = statusOf(a);
  const canChoose = onAlternate !== undefined && a.plannable !== null;
  const action = a.taken ? 'Stay on the main route' : 'Take this alternate';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: a.taken ? colors.accent : colors.border },
      ]}
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>{titleOf(a)}</Text>
      <Text style={[styles.detail, { color: colors.textSecondary }]}>
        {`${along}${formatDistance(a.distanceKm, units)} in all${climb}${deltaText}`}
      </Text>

      {a.leavesKm !== null && a.role !== 'leaves' && (
        <JunctionLine
          label="Leaves the main route at"
          km={a.leavesKm}
          place={a.leavesAt}
          units={units}
          currentWaypointId={currentWaypointId}
          onOpenPlace={onOpenPlace}
        />
      )}
      {a.rejoinsKm !== null && a.role !== 'rejoins' && (
        <JunctionLine
          label="Rejoins the main route at"
          km={a.rejoinsKm}
          place={a.rejoinsAt}
          units={units}
          currentWaypointId={currentWaypointId}
          onOpenPlace={onOpenPlace}
        />
      )}

      {status ? <Text style={[styles.detail, { color: colors.textSecondary }]}>{status}</Text> : null}
      {canChoose && !a.taken && a.replaces.length > 0 && (
        <Text style={[styles.detail, { color: colors.textSecondary }]}>
          {`Taking it drops ${a.replaces.map(alternateLabel).join(' and ')}, which covers the same main route.`}
        </Text>
      )}

      {canChoose && (
        <Pressable
          onPress={() => onAlternate!(a.plannable!.name, !a.taken)}
          accessibilityRole="button"
          accessibilityLabel={`${action}: ${alternateLabel(a.name)}`}
          style={({ pressed }) => [
            styles.button,
            { borderColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.buttonText, { color: colors.accent }]}>{action}</Text>
        </Pressable>
      )}
    </View>
  );
}

function JunctionLine({
  label,
  km,
  place,
  units,
  currentWaypointId,
  onOpenPlace,
}: {
  label: string;
  km: number;
  place: JunctionPlace | null;
  units: Units;
  currentWaypointId?: string;
  onOpenPlace?: (waypointId: string) => void;
}) {
  const { colors } = useTheme();
  const kmText = formatDistance(km, units);
  const text = place ? `${label} ${place.name} (${kmText})` : `${label} ${kmText}`;
  const linkId = place?.id && place.id !== currentWaypointId ? place.id : undefined;
  if (!linkId || !onOpenPlace) {
    return <Text style={[styles.junction, { color: colors.textPrimary }]}>{text}</Text>;
  }
  return (
    <Pressable
      onPress={() => onOpenPlace(linkId)}
      accessibilityRole="link"
      accessibilityLabel={text}
      hitSlop={spacing.xs}
      style={({ pressed }) => pressed && styles.pressed}
    >
      <Text style={[styles.junction, { color: colors.accent }]}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
  },
  title: { ...typography.titleSmall },
  detail: { ...typography.bodySmall },
  junction: { ...typography.bodySmall, fontWeight: '700' },
  button: {
    minHeight: touchTarget.min,
    borderWidth: 1,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
