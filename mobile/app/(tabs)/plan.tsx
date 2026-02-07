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
import { useTheme } from '../../src/theme';
import { TrailDataService, type Trail } from '../../src/services/trail-data-service';
import {
  getTrailTileStatus,
  downloadTrailTiles,
  deleteTrailTiles,
  type TrailTileStatus,
} from '../../src/services/tile-service';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

// Set via EXPO_PUBLIC_TILE_BASE_URL env var (e.g. https://tiles.trailcompanion.app)
// For local dev, use the dev screen (Dev Catalog > Map Tiles) which prompts for a server IP.
const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TrailWithTiles extends Trail {
  tileStatus: TrailTileStatus;
}

export default function PlanScreen() {
  const { colors } = useTheme();
  const [trails, setTrails] = useState<TrailWithTiles[]>([]);
  const [downloadingTrailId, setDownloadingTrailId] = useState<string | null>(null);

  const loadTrails = useCallback(async () => {
    const service = await TrailDataService.create();
    const list = await service.listTrails();
    const withTiles: TrailWithTiles[] = list.map((trail) => ({
      ...trail,
      tileStatus: getTrailTileStatus(trail.id),
    }));
    setTrails(withTiles);
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
    try {
      await downloadTrailTiles(trailId, TILE_BASE_URL, () => {
        refreshTileStatus(trailId);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      Alert.alert('Download Failed', msg);
    }
    setDownloadingTrailId(null);
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
      return (
        <View style={styles.tileRow}>
          <ActivityIndicator size="small" color={colors.accent} />
          <Text style={[styles.tileText, { color: colors.textSecondary }]}>
            Downloading...
          </Text>
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
          >
            <Text style={[styles.trailName, { color: colors.textPrimary }]}>{item.name}</Text>
            <View style={styles.meta}>
              {item.region && <Text style={[styles.region, { color: colors.textSecondary }]}>{item.region}</Text>}
              {item.lengthKm && <Text style={[styles.length, { color: colors.accent }]}>{item.lengthKm} km</Text>}
            </View>
            {renderTileStatus(item)}
          </Pressable>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>No trails loaded</Text>
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
  region: {
    ...typography.caption,
  },
  length: {
    ...typography.caption,
    fontWeight: '500',
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
  empty: {
    ...typography.body,
    textAlign: 'center',
    marginTop: 40,
  },
});
