import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRAIL_KEY } from './trail/[id]';

export default function Index() {
  const [target, setTarget] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    AsyncStorage.getItem(ACTIVE_TRAIL_KEY)
      .then(trailId => {
        setTarget(trailId ? `/trail/${trailId}` : '/(tabs)/plan');
      })
      .catch(() => {
        setTarget('/(tabs)/plan');
      })
      .finally(() => setChecking(false));
  }, []);

  if (checking) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return <Redirect href={target!} />;
}
