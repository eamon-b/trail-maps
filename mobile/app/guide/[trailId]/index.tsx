/**
 * Guide home — the three-pane shell (Map | Elevation | List).
 * The GuideProvider (in _layout) supplies the loaded, direction-applied trail.
 *
 * A community route gets a one-line status banner above the panes (Verified /
 * Unverified, or "No longer shared" once the server has taken it down, and
 * what that means), tapping through to its About screen.
 *
 * Any guide gets the "Updated guide data" banner when a newer copy of its trail
 * downloads while it is open (`GuideUpdateBanner`).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { isCommunityRouteId } from '@lib/community-types';
import { GuideView } from '../../../src/features/guide/GuideView';
import { GuideUpdateBanner } from '../../../src/features/guide/GuideUpdateBanner';
import { useTheme } from '../../../src/theme';
import { spacing, typography } from '../../../src/tokens';
import { getCommunityRouteInfo } from '../../../src/services/community-routes';
import {
  CommunityStatusPill,
  communityStatusExplanation,
} from '../../../src/features/community/CommunityUi';
import { useTrailDataStore } from '../../../src/state/trail-data-store';

export default function GuideScreen() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  return (
    <View style={styles.root}>
      {isCommunityRouteId(trailId) ? <CommunityBanner trailId={trailId} /> : null}
      <GuideUpdateBanner />
      <GuideView />
    </View>
  );
}

function CommunityBanner({ trailId }: { trailId: string }) {
  const { colors } = useTheme();
  const router = useRouter();
  // Re-read when the cached list changes (the About screen refreshes the row).
  useTrailDataStore((s) => s.revision);
  const info = getCommunityRouteInfo(trailId);
  const status = info?.status ?? 'unverified';
  const takenDown = info?.takenDown === true;
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/community-route', params: { id: trailId } })}
      accessibilityRole="button"
      accessibilityHint={
        takenDown
          ? 'Opens details and the option to remove it from this phone'
          : "Opens details, reporting and the route's licence"
      }
      style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <CommunityStatusPill status={status} takenDown={takenDown} />
      <Text style={[styles.text, { color: colors.textSecondary }]} numberOfLines={2}>
        {communityStatusExplanation(status, takenDown)}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { ...typography.caption, flex: 1 },
});
