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
import { useRouter } from 'expo-router';
import { useTheme } from '../../src/theme';
import { TrailDataService, type Trail } from '../../src/services/trail-data-service';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  type TrailTileStatus,
  type DownloadProgress,
} from '../../src/services/tile-service';
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
  const [downloadingTrailId, setDownloadingTrailId] = useState<string | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<{ fileName: string; fileIndex: number; totalFiles: number } | null>(null);
  const [storageInfo, setStorageInfo] = useState<{ usedBytes: number; availableBytes: number } | null>(null);

  const loadTrails = useCallback(async () => {
    const service = await TrailDataService.create();
    const list = await service.listTrails();
    const withTiles: TrailWithTiles[] = list.map((trail) => ({
      ...trail,
      tileStatus: getTrailTileStatus(trail.id),
    }));
    setTrails(withTiles);

    // Load storage info
    const usedBytes = tileManager.getTotalStorageUsed();
    const availableBytes = await tileManager.getAvailableSpace();
    setStorageInfo({ usedBytes, availableBytes });
  }, []);

  useEffect(() => {
    loadTrails();
  }, [loadTrails]);

  function refreshTileStatus(trailId: string) {
    setTrails((prev) =>
      prev.map((t) =>
        t.id === trailId ? { ...t, tileStatus: getTrailTileStatus(trailId) } : t,
      ),
    );
    // Refresh storage info
    tileManager.getAvailableSpace().then((availableBytes) => {
      setStorageInfo({
        usedBytes: tileManager.getTotalStorageUsed(),
        availableBytes,
      });
    }).catch(() => {});
  }

  async function handleDownload(trailId: string) {
    if (!TILE_BASE_URL) {
      Alert.alert(
        'Tile server not configured',
        'Set EXPO_PUBLIC_TILE_BASE_URL in your environment (e.g. .env file).\n\nFor development, use the dev screen (Dev Catalog > Map Tiles).',
      );
      return;
    }

    setDownloadingTrailId(trailId);
    let filesDone = 0;
    try {
      await downloadTrailTiles(trailId, TILE_BASE_URL, (progress: DownloadProgress) => {
        filesDone++;
        setDownloadProgress({
          fileName: progress.fileName,
          fileIndex: filesDone,
          totalFiles: 2, // base.mbtiles + contours.mbtiles
        });
        refreshTileStatus(trailId);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Download Failed', msg);
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

    if (tileStatus.complete) {
      return (
        <View style={styles.tileRow}>
          <Text style={[styles.tileText, { color: colors.accent }]}>
            Offline maps: {formatBytes(tileStatus.totalSizeBytes)}
          </Text>
          <Pressable
            onPress={() => handleDelete(item.id, item.name)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Delete offline maps for ${item.name}`}
          >
            <Text style={[styles.tileAction, { color: '#c00' }]}>Delete</Text>
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
          onPress={() => handleDownload(item.id)}
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
      <Text style={[styles.header, { color: colors.accent }]}>Select a Trail</Text>
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
            <Text style={[styles.trailName, { color: colors.textPrimary }]}>{item.name}</Text>
            <View style={styles.meta}>
              {item.region && <Text style={[styles.region, { color: colors.textSecondary }]}>{item.region}</Text>}
              {item.lengthKm && <Text style={[styles.length, { color: colors.accent }]}>{item.lengthKm} km</Text>}
            </View>
            {item.dataVersion && (
              <Text style={[styles.dataUpdated, { color: colors.textSecondary }]}>
                Data updated: {formatDataVersion(item.dataVersion)}
              </Text>
            )}
            {renderTileStatus(item)}
            <Text style={[styles.viewTrail, { color: colors.accent }]}>View trail →</Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No trails loaded</Text>
        }
        ListFooterComponent={
          storageInfo && storageInfo.usedBytes > 0 ? (
            <View style={[styles.storageFooter, { borderTopColor: colors.border }]}>
              <Text style={[styles.storageTitle, { color: colors.textPrimary }]}>Offline Storage</Text>
              <Text style={[styles.storageDetail, { color: colors.textSecondary }]}>
                Maps: {formatBytes(storageInfo.usedBytes)} used  |  {formatBytes(storageInfo.availableBytes)} available
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
  header: {
    ...typography.titleLarge,
    fontSize: 18,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
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
  trailName: {
    ...typography.body,
    fontWeight: '600',
    marginBottom: spacing.xs,
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
    minHeight: touchTarget.min / 2,
  },
  tileText: {
    ...typography.caption,
  },
  tileAction: {
    ...typography.caption,
    fontWeight: '600',
  },
  viewTrail: {
    ...typography.caption,
    fontWeight: '600',
    marginTop: spacing.sm,
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
