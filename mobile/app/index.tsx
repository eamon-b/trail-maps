import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ACTIVE_TRAIL_KEY } from './trail/[id]';
import { TrailDataService } from '../src/services/trail-data-service';

export default function Index() {
  const [target, setTarget] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const trailId = await AsyncStorage.getItem(ACTIVE_TRAIL_KEY);
        if (!trailId) {
          if (!cancelled) setTarget('/(tabs)/plan');
          return;
        }
        // Guard against a stale active id (its trail was deleted). Resolve it
        // the same way the viewer does — getTrailTrackData covers both bundled
        // (in-memory) and custom (SQLite) trails, so a valid bundled trail is
        // never wrongly cleared. On a miss, clear the key and fall back to the
        // default route instead of redirecting into a "Trail not found" screen.
        const service = await TrailDataService.create();
        const json = await service.getTrailTrackData(trailId);
        if (cancelled) return;
        if (!json) {
          await AsyncStorage.removeItem(ACTIVE_TRAIL_KEY);
          if (!cancelled) setTarget('/(tabs)/plan');
        } else {
          setTarget(`/trail/${trailId}`);
        }
      } catch {
        if (!cancelled) setTarget('/(tabs)/plan');
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
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
