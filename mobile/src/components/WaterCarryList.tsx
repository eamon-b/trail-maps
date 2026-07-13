import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Card } from './Card';
import type { WaterCarryAnalysis } from '@lib/water-carry-calculator';
import { spacing } from '../tokens/spacing';
import { typography } from '../tokens/typography';

interface WaterCarryListProps {
  analysis: WaterCarryAnalysis;
}

/**
 * Displays water sources along a trail with inter-source gaps
 * and dry stretch warnings. Shows a "no data" message when the
 * trail has no water source information.
 */
export function WaterCarryList({ analysis }: WaterCarryListProps) {
  const { colors } = useTheme();

  if (!analysis.hasWaterData) {
    return (
      <Card>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Water Sources</Text>
        <Text style={[styles.noData, { color: colors.textSecondary }]}>
          No water source data available for this trail.
        </Text>
      </Card>
    );
  }

  return (
    <Card>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Water Sources</Text>

      {/* Summary stats */}
      <View style={styles.statsRow}>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          {analysis.sources.length} source{analysis.sources.length !== 1 ? 's' : ''}
        </Text>
        <Text style={[styles.stat, { color: colors.textSecondary }]}>
          Longest gap: {analysis.longestGapKm.toFixed(1)} km
        </Text>
        {analysis.dryStretchCount > 0 && (
          <Text style={[styles.stat, { color: colors.alertAmber }]}>
            {analysis.dryStretchCount} dry stretch{analysis.dryStretchCount !== 1 ? 'es' : ''}
          </Text>
        )}
      </View>

      {/* Sources with seasonal notes */}
      {analysis.sources.some(s => s.seasonalNote) && (
        <View style={[styles.seasonalSection, { borderBottomColor: colors.border }]}>
          {analysis.sources
            .filter(s => s.seasonalNote)
            .map((source, i) => (
              <View key={i} style={styles.seasonalRow}>
                <Text style={[styles.seasonalName, { color: colors.textPrimary }]}>
                  💧 {source.name} (km {source.km.toFixed(1)})
                </Text>
                <Text style={[styles.seasonalNote, { color: colors.textSecondary }]}>
                  {source.seasonalNote}
                </Text>
              </View>
            ))}
        </View>
      )}

      {/* Gap list */}
      {analysis.gaps.map((gap, i) => (
        <View
          key={i}
          style={[
            styles.gapRow,
            { borderBottomColor: colors.border },
            gap.isDryStretch && { borderLeftColor: colors.alertAmber, borderLeftWidth: 3 },
          ]}
        >
          <View style={styles.gapHeader}>
            <Text style={[styles.gapDistance, { color: gap.isDryStretch ? colors.alertAmber : colors.textPrimary }]}>
              {gap.distanceKm.toFixed(1)} km
            </Text>
            {gap.isDryStretch && (
              <Text style={[styles.dryLabel, { color: colors.alertAmber }]}>DRY</Text>
            )}
          </View>
          <Text style={[styles.gapNames, { color: colors.textSecondary }]} numberOfLines={1}>
            {gap.fromName} → {gap.toName}
          </Text>
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  title: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  noData: {
    ...typography.body,
    fontStyle: 'italic',
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  stat: {
    ...typography.caption,
    fontVariant: ['tabular-nums'],
  },
  gapRow: {
    paddingVertical: spacing.sm,
    paddingLeft: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  gapDistance: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  dryLabel: {
    ...typography.caption,
    fontWeight: '700',
  },
  gapNames: {
    ...typography.caption,
    marginTop: 2,
  },
  seasonalSection: {
    marginBottom: spacing.sm,
    paddingBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  seasonalRow: {
    paddingVertical: spacing.xs,
  },
  seasonalName: {
    ...typography.caption,
    fontWeight: '600',
  },
  seasonalNote: {
    ...typography.caption,
    fontStyle: 'italic',
    marginTop: 2,
  },
});
