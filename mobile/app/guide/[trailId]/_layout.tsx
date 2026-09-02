/**
 * Guide navigator — a nested Stack scoped to one trail.
 *
 * Wraps its screens in a GuideProvider so `index` and `downloads` share a
 * single loaded (and direction-applied) trail. The header exposes the guide
 * title plus icon-only quick actions: routes, plan, offline maps and app
 * settings.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useTheme } from '../../../src/theme';
import {
  HeaderActions,
  HeaderIconButton,
} from '../../../src/navigation/HeaderIconButton';
import { GuideProvider } from '../../../src/features/guide/GuideContext';
import { useTrailTitle } from '../../../src/features/guide/use-trail-title';
import { GuidePositionProvider } from '../../../src/features/guide/GuidePositionContext';

export default function GuideLayout() {
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const title = useTrailTitle(trailId);

  return (
    <GuideProvider trailId={trailId}>
      {/* Hoisted so the index panes AND the waypoint detail screen share one
          GPS session (distance-from-me / ETA on the detail screen). */}
      <GuidePositionProvider>
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
            title,
            // `routes` (a branching path) for alternates, `calendar-check` for
            // the day-split planner, `download` for tile packs, `cog` for the
            // app-wide settings the root header also links to.
            headerRight: () => (
              <HeaderActions>
                <HeaderIconButton
                  name="routes"
                  accessibilityLabel="Routes"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/routes',
                      params: { trailId },
                    })
                  }
                />
                <HeaderIconButton
                  name="calendar-check"
                  accessibilityLabel="Plan"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/plan',
                      params: { trailId },
                    })
                  }
                />
                <HeaderIconButton
                  name="download"
                  accessibilityLabel="Offline maps"
                  onPress={() =>
                    router.push({
                      pathname: '/guide/[trailId]/downloads',
                      params: { trailId },
                    })
                  }
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
        <Stack.Screen name="downloads" options={{ title: 'Offline maps' }} />
        <Stack.Screen name="routes" options={{ title: 'Routes' }} />
        <Stack.Screen name="plan" options={{ title: 'Plan' }} />
        {/* Title is overridden with the waypoint name from within the screen. */}
        <Stack.Screen name="waypoint/[waypointId]" options={{ title: 'Waypoint' }} />
      </Stack>
      </GuidePositionProvider>
    </GuideProvider>
  );
}
