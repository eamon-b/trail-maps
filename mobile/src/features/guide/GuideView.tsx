/**
 * The guide three-pane shell: a segmented control switches Map | Elevation |
 * List. All three panes stay mounted; inactive panes are frozen with
 * `display: 'none'` and `pointerEvents="none"` so switching is instant and no
 * pane loses its scroll position or re-runs expensive work.
 *
 * Phase 1: Map and Elevation are themed placeholders. The List pane is real.
 * The MapLibre map lands after the first on-device boot (see notes below).
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { useDownloadsStore } from '../../state/downloads-store';
import { useGuide } from './GuideContext';
import { SegmentedControl } from './SegmentedControl';
import { WaypointListPane } from './WaypointListPane';

type PaneKey = 'map' | 'elevation' | 'list';

const OPTIONS = [
  { value: 'map' as const, label: 'Map' },
  { value: 'elevation' as const, label: 'Elevation' },
  { value: 'list' as const, label: 'List' },
];

export function GuideView() {
  const { colors } = useTheme();
  const { trail } = useGuide();
  const [pane, setPane] = useState<PaneKey>('map');

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <View style={styles.header}>
        <SegmentedControl options={OPTIONS} value={pane} onChange={setPane} />
      </View>

      <View style={styles.panes}>
        <FrozenPane active={pane === 'map'}>
          <MapPane />
        </FrozenPane>
        <FrozenPane active={pane === 'elevation'}>
          <ElevationPane />
        </FrozenPane>
        <FrozenPane active={pane === 'list'}>
          <WaypointListPane trail={trail} />
        </FrozenPane>
      </View>
    </View>
  );
}

/** Keeps children mounted; hides + disables them when inactive. */
function FrozenPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <View
      style={[StyleSheet.absoluteFill, !active && styles.hidden]}
      pointerEvents={active ? 'auto' : 'none'}
    >
      {children}
    </View>
  );
}

function MapPane() {
  const { colors } = useTheme();
  const { trailId } = useGuide();
  const download = useDownloadsStore((s) => s.byTrail[trailId]);
  const complete = download?.state === 'complete';

  return (
    <View style={[styles.placeholder, { backgroundColor: colors.surface }]}>
      <Text style={[styles.placeholderTitle, { color: colors.textPrimary }]}>Map</Text>
      <Text
        style={[
          styles.placeholderStatus,
          { color: complete ? colors.downloadDone : colors.textSecondary },
        ]}
      >
        {complete ? 'Offline maps ready' : 'Online — no offline maps downloaded'}
      </Text>
      <Text style={[styles.placeholderHint, { color: colors.textSecondary }]}>
        The interactive map lands after the first on-device boot.
      </Text>
    </View>
  );
}

function ElevationPane() {
  const { colors } = useTheme();
  return (
    <View style={[styles.placeholder, { backgroundColor: colors.surface }]}>
      <Text style={[styles.placeholderTitle, { color: colors.textPrimary }]}>Elevation</Text>
      <Text style={[styles.placeholderHint, { color: colors.textSecondary }]}>
        Elevation profile coming soon.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    padding: spacing.lg,
  },
  panes: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  placeholderTitle: {
    ...typography.displaySmall,
  },
  placeholderStatus: {
    ...typography.dataSmall,
    textAlign: 'center',
  },
  placeholderHint: {
    ...typography.bodySmall,
    textAlign: 'center',
  },
});
