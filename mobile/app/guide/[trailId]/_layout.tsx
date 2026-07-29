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

export default function GuideLayout() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const entry = getTrailIndexEntry(trailId);

  return (
    <GuideProvider trailId={trailId}>
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
                  accessibilityLabel="Offline maps"
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
      </Stack>
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
