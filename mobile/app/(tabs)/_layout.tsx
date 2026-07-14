import { useCallback } from 'react';
import { BackHandler, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme, useBottomSheetDismiss } from '../../src/theme';
import { resolveTheme, type AppMode } from '../../src/tokens/themes';
import { ModeSelector } from '../../src/components/ModeSelector';

export default function TabLayout() {
  const { mode, setMode, colors, themeVariant } = useTheme();
  const { dismissSheet } = useBottomSheetDismiss();

  // Android back button: dismiss bottom sheet if open, otherwise allow default behavior
  useFocusEffect(
    useCallback(() => {
      const handler = BackHandler.addEventListener('hardwareBackPress', () => {
        return dismissSheet();
      });
      return () => handler.remove();
    }, [dismissSheet]),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ModeSelector />
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: colors.accent,
          tabBarInactiveTintColor: colors.textSecondary,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
          },
          headerStyle: {
            backgroundColor: colors.surface,
          },
          headerTintColor: colors.accent,
          headerTitleStyle: { color: colors.textPrimary },
        }}
        screenListeners={{
          tabPress: (e) => {
            // Sync mode when tab is pressed
            const routeName = e.target?.split('-')[0] as AppMode | undefined;
            if (routeName && routeName !== mode && ['plan', 'hike', 'contribute'].includes(routeName)) {
              setMode(routeName);
            }
          },
        }}
      >
        <Tabs.Screen
          name="plan"
          options={{
            title: 'Plan',
            headerShown: false,
            tabBarActiveTintColor: resolveTheme(themeVariant, 'plan').accent,
            headerTintColor: resolveTheme(themeVariant, 'plan').accent,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? 'map' : 'map-outline'} color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="hike"
          options={{
            title: 'Hike',
            tabBarActiveTintColor: resolveTheme(themeVariant, 'hike').accent,
            headerTintColor: resolveTheme(themeVariant, 'hike').accent,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? 'footsteps' : 'footsteps-outline'} color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="contribute"
          options={{
            title: 'Contribute',
            tabBarActiveTintColor: resolveTheme(themeVariant, 'contribute').accent,
            headerTintColor: resolveTheme(themeVariant, 'contribute').accent,
            tabBarIcon: ({ color, size, focused }) => (
              <Ionicons name={focused ? 'add-circle' : 'add-circle-outline'} color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}
