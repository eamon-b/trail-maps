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
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { spacing } from '../../tokens';
import { ElevationPane } from '../elevation/ElevationPane';
import { MapPane } from '../map/MapPane';
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
});
