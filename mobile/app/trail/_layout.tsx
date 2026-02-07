import { Stack } from 'expo-router';

export default function TrailLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="overview" />
      <Stack.Screen name="[id]" />
    </Stack>
  );
}
