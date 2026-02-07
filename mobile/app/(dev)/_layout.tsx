import { Stack } from 'expo-router';
import { useTheme } from '../../src/theme';

export default function DevLayout() {
  const { colors } = useTheme();

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.textPrimary,
        headerTitleStyle: { color: colors.textPrimary },
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Dev Catalog' }} />
      <Stack.Screen name="cards" options={{ title: 'Cards' }} />
      <Stack.Screen name="bottom-sheet" options={{ title: 'Bottom Sheet' }} />
      <Stack.Screen name="mode-selector" options={{ title: 'Mode Selector' }} />
      <Stack.Screen name="alerts" options={{ title: 'Alerts' }} />
      <Stack.Screen name="day-plan-card" options={{ title: 'Day Plan Card' }} />
      <Stack.Screen name="typography" options={{ title: 'Typography' }} />
      <Stack.Screen name="colors" options={{ title: 'Colors' }} />
    </Stack>
  );
}
