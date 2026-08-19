/**
 * Guide navigator — a nested Stack scoped to one trail.
 *
 * Wraps its screens in a GuideProvider so `index` and `downloads` share a
 * single loaded (and direction-applied) trail. The header exposes the guide
 * title plus quick actions: app settings, and a ⋯ overflow menu holding the
 * guide-scoped actions (Routes, Plan, Offline maps).
 *
 * Issue #26 preview: these three used to be always-visible inline glyphs, so
 * the header carried four buttons (⋔ ▤ ⤓ ⚙) and React Navigation ate the
 * *title* to make room. Settings stays inline — it is the one app-level (not
 * guide-scoped) action and the conventional always-there gear.
 */

import { useMemo } from 'react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../src/theme';
import { glyphSizes, spacing, touchTarget } from '../../../src/tokens';
import { getTrailIndexEntry } from '../../../src/services/trail-loader';
import { GuideProvider } from '../../../src/features/guide/GuideContext';
import { GuidePositionProvider } from '../../../src/features/guide/GuidePositionContext';
import {
  GuideHeaderMenu,
  type GuideMenuItem,
} from '../../../src/features/guide/GuideHeaderMenu';

export default function GuideLayout() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const entry = getTrailIndexEntry(trailId);

  const menuItems = useMemo<GuideMenuItem[]>(
    () => [
      {
        key: 'routes',
        label: 'Routes',
        glyph: '⋔',
        onPress: () =>
          router.push({ pathname: '/guide/[trailId]/routes', params: { trailId } }),
      },
      {
        key: 'plan',
        label: 'Plan',
        glyph: '▤',
        onPress: () =>
          router.push({ pathname: '/guide/[trailId]/plan', params: { trailId } }),
      },
      {
        key: 'downloads',
        label: 'Offline maps',
        glyph: '⤓',
        onPress: () =>
          router.push({ pathname: '/guide/[trailId]/downloads', params: { trailId } }),
      },
    ],
    [router, trailId],
  );

  return (
    <GuideProvider trailId={trailId}>
      {/* Hoisted so the index panes AND the waypoint detail screen share one
          GPS session (distance-from-me / ETA on the detail screen). */}
      <GuidePositionProvider>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.accent },
          headerTintColor: colors.accentText,
          headerTitleStyle: { color: colors.accentText },
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: entry?.shortName ?? entry?.name ?? 'Guide',
            headerRight: () => (
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityLabel="Settings"
                  accessibilityRole="button"
                  onPress={() => router.push('/settings')}
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>⚙</Text>
                </Pressable>
                {/* Overflow sits last: the far right is where both platforms
                    put it, and the popover right-aligns beneath it. */}
                <GuideHeaderMenu items={menuItems} tintColor={colors.accentText} />
              </View>
            ),
          }}
        />
        <Stack.Screen name="downloads" options={{ title: 'Offline maps' }} />
        <Stack.Screen name="routes" options={{ title: 'Routes' }} />
        <Stack.Screen name="plan" options={{ title: 'Plan' }} />
        {/* Title is overridden with the waypoint name from within the screen. */}
        <Stack.Screen name="waypoint/[waypointId]" options={{ title: 'Waypoint' }} />
      </Stack>
      </GuidePositionProvider>
    </GuideProvider>
  );
}

const styles = StyleSheet.create({
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerButton: {
    paddingHorizontal: spacing.sm,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  icon: {
    fontSize: glyphSizes.lg,
  },
});
