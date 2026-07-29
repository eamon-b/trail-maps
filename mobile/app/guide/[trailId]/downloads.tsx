/**
 * Offline maps screen — download / cancel / delete a guide's map tiles.
 *
 * Download state comes from the downloads store (which wraps the filesystem
 * tile manager). The tile base URL is read from EXPO_PUBLIC_TILE_BASE_URL and
 * passed into the store — services never read env themselves.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { getTrailIndexEntry } from '../../../src/services/trail-loader';
import { tileManager } from '../../../src/services/tile-manager';
import { useDownloadsStore } from '../../../src/state/downloads-store';

const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

const IDLE = { state: 'absent' as const, downloading: false, progress: 0 };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export default function DownloadsScreen() {
  const { colors } = useTheme();
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const entry = getTrailIndexEntry(trailId);

  const download = useDownloadsStore((s) => s.byTrail[trailId]) ?? IDLE;
  const startDownload = useDownloadsStore((s) => s.startDownload);
  const cancel = useDownloadsStore((s) => s.cancel);
  const deleteTiles = useDownloadsStore((s) => s.deleteTiles);
  const refreshStatus = useDownloadsStore((s) => s.refreshStatus);

  // On-disk size, re-read whenever the download state changes.
  const [sizeBytes, setSizeBytes] = useState(0);
  useEffect(() => {
    refreshStatus(trailId);
    setSizeBytes(tileManager.getTrailStatus(trailId).totalSizeBytes);
  }, [trailId, refreshStatus, download.state]);

  const missingBaseUrl = TILE_BASE_URL.length === 0;

  const statusText = useMemo(() => {
    if (download.downloading) return `Downloading… ${Math.round(download.progress * 100)}%`;
    if (download.error) return `Error: ${download.error}`;
    switch (download.state) {
      case 'complete':
        return 'Offline maps ready';
      case 'partial':
        return 'Partial download — re-download to finish';
      default:
        return 'Not downloaded';
    }
  }, [download]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.panel, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>
          {entry?.name ?? trailId}
        </Text>
        <Text style={[styles.status, { color: colors.textSecondary }]}>{statusText}</Text>
        {sizeBytes > 0 && (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>
            On device: {formatBytes(sizeBytes)}
          </Text>
        )}

        {download.downloading && (
          <View style={[styles.progressTrack, { backgroundColor: colors.surface }]}>
            <View
              style={[
                styles.progressFill,
                { backgroundColor: colors.downloadActive, width: `${Math.round(download.progress * 100)}%` },
              ]}
            />
          </View>
        )}
      </View>

      {missingBaseUrl && (
        <Text style={[styles.warning, { color: colors.warning }]}>
          EXPO_PUBLIC_TILE_BASE_URL is not set — downloads are disabled.
        </Text>
      )}

      <View style={styles.actions}>
        {download.downloading ? (
          <ActionButton
            label="Cancel"
            variant="danger"
            onPress={() => cancel(trailId)}
          />
        ) : (
          <ActionButton
            label={download.state === 'complete' ? 'Re-download' : 'Download'}
            variant="accent"
            disabled={missingBaseUrl}
            onPress={() => startDownload(trailId, TILE_BASE_URL)}
          />
        )}

        {(download.state === 'complete' || download.state === 'partial') && !download.downloading && (
          <ActionButton
            label="Delete"
            variant="danger"
            onPress={() => deleteTiles(trailId)}
          />
        )}
      </View>
    </View>
  );
}

function ActionButton({
  label,
  variant,
  onPress,
  disabled,
}: {
  label: string;
  variant: 'accent' | 'danger';
  onPress: () => void;
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const bg = variant === 'accent' ? colors.accent : colors.danger;
  const fg = variant === 'accent' ? colors.accentText : colors.dangerText;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.button, { backgroundColor: bg }, disabled && styles.buttonDisabled]}
    >
      <Text style={[styles.buttonLabel, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: spacing.lg,
    gap: spacing.lg,
  },
  panel: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  title: {
    ...typography.displaySmall,
  },
  status: {
    ...typography.body,
  },
  meta: {
    ...typography.caption,
  },
  progressTrack: {
    height: spacing.sm,
    borderRadius: radii.full,
    overflow: 'hidden',
    marginTop: spacing.sm,
  },
  progressFill: {
    height: '100%',
    borderRadius: radii.full,
  },
  warning: {
    ...typography.bodySmall,
  },
  actions: {
    gap: spacing.md,
  },
  button: {
    minHeight: touchTarget.field,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonLabel: {
    ...typography.body,
    fontWeight: '600',
  },
});
