import { Stack, useRouter } from 'expo-router';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from '../src/theme';
import { glyphSizes, spacing } from '../src/tokens';
import { pickGpxFile } from '../src/features/import/import-gpx';
import { useIncomingFile } from '../src/features/import/incoming-file';

function ThemedStack() {
  const { colors } = useTheme();
  const router = useRouter();

  // A GPX or .tracknotes.json opened from outside the app — a file manager's
  // "open with", a downloaded attachment, the share sheet — arrives as a launch
  // URL rather than through the picker below, and lands on the same review
  // screen. Mounted here because it is the one component guaranteed to exist
  // for the whole app lifetime.
  useIncomingFile();

  // The picker runs here rather than on the import screen so that screen only
  // ever has to process a URI it was given — see app/import.tsx.
  const onImport = async () => {
    try {
      const picked = await pickGpxFile();
      if (!picked) return;
      router.push({
        pathname: '/import',
        params: { uri: picked.uri, fileName: picked.fileName },
      });
    } catch (err: unknown) {
      Alert.alert(
        'Could not open that file',
        err instanceof Error ? err.message : 'The file picker failed.',
      );
    }
  };

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
            // ＋ imports a GPX file as a new guide. ⚙ is the same affordance
            // as the guide header — Settings is app-wide, so it must be
            // reachable without opening a guide first.
            headerRight: () => (
              <View style={styles.headerActions}>
                <Pressable
                  accessibilityLabel="Import GPX"
                  accessibilityRole="button"
                  onPress={() => void onImport()}
                  style={styles.headerButton}
                  hitSlop={spacing.sm}
                >
                  <Text style={[styles.icon, { color: colors.accentText }]}>＋</Text>
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
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
        {/* Modal: review an imported GPX before it becomes a guide. */}
        <Stack.Screen
          name="import"
          options={{ title: 'Import GPX', presentation: 'modal' }}
        />
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
