/**
 * Settings' "Guide updates" row — check the trail catalog now rather than at
 * the next automatic check (on launch and foreground, at most every six hours).
 *
 * The same check as pull-to-refresh on My Guides, community list included. A
 * guide that is open when an update lands offers to reload (`GuideUpdateBanner`),
 * so the result line says so. Hidden in a build with no tile base URL, which
 * runs on its bundled data alone.
 */

import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import {
  checkForTrailDataUpdates,
  trailDataBaseUrl,
  type TrailDataCheckResult,
} from '../../services/trail-data-updates';
import { refreshCommunityRoutes } from '../../services/community-routes';
import { useTrailDataStore } from '../../state/trail-data-store';

/** The line under the button after a check. Exported for tests. */
export function guideUpdateResultText(result: TrailDataCheckResult): string {
  if (result.error) return `Couldn’t check for updates. ${result.error}`;
  if (!result.checked && result.failed.length === 0) return 'Couldn’t check for updates.';
  const n = result.updated.length;
  const updated =
    n === 0
      ? ''
      : `${n === 1 ? '1 guide was' : `${n} guides were`} updated. An open guide offers to reload. `;
  if (result.failed.length > 0) {
    return `${updated}Some updates failed and will be tried again next time.`.trim();
  }
  return n === 0 ? 'Every guide is up to date.' : updated.trim();
}

export function GuideUpdatesSection() {
  const { colors } = useTheme();
  // A check started anywhere (launch, foreground, pull-to-refresh) is joined
  // by this one, so show it as running.
  const checking = useTrailDataStore((s) => s.checking);
  const [result, setResult] = useState<string | null>(null);

  const onCheck = useCallback(async () => {
    setResult(null);
    const [check] = await Promise.all([
      checkForTrailDataUpdates({ force: true }),
      // Best effort: an offline community list keeps showing the cached one.
      refreshCommunityRoutes({ force: true }),
    ]);
    setResult(guideUpdateResultText(check));
  }, []);

  if (!trailDataBaseUrl()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>Guide updates</Text>
      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <View style={styles.row}>
          <Text style={[styles.hint, styles.rowMain, { color: colors.textSecondary }]}>
            Guides check for corrected trail data when the app opens, at most every six hours.
          </Text>
          <Pressable
            onPress={() => void onCheck()}
            disabled={checking}
            accessibilityRole="button"
            accessibilityLabel="Check for guide updates"
            accessibilityState={{ busy: checking }}
            hitSlop={spacing.sm}
            style={styles.action}
          >
            {checking ? (
              <ActivityIndicator accessibilityLabel="Checking for updates" color={colors.accent} />
            ) : (
              <Text style={[styles.actionLink, { color: colors.accent }]}>Check now</Text>
            )}
          </Pressable>
        </View>
        {result && !checking ? (
          <Text
            accessibilityLiveRegion="polite"
            style={[styles.hint, { color: colors.textPrimary }]}
          >
            {result}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: spacing.sm },
  label: { ...typography.titleLarge },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  rowMain: { flex: 1 },
  hint: { ...typography.bodySmall },
  action: {
    minHeight: touchTarget.min,
    minWidth: touchTarget.min,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.sm,
  },
  actionLink: { ...typography.titleSmall },
});
