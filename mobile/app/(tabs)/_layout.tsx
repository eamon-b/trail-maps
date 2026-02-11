import { useCallback } from 'react';
import { BackHandler, Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme, useBottomSheetDismiss } from '../../src/theme';
import { resolveTheme, type AppMode } from '../../src/tokens/themes';
import { ModeSelector } from '../../src/components/ModeSelector';

export default function TabLayout() {
  const { mode, setMode, colors, themeVariant } = useTheme();
  const { dismissSheet } = useBottomSheetDismiss();

  // Android back button: dismiss bottom sheet if open → otherwise no-op (don't exit app)
  useFocusEffect(
    useCallback(() => {
      const handler = BackHandler.addEventListener('hardwareBackPress', () => {
        return dismissSheet() || true;
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
            tabBarActiveTintColor: resolveTheme(themeVariant, 'plan').accent,
            headerTintColor: resolveTheme(themeVariant, 'plan').accent,
            tabBarIcon: ({ color, size }) => (
              <TabIcon label="P" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="hike"
          options={{
            title: 'Hike',
            tabBarActiveTintColor: resolveTheme(themeVariant, 'hike').accent,
            headerTintColor: resolveTheme(themeVariant, 'hike').accent,
            tabBarIcon: ({ color, size }) => (
              <TabIcon label="H" color={color} size={size} />
            ),
          }}
        />
        <Tabs.Screen
          name="contribute"
          options={{
            title: 'Contribute',
            tabBarActiveTintColor: resolveTheme(themeVariant, 'contribute').accent,
            headerTintColor: resolveTheme(themeVariant, 'contribute').accent,
            tabBarIcon: ({ color, size }) => (
              <TabIcon label="C" color={color} size={size} />
            ),
          }}
        />
      </Tabs>
    </View>
  );
}

function TabIcon({ label, color, size }: { label: string; color: string; size: number }) {
  return (
    <View style={{
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: color,
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <Text style={{ color: '#fff', fontSize: size * 0.5, fontWeight: 'bold' }}>
        {label}
      </Text>
    </View>
  );
}
