/**
 * The Stops list — the heart of the planner. You walk down the places you
 * could sleep and tap one to make it tonight's stop; the day cards above
 * re-split as you go. Nothing here generates anything.
 *
 * Rows default to the overnight candidates (`plan-stops.stopCandidates`),
 * because a trail's full waypoint list is mostly water and junctions; the "All
 * waypoints" switch opens it up for the hiker who wants to finish at a
 * trailhead or a river crossing.
 *
 * Each row carries a services strip read from the trail's OSM POIs
 * (`@lib/plan-editor` `servicesAtStop`, 1 km either side). A greyed glyph means
 * "OSM knows of nothing like that here"; a trail with no POI data at all
 * (`pois === undefined` — CDT, Te Araroa) hides the strips entirely and says so
 * once in the footer, because "no services" and "we cannot answer" are not the
 * same claim to make about a water source.
 *
 * Presentational: every edit goes back out through the callbacks, which the
 * screen turns into `plans-store.apply` calls.
 */

import React, { useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { formatDistance } from '@lib/format-distance';
import { findStop, servicesAtStop, type StopServices } from '@lib/plan-editor';
import { OSM_ATTRIBUTION } from '@lib/poi-display';
import type { PlanDocument, PlanStop } from '@lib/plan-types';
import type { TrailPOI } from '@lib/trail-types';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { StopEditor } from './StopEditor';
import { stopKeyOf, type StopCandidate } from './plan-stops';

/** Rows revealed at a time — a long trail's "All waypoints" list is thousands. */
const PAGE_SIZE = 50;

/** The services strip, in the order the web page shows them. */
const SERVICE_GLYPHS: { key: keyof StopServices; glyph: string; label: string }[] = [
  { key: 'camping', glyph: '⛺', label: 'Camping' },
  { key: 'lodging', glyph: '🛏', label: 'Beds' },
  { key: 'shop', glyph: '🛒', label: 'Shop' },
  { key: 'food', glyph: '🍽', label: 'Food' },
  { key: 'water', glyph: '💧', label: 'Water' },
  { key: 'transport', glyph: '🚌', label: 'Transport' },
];

export interface StopsSectionProps {
  candidates: StopCandidate[];
  /** The trail's plan, or undefined when it has none yet (nothing is ticked). */
  plan: PlanDocument | undefined;
  /** The guide trail's POIs — `undefined` for a trail never enriched. */
  pois: TrailPOI[] | undefined;
  units: Units;
  showAll: boolean;
  onShowAll: (showAll: boolean) => void;
  onToggle: (candidate: StopCandidate) => void;
  onNights: (candidate: StopCandidate, nights: number) => void;
  onNote: (candidate: StopCandidate, note: string) => void;
  onBooked: (candidate: StopCandidate, booked: boolean) => void;
  /**
   * The hiker's km (active), or null with no on-trail fix. A "You are here"
   * divider is drawn before the first place at or past it, and the rows up to
   * it are revealed however far down the trail it is.
   */
  currentKm?: number | null;
  /** Called with the divider once it is laid out, so the screen can scroll to it. */
  onHereLayout?: (marker: View) => void;
}

export function StopsSection(props: StopsSectionProps) {
  const { colors } = useTheme();
  const { candidates, plan, pois, units, showAll } = props;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // One pass over the POIs per candidate is O(rows × pois); memoised on the
  // list so a tap (which changes only the plan) never re-scans them.
  const services = useMemo(() => {
    const map = new Map<string, StopServices | undefined>();
    for (const candidate of candidates) {
      map.set(candidate.key, servicesAtStop({ km: candidate.activeKm }, pois));
    }
    return map;
  }, [candidates, pois]);

  const currentKm = props.currentKm ?? null;
  const hereIndex = useMemo(() => {
    if (currentKm === null) return -1;
    const idx = candidates.findIndex((c) => c.activeKm >= currentKm);
    return idx === -1 ? candidates.length : idx;
  }, [candidates, currentKm]);
  const markerRef = useRef<View>(null);

  // The divider is always inside the revealed rows, with a few places after it.
  const shown = Math.max(visibleCount, hereIndex + 10);
  const visible = candidates.slice(0, shown);
  const remaining = candidates.length - visible.length;

  return (
    <View style={styles.root}>
      <View style={styles.headRow}>
        <Text style={[styles.headLabel, { color: colors.textSecondary }]}>All waypoints</Text>
        <Switch
          value={showAll}
          onValueChange={props.onShowAll}
          accessibilityLabel="Show all waypoints"
          accessibilityRole="switch"
        />
      </View>

      {candidates.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          This trail has no places listed to stop at.
        </Text>
      ) : (
        visible.map((candidate, i) => (
          <React.Fragment key={candidate.key}>
            {i === hereIndex && (
              <HereMarker
                ref={markerRef}
                onLayout={() => markerRef.current && props.onHereLayout?.(markerRef.current)}
              />
            )}
            <StopRow
              candidate={candidate}
              stop={plan ? findStop(plan, stopKeyOf(candidate)) : undefined}
              services={services.get(candidate.key)}
              units={units}
              onToggle={() => props.onToggle(candidate)}
              onNights={(nights) => props.onNights(candidate, nights)}
              onNote={(note) => props.onNote(candidate, note)}
              onBooked={(booked) => props.onBooked(candidate, booked)}
            />
          </React.Fragment>
        ))
      )}
      {candidates.length > 0 && hereIndex === candidates.length && (
        <HereMarker
          ref={markerRef}
          onLayout={() => markerRef.current && props.onHereLayout?.(markerRef.current)}
        />
      )}

      {remaining > 0 && (
        <Pressable
          onPress={() => setVisibleCount(shown + PAGE_SIZE)}
          accessibilityRole="button"
          accessibilityLabel={`Show more places, ${remaining} remaining`}
          hitSlop={spacing.xs}
        >
          <Text style={[styles.more, { color: colors.accent }]}>
            {`Show more (${remaining} remaining)`}
          </Text>
        </Pressable>
      )}

      <Text style={[styles.footer, { color: colors.textSecondary }]}>
        {pois === undefined
          ? 'No OSM data for this trail — services are unknown, not absent.'
          : `Services from OpenStreetMap, within 1 km. ${OSM_ATTRIBUTION}`}
      </Text>
    </View>
  );
}

