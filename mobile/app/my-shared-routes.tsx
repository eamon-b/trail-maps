/**
 * My shared routes: every route this phone's account shared to the community,
 * whatever its status (`GET /v1/me/community/routes`).
 *
 * A hidden route — by the automatic review, by reports or by a moderator —
 * leaves the public list, so My Guides never lists it, and it has no public
 * track, so it cannot open as a guide. This screen is where its owner still
 * finds it, sees why it is hidden and can delete it. Reached from Settings and from the share screen's
 * "already shared" message, which passes `?id=` to open that route's detail.
 *
 * Tapping a card expands its detail in place rather than pushing a screen: the
 * list already carries every field the detail shows.
 */

import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { CommunityRouteDetail } from '@lib/community-types';
import { useTheme } from '../src/theme';
import { spacing, typography } from '../src/tokens';
import { useSettingsStore } from '../src/state/settings-store';
import { apiErrorMessage } from '../src/api/error-message';
import { upsertCommunitySummary } from '../src/services/community-routes';
import { useMySharedRoutes } from '../src/features/community/useMySharedRoutes';
import {
  MySharedRouteCard,
  MySharedRouteDetail,
} from '../src/features/community/MySharedRoutes';
import {
  DELETE_SHARED_ROUTE_TITLE,
  MY_ROUTE_DELETE_FAILED,
  deleteSharedRouteMessage,
  isLiveRoute,
} from '../src/features/community/my-shared-routes';

export default function MySharedRoutesScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { state, refreshing, refresh, remove } = useMySharedRoutes();
  const [expanded, setExpanded] = useState<string | null>(typeof id === 'string' ? id : null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const onDelete = useCallback(
    (route: CommunityRouteDetail) => {
      Alert.alert(
        DELETE_SHARED_ROUTE_TITLE,
        deleteSharedRouteMessage(route.name),
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () => {
              setDeleting(route.id);
              remove(route.id)
                .catch((err: unknown) => {
                  Alert.alert(
                    'Couldn’t delete the route',
                    apiErrorMessage(err, MY_ROUTE_DELETE_FAILED),
                  );
                })
                .finally(() => setDeleting(null));
            },
          },
        ],
      );
    },
    [remove],
  );

  const onOpenGuide = useCallback(
    (route: CommunityRouteDetail) => {
      // List it on the phone first, so the guide can download it even when the
      // cached community list predates it.
      upsertCommunitySummary(route);
      router.push({ pathname: '/guide/[trailId]', params: { trailId: route.id } });
    },
    [router],
  );

  if (state.kind !== 'ready') {
    let message: string | null = null;
    if (state.kind === 'unconfigured') message = 'Sharing routes isn’t available in this build.';
    else if (state.kind === 'signed-out') {
      message =
        'This phone has no account yet. Routes you share from an imported guide will be listed here.';
    } else if (state.kind === 'error') message = state.message;
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        {message === null ? (
          <ActivityIndicator color={colors.accent} size="large" />
        ) : (
          <Text
            style={[styles.body, { color: colors.textSecondary }]}
            accessibilityRole={state.kind === 'error' ? 'alert' : undefined}
          >
            {message}
          </Text>
        )}
      </View>
    );
  }

  return (
    <FlatList
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      data={state.routes}
      keyExtractor={(r) => r.id}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={colors.accent}
          colors={[colors.accent]}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={[styles.body, { color: colors.textSecondary }]}>
            Every route you have shared, including any hidden from the community list.
          </Text>
          {state.error ? (
            <Text style={[styles.body, { color: colors.danger }]} accessibilityRole="alert">
              {state.error}
            </Text>
          ) : null}
        </View>
      }
      ListEmptyComponent={
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          You haven’t shared any routes yet. Share one from an imported guide’s menu.
        </Text>
      }
      renderItem={({ item }) => {
        const open = expanded === item.id;
        return (
          <MySharedRouteCard
            route={item}
            units={units}
            expanded={open}
            onPress={() => setExpanded(open ? null : item.id)}
          >
            <MySharedRouteDetail
              route={item}
              deleting={deleting === item.id}
              onDelete={() => onDelete(item)}
              onOpenGuide={isLiveRoute(item) ? () => onOpenGuide(item) : undefined}
            />
          </MySharedRouteCard>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.lg, gap: spacing.md },
  header: { gap: spacing.sm },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  body: { ...typography.body },
});
