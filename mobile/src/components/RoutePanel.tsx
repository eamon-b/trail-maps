import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { spacing, radii, touchTarget } from '../tokens/spacing';
import { glyphSizes, typography } from '../tokens/typography';
import type { ResolvedRoutePoint, RouteMetrics } from '../services/route-service';

interface RoutePanelProps {
  /** 'build': tap waypoints to add, reorder/remove, name + save.
   *  'view': read-only legs of a saved route, with export. */
  mode: 'build' | 'view';
  /** Saved route name (view mode) */
  routeName?: string;
  /** Ordered route points */
  points: ResolvedRoutePoint[];
  /** Per-leg metrics + totals (recomputed live by the parent) */
  metrics: RouteMetrics;
  /** Remove the point at index (build mode) */
  onRemovePoint?: (index: number) => void;
  /** Move the point at index up (-1) or down (+1) (build mode) */
  onMovePoint?: (index: number, direction: -1 | 1) => void;
  /** Save the route under the entered name (build mode) */
  onSave?: (name: string) => void;
  /** Export the route as GPX (view mode) */
  onExport?: () => void;
  /** Exit the builder / close the route view */
  onClose: () => void;
  saving?: boolean;
}

function formatHours(hours: number): string {
  // Round to whole minutes FIRST, then split, so a value that rounds up to a
  // full 60 carries into the next hour instead of printing "60 min" or
  // "1 h 60 min".
  const totalMinutes = Math.round(hours * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h === 0) return `${m} min`;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Bottom panel for the waypoint-sequence route builder/viewer (P1 PR D).
 * Overlays the map above the elevation drawer area; the map stays
 * interactive for tapping waypoints while building.
 */
export function RoutePanel({
  mode,
  routeName,
  points,
  metrics,
  onRemovePoint,
  onMovePoint,
  onSave,
  onExport,
  onClose,
  saving = false,
}: RoutePanelProps) {
  const { colors } = useTheme();
  const [name, setName] = useState('');

  // The panel is not unmounted between routes — the parent renders it whenever
  // a route is active and only flips `mode` (build → view on save, view →
  // build when the next route starts). Component state therefore survives, so
  // the entered name would otherwise carry from one route into the next
  // build session and get saved onto it. Clear it whenever we (re-)enter build
  // mode from a different mode, which is exactly the start of a fresh route.
  const prevModeRef = useRef<RoutePanelProps['mode'] | null>(null);
  useEffect(() => {
    if (mode === 'build' && prevModeRef.current !== 'build') {
      setName('');
    }
    prevModeRef.current = mode;
  }, [mode]);

  const canSave = mode === 'build' && points.length >= 2 && name.trim().length > 0 && !saving;

  return (
    <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={1}>
          {mode === 'build' ? 'Build route' : routeName ?? 'Route'}
        </Text>
        <Pressable
          onPress={onClose}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel={mode === 'build' ? 'Cancel route building' : 'Close route'}
        >
          <Text style={[styles.closeIcon, { color: colors.textSecondary }]}>✕</Text>
        </Pressable>
      </View>

      {mode === 'build' && points.length === 0 && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          Tap waypoints in the order you want to walk them, or tap anywhere on the map to add a detour point.
        </Text>
      )}

      <ScrollView style={styles.list} nestedScrollEnabled>
        {/* Ordered stops (build mode gets reorder/remove controls) */}
        {points.map((pt, i) => (
          <View key={`${pt.seq}-${i}`} style={[styles.stopRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.stopIndex, { color: colors.textSecondary }]}>{i + 1}.</Text>
            <View style={styles.stopInfo}>
              <Text
                style={[styles.stopName, { color: pt.deleted ? colors.textSecondary : colors.textPrimary }]}
                numberOfLines={1}
              >
                {pt.name}
                {pt.offTrack ? ' · off-track' : ''}
              </Text>
              <Text style={[styles.stopKm, { color: colors.textSecondary }]}>
                km {pt.km.toFixed(1)}
              </Text>
            </View>
            {mode === 'build' && (
              <View style={styles.stopControls}>
                <Pressable
                  onPress={() => onMovePoint?.(i, -1)}
                  disabled={i === 0}
                  style={styles.stopControl}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${pt.name} earlier`}
                >
                  <Text style={[styles.stopControlText, { color: i === 0 ? colors.border : colors.accent }]}>↑</Text>
                </Pressable>
                <Pressable
                  onPress={() => onMovePoint?.(i, 1)}
                  disabled={i === points.length - 1}
                  style={styles.stopControl}
                  accessibilityRole="button"
                  accessibilityLabel={`Move ${pt.name} later`}
                >
                  <Text style={[styles.stopControlText, { color: i === points.length - 1 ? colors.border : colors.accent }]}>↓</Text>
                </Pressable>
                <Pressable
                  onPress={() => onRemovePoint?.(i)}
                  style={styles.stopControl}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${pt.name} from route`}
                >
                  <Text style={[styles.stopControlText, { color: colors.alertRed }]}>✕</Text>
                </Pressable>
              </View>
            )}
          </View>
        ))}

        {/* Per-leg metrics (reuses the Measure result vocabulary) */}
        {metrics.legs.map((leg, i) => (
          <View key={`leg-${i}`} style={styles.legRow}>
            <Text style={[styles.legText, { color: colors.textSecondary }]} numberOfLines={2}>
              {leg.from.name} → {leg.to.name}: {leg.distanceKm.toFixed(1)} km
              {leg.straightLine
                ? ' · off-track ≈straight-line'
                : ` · +${Math.round(leg.ascentM)} m / -${Math.round(leg.descentM)} m · 💧${leg.waterSourceCount}`}
              {` · ${formatHours(leg.estimatedHours)}`}
            </Text>
          </View>
        ))}
      </ScrollView>

      {/* Live totals */}
      {points.length >= 2 && (
        <Text style={[styles.totals, { color: colors.textPrimary }]}>
          Total: {metrics.totalKm.toFixed(1)} km · ~{formatHours(metrics.totalHours)}
        </Text>
      )}

      {mode === 'build' ? (
        <View style={styles.saveRow}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Route name"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Route name"
            style={[
              styles.nameInput,
              { backgroundColor: colors.background, borderColor: colors.border, color: colors.textPrimary },
            ]}
          />
          <Pressable
            onPress={() => canSave && onSave?.(name.trim())}
            disabled={!canSave}
            style={[styles.actionButton, { backgroundColor: canSave ? colors.accent : colors.border }]}
            accessibilityRole="button"
            accessibilityLabel="Save route"
            accessibilityState={{ disabled: !canSave }}
          >
            <Text style={[styles.actionButtonText, { color: canSave ? colors.textInverse : colors.textSecondary }]}>
              Save
            </Text>
          </Pressable>
        </View>
      ) : (
        onExport && (
          <Pressable
            onPress={onExport}
            style={[styles.exportButton, { borderColor: colors.accent }]}
            accessibilityRole="button"
            accessibilityLabel="Export route as GPX"
          >
            <Text style={[styles.exportButtonText, { color: colors.accent }]}>Export GPX</Text>
          </Pressable>
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: spacing.md,
    borderRadius: radii.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.md,
    maxHeight: 340,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  title: {
    ...typography.titleLarge,
    flex: 1,
  },
  closeButton: {
    width: touchTarget.min,
    height: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: -spacing.sm,
    marginVertical: -spacing.xs,
  },
  closeIcon: {
    fontSize: glyphSizes.sm,
    fontWeight: '600',
  },
  hint: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  list: {
    marginTop: spacing.xs,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget.min,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stopIndex: {
    ...typography.caption,
    width: 22,
    fontVariant: ['tabular-nums'],
  },
  stopInfo: {
    flex: 1,
  },
  stopName: {
    ...typography.body,
    fontWeight: '500',
  },
  stopKm: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  stopControls: {
    flexDirection: 'row',
  },
  stopControl: {
    width: 40,
    height: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopControlText: {
    fontSize: glyphSizes.sm,
    fontWeight: '600',
  },
  legRow: {
    paddingVertical: spacing.xs,
  },
  legText: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  totals: {
    ...typography.body,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    marginTop: spacing.sm,
  },
  saveRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  nameInput: {
    ...typography.body,
    flex: 1,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    minHeight: touchTarget.min,
  },
  actionButton: {
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  exportButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  exportButtonText: {
    ...typography.body,
    fontWeight: '600',
  },
});
