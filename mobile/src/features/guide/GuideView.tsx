/**
 * The guide three-pane shell: a segmented control switches Map | Elevation |
 * List, with a direction toggle beside it and a shared GPS "what's next" strip
 * above the panes. All three panes stay mounted; inactive panes are frozen with
 * `display: 'none'` and `pointerEvents="none"` so switching is instant and no
 * pane loses its scroll position or re-runs expensive work.
 *
 * A single `GuidePositionProvider` wraps the whole view so the distance strip,
 * the map puck, the elevation marker, and the list distances all read one GPS
 * session in lockstep.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme';
import { spacing } from '../../tokens';
import { ElevationPane } from '../elevation/ElevationPane';
import { MapPane } from '../map/MapPane';
import { DirectionToggle } from './DirectionToggle';
import { DistanceStrip } from './DistanceStrip';
import { GuidePositionProvider } from './GuidePositionContext';
import { SegmentedControl } from './SegmentedControl';
import { WaypointListPane } from './WaypointListPane';
import { useGuide } from './GuideContext';

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
    <GuidePositionProvider>
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={styles.header}>
          <View style={styles.segmented}>
            <SegmentedControl options={OPTIONS} value={pane} onChange={setPane} />
          </View>
          <DirectionToggle />
        </View>

        <DistanceStrip />

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
    </GuidePositionProvider>
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  segmented: {
    flex: 1,
  },
  panes: {
    flex: 1,
  },
  hidden: {
    display: 'none',
  },
});
