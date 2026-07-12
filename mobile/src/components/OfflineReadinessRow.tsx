import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, ViewStyle } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../theme';
import { PressableRow } from './PressableRow';
import { AppText } from './AppText';
import { useTileDownloads, formatBytes } from '../hooks/useTileDownloads';
import { getTrailTileStatus, type TrailTileStatus } from '../services/tile-service';
import { TrailDataService } from '../services/trail-data-service';
import { spacing, radii } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface OfflineReadinessRowProps {
  trailId: string;
  /** Called after tiles land or are removed (e.g. reload the offline style) */
  onStatusChanged?: (trailId: string) => void;
  style?: ViewStyle;
}

/**
 * One honest line about offline readiness (decision 9 of the P2 plan):
 * "Offline maps ✓ (base + contours)" when tiles are on disk, otherwise
 * "No offline maps for this trail" with a Download affordance driving the
 * same shared useTileDownloads workflow the Plan tab uses.
 */
export function OfflineReadinessRow({ trailId, onStatusChanged, style }: OfflineReadinessRowProps) {
  const { colors } = useTheme();
  const [tileStatus, setTileStatus] = useState<TrailTileStatus | null>(null);
  const [isCustom, setIsCustom] = useState(false);

  const refresh = useCallback((id: string) => {
    setTileStatus(getTrailTileStatus(id));
    onStatusChanged?.(id);
  }, [onStatusChanged]);

  const { downloadingTrailId, downloadProgress, downloadError, clearError, download } =
    useTileDownloads(refresh);

  useEffect(() => {
    setTileStatus(getTrailTileStatus(trailId));
    let cancelled = false;
    TrailDataService.create()
      .then((service) => service.getTrail(trailId))
      .then((row) => {
        if (!cancelled) setIsCustom(row?.isCustom ?? false);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [trailId]);

  // Tab screens stay mounted, so tiles downloaded/deleted from another tab
  // (e.g. Plan) would leave this row stale. Recompute whenever the screen
  // regains focus. (Download/delete driven from this row already refresh via
  // the useTileDownloads onStatusChanged callback above.)
  useFocusEffect(
    useCallback(() => {
      setTileStatus(getTrailTileStatus(trailId));
    }, [trailId]),
  );

  const isDownloading = downloadingTrailId === trailId;

  if (!tileStatus) return null;

  if (isDownloading) {
    const label = downloadProgress
      ? `Downloading maps… (${downloadProgress.fileIndex}/${downloadProgress.totalFiles})`
      : 'Downloading maps…';
    return (
      <View style={[styles.row, { borderColor: colors.border }, style]}>
        <AppText style={[styles.text, { color: colors.textSecondary }]}>{label}</AppText>
      </View>
    );
  }

  if (downloadError && downloadError.trailId === trailId) {
    return (
      <PressableRow
        onPress={() => {
          clearError();
          download(trailId, isCustom);
        }}
        accessibilityLabel="Map download failed. Tap to retry."
        style={StyleSheet.flatten([styles.row, { borderColor: colors.alertRed }, style])}
        bordered={false}
      >
        <AppText style={[styles.text, { color: colors.alertRed }]} numberOfLines={1}>
          Map download failed — tap to retry
        </AppText>
      </PressableRow>
    );
  }

  if (tileStatus.complete) {
    return (
      <View
        style={[styles.row, { borderColor: colors.border }, style]}
        accessibilityLabel={`Offline maps downloaded, ${formatBytes(tileStatus.totalSizeBytes)}`}
      >
        <AppText style={[styles.text, { color: colors.alertGreen }]}>
          Offline maps ✓ (base + contours)
        </AppText>
      </View>
    );
  }

  // A killed/truncated download leaves files on disk that don't match the
  // manifest — honest partial state with a re-download affordance, never a ✓.
  if (tileStatus.state === 'partial') {
    return (
      <PressableRow
        onPress={() => download(trailId, isCustom)}
        accessibilityLabel="Offline maps incomplete. Tap to finish downloading."
        style={StyleSheet.flatten([styles.row, { borderColor: colors.alertAmber }, style])}
      >
        <View style={styles.downloadRow}>
          <AppText style={[styles.text, { color: colors.alertAmber }]} numberOfLines={1}>
            Offline maps incomplete
          </AppText>
          <AppText style={[styles.action, { color: colors.accent }]}>Re-download</AppText>
        </View>
      </PressableRow>
    );
  }

  return (
    <PressableRow
      onPress={() => download(trailId, isCustom)}
      accessibilityLabel="No offline maps for this trail. Tap to download."
      style={StyleSheet.flatten([styles.row, { borderColor: colors.border }, style])}
    >
      <View style={styles.downloadRow}>
        <AppText style={[styles.text, { color: colors.textSecondary }]} numberOfLines={1}>
          No offline maps for this trail
        </AppText>
        <AppText style={[styles.action, { color: colors.accent }]}>Download</AppText>
      </View>
    </PressableRow>
  );
}

const styles = StyleSheet.create({
  row: {
    borderRadius: radii.lg,
    borderWidth: 1.5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
    minHeight: 44,
  },
  downloadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  text: {
    ...typography.dataSmall,
    fontWeight: '600',
    flexShrink: 1,
  },
  action: {
    ...typography.dataSmall,
    fontWeight: '700',
  },
});
