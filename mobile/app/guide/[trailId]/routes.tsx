/**
 * Routes screen — the trail's saved custom routes.
 *
 * Lists each saved route with its denormalized stats (unit-aware distance +
 * ascent), lets the hiker activate one (overlaid on the map + highlighted on
 * the elevation profile via the routes store) or clear the active route, and
 * delete a route with confirmation. Routes are BUILT on the map pane (Draw
 * route); this screen only manages the saved set.
 */

import React, { useEffect } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance, formatElevation } from '@lib/format-distance';
import { useTheme } from '../../../src/theme';
import { radii, spacing, typography } from '../../../src/tokens';
import { useSettingsStore } from '../../../src/state/settings-store';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { useRoutesStore } from '../../../src/features/routes/routes-store';
import type { Route } from '../../../src/db/routes-repo';

export default function RoutesScreen() {
  const { colors } = useTheme();
  const { trailId } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const router = useRouter();

  const routes = useRoutesStore((s) => s.byTrail[trailId]);
  const activeId = useRoutesStore((s) => s.activeIdByTrail[trailId]) ?? null;
  const hydrate = useRoutesStore((s) => s.hydrate);
  const activate = useRoutesStore((s) => s.activate);
  const remove = useRoutesStore((s) => s.remove);

  useEffect(() => {
    void hydrate(trailId);
  }, [hydrate, trailId]);

  const confirmDelete = (route: Route) => {
    Alert.alert('Delete route', `Delete “${route.name}”? This can’t be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void remove(trailId, route.id) },
    ]);
  };

  if (routes === undefined) {
    return <View style={[styles.root, { backgroundColor: colors.background }]} />;
  }

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
    >
      {routes.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No routes yet</Text>
          <Text style={[styles.emptyHint, { color: colors.textSecondary }]}>
            Open the map and tap the ✎ button to draw a route — tap along the trail to add points,
            then save it here.
          </Text>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.emptyButton,
              { backgroundColor: colors.accent },
              pressed && styles.pressed,
            ]}
          >
            <Text style={[styles.emptyButtonText, { color: colors.accentText }]}>Go to map</Text>
          </Pressable>
        </View>
      ) : (
        routes.map((route) => {
          const active = route.id === activeId;
          return (
            <View
              key={route.id}
              style={[
                styles.card,
                { backgroundColor: colors.surface, borderColor: active ? colors.warning : colors.border },
              ]}
            >
              <Pressable
                onPress={() => void activate(trailId, active ? null : route.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={active ? `Hide ${route.name}` : `Show ${route.name} on map`}
                style={({ pressed }) => [styles.cardMain, pressed && styles.pressed]}
              >
                <View style={styles.cardHead}>
                  <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
                    {route.name}
                  </Text>
                  {active && (
                    <View style={[styles.activeBadge, { backgroundColor: colors.warning }]}>
                      <Text style={[styles.activeBadgeText, { color: colors.accentText }]}>
                        On map
                      </Text>
                    </View>
                  )}
                </View>
                <Text style={[styles.stats, { color: colors.textSecondary }]}>
                  {formatDistance(route.totalKm, units)} · ↑ {formatElevation(route.ascentM, units)}
                </Text>
              </Pressable>

              <Pressable
                onPress={() => confirmDelete(route)}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${route.name}`}
                hitSlop={spacing.sm}
                style={({ pressed }) => [styles.delete, pressed && styles.pressed]}
              >
                <Text style={[styles.deleteText, { color: colors.danger }]}>Delete</Text>
              </Pressable>
            </View>
          );
        })
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.md },

  empty: {
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xxl,
  },
  emptyTitle: { ...typography.displaySmall },
  emptyHint: { ...typography.bodySmall, textAlign: 'center' },
  emptyButton: {
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.full,
    marginTop: spacing.sm,
  },
  emptyButtonText: { ...typography.titleSmall },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  cardMain: { flex: 1, gap: spacing.xs },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.titleSmall, flexShrink: 1 },
  activeBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
  },
  activeBadgeText: { ...typography.caption, fontWeight: '700' },
  stats: { ...typography.bodySmall, fontVariant: ['tabular-nums'] },
  delete: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  deleteText: { ...typography.titleSmall },
  pressed: { opacity: 0.6 },
});
