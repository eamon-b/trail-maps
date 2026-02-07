import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { View, ActivityIndicator, Text, StyleSheet } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { ThemeProvider, useTheme, BottomSheetProvider } from '../src/theme';
import { FocusedWaypointProvider } from '../src/theme/FocusedWaypointContext';
import { TrailDataService } from '../src/services/trail-data-service';
import { loadBundledTrails } from '../src/services/trail-loader';

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

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Failed to initialize: {error}</Text>
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
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="trail" />
              {__DEV__ && <Stack.Screen name="(dev)" />}
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
});
