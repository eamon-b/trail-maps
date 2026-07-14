import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme } from '../../src/theme';
import { TrailDataService } from '../../src/services/trail-data-service';
import { PlanService, type Plan } from '../../src/services/plan-service';
import { deleteCustomTrail } from '../../src/services/custom-trail-service';
import { getTrailTileStatus } from '../../src/services/tile-service';
import { tileManager } from '../../src/services/tile-manager';
import { useTileDownloads, formatBytes } from '../../src/hooks/useTileDownloads';
import { TrailCard, type TrailWithTiles } from '../../src/components/plan/TrailCard';
import { spacing, touchTarget } from '../../src/tokens/spacing';
import { glyphSizes, typography } from '../../src/tokens/typography';

/**
 * Trail-list shell for the Plan tab (WS4 structural split): browsing,
 * plan lists, and storage summary live here; per-trail rendering is
 * TrailCard and the tile download workflow is useTileDownloads.
 */
export default function PlanScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [trails, setTrails] = useState<TrailWithTiles[]>([]);
  const [plans, setPlans] = useState<Record<string, Plan[]>>({});
  const [storageInfo, setStorageInfo] = useState<{ usedBytes: number; availableBytes: number; customTrailBytes: number } | null>(null);

  const refreshTileStatus = useCallback((trailId: string) => {
    setTrails((prev) =>
      prev.map((t) =>
        t.id === trailId ? { ...t, tileStatus: getTrailTileStatus(trailId) } : t,
      ),
    );
    // Refresh storage info
    TrailDataService.create()
      .then(s => s.getCustomTrailStorageBytes())
      .then((customTrailBytes) => {
        setStorageInfo({
          usedBytes: tileManager.getTotalStorageUsed(),
          availableBytes: tileManager.getAvailableSpace(),
          customTrailBytes,
        });
      }).catch(() => {});
  }, []);

  const {
    downloadingTrailId,
    downloadProgress,
    downloadError,
    clearError,
    download,
    removeTiles,
  } = useTileDownloads(refreshTileStatus);

  const loadTrails = useCallback(async () => {
    const service = await TrailDataService.create();
    const list = await service.listTrails();
    const withTiles: TrailWithTiles[] = list.map((trail) => ({
      ...trail,
      tileStatus: getTrailTileStatus(trail.id),
    }));
    setTrails(withTiles);

    // Load all plans in a single query
    const planService = await PlanService.create();
    const plansByTrail = await planService.listAllPlansByTrail();
    setPlans(plansByTrail);

    // Load storage info
    const usedBytes = tileManager.getTotalStorageUsed();
    const availableBytes = tileManager.getAvailableSpace();
    const customTrailBytes = await service.getCustomTrailStorageBytes();
    setStorageInfo({ usedBytes, availableBytes, customTrailBytes });
  }, []);

  useEffect(() => {
    loadTrails();
  }, [loadTrails]);

  // Reload plans when screen comes back into focus
  useFocusEffect(
    useCallback(() => {
      loadTrails();
    }, [loadTrails]),
  );

  function handleDeleteCustomTrail(trailId: string, trailName: string) {
    Alert.alert(
      'Delete Custom Trail',
      `Delete "${trailName}" and all associated data? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteCustomTrail(trailId);
            loadTrails();
          },
        },
      ],
    );
  }

  function handleDeletePlan(planId: string, planName: string) {
    Alert.alert('Delete Plan', `Delete "${planName}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const service = await PlanService.create();
          await service.deletePlan(planId);
          loadTrails();
        },
      },
    ]);
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.headerRow}>
        <Text style={[styles.header, { color: colors.accent }]}>Select a Trail</Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/settings')}
            style={styles.measureButton}
            accessibilityRole="button"
            accessibilityLabel="Settings"
          >
            <Text style={[styles.measureText, { color: colors.textSecondary }]}>Settings</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/import')}
            style={styles.measureButton}
            accessibilityRole="button"
            accessibilityLabel="Import a GPX trail"
          >
            <Text style={[styles.measureText, { color: colors.accent }]}>Import</Text>
          </Pressable>
          {trails.length > 0 && (
            <Pressable
              onPress={() => {
                if (trails.length === 1) {
                  router.push({ pathname: '/plan/measure', params: { trailId: trails[0].id } });
                } else {
                  Alert.alert(
                    'Measure Tool',
                    'Select a trail to measure on',
                    trails.map(t => ({
                      text: t.name,
                      onPress: () => router.push({ pathname: '/plan/measure', params: { trailId: t.id } }),
                    })).concat([{ text: 'Cancel', onPress: () => {}, style: 'cancel' } as any]),
                  );
                }
              }}
              style={styles.measureButton}
              accessibilityRole="button"
              accessibilityLabel="Measure distance between two points"
            >
              <Text style={[styles.measureText, { color: colors.accent }]}>Measure</Text>
            </Pressable>
          )}
        </View>
      </View>
      <FlatList
        data={trails}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <TrailCard
            trail={item}
            plans={plans[item.id] ?? []}
            isDownloading={downloadingTrailId === item.id}
            downloadProgress={downloadProgress}
            downloadError={downloadError}
            onViewMap={() => router.push({ pathname: '/trail/[id]', params: { id: item.id } })}
            onViewDetails={() => router.push({ pathname: '/trail/overview', params: { id: item.id } })}
            onCreatePlan={() => router.push({ pathname: '/plan/create', params: { trailId: item.id, trailName: item.name } })}
            onOpenPlan={(p) => router.push({ pathname: '/plan/[planId]', params: { planId: p.id, trailId: item.id } })}
            onDeletePlan={(p) => handleDeletePlan(p.id, p.name)}
            onDeleteCustomTrail={() => handleDeleteCustomTrail(item.id, item.name)}
            onDownloadTiles={() => download(item.id, item.isCustom)}
            onDeleteTiles={() => removeTiles(item.id, item.name)}
            onRetryDownload={() => {
              clearError();
              download(item.id, item.isCustom);
            }}
            onDismissDownloadError={clearError}
          />
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No trails loaded</Text>
        }
        ListFooterComponent={
          storageInfo && (storageInfo.usedBytes > 0 || storageInfo.customTrailBytes > 0) ? (
            <View style={[styles.storageFooter, { borderTopColor: colors.border }]}>
              <Text style={[styles.storageTitle, { color: colors.textPrimary }]}>Storage</Text>
              {storageInfo.usedBytes > 0 && (
                <Text style={[styles.storageDetail, { color: colors.textSecondary }]}>
                  Maps: {formatBytes(storageInfo.usedBytes)}
                </Text>
              )}
              {storageInfo.customTrailBytes > 0 && (
                <Text style={[styles.storageDetail, { color: colors.textSecondary }]}>
                  Custom trails: {formatBytes(storageInfo.customTrailBytes)}
                </Text>
              )}
              <Text style={[styles.storageDetail, { color: colors.textSecondary }]}>
                {formatBytes(storageInfo.availableBytes)} available
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  header: {
    ...typography.titleLarge,
    fontSize: glyphSizes.sm,
  },
  measureButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  measureText: {
    ...typography.caption,
    fontWeight: '600',
  },
  list: {
    padding: spacing.lg,
    paddingTop: 0,
    gap: spacing.md,
  },
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 40,
  },
  storageFooter: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  storageTitle: {
    ...typography.caption,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  storageDetail: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
});