/** The "You are here" divider between the places behind and ahead of the hiker. */
const HereMarker = React.forwardRef<View, { onLayout: () => void }>(function HereMarker(
  { onLayout },
  ref,
) {
  const { colors } = useTheme();
  return (
    <View ref={ref} onLayout={onLayout} style={styles.here} accessibilityLabel="You are here">
      <View style={[styles.hereRule, { backgroundColor: colors.accent }]} />
      <Text style={[styles.hereLabel, { color: colors.accent }]}>You are here</Text>
      <View style={[styles.hereRule, { backgroundColor: colors.accent }]} />
    </View>
  );
});

function StopRow({
  candidate,
  stop,
  services,
  units,
  onToggle,
  onNights,
  onNote,
  onBooked,
}: {
  candidate: StopCandidate;
  stop: PlanStop | undefined;
  services: StopServices | undefined;
  units: Units;
  onToggle: () => void;
  onNights: (nights: number) => void;
  onNote: (note: string) => void;
  onBooked: (booked: boolean) => void;
}) {
  const { colors } = useTheme();
  const checked = stop !== undefined;
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: checked ? colors.accent : colors.border,
        },
      ]}
    >
      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        accessibilityLabel={candidate.name}
        style={({ pressed }) => [styles.rowPress, pressed && styles.pressed]}
      >
        <View
          style={[
            styles.tick,
            {
              borderColor: checked ? colors.accent : colors.border,
              backgroundColor: checked ? colors.accent : 'transparent',
            },
          ]}
        >
          {checked && <Text style={[styles.tickGlyph, { color: colors.accentText }]}>✓</Text>}
        </View>
        <View style={styles.rowBody}>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {candidate.name}
          </Text>
          <Text style={[styles.km, { color: colors.textSecondary }]}>
            {formatDistance(candidate.activeKm, units)}
          </Text>
          {services && <ServicesStrip services={services} />}
        </View>
      </Pressable>

      {stop && (
        <View style={[styles.editor, { borderTopColor: colors.border }]}>
          <StopEditor stop={stop} onNights={onNights} onNote={onNote} onBooked={onBooked} />
        </View>
      )}
    </View>
  );
}

/** ⛺ 🛏 🛒 🍽 💧 🚌 — lit for what OSM knows is here, greyed for what it does not. */
function ServicesStrip({ services }: { services: StopServices }) {
  const { colors } = useTheme();
  return (
    <View style={styles.services}>
      {SERVICE_GLYPHS.map(({ key, glyph, label }) => {
        const present = services[key] === true;
        return (
          <Text
            key={key}
            accessibilityLabel={present ? label : `No ${label.toLowerCase()}`}
            style={[
              styles.serviceGlyph,
              !present && styles.serviceAbsent,
              { color: colors.textPrimary },
            ]}
          >
            {glyph}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: spacing.sm },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headLabel: { ...typography.bodySmall },
  empty: { ...typography.bodySmall, paddingVertical: spacing.md },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
  },
  rowPress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBody: { flex: 1, gap: 2 },
  name: { ...typography.bodySmall, fontWeight: '600' },
  km: { ...typography.caption, fontVariant: ['tabular-nums'] },
  services: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  serviceGlyph: { ...typography.caption },
  serviceAbsent: { opacity: 0.25 },
  tick: {
    width: 24,
    height: 24,
    borderRadius: radii.sm,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tickGlyph: { fontWeight: '700' },
  editor: {
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
  },
  here: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hereRule: { flex: 1, height: 2 },
  hereLabel: { ...typography.caption, fontWeight: '700' },
  more: { ...typography.bodySmall, fontWeight: '700', paddingVertical: spacing.xs },
  footer: { ...typography.caption },
  pressed: { opacity: 0.6 },
});
