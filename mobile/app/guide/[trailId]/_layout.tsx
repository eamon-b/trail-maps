/**
 * Guide navigator — a nested Stack scoped to one trail.
 *
 * Wraps its screens in a GuideProvider so `index` and `downloads` share a
 * single loaded (and direction-applied) trail. The header exposes the guide
 * title plus quick actions: offline maps and app settings.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../../src/theme';
import { glyphSizes, spacing } from '../../../src/tokens';
import { getTrailIndexEntry } from '../../../src/services/trail-loader';
import { GuideProvider } from '../../../src/features/guide/GuideContext';
import { GuidePositionProvider } from '../../../src/features/guide/GuidePositionContext';

export default function GuideLayout() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const entry = getTrailIndexEntry(trailId);

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
                  accessibilityLabel="Routes"
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/routes',
                      params: { trailId },
                    })
                  }
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>⋔</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Plan"
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/plan',
                      params: { trailId },
                    })
                  }
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>▤</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Offline maps"
                  accessibilityRole="button"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/downloads',
                      params: { trailId },
                    })
                  }
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>⤓</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel="Settings"
                  accessibilityRole="button"
                  onPress={() => router.push('/settings')}
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>⚙</Text>
                </Pressable>
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
    gap: spacing.sm,
  },
  headerButton: {
    paddingHorizontal: spacing.sm,
  },
  icon: {
    fontSize: glyphSizes.lg,
  },
});
