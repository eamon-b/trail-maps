import { Stack, useRouter } from 'expo-router';
import { Alert } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import { ThemeProvider, useTheme } from '../src/theme';
import { HeaderActions, HeaderIconButton } from '../src/navigation/HeaderIconButton';
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
            // `plus` imports a GPX file as a new guide. `cog` is the same
            // affordance — and the same icon — as the guide header: Settings is
            // app-wide, so it must be reachable without opening a guide first.
            headerRight: () => (
              <HeaderActions>
                <HeaderIconButton
                  name="plus"
                  accessibilityLabel="Import GPX"
                  onPress={() => void onImport()}
                />
                <HeaderIconButton
                  name="cog"
                  accessibilityLabel="Settings"
                  onPress={() => router.push('/settings')}
                />
              </HeaderActions>
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
