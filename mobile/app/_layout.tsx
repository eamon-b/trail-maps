import { useCallback, useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, ActivityIndicator, Text, Pressable, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Paths, File } from 'expo-file-system';
import { ThemeProvider, useTheme, BottomSheetProvider } from '../src/theme';
import { FocusedWaypointProvider } from '../src/theme/FocusedWaypointContext';
import { TrailDataService } from '../src/services/trail-data-service';
import { loadBundledTrails } from '../src/services/trail-loader';
import { closeDatabase } from '../src/db/database';

export default function RootLayout() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const service = await TrailDataService.create();
        await loadBundledTrails(service);
        setReady(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
    init();
  }, []);

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
  }, []);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to initialize: {error}</Text>
        <Pressable onPress={handleReset} style={styles.resetButton}>
          <Text style={styles.resetText}>Reset App Data</Text>
        </Pressable>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#4CAF50" />
        <Text style={styles.loading}>Loading trail data...</Text>
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <BottomSheetProvider>
          <FocusedWaypointProvider>
            <ThemedStatusBar />
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="index" />
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="trail" />
              <Stack.Screen name="plan" />
              <Stack.Screen name="import" options={{ presentation: 'modal' }} />
              <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
            </Stack>
          </FocusedWaypointProvider>
        </BottomSheetProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

/** Applies the theme's statusBarStyle to the system status bar */
function ThemedStatusBar() {
  const { colors } = useTheme();
  return <StatusBar style={colors.statusBarStyle === 'light' ? 'light' : 'dark'} />;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  loading: {
    marginTop: 12,
    fontSize: 16,
    color: '#666',
  },
  error: {
    fontSize: 16,
    color: '#d32f2f',
    textAlign: 'center',
  },
  resetButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#d32f2f',
    borderRadius: 8,
  },
  resetText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
});
