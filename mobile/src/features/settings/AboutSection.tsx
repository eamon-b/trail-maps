/**
 * About section for Settings — the in-app route to the privacy policy.
 *
 * The store listings link the same URL, and app stores expect the policy to be
 * reachable from inside the app too, so this is the one place a hiker can read
 * what the app collects without leaving for a browser search. The policy is the
 * web app's copy (`public/privacy.html`, deployed to Vercel) rather than a
 * bundled duplicate: a bundled copy would need an app release to correct a
 * policy, and the store listing would drift from what the app shows.
 *
 * Opening leaves the app, so a failure (no browser, unhandled scheme) is
 * reported inline with the URL spelled out — a hiker with no browser can still
 * type it in — instead of silently doing nothing.
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { openURL } from 'expo-linking';
import { useTheme } from '../../theme';
import { radii, spacing, touchTarget, typography } from '../../tokens';

/**
 * Canonical privacy policy URL — the Vercel deploy of `public/privacy.html` in
 * this repo (the repo's homepage URL). Keep this in sync with the URL used on
 * the App Store / Play Store listings; store review flags a mismatch.
 */
export const PRIVACY_POLICY_URL = 'https://trail-maps.vercel.app/privacy.html';

/** Shown when the OS refuses to open the policy (no browser, blocked scheme). */
export const PRIVACY_OPEN_FAILED_MESSAGE = `Couldn't open the privacy policy. You can read it at ${PRIVACY_POLICY_URL}`;

export function AboutSection() {
  const { colors } = useTheme();
  const [error, setError] = useState<string | null>(null);

  const openPrivacyPolicy = useCallback(async () => {
    setError(null);
    try {
      await openURL(PRIVACY_POLICY_URL);
    } catch {
      setError(PRIVACY_OPEN_FAILED_MESSAGE);
    }
  }, []);

  return (
    <View style={styles.section}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>About</Text>

      <View
        style={[
          styles.panel,
          { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
        ]}
      >
        <View style={styles.row}>
          <View style={styles.rowMain}>
            <Text style={[styles.rowLabel, { color: colors.textSecondary }]}>Privacy policy</Text>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              What Tracknotes collects, where it’s stored, and how to delete it. Opens in your
              browser.
            </Text>
          </View>
          <Pressable
            onPress={() => void openPrivacyPolicy()}
            accessibilityRole="link"
            accessibilityLabel="Open privacy policy"
            accessibilityHint="Opens the Tracknotes privacy policy in your browser"
            hitSlop={spacing.sm}
            style={styles.action}
          >
            <Text style={[styles.actionLink, { color: colors.accent }]}>Read</Text>
          </Pressable>
        </View>

        {error ? (
          <Text style={[styles.error, { color: colors.danger }]} accessibilityRole="alert">
            {error}
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
  rowMain: { flex: 1, gap: spacing.xs },
  rowLabel: { ...typography.caption },
  hint: { ...typography.bodySmall },
  error: { ...typography.bodySmall },
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
