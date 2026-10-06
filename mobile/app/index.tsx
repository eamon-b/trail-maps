/**
 * "My Guides" — the FarOut-style guide list.
 *
 * One card per trail (name, unit-aware length, offline-status badge): bundled
 * trails first, then trails published to the R2 catalog after this build (a
 * "Download" pill until first opened), then user-imported ones. Tapping a card
 * opens that guide; long-pressing an imported one offers to delete it. Pulling
 * down checks the catalog for newer trail data now rather than on the six-hour
 * schedule (`services/trail-data-updates`).
 *
 * The list reads only index metadata via `listAllTrails()` — it never eagerly
 * loads any full trail JSON, so it stays instant. (That metadata carries no
 * elevation data, so there are no sparklines.) It re-reads on focus rather than
 * once on mount, because the import and delete flows both change what belongs
 * in it while this screen sits mounted underneath them — and whenever trail
 * data changes, since a background update can rename a trail or add one.
 *
 * The pin on each card marks the trail being hiked now (`currentTrailId` in the
 * settings store): that card leads the list with a "Hiking now" pill, and a
 * fresh launch opens straight into its guide — pushed over this screen, so Back
 * still lands here. That happens once per launch, so backing out to the list
 * leaves you on it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../src/theme';
import { glyphSizes, radii, spacing, typography } from '../src/tokens';
import { listAllTrails, listTrails, type TrailIndexEntry } from '../src/services/trail-loader';
import { getDatabase } from '../src/db/database';
import { deleteImportedTrailEverywhere } from '../src/services/imported-trail-store';
import { useSettingsStore } from '../src/state/settings-store';
import { useDownloadsStore } from '../src/state/downloads-store';
import { DownloadBadge } from '../src/features/guide/DownloadBadge';
import { checkForTrailDataUpdates } from '../src/services/trail-data-updates';
import { useTrailDataStore } from '../src/state/trail-data-store';
import { launchTrailId, orderWithCurrentFirst } from '../src/features/guide/current-hike';
import { classifyIncomingUrl } from '../src/features/import/incoming-file';

// Once per app process: the launch has been offered its current-trail guide.
// Module-level so remounting this screen never opens it a second time.
let launchHandled = false;

/** Resolves once the persisted settings (and so `currentTrailId`) are loaded. */
function settingsHydrated(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export default function GuideListScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const hydrate = useDownloadsStore((s) => s.hydrate);
  const navigation = useNavigation();
  const currentTrailId = useSettingsStore((s) => s.currentTrailId);
  const setCurrentTrail = useSettingsStore((s) => s.setCurrentTrail);

  // Seeded with the bundled trails so the first frame is already the real list;
  // the registry read only ever appends to it.
  const [trails, setTrails] = useState<TrailIndexEntry[]>(listTrails);

  const refresh = useCallback(async () => {
    setTrails(await listAllTrails());
  }, []);

  // Bumped by every catalog refresh and trail download.
  const dataRevision = useTrailDataStore((s) => s.revision);
  const [refreshing, setRefreshing] = useState(false);

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

  // A background catalog refresh or download can rename a trail or add one
  // while this list is on screen.
  useEffect(() => {
    if (dataRevision === 0) return;
    let cancelled = false;
    listAllTrails().then((all) => {
      if (!cancelled) setTrails(all);
    });
    return () => {
      cancelled = true;
    };
  }, [dataRevision]);

  // Open the current trail's guide on a fresh launch. Skipped when the launch
  // was a file opened from outside the app (the import review screen is on its
  // way), and when anything else is already over this screen (a shared-plan
  // deep link).
  useEffect(() => {
    if (launchHandled) return;
    let cancelled = false;
    void (async () => {
      await settingsHydrated();
      const [all, initialUrl] = await Promise.all([listAllTrails(), Linking.getInitialURL()]);
      if (cancelled || launchHandled) return;
      launchHandled = true;
      const trailId = launchTrailId(
        useSettingsStore.getState().currentTrailId,
        all.map((t) => t.id),
        classifyIncomingUrl(initialUrl) != null,
      );
      if (trailId && navigation.isFocused()) {
        router.push({ pathname: '/guide/[trailId]', params: { trailId } });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigation, router]);

  const orderedTrails = useMemo(
    () => orderWithCurrentFirst(trails, currentTrailId),
    [trails, currentTrailId],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await checkForTrailDataUpdates({ force: true });
      await refresh();
      if (result.error) {
        Alert.alert('Couldn’t check for trail updates', result.error);
      } else if (result.failed.length > 0) {
        Alert.alert(
          'Some trail updates failed',
          'They will be tried again next time. The guides still open with the data already on this phone.',
        );
      }
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  // Offline-tile statuses, for bundled and catalog trails only: tile packs are
  // built server-side per published trailId, so no directory is ever named
  // after an imported id and asking the tile manager about one is a pointless probe.
  //
  // An import can still *borrow* a bundled pack when its track sits inside that
  // trail's coverage (`services/offline-pack-resolver`) — but the borrowed
  // pack's status is hydrated under the bundled id, which is already in this
  // list. Known gap: the imported card shows an "Imported" pill instead of a
  // DownloadBadge, so a borrowed pack is not reflected here.
  useEffect(() => {
    hydrate(trails.filter((t) => t.source !== 'imported').map((t) => t.id));
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
      data={orderedTrails}
      keyExtractor={(t) => t.id}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.accent]}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <Text style={[styles.heading, { color: colors.textPrimary }]}>My Guides</Text>
      }
      renderItem={({ item }) => {
        const imported = item.source === 'imported';
        const current = item.id === currentTrailId;
        return (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/guide/[trailId]', params: { trailId: item.id } })
            }
            onLongPress={imported ? () => confirmDelete(item) : undefined}
            accessibilityRole="button"
            accessibilityLabel={[item.name, imported && 'imported', current && 'hiking now']
              .filter(Boolean)
              .join(', ')}
            accessibilityHint={imported ? 'Long press to delete this imported guide' : undefined}
            style={[
              styles.card,
              {
                backgroundColor: colors.surfaceElevated,
                borderColor: current ? colors.accent : colors.border,
                borderWidth: current ? 2 : StyleSheet.hairlineWidth,
              },
            ]}
          >
            <View style={styles.cardTop}>
              <View style={styles.cardMain}>
                {current && (
                  <View style={[styles.currentPill, { backgroundColor: colors.accent }]}>
                    <MaterialCommunityIcons
                      name="hiking"
                      size={glyphSizes.xs}
                      color={colors.accentText}
                    />
                    <Text style={[styles.currentLabel, { color: colors.accentText }]}>
                      Hiking now
                    </Text>
                  </View>
                )}
                <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={[styles.length, { color: colors.textSecondary }]}>
                  {formatDistance(item.lengthKm, units)}
                </Text>
              </View>
              <Pressable
                onPress={() => setCurrentTrail(current ? null : item.id)}
                accessibilityRole="button"
                accessibilityLabel={
                  current
                    ? `Stop hiking ${item.name}`
                    : `Set ${item.name} as the trail I'm hiking`
                }
                accessibilityState={{ selected: current }}
                hitSlop={spacing.sm}
                style={styles.pinButton}
              >
                <MaterialCommunityIcons
                  name={current ? 'pin' : 'pin-outline'}
                  size={glyphSizes.lg}
                  color={current ? colors.accent : colors.textSecondary}
                />
              </Pressable>
            </View>
            {imported ? (
              <View style={[styles.importedPill, { borderColor: colors.accentMuted }]}>
                <Text style={[styles.importedLabel, { color: colors.accentMuted }]}>Imported</Text>
              </View>
            ) : item.source === 'remote' && !item.downloaded ? (
              // Published after this build: the guide itself is fetched on
              // first open, so offline-map status would be premature.
              <View style={[styles.importedPill, { borderColor: colors.accentMuted }]}>
                <Text style={[styles.importedLabel, { color: colors.accentMuted }]}>
                  New · downloads when opened
                </Text>
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
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
  },
  cardMain: {
    flex: 1,
    gap: spacing.xs,
  },
  pinButton: {
    padding: spacing.xs,
  },
  currentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
  },
  currentLabel: {
    ...typography.caption,
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
