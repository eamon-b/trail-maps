import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { ClimateOverview } from '../ClimateOverview';
import { Card } from '../Card';
import type { ClimateData } from '../../services/climate-service';
import type { ClimateFetchState } from '../../hooks/usePlanEditor';
import { spacing, radii, touchTarget } from '../../tokens/spacing';
import { typography } from '../../tokens/typography';

interface PlanClimateTabProps {
  climateData: ClimateData | null;
  isCustomTrail: boolean;
  climateFetch: ClimateFetchState;
  onFetchClimate: () => void;
  planMonths: number[];
}

/** Climate tab of the plan editor (extracted from app/plan/[planId].tsx). */
export function PlanClimateTab({
  climateData,
  isCustomTrail,
  climateFetch,
  onFetchClimate,
  planMonths,
}: PlanClimateTabProps) {
  const { colors } = useTheme();

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {climateData ? (
        <ClimateOverview climate={climateData} planMonths={planMonths} />
      ) : isCustomTrail ? (
        <Card>
          <Text style={[styles.climateFetchTitle, { color: colors.textPrimary }]}>
            No Climate Data Yet
          </Text>
          {climateFetch.status === 'loading' ? (
            <View style={styles.climateFetchProgress}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.climateFetchBody, { color: colors.textSecondary }]}>
                {climateFetch.progress
                  ? `Fetching ${climateFetch.progress.locationName} (${climateFetch.progress.current}/${climateFetch.progress.total})...`
                  : 'Fetching climate data...'}
              </Text>
            </View>
          ) : (
            <>
              <Text style={[styles.climateFetchBody, { color: colors.textSecondary }]}>
                {climateFetch.status === 'error'
                  ? 'Could not fetch climate data. Check your internet connection and try again.'
                  : 'Climate data requires a one-time internet fetch. Historical averages are downloaded for a few points along the trail and stored on your device for offline use.'}
              </Text>
              <Pressable
                onPress={onFetchClimate}
                style={[styles.climateFetchButton, { backgroundColor: colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel="Fetch climate data"
              >
                <Text style={[styles.climateFetchButtonText, { color: colors.textInverse }]}>
                  {climateFetch.status === 'error' ? 'Retry' : 'Fetch Climate Data'}
                </Text>
              </Pressable>
            </>
          )}
        </Card>
      ) : (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: colors.textPrimary }]}>No Climate Data</Text>
          <Text style={[styles.emptyBody, { color: colors.textSecondary }]}>
            Climate data is not available for this trail.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: {
    padding: spacing.lg,
    paddingBottom: 100,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  emptyTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  emptyBody: {
    ...typography.body,
    textAlign: 'center',
  },
  climateFetchTitle: {
    ...typography.titleLarge,
    marginBottom: spacing.sm,
  },
  climateFetchBody: {
    ...typography.body,
    lineHeight: 20,
  },
  climateFetchProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  climateFetchButton: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.lg,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  climateFetchButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
});
