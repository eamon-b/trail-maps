import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { Card } from '../Card';
import { ProgressBar } from '../ProgressBar';
import type { Trail } from '../../services/trail-data-service';
import type { Plan } from '../../services/plan-service';
import type { TrailTileStatus } from '../../services/tile-service';
import {
  formatBytes,
  type TileDownloadProgress,
  type TileDownloadError,
} from '../../hooks/useTileDownloads';
import { spacing, radii, touchTarget } from '../../tokens/spacing';
import { typography } from '../../tokens/typography';

export interface TrailWithTiles extends Trail {
  tileStatus: TrailTileStatus;
}

function formatDataVersion(version: string): string {
  const d = new Date(version + 'T00:00:00');
  if (isNaN(d.getTime())) return version;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface TrailCardProps {
  trail: TrailWithTiles;
  plans: Plan[];
  isDownloading: boolean;
  downloadProgress: TileDownloadProgress | null;
  downloadError: TileDownloadError | null;
  onOpen: () => void;
  onCreatePlan: () => void;
  onOpenPlan: (plan: Plan) => void;
  onDeletePlan: (plan: Plan) => void;
  onDeleteCustomTrail: () => void;
  onDownloadTiles: () => void;
  onDeleteTiles: () => void;
  onRetryDownload: () => void;
  onDismissDownloadError: () => void;
}

/** One trail's card in the Plan tab list (extracted from app/(tabs)/plan.tsx). */
export function TrailCard({
  trail,
  plans,
  isDownloading,
  downloadProgress,
  downloadError,
  onOpen,
  onCreatePlan,
  onOpenPlan,
  onDeletePlan,
  onDeleteCustomTrail,
  onDownloadTiles,
  onDeleteTiles,
  onRetryDownload,
  onDismissDownloadError,
}: TrailCardProps) {
  const { colors } = useTheme();

  function renderTileStatus() {
    const { tileStatus } = trail;

    if (isDownloading) {
      const progressFraction = downloadProgress
        ? downloadProgress.fileIndex / downloadProgress.totalFiles
        : 0;
      const progressLabel = downloadProgress
        ? `Downloading ${downloadProgress.fileName} (${downloadProgress.fileIndex}/${downloadProgress.totalFiles})`
        : 'Starting download...';
      return (
        <View style={[styles.tileDownloadProgress, { borderTopColor: colors.border }]}>
          <View style={[styles.tileRow, { borderTopColor: colors.border }]}>
            <ActivityIndicator size="small" color={colors.accent} />
            <Text style={[styles.tileText, { color: colors.textSecondary }]}>
              {progressLabel}
            </Text>
          </View>
          <ProgressBar progress={progressFraction} height={4} style={styles.downloadProgressBar} />
        </View>
      );
    }

    if (downloadError && downloadError.trailId === trail.id) {
      return (
        <View style={[styles.tileDownloadProgress, { borderTopColor: colors.border }]}>
          <Text style={[styles.tileText, { color: colors.alertRed }]}>
            Download failed: {downloadError.message}
          </Text>
          <View style={[styles.tileRow, { borderTopColor: colors.border, borderTopWidth: 0, marginTop: spacing.xs }]}>
            <Pressable
              onPress={onRetryDownload}
              style={styles.tileActionButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Retry download"
            >
              <Text style={[styles.tileAction, { color: colors.accent }]}>Retry</Text>
            </Pressable>
            <Pressable
              onPress={onDismissDownloadError}
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
        <View style={[styles.tileRow, { borderTopColor: colors.border }]}>
          <Text style={[styles.tileText, { color: colors.accent }]}>
            Offline maps: {formatBytes(tileStatus.totalSizeBytes)}
          </Text>
          <Pressable
            onPress={onDeleteTiles}
            style={styles.tileActionButton}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Delete offline maps for ${trail.name}`}
          >
            <Text style={[styles.tileAction, { color: colors.alertRed }]}>Delete</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={[styles.tileRow, { borderTopColor: colors.border }]}>
        <Text style={[styles.tileText, { color: colors.textSecondary }]}>
          No offline maps
        </Text>
        <Pressable
          onPress={onDownloadTiles}
          style={styles.tileActionButton}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Download offline maps for ${trail.name}`}
        >
          <Text style={[styles.tileAction, { color: colors.accent }]}>Download</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <Card
      style={styles.card}
      accessibilityLabel={`${trail.name}${trail.region ? `, ${trail.region}` : ''}${trail.lengthKm ? `, ${trail.lengthKm} kilometers` : ''}`}
      onPress={onOpen}
    >
      <View style={styles.trailNameRow}>
        <Text style={[styles.trailName, { color: colors.textPrimary }]}>{trail.name}</Text>
        {trail.isCustom && (
          <View style={[styles.customBadge, { backgroundColor: colors.accentSubtle }]}>
            <Text style={[styles.customBadgeText, { color: colors.accent }]}>Custom</Text>
          </View>
        )}
      </View>
      <View style={styles.meta}>
        {trail.region && !trail.isCustom && <Text style={[styles.region, { color: colors.textSecondary }]}>{trail.region}</Text>}
        {trail.lengthKm && <Text style={[styles.length, { color: colors.accent }]}>{trail.lengthKm} km</Text>}
        {trail.isCustom && trail.sourceFilename && (
          <Text style={[styles.region, { color: colors.textSecondary }]} numberOfLines={1}>{trail.sourceFilename}</Text>
        )}
      </View>
      {trail.dataVersion && (
        <Text style={[styles.dataUpdated, { color: colors.textSecondary }]}>
          Data updated: {formatDataVersion(trail.dataVersion)}
        </Text>
      )}
      {renderTileStatus()}

      {/* Plans for this trail */}
      {plans.length > 0 && (
        <View style={[styles.plansSection, { borderTopColor: colors.border }]}>
          <Text style={[styles.plansLabel, { color: colors.textSecondary }]}>Plans</Text>
          {plans.map((p) => (
            <View key={p.id} style={styles.planRow}>
              <Pressable
                onPress={() => onOpenPlan(p)}
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
                onPress={() => onDeletePlan(p)}
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
        onPress={onCreatePlan}
        style={styles.newPlanButton}
        accessibilityRole="button"
        accessibilityLabel={`Create new plan for ${trail.name}`}
      >
        <Text style={[styles.newPlanText, { color: colors.accent }]}>+ New Plan</Text>
      </Pressable>
      <View style={styles.cardFooter}>
        <Text style={[styles.viewTrail, { color: colors.accent }]}>View trail →</Text>
        {trail.isCustom && (
          <Pressable
            onPress={onDeleteCustomTrail}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={`Delete custom trail ${trail.name}`}
          >
            <Text style={[styles.tileAction, { color: colors.alertRed }]}>Delete trail</Text>
          </Pressable>
        )}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: {
    // List uses gap for separation; Card's default margin would double it
    marginBottom: 0,
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
  plansSection: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
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
