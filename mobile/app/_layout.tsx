import { Stack, useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from '../src/theme';
import { glyphSizes, spacing } from '../src/tokens';

function ThemedStack() {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <>
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
            title: 'Tracknotes',
            // Same ⚙ affordance as the guide header — Settings is app-wide, so
            // it must be reachable without opening a guide first.
            headerRight: () => (
              <Pressable
                accessibilityLabel="Settings"
                accessibilityRole="button"
                onPress={() => router.push('/settings')}
                style={styles.headerButton}
                hitSlop={spacing.sm}
              >
                <Text style={[styles.icon, { color: colors.accentText }]}>⚙</Text>
              </Pressable>
            ),
          }}
        />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        {/* Guide group renders its own nested Stack (header + provider). */}
        <Stack.Screen name="guide/[trailId]" options={{ headerShown: false }} />
      </Stack>
      <StatusBar style={colors.statusBarStyle} />
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <ThemedStack />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  headerButton: {
    paddingHorizontal: spacing.sm,
  },
  icon: {
    fontSize: glyphSizes.lg,
  },
});
