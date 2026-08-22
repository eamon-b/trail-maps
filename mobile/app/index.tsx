/**
 * "My Guides" — the FarOut-style guide list.
 *
 * One card per trail (name, unit-aware length, offline-status badge), bundled
 * trails first and user-imported ones after. Tapping a card opens that guide;
 * long-pressing an imported one offers to delete it.
 *
 * The list reads only index metadata via `listAllTrails()` — it never eagerly
 * loads any full trail JSON, so it stays instant. (That metadata carries no
 * elevation data, so there are no sparklines.) It re-reads on focus rather than
 * once on mount, because the import and delete flows both change what belongs
 * in it while this screen sits mounted underneath them.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../src/theme';
import { radii, spacing, typography } from '../src/tokens';
import { listAllTrails, listTrails, type TrailIndexEntry } from '../src/services/trail-loader';
import { getDatabase } from '../src/db/database';
import { deleteImportedTrailEverywhere } from '../src/services/imported-trail-store';
import { useSettingsStore } from '../src/state/settings-store';
import { useDownloadsStore } from '../src/state/downloads-store';
import { DownloadBadge } from '../src/features/guide/DownloadBadge';

export default function GuideListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const hydrate = useDownloadsStore((s) => s.hydrate);

  // Seeded with the bundled trails so the first frame is already the real list;
  // the registry read only ever appends to it.
  const [trails, setTrails] = useState<TrailIndexEntry[]>(listTrails);

  const refresh = useCallback(async () => {
    setTrails(await listAllTrails());
  }, []);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      listAllTrails().then((all) => {
        if (!cancelled) setTrails(all);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // Offline-tile statuses, for bundled trails only: tile packs are built
  // server-side per bundled trailId, so no directory is ever named after an
  // imported id and asking the tile manager about one is a pointless probe.
  //
  // An import can still *borrow* a bundled pack when its track sits inside that
  // trail's coverage (`services/offline-pack-resolver`) — but the borrowed
  // pack's status is hydrated under the bundled id, which is already in this
  // list. Known gap: the imported card shows an "Imported" pill instead of a
  // DownloadBadge, so a borrowed pack is not reflected here.
  useEffect(() => {
    hydrate(trails.filter((t) => t.source === 'bundled').map((t) => t.id));
  }, [hydrate, trails]);

  const confirmDelete = (trail: TrailIndexEntry) => {
    if (trail.source !== 'imported') return;
    Alert.alert(
      'Delete guide',
      `Delete “${trail.name}”? Its notes, favourites and routes on this device go with it. This can’t be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const db = await getDatabase();
              await deleteImportedTrailEverywhere(db, trail.id);
              await refresh();
            })();
          },
        },
      ],
    );
  };

  return (
    <FlatList
      data={trails}
      keyExtractor={(t) => t.id}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      ListHeaderComponent={
        <Text style={[styles.heading, { color: colors.textPrimary }]}>My Guides</Text>
      }
      renderItem={({ item }) => {
        const imported = item.source === 'imported';
        return (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/guide/[trailId]', params: { trailId: item.id } })
            }
            onLongPress={imported ? () => confirmDelete(item) : undefined}
            accessibilityRole="button"
            accessibilityLabel={imported ? `${item.name} (imported)` : item.name}
            accessibilityHint={imported ? 'Long press to delete this imported guide' : undefined}
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
            {imported ? (
              <View style={[styles.importedPill, { borderColor: colors.accentMuted }]}>
                <Text style={[styles.importedLabel, { color: colors.accentMuted }]}>Imported</Text>
              </View>
            ) : (
              <DownloadBadge trailId={item.id} />
            )}
          </Pressable>
        );
      }}
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
  importedPill: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  importedLabel: {
    ...typography.caption,
  },
});
