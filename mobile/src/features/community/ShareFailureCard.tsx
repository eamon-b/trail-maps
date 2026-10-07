/**
 * Why a share failed (`app/share-route.tsx`): the message, the server's checks
 * on a 422 and, on a 409 naming the hiker's own earlier route (`existingId`),
 * a "View my shared routes" button — the route may be hidden, and that screen
 * is the only place a hidden route can be seen.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { ChecksList } from './CommunityUi';
import type { ShareFailure } from './share-form';

export function ShareFailureCard({
  failure,
  onViewMyRoutes,
}: {
  failure: ShareFailure;
  onViewMyRoutes: (existingId: string) => void;
}) {
  const { colors } = useTheme();
  const existingId = failure.existingId;
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.danger }]}>
      <Text style={[styles.title, { color: colors.danger }]}>{failure.message}</Text>
      {failure.checks ? <ChecksList checks={failure.checks} /> : null}
      {existingId ? (
        <Pressable
          onPress={() => onViewMyRoutes(existingId)}
          accessibilityRole="button"
          accessibilityLabel="View my shared routes"
          style={({ pressed }) => [
            styles.button,
            { borderColor: colors.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.title, { color: colors.accent }]}>View my shared routes</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: { ...typography.titleSmall },
  button: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  pressed: { opacity: 0.6 },
});
