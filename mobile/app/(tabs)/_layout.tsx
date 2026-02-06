import { Tabs } from 'expo-router';
import { Text, View } from 'react-native';

const COLORS = {
  plan: '#2196F3',
  hike: '#4CAF50',
  contribute: '#FF9800',
  inactive: '#888',
} as const;

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: undefined,
        tabBarInactiveTintColor: COLORS.inactive,
        headerShown: true,
      }}
    >
      <Tabs.Screen
        name="plan"
        options={{
          title: 'Plan',
          tabBarActiveTintColor: COLORS.plan,
          headerTintColor: COLORS.plan,
          tabBarIcon: ({ color, size }) => (
            <TabIcon label="P" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="hike"
        options={{
          title: 'Hike',
          tabBarActiveTintColor: COLORS.hike,
          headerTintColor: COLORS.hike,
          tabBarIcon: ({ color, size }) => (
            <TabIcon label="H" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="contribute"
        options={{
          title: 'Contribute',
          tabBarActiveTintColor: COLORS.contribute,
          headerTintColor: COLORS.contribute,
          tabBarIcon: ({ color, size }) => (
            <TabIcon label="C" color={color} size={size} />
          ),
        }}
      />
    </Tabs>
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
