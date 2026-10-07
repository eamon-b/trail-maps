/**
 * The rows of "My shared routes" (`app/my-shared-routes.tsx`): a card per
 * route the hiker shared — name, place, length, status pill and, for a hidden
 * route, why — and the detail it expands into: description, credit, the
 * automatic checks, what the review said, and Delete / Open guide.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { CommunityRouteDetail } from '@lib/community-types';
import { formatDistance } from '@lib/format-distance';
import { countryName, stateName } from '@lib/trail-regions';
import { useTheme } from '../../theme';
import { glyphSizes, radii, spacing, touchTarget, typography } from '../../tokens';
import type { Units } from '../../state/settings-store';
import { ChecksList, CommunityStatusPill, communityStatusExplanation } from './CommunityUi';
import { hiddenReasonText } from './my-shared-routes';

/** "Australia · Victoria · 12.4 km" */
export function routePlaceLine(
  route: Pick<CommunityRouteDetail, 'country' | 'state' | 'lengthKm'>,
  units: Units,
): string {
  return [countryName(route.country), stateName(route.country, route.state), formatDistance(route.lengthKm, units)]
    .filter(Boolean)
    .join(' · ');
}

export function MySharedRouteCard({
  route,
  units,
  expanded,
  onPress,
  children,
}: {
  route: CommunityRouteDetail;
  units: Units;
  expanded: boolean;
  onPress: () => void;
  /** The expanded detail, drawn inside the card. */
  children?: ReactNode;
}) {
  const { colors } = useTheme();
  const why = hiddenReasonText(route);
  const summary = why ? route.review?.summary?.trim() : undefined;
  return (
    <View
      style={[styles.card, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel={route.name}
        accessibilityHint={expanded ? 'Hides the details' : 'Shows the details'}
        style={({ pressed }) => [styles.header, pressed && styles.pressed]}
      >
        <View style={styles.headerMain}>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={2}>
            {route.name}
          </Text>
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            {routePlaceLine(route, units)}
          </Text>
          <CommunityStatusPill status={route.status} />
          {why ? <Text style={[styles.why, { color: colors.danger }]}>{why}</Text> : null}
          {summary ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={expanded ? undefined : 2}>
              {summary}
            </Text>
          ) : null}
        </View>
        <MaterialCommunityIcons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={glyphSizes.lg}
          color={colors.textSecondary}
        />
      </Pressable>
      {expanded ? children : null}
    </View>
  );
}

export function MySharedRouteDetail({
  route,
  deleting,
  onDelete,
  onOpenGuide,
}: {
  route: CommunityRouteDetail;
  deleting: boolean;
  onDelete: () => void;
  /** Given only when the route is shared and can open as a guide. */
  onOpenGuide?: () => void;
}) {
  const { colors } = useTheme();
  const review = route.review;
  const concerns = review?.concerns?.filter((c) => c.trim().length > 0) ?? [];
  return (
    <View style={[styles.detail, { borderTopColor: colors.border }]}>
      {route.status !== 'hidden' ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          {communityStatusExplanation(route.status)}
        </Text>
      ) : (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          Only you can see this route. It stays off the community list until a moderator restores it.
        </Text>
      )}

      <Text style={[styles.body, { color: colors.textPrimary }]}>{route.description}</Text>
      {route.credit ? (
        <Text style={[styles.meta, { color: colors.textSecondary }]}>Credit: {route.credit}</Text>
      ) : null}

      {route.checks.length > 0 ? (
        <View style={styles.block}>
          <Text style={[styles.blockTitle, { color: colors.textPrimary }]}>Automatic checks</Text>
          <ChecksList checks={route.checks} />
        </View>
      ) : null}

      {review && (review.status === 'pending' || review.summary || concerns.length > 0) ? (
        <View style={styles.block}>
          <Text style={[styles.blockTitle, { color: colors.textPrimary }]}>Automatic review</Text>
          {review.status === 'pending' ? (
            <Text style={[styles.meta, { color: colors.textSecondary }]}>
              The review has not finished yet.
            </Text>
          ) : null}
          {review.summary ? (
            <Text style={[styles.body, { color: colors.textPrimary }]}>{review.summary}</Text>
          ) : null}
          {concerns.map((c) => (
            <View key={c} style={styles.concern}>
              <MaterialCommunityIcons name="alert" size={glyphSizes.sm} color={colors.warning} />
              <Text style={[styles.meta, styles.concernText, { color: colors.textPrimary }]}>{c}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.actions}>
        {onOpenGuide ? (
          <Pressable
            onPress={onOpenGuide}
            accessibilityRole="button"
            accessibilityLabel={`Open ${route.name} as a guide`}
            style={({ pressed }) => [
              styles.button,
              { borderColor: colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.buttonText, { color: colors.accent }]}>Open guide</Text>
          </Pressable>
        ) : null}
        <Pressable
          onPress={onDelete}
          disabled={deleting}
          accessibilityRole="button"
          accessibilityLabel={`Delete ${route.name}`}
          accessibilityState={{ disabled: deleting }}
          style={({ pressed }) => [
            styles.button,
            { borderColor: colors.danger },
            pressed && styles.pressed,
          ]}
        >
          {deleting ? (
            <ActivityIndicator color={colors.danger} />
          ) : (
            <Text style={[styles.buttonText, { color: colors.danger }]}>Delete shared route</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  header: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  headerMain: { flex: 1, gap: spacing.xs },
  name: { ...typography.titleSmall },
  meta: { ...typography.bodySmall },
  why: { ...typography.bodySmall },
  body: { ...typography.body },
  detail: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.md,
    gap: spacing.md,
  },
  block: { gap: spacing.sm },
  blockTitle: { ...typography.titleSmall },
  concern: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  concernText: { flex: 1 },
  actions: { gap: spacing.sm },
  button: {
    minHeight: touchTarget.min,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
