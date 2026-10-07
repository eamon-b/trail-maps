/**
 * Small pieces shared by the community screens (`app/share-route.tsx`,
 * `app/guide/[trailId]/community.tsx`): the check results list, a row of
 * choice chips, and the Verified/Unverified/"No longer shared" pill.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { CommunityCheck, CommunityRouteStatus } from '@lib/community-types';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, typography } from '../../tokens';

/** One line per check: icon, message. Passing checks are listed too, so the list reads as a report. */
export function ChecksList({ checks }: { checks: readonly CommunityCheck[] }) {
  const { colors } = useTheme();
  return (
    <View style={styles.checks}>
      {checks.map((c) => {
        const tone =
          c.level === 'fail' ? colors.danger : c.level === 'warn' ? colors.warning : colors.success;
        const icon =
          c.level === 'fail' ? 'close-circle' : c.level === 'warn' ? 'alert' : 'check-circle';
        return (
          <View
            key={`${c.id}-${c.message}`}
            style={styles.checkRow}
            accessible
            accessibilityLabel={`${c.level === 'pass' ? 'Passed' : c.level === 'warn' ? 'Warning' : 'Failed'}: ${c.message}`}
          >
            <MaterialCommunityIcons name={icon} size={glyphSizes.sm} color={tone} />
            <Text style={[styles.checkText, { color: colors.textPrimary }]}>{c.message}</Text>
          </View>
        );
      })}
    </View>
  );
}

export interface Choice {
  value: string;
  label: string;
}

/** A wrapping row of single-select chips. */
export function ChoiceChips({
  choices,
  selected,
  onSelect,
  accessibilityLabel,
}: {
  choices: readonly Choice[];
  selected: string | null;
  onSelect: (value: string) => void;
  accessibilityLabel: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.chips} accessibilityLabel={accessibilityLabel} accessibilityRole="radiogroup">
      {choices.map((choice) => {
        const on = choice.value === selected;
        return (
          <Pressable
            key={choice.value}
            onPress={() => onSelect(choice.value)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            style={[
              styles.chip,
              {
                borderColor: on ? colors.accent : colors.border,
                backgroundColor: on ? colors.accent : colors.surface,
              },
            ]}
          >
            <Text style={[styles.chipLabel, { color: on ? colors.accentText : colors.textPrimary }]}>
              {choice.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * "Verified" (an admin approved it) or "Unverified" (passed the automatic
 * checks only) — or "No longer shared" for a downloaded route the server has
 * since taken down (`takenDown`), whatever status it was downloaded under.
 */
export function CommunityStatusPill({
  status,
  takenDown = false,
}: {
  status: CommunityRouteStatus;
  takenDown?: boolean;
}) {
  const { colors } = useTheme();
  if (takenDown) {
    return (
      <View style={[styles.pill, { borderColor: colors.textSecondary }]}>
        <MaterialCommunityIcons
          name="cloud-off-outline"
          size={glyphSizes.xs}
          color={colors.textSecondary}
        />
        <Text style={[styles.pillLabel, { color: colors.textSecondary }]}>No longer shared</Text>
      </View>
    );
  }
  const verified = status === 'verified';
  const tone = verified ? colors.success : colors.warning;
  const label = verified ? 'Verified' : status === 'unverified' ? 'Unverified' : 'Hidden';
  return (
    <View style={[styles.pill, { borderColor: tone }]}>
      <MaterialCommunityIcons
        name={verified ? 'check-decagram' : 'account-group'}
        size={glyphSizes.xs}
        color={tone}
      />
      <Text style={[styles.pillLabel, { color: tone }]}>{label}</Text>
    </View>
  );
}

/** The one-line explanation that goes with the pill. */
export function communityStatusExplanation(
  status: CommunityRouteStatus,
  takenDown = false,
): string {
  if (takenDown) {
    return 'No longer shared: it was removed or hidden. The copy on this phone still opens until you remove it.';
  }
  if (status === 'verified') return 'Shared by a hiker and checked by the Tracknotes team.';
  if (status === 'hidden') return 'Hidden from the community list while it is looked at.';
  return 'Shared by a hiker. It passed automatic checks but no one has verified it.';
}

const styles = StyleSheet.create({
  checks: { gap: spacing.sm },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  checkText: { ...typography.bodySmall, flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.md,
  },
  chipLabel: { ...typography.bodySmall },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  pillLabel: { ...typography.caption },
});
