/**
 * Small pill showing a trail's offline-tile status:
 * absent / partial / complete, or a live percentage while downloading.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { useDownloadsStore, type TrailDownload } from '../../state/downloads-store';

const IDLE: TrailDownload = { state: 'absent', downloading: false, progress: 0 };

export function DownloadBadge({ trailId }: { trailId: string }) {
  const { colors } = useTheme();
  const download = useDownloadsStore((s) => s.byTrail[trailId]) ?? IDLE;

  let label: string;
  let color: string;

  if (download.downloading) {
    label = `Downloading ${Math.round(download.progress * 100)}%`;
    color = colors.downloadActive;
  } else if (download.error) {
    label = 'Error';
    color = colors.downloadError;
  } else if (download.state === 'complete') {
    label = 'Offline';
    color = colors.downloadDone;
  } else if (download.state === 'partial') {
    label = 'Partial';
    color = colors.downloadActive;
  } else {
    label = 'Not downloaded';
    color = colors.downloadIdle;
  }

  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: {
    width: spacing.sm,
    height: spacing.sm,
    borderRadius: radii.full,
  },
  label: {
    ...typography.caption,
  },
});
