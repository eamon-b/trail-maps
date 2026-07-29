/**
 * "My Guides" — the FarOut-style guide list.
 *
 * One card per bundled trail (name, unit-aware length, offline-status badge).
 * Tapping a card opens that guide. The list reads only index.json metadata via
 * `listTrails()` — it never eagerly loads the six full trail JSONs, so it stays
 * instant. (index.json carries no elevation data, so there are no sparklines.)
 */

import { useEffect, useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../src/theme';
import { radii, spacing, typography } from '../src/tokens';
import { listTrails } from '../src/services/trail-loader';
import { useSettingsStore } from '../src/state/settings-store';
import { useDownloadsStore } from '../src/state/downloads-store';
import { DownloadBadge } from '../src/features/guide/DownloadBadge';

export default function GuideListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const hydrate = useDownloadsStore((s) => s.hydrate);

  const trails = useMemo(() => listTrails(), []);

  // Hydrate offline-tile statuses once on mount.
  useEffect(() => {
    hydrate(trails.map((t) => t.id));
  }, [hydrate, trails]);

  return (
    <FlatList
      data={trails}
      keyExtractor={(t) => t.id}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <Text style={[styles.heading, { color: colors.textPrimary }]}>My Guides</Text>
      }
      renderItem={({ item }) => (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/guide/[trailId]', params: { trailId: item.id } })
          }
          style={[
            styles.card,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border },
          ]}
        >
          <View style={styles.cardMain}>
            <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={2}>
              {item.name}
            </Text>
            <Text style={[styles.length, { color: colors.textSecondary }]}>
              {formatDistance(item.lengthKm, units)}
            </Text>
          </View>
          <DownloadBadge trailId={item.id} />
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  content: {
    padding: spacing.lg,
    gap: spacing.md,
  },
  heading: {
    ...typography.displayLarge,
    marginBottom: spacing.sm,
  },
  card: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  cardMain: {
    gap: spacing.xs,
  },
  name: {
    ...typography.displaySmall,
  },
  length: {
    ...typography.dataSmall,
  },
});
