/**
 * Guide home — the three-pane shell (Map | Elevation | List).
 * The GuideProvider (in _layout) supplies the loaded, direction-applied trail.
 *
 * A community route gets a one-line status banner above the panes (Verified /
 * Unverified and what that means), tapping through to its About screen.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { isCommunityRouteId } from '@lib/community-types';
import { GuideView } from '../../../src/features/guide/GuideView';
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
  if (!isCommunityRouteId(trailId)) return <GuideView />;
  return (
    <View style={styles.root}>
      <CommunityBanner trailId={trailId} />
      <GuideView />
    </View>
  );
}

function CommunityBanner({ trailId }: { trailId: string }) {
  const { colors } = useTheme();
  const router = useRouter();
  // Re-read when the cached list changes (the About screen refreshes the row).
  useTrailDataStore((s) => s.revision);
  const status = getCommunityRouteInfo(trailId)?.status ?? 'unverified';
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/guide/[trailId]/community', params: { trailId } })}
      accessibilityRole="button"
      accessibilityHint="Opens details, reporting and the route's licence"
      style={[styles.banner, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <CommunityStatusPill status={status} />
      <Text style={[styles.text, { color: colors.textSecondary }]} numberOfLines={2}>
        {communityStatusExplanation(status)}
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
