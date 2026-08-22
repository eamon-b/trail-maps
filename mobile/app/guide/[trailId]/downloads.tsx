/**
 * Offline maps screen — download / cancel / delete a guide's map tiles.
 *
 * Download state comes from the downloads store (which wraps the filesystem
 * tile manager). The tile base URL is read from EXPO_PUBLIC_TILE_BASE_URL and
 * passed into the store — services never read env themselves.
 *
 * The screen never assumes the guide owns a pack. `offline-pack-resolver`
 * decides which tile directory this guide actually maps to: its own for a
 * bundled trail, a *borrowed* bundled pack for an import whose track sits
 * inside one's coverage, or none at all. Everything below — the store key, the
 * on-disk size, the update check, download / cancel / delete — is driven by
 * that resolved pack id rather than by the route's trailId, so borrowing is a
 * single substitution and an uncovered import disables the actions instead of
 * requesting a pack the server has never heard of.
 */

import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTheme } from '../../../src/theme';
import { radii, spacing, touchTarget, typography } from '../../../src/tokens';
import { useGuide } from '../../../src/features/guide/GuideContext';
import { useTrailTitle } from '../../../src/features/guide/use-trail-title';
import { offlinePackPlan, resolveOfflinePack } from '../../../src/services/offline-pack-resolver';
import { tileManager } from '../../../src/services/tile-manager';
import { useDownloadsStore, type TrailDownload } from '../../../src/state/downloads-store';

const TILE_BASE_URL = process.env.EXPO_PUBLIC_TILE_BASE_URL ?? '';

const IDLE: TrailDownload = { state: 'absent', downloading: false, progress: 0 };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(1)} MB`;
}

export default function DownloadsScreen() {
  const { colors } = useTheme();
  const { trailId } = useLocalSearchParams<{ trailId: string }>();
  const { trail } = useGuide();
  const title = useTrailTitle(trailId, trailId);

  // Which pack this guide maps to (its own, a borrowed bundled one, or none).
  const plan = useMemo(
    () => offlinePackPlan(resolveOfflinePack(trailId, trail), trailId),
    [trailId, trail],
  );
  const packTrailId = plan.packTrailId;

  const download = useDownloadsStore((s) => (packTrailId ? s.byTrail[packTrailId] : undefined)) ?? IDLE;
  const startDownload = useDownloadsStore((s) => s.startDownload);
  const cancel = useDownloadsStore((s) => s.cancel);
  const deleteTiles = useDownloadsStore((s) => s.deleteTiles);
  const refreshStatus = useDownloadsStore((s) => s.refreshStatus);
  const checkForUpdates = useDownloadsStore((s) => s.checkForUpdates);

  // On-disk size, re-read whenever the download state changes.
  const [sizeBytes, setSizeBytes] = useState(0);
  useEffect(() => {
    if (!packTrailId) {
      setSizeBytes(0);
      return;
    }
    refreshStatus(packTrailId);
    setSizeBytes(tileManager.getTrailStatus(packTrailId).totalSizeBytes);
  }, [packTrailId, refreshStatus, download.state]);

  const missingBaseUrl = TILE_BASE_URL.length === 0;
  const canDownload = plan.packAvailable && !missingBaseUrl && packTrailId != null;

  // Ask the server whether a newer pack exists — on open, and again once a
  // download finishes so the badge is re-derived rather than guessed. The store
  // ignores anything that isn't a complete pack and swallows network failures,
  // so this is a no-op when there is nothing to say.
  useEffect(() => {
    if (missingBaseUrl || !packTrailId) return;
    void checkForUpdates([packTrailId], TILE_BASE_URL);
  }, [packTrailId, checkForUpdates, missingBaseUrl, download.state, download.downloading]);

  const updateAvailable =
    !!download.updateAvailable && download.state === 'complete' && !download.downloading;

  const statusText = useMemo(() => {
    if (!plan.packAvailable) return 'Offline maps unavailable';
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
  }, [download, plan.packAvailable]);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.panel, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
        <Text style={[styles.status, { color: colors.textSecondary }]}>{statusText}</Text>
        {plan.note && (
          <Text style={[styles.meta, { color: colors.textSecondary }]}>{plan.note}</Text>
        )}
        {updateAvailable && (
          <Text style={[styles.badge, { color: colors.downloadActive, borderColor: colors.downloadActive }]}>
            Update available{download.remoteVersion ? ` (${download.remoteVersion})` : ''}
          </Text>
        )}
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

      {missingBaseUrl && plan.packAvailable && (
        <Text style={[styles.warning, { color: colors.warning }]}>
          EXPO_PUBLIC_TILE_BASE_URL is not set — downloads are disabled.
        </Text>
      )}

      <View style={styles.actions}>
        {download.downloading && packTrailId ? (
          <ActionButton
            label="Cancel"
            variant="danger"
            onPress={() => cancel(packTrailId)}
          />
        ) : (
          <ActionButton
            label={
              updateAvailable
                ? 'Update'
                : download.state === 'complete'
                  ? 'Re-download'
                  : 'Download'
            }
            variant="accent"
            disabled={!canDownload}
            onPress={() => packTrailId && startDownload(packTrailId, TILE_BASE_URL)}
          />
        )}

        {packTrailId &&
          (download.state === 'complete' || download.state === 'partial') &&
          !download.downloading && (
            <ActionButton
              label="Delete"
              variant="danger"
              onPress={() => deleteTiles(packTrailId)}
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
  badge: {
    ...typography.caption,
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.full,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
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
