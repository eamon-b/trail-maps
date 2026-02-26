import { Stack } from 'expo-router';
import { TrailDataProvider } from '../../src/contexts/TrailDataContext';

export default function TrailLayout() {
  return (
    <TrailDataProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="overview" />
        <Stack.Screen name="datasheet" />
        <Stack.Screen name="[id]" />
      </Stack>
    </TrailDataProvider>
  );
}
