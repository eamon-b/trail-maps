import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useTheme } from '../../src/theme';
import { TrailDataService, type Trail } from '../../src/services/trail-data-service';
import { PlanService, type Plan } from '../../src/services/plan-service';
import { deleteCustomTrail } from '../../src/services/custom-trail-service';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  type TrailTileStatus,
  type DownloadProgress,
} from '../../src/services/tile-service';
import {
  fetchGridIndex,
  resolveGridCells,
  downloadGridTiles,
  type GridProgressCallback,
} from '../../src/services/grid-tile-service';
import { calculateTrailBounds } from '../../src/services/trail-bounds';
import { trailJsonToTrail } from '../../src/lib/trail-utils';
import { tileManager } from '../../src/services/tile-manager';
import { ProgressBar } from '../../src/components';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

// Set via EXPO_PUBLIC_TILE_BASE_URL env var (e.g. https://tiles.trailcompanion.app)
// For local dev, use the dev screen (Dev Catalog > Map Tiles) which prompts for a server IP.
const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDataVersion(version: string): string {
  const d = new Date(version + 'T00:00:00');
  if (isNaN(d.getTime())) return version;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface TrailWithTiles extends Trail {
  tileStatus: TrailTileStatus;
}

export default function PlanScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [trails, setTrails] = useState<TrailWithTiles[]>([]);
  const [plans, setPlans] = useState<Record<string, Plan[]>>({});
  const [downloadingTrailId, setDownloadingTrailId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ fileName: string; fileIndex: number; totalFiles: number } | null>(null);
  const [downloadError, setDownloadError] = useState<{ trailId: string; message: string } | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usedBytes: number; availableBytes: number; customTrailBytes: number } | null>(null);

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

  function refreshTileStatus(trailId: string) {
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
  }

  async function handleDownload(trailId: string, isCustom: boolean) {
    if (!TILE_BASE_URL) {
      Alert.alert(
        'Tile server not configured',
        'Set EXPO_PUBLIC_TILE_BASE_URL in your environment.\n\nFor local development, add it to .env. For EAS builds, add it to eas.json under the build profile\'s "env" key.',
      );
      return;
    }
    if (!/^https?:\/\/.+/.test(TILE_BASE_URL)) {
      Alert.alert(
        'Invalid tile server URL',
        `EXPO_PUBLIC_TILE_BASE_URL must be a valid URL starting with http:// or https://.\n\nCurrent value: "${TILE_BASE_URL}"`,
      );
      return;
    }

    if (isCustom) {
      await handleDownloadCustom(trailId);
    } else {
      await handleDownloadBuiltIn(trailId);
    }
  }

  async function handleDownloadBuiltIn(trailId: string) {
    setDownloadingTrailId(trailId);
    setDownloadError(null);
    let filesDone = 0;
    try {
      await downloadTrailTiles(trailId, TILE_BASE_URL, (progress: DownloadProgress) => {
        filesDone++;
        setDownloadProgress({
          fileName: progress.fileName,
          fileIndex: filesDone,
          totalFiles: 2,
        });
        refreshTileStatus(trailId);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setDownloadError({ trailId, message: msg });
    }
    setDownloadingTrailId(null);
    setDownloadProgress(null);
    refreshTileStatus(trailId);
  }

  async function handleDownloadCustom(trailId: string) {
    try {
      // Load trail track data to calculate bounding box
      const service = await TrailDataService.create();
      const json = await service.getTrailTrackData(trailId);
      if (!json) {
        Alert.alert('Error', 'Could not load trail data');
        return;
      }

      const trail = trailJsonToTrail(json);
      const bounds = calculateTrailBounds(trail.track.points);

      // Fetch grid index and resolve cells
      const gridIndex = await fetchGridIndex(TILE_BASE_URL);
      const cells = resolveGridCells(bounds, gridIndex);

      if (cells.length === 0) {
        Alert.alert('No Tiles Available', 'No map tiles are available for this trail\'s region yet.');
        return;
      }

      // Show the real download size (sum of cell sizes from the grid index).
      // Guard against cells missing/NaN totalSize so the dialog never renders
      // "approximately NaN MB"; fall back to a generic phrase if unknown.
      let anySizeMissing = false;
      const downloadSize = cells.reduce((sum, cell) => {
        if (Number.isFinite(cell.totalSize)) return sum + cell.totalSize;
        anySizeMissing = true;
        return sum;
      }, 0);
      const sizeStr =
        downloadSize > 0 && !anySizeMissing ? `approximately ${formatBytes(downloadSize)} of ` : '';

      await new Promise<void>((resolve, reject) => {
        Alert.alert(
          'Download Offline Maps',
          `This will download ${sizeStr}map tiles (${cells.length} grid cell${cells.length > 1 ? 's' : ''}).`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => reject(new Error('Cancelled')) },
            { text: 'Download', onPress: () => resolve() },
          ],
        );
      });

      setDownloadingTrailId(trailId);

      const onProgress: GridProgressCallback = (progress) => {
        if (progress.phase === 'downloading') {
          setDownloadProgress({
            fileName: progress.currentCell ?? 'tiles',
            fileIndex: progress.cellsComplete,
            totalFiles: progress.cellsTotal,
          });
        } else {
          setDownloadProgress({
            fileName: 'Merging tiles...',
            fileIndex: progress.cellsTotal,
            totalFiles: progress.cellsTotal,
          });
        }
      };

      await downloadGridTiles(trailId, cells, TILE_BASE_URL, onProgress);
    } catch (err) {
      if (err instanceof Error && err.message === 'Cancelled') {
        // User cancelled — no alert needed
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setDownloadError({ trailId, message: msg });
      }
    }
    setDownloadingTrailId(null);
    setDownloadProgress(null);
    refreshTileStatus(trailId);
  }

  function handleDelete(trailId: string, trailName: string) {
    Alert.alert(
      'Delete Offline Maps',
      `Remove downloaded map tiles for ${trailName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteTrailTiles(trailId);
            refreshTileStatus(trailId);
          },
        },
      ],
    );
  }

  function renderTileStatus(item: TrailWithTiles) {
    const { tileStatus } = item;
    const isDownloading = downloadingTrailId === item.id;

    if (isDownloading) {
      const progressFraction = downloadProgress
        ? downloadProgress.fileIndex / downloadProgress.totalFiles
        : 0;
      const progressLabel = downloadProgress
        ? `Downloading ${downloadProgress.fileName} (${downloadProgress.fileIndex}/${downloadProgress.totalFiles})`
        : 'Starting download...';
      return (
        <View style={styles.tileDownloadProgress}>
          <View style={styles.tileRow}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={[styles.tileText, { color: colors.textSecondary }]}>
              {progressLabel}
            </Text>
          </View>
          <ProgressBar progress={progressFraction} height={4} style={styles.downloadProgressBar} />
        </View>
      );
    }

    if (downloadError && downloadError.trailId === item.id) {
      return (
        <View style={styles.tileDownloadProgress}>
          <Text style={[styles.tileText, { color: colors.alertRed }]}>
            Download failed: {downloadError.message}
          </Text>
          <View style={[styles.tileRow, { borderTopWidth: 0, marginTop: spacing.xs }]}>
            <Pressable
              onPress={() => {
                setDownloadError(null);
                handleDownload(item.id, item.isCustom);
              }}
              style={styles.tileActionButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry download"
            >
              <Text style={[styles.tileAction, { color: colors.accent }]}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={() => setDownloadError(null)}
              style={styles.tileActionButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Dismiss error"
            >
              <Text style={[styles.tileAction, { color: colors.textSecondary }]}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      );
    }

    if (tileStatus.complete) {
      return (
        <View style={styles.tileRow}>
          <Text style={[styles.tileText, { color: colors.accent }]}>
            Offline maps: {formatBytes(tileStatus.totalSizeBytes)}
          </Text>
          <Pressable
            onPress={() => handleDelete(item.id, item.name)}
            style={styles.tileActionButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Delete offline maps for ${item.name}`}
          >
            <Text style={[styles.tileAction, { color: colors.alertRed }]}>Delete</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.tileRow}>
        <Text style={[styles.tileText, { color: colors.textSecondary }]}>
          No offline maps
        </Text>
        <Pressable
          onPress={() => handleDownload(item.id, item.isCustom)}
          style={styles.tileActionButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Download offline maps for ${item.name}`}
        >
          <Text style={[styles.tileAction, { color: colors.accent }]}>Download</Text>
        </Pressable>
      </View>
    );
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
          <Pressable
            style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
            accessibilityRole="button"
            accessibilityLabel={`${item.name}${item.region ? `, ${item.region}` : ''}${item.lengthKm ? `, ${item.lengthKm} kilometers` : ''}`}
            onPress={() => router.push({ pathname: '/trail/overview', params: { id: item.id } })}
          >
            <View style={styles.trailNameRow}>
              <Text style={[styles.trailName, { color: colors.textPrimary }]}>{item.name}</Text>
              {item.isCustom && (
                <View style={[styles.customBadge, { backgroundColor: colors.accentSubtle }]}>
                  <Text style={[styles.customBadgeText, { color: colors.accent }]}>Custom</Text>
                </View>
              )}
            </View>
            <View style={styles.meta}>
              {item.region && !item.isCustom && <Text style={[styles.region, { color: colors.textSecondary }]}>{item.region}</Text>}
              {item.lengthKm && <Text style={[styles.length, { color: colors.accent }]}>{item.lengthKm} km</Text>}
              {item.isCustom && item.sourceFilename && (
                <Text style={[styles.region, { color: colors.textSecondary }]} numberOfLines={1}>{item.sourceFilename}</Text>
              )}
            </View>
            {item.dataVersion && (
              <Text style={[styles.dataUpdated, { color: colors.textSecondary }]}>
                Data updated: {formatDataVersion(item.dataVersion)}
              </Text>
            )}
            {renderTileStatus(item)}

            {/* Plans for this trail */}
            {plans[item.id] && plans[item.id].length > 0 && (
              <View style={styles.plansSection}>
                <Text style={[styles.plansLabel, { color: colors.textSecondary }]}>Plans</Text>
                {plans[item.id].map((p) => (
                  <View key={p.id} style={styles.planRow}>
                    <Pressable
                      onPress={() => router.push({ pathname: '/plan/[planId]', params: { planId: p.id, trailId: item.id } })}
                      style={styles.planInfo}
                      accessibilityRole="button"
                      accessibilityLabel={`Open plan ${p.name}`}
                    >
                      <Text style={[styles.planName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text style={[styles.planMeta, { color: colors.textSecondary }]}>
                        {p.direction}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDeletePlan(p.id, p.name)}
                      style={styles.tileActionButton}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete plan ${p.name}`}
                    >
                      <Text style={[styles.tileAction, { color: colors.alertRed }]}>Delete</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            )}

            <Pressable
              onPress={() => router.push({ pathname: '/plan/create', params: { trailId: item.id, trailName: item.name } })}
              style={styles.newPlanButton}
              accessibilityRole="button"
              accessibilityLabel={`Create new plan for ${item.name}`}
            >
              <Text style={[styles.newPlanText, { color: colors.accent }]}>+ New Plan</Text>
            </Pressable>
            <View style={styles.cardFooter}>
              <Text style={[styles.viewTrail, { color: colors.accent }]}>View trail →</Text>
              {item.isCustom && (
                <Pressable
                  onPress={() => handleDeleteCustomTrail(item.id, item.name)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete custom trail ${item.name}`}
                >
                  <Text style={[styles.tileAction, { color: colors.alertRed }]}>Delete trail</Text>
                </Pressable>
              )}
            </View>
          </Pressable>
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
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  header: {
    ...typography.titleLarge,
    fontSize: 18,
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
  card: {
    borderRadius: radii.lg,
    padding: spacing.lg,
    borderWidth: StyleSheet.hairlineWidth,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 3,
    elevation: 2,
  },
  trailNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xs,
  },
  trailName: {
    ...typography.body,
    fontWeight: '600',
    flex: 1,
  },
  customBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.full,
  },
  customBadgeText: {
    ...typography.caption,
    fontSize: 10,
    fontWeight: '600',
  },
  meta: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  dataUpdated: {
    ...typography.caption,
    marginTop: spacing.xs,
  },
  region: {
    ...typography.caption,
  },
  length: {
    ...typography.caption,
    fontWeight: '500',
  },
  tileDownloadProgress: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  downloadProgressBar: {
    marginTop: spacing.xs,
  },
  tileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
    minHeight: touchTarget.min,
  },
  tileText: {
    ...typography.caption,
  },
  tileAction: {
    ...typography.caption,
    fontWeight: '600',
  },
  tileActionButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  viewTrail: {
    ...typography.caption,
    fontWeight: '600',
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
  plansSection: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(0,0,0,0.08)',
  },
  plansLabel: {
    ...typography.caption,
    fontWeight: '600',
    marginBottom: spacing.xs,
  },
  planRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touchTarget.min,
    marginBottom: spacing.xs,
  },
  planInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget.min,
  },
  planName: {
    ...typography.body,
    flex: 1,
  },
  planMeta: {
    ...typography.caption,
  },
  newPlanButton: {
    marginTop: spacing.xs,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  newPlanText: {
    ...typography.caption,
    fontWeight: '600',
  },
});
