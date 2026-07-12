import { useCallback, useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, ActivityIndicator, Text, TextInput, Pressable, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Paths, File } from 'expo-file-system';
import { ThemeProvider, useTheme, BottomSheetProvider } from '../src/theme';
import { FocusedWaypointProvider } from '../src/theme/FocusedWaypointContext';
import { TrailDataService } from '../src/services/trail-data-service';
import { loadBundledTrails } from '../src/services/trail-loader';
import { closeDatabase } from '../src/db/database';
import { setHapticsEnabled } from '../src/components/haptics';
import { HAPTIC_FEEDBACK_KEY } from './settings';
import { spacing, radii, touchTarget } from '../src/tokens/spacing';
import { typography, MAX_FONT_SCALE } from '../src/tokens/typography';

/**
 * Global OS font-scale clamp (P2 plan decision 4: "clamp, don't disable").
 * Every RN <Text>/<TextInput> in the app grows with the accessibility text
 * size up to MAX_FONT_SCALE (1.4×) and then stops, so fixed/min-height rows
 * degrade gracefully instead of clipping — without threading a prop through
 * every component. AppText still sets maxFontSizeMultiplier explicitly for
 * callers that want it spelled out; this just changes the default.
 *
 * RN 0.81 exposes no public API for a default maxFontSizeMultiplier, so we
 * assign to the component's `defaultProps` at module scope. It's the
 * documented-workaround mechanism; `defaultProps` isn't in RN's public types,
 * hence the guarded cast. Runs once on first import (before any screen mounts).
 */
type DefaultableComponent = { defaultProps?: { maxFontSizeMultiplier?: number } };
for (const Component of [Text, TextInput] as unknown as DefaultableComponent[]) {
  Component.defaultProps = {
    ...Component.defaultProps,
    maxFontSizeMultiplier: MAX_FONT_SCALE,
  };
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.flex}>
      <ThemeProvider>
        <BottomSheetProvider>
          <FocusedWaypointProvider>
            <ThemedStatusBar />
            <RootContent />
          </FocusedWaypointProvider>
        </BottomSheetProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

/** Data initialization + themed loading/error screens, inside the providers */
function RootContent() {
  const { colors } = useTheme();
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    async function init() {
      try {
        // Hydrate the haptics preference before any UI can fire feedback.
        // Absent (null) means default on; only an explicit 'false' disables.
        const hapticPref = await AsyncStorage.getItem(HAPTIC_FEEDBACK_KEY);
        setHapticsEnabled(hapticPref !== 'false');

        const service = await TrailDataService.create();
        await loadBundledTrails(service);
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    init();
  }, [retryCount]);

  const handleReset = useCallback(async () => {
    try {
      await closeDatabase();
      for (const name of ['trail-companion.db', 'trail-companion.db-wal', 'trail-companion.db-shm']) {
        try {
          const f = new File(Paths.document, 'SQLite', name);
          if (f.exists) f.delete();
        } catch { /* ignore missing files */ }
      }
      await AsyncStorage.clear();
    } catch {
      // Best effort
    }
    // Clear error state to retry initialization
    setError(null);
    setReady(false);
    setRetryCount(c => c + 1);
  }, []);

  if (error) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Text style={[styles.error, { color: colors.danger }]}>
          Failed to initialize: {error}
        </Text>
        <Pressable
          onPress={handleReset}
          style={[styles.resetButton, { backgroundColor: colors.danger }]}
          accessibilityRole="button"
          accessibilityLabel="Reset app data"
        >
          <Text style={[styles.resetText, { color: colors.dangerText }]}>Reset App Data</Text>
        </Pressable>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loading, { color: colors.textSecondary }]}>
          Loading trail data...
        </Text>
      </View>
    );
  }

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="trail" />
      <Stack.Screen name="plan" />
      <Stack.Screen name="import" options={{ presentation: 'modal' }} />
      <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
    </Stack>
  );
}

/** Applies the theme's statusBarStyle to the system status bar */
function ThemedStatusBar() {
  const { colors } = useTheme();
  return <StatusBar style={colors.statusBarStyle === 'light' ? 'light' : 'dark'} />;
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  loading: {
    ...typography.body,
    marginTop: spacing.md,
  },
  error: {
    ...typography.body,
    textAlign: 'center',
  },
  resetButton: {
    marginTop: spacing.xl,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
    justifyContent: 'center',
    borderRadius: radii.md,
  },
  resetText: {
    ...typography.body,
    fontWeight: '600',
  },
});
