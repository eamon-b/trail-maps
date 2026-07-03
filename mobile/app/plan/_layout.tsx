import { Stack } from 'expo-router';

export default function PlanLayout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="create" />
      <Stack.Screen name="[planId]" />
      <Stack.Screen name="map" />
      <Stack.Screen name="measure" />
      <Stack.Screen name="section-map" />
    </Stack>
  );
}
