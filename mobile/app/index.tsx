/**
 * "My Guides" — the FarOut-style guide list.
 *
 * One card per trail (name, region, unit-aware length, offline-status badge),
 * in sections (`features/guide/guide-sections`): "Hiking now", then the curated
 * trails — bundled, and published to the R2 catalog after this build (a
 * "downloads when opened" pill until first opened) — one section per country,
 * then "Community" (routes other hikers shared, with a Verified/Unverified
 * pill, or "No longer shared" for a downloaded one the server has since taken
 * down — kept until the hiker removes it), then "Imported". A search field at
 * the top filters every section by name or region. Tapping a card opens that
 * guide; long-pressing an imported one offers to share it to the community or
 * delete it, and long-pressing a community one offers its About screen
 * (details, report) and, once downloaded, "Remove from this phone". Pulling
 * down checks the catalog for newer trail data and the community list now
 * rather than on their schedules (`services/trail-data-updates`, `services/community-routes`).
 *
 * The list reads only index metadata via `listAllTrails()` — it never eagerly
 * loads any full trail JSON, so it stays instant. (That metadata carries no
 * elevation data, so there are no sparklines.) It re-reads on focus rather than
 * once on mount, because the import and delete flows both change what belongs
 * in it while this screen sits mounted underneath them — and whenever trail
 * data changes, since a background update can rename a trail or add one.
 *
 * The pin on each card marks the trail being hiked now (`currentTrailId` in the
 * settings store): that card leads the list in its own section, and a
 * fresh launch opens straight into its guide — pushed over this screen, so Back
 * still lands here. That happens once per launch, so backing out to the list
 * leaves you on it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
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
import { launchTrailId } from '../src/features/guide/current-hike';
import { buildGuideSections, regionSubtitle } from '../src/features/guide/guide-sections';
import {
  refreshCommunityRoutes,
  removeCommunityRouteFromDevice,
} from '../src/services/community-routes';
import { isApiConfigured } from '../src/api/client';
import { CommunityStatusPill } from '../src/features/community/CommunityUi';
import { classifyIncomingUrl } from '../src/features/import/incoming-file';
import { useBottomInsetContentStyle } from '../src/navigation/bottom-inset';

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
  const contentStyle = useBottomInsetContentStyle(styles.content);
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

  const [query, setQuery] = useState('');
  const sections = useMemo(
    () => buildGuideSections(trails, currentTrailId, query),
    [trails, currentTrailId, query],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [result] = await Promise.all([
        checkForTrailDataUpdates({ force: true }),
        // Best effort: an offline community list keeps showing the cached one.
        refreshCommunityRoutes({ force: true }),
      ]);
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
  // after an imported or community id and asking the tile manager about one is
  // a pointless probe.
  //
  // An import or community route can still *borrow* a bundled pack when its
  // track sits inside that trail's coverage (`services/offline-pack-resolver`)
  // — but the borrowed pack's status is hydrated under the bundled id, which is
  // already in this list. Known gap: those cards show a pill instead of a
  // DownloadBadge, so a borrowed pack is not reflected here.
  useEffect(() => {
    hydrate(
      trails.filter((t) => t.source === 'bundled' || t.source === 'remote').map((t) => t.id),
    );
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

  // Long-press on an imported guide: share it to the community (when the API is
  // configured) or delete it. Android's Alert takes at most three buttons.
  const onImportedLongPress = (trail: TrailIndexEntry) => {
    if (!isApiConfigured()) {
      confirmDelete(trail);
      return;
    }
    Alert.alert(trail.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Share to community',
        onPress: () => router.push({ pathname: '/share-route', params: { trailId: trail.id } }),
      },
      { text: 'Delete…', style: 'destructive', onPress: () => confirmDelete(trail) },
    ]);
  };

  const confirmRemoveCommunity = (trail: TrailIndexEntry) => {
    Alert.alert(
      'Remove from this phone',
      `Remove “${trail.name}” from this phone? Its plan, favourites and routes on this phone go with it. This can’t be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await removeCommunityRouteFromDevice(trail.id);
              } finally {
                await refresh();
              }
            })();
          },
        },
      ],
    );
  };

  // Long-press on a community route: its About screen (details, report,
  // the owner's delete) and, when a copy is on the phone, removing it.
  const onCommunityLongPress = (trail: TrailIndexEntry) => {
    const about = () =>
      router.push({ pathname: '/community-route', params: { id: trail.id } });
    Alert.alert(trail.name, undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'About & report', onPress: about },
      ...(trail.downloaded
        ? [
            {
              text: 'Remove from this phone…',
              style: 'destructive' as const,
              onPress: () => confirmRemoveCommunity(trail),
            },
          ]
        : []),
    ]);
  };

  return (
    <SectionList
      sections={sections}
      keyExtractor={(t) => t.id}
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={contentStyle}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          colors={[colors.accent]}
          tintColor={colors.accent}
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={[styles.heading, { color: colors.textPrimary }]}>My Guides</Text>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search by name or region"
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel="Search guides"
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            returnKeyType="search"
            style={[
              styles.search,
              {
                color: colors.textPrimary,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              },
            ]}
          />
        </View>
      }
      ListEmptyComponent={
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          {query.trim() ? `No guides match “${query.trim()}”.` : 'No guides yet.'}
        </Text>
      }
      renderSectionHeader={({ section }) => (
        <Text
          accessibilityRole="header"
          style={[styles.sectionTitle, { color: colors.textSecondary }]}
        >
          {section.title}
        </Text>
      )}
      renderItem={({ item }) => {
        const imported = item.source === 'imported';
        const community = item.source === 'community';
        const current = item.id === currentTrailId;
        const subtitle = regionSubtitle(item);
        const verified = item.communityStatus === 'verified';
        const takenDown = community && item.communityTakenDown === true;
        return (
          <Pressable
            onPress={() =>
              router.push({ pathname: '/guide/[trailId]', params: { trailId: item.id } })
            }
            onLongPress={
              imported
                ? () => onImportedLongPress(item)
                : community
                  ? () => onCommunityLongPress(item)
                  : undefined
            }
            accessibilityRole="button"
            accessibilityLabel={[
              item.name,
              subtitle,
              imported && 'imported',
              community &&
                (takenDown
                  ? 'community route, no longer shared'
                  : verified
                    ? 'community route, verified'
                    : 'community route, unverified'),
              current && 'hiking now',
            ]
              .filter(Boolean)
              .join(', ')}
            accessibilityHint={
              imported
                ? 'Long press to share or delete this imported guide'
                : community
                  ? 'Long press for details, reporting or removing it from this phone'
                  : undefined
            }
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
                {subtitle ? (
                  <Text
                    style={[styles.subtitle, { color: colors.textSecondary }]}
                    numberOfLines={1}
                  >
                    {subtitle}
                  </Text>
                ) : null}
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
            ) : community ? (
              <View style={styles.pillRow}>
                <CommunityStatusPill
                  status={item.communityStatus ?? 'unverified'}
                  takenDown={takenDown}
                />
                {!item.downloaded && (
                  <View style={[styles.importedPill, { borderColor: colors.accentMuted }]}>
                    <Text style={[styles.importedLabel, { color: colors.accentMuted }]}>
                      Downloads when opened
                    </Text>
                  </View>
                )}
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
  header: {
    gap: spacing.md,
  },
  heading: {
    ...typography.displayLarge,
  },
  search: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  sectionTitle: {
    ...typography.titleSmall,
    marginTop: spacing.md,
  },
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xl,
  },
  subtitle: {
    ...typography.bodySmall,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
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
