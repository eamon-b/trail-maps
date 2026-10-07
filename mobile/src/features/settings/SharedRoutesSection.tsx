/**
 * Settings' "My shared routes" row — the way to `app/my-shared-routes.tsx`.
 *
 * A route hidden by the review, by reports or by a moderator is gone from the
 * community list and so from My Guides; this is how its owner finds it again.
 * Hidden in a build with no API, where nothing can have been shared.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';
import { isApiConfigured } from '../../api/client';

export function SharedRoutesSection() {
  const { colors } = useTheme();
  const router = useRouter();
  if (!isApiConfigured()) return null;

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>My shared routes</Text>
      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <View style={styles.row}>
          <Text style={[styles.hint, styles.rowMain, { color: colors.textSecondary }]}>
            Routes you shared to the community, with their status, including any hidden from the
            list.
          </Text>
          <Pressable
            onPress={() => router.push('/my-shared-routes')}
            accessibilityRole="button"
            accessibilityLabel="View my shared routes"
            hitSlop={spacing.sm}
            style={styles.action}
          >
            <Text style={[styles.actionLink, { color: colors.accent }]}>View</Text>
          </Pressable>
        </View>
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
