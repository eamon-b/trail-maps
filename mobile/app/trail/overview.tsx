import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailDataService } from '../../src/services/trail-data-service';
import { TRAIL_DATA } from '../../src/services/trail-loader';
import { trailJsonToTrail, getMinMax, type Trail } from '../../src/lib/trail-utils';
import { tileManager } from '../../src/services/tile-manager';
import { spacing, radii } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

const WAYPOINT_TYPE_LABELS: Record<string, string> = {
  campsite: 'Campsites',
  water: 'Water sources',
  'water-tank': 'Water tanks',
  town: 'Towns',
  shelter: 'Shelters',
  hut: 'Huts',
  poi: 'Points of interest',
  road: 'Road crossings',
  trailhead: 'Trailheads',
};

function formatLabel(type: string): string {
  return WAYPOINT_TYPE_LABELS[type] ?? type.charAt(0).toUpperCase() + type.slice(1);
}

export default function TrailOverviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [dataVersion, setDataVersion] = useState<string | null>(null);
  const [tilesDownloaded, setTilesDownloaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!id) return;
      try {
        const service = await TrailDataService.create();
        const json = TRAIL_DATA[id];
        if (!json) {
          setError('Trail not found');
          setLoading(false);
          return;
        }
        const parsed = trailJsonToTrail(json);
        setTrail(parsed);

        const dbTrail = await service.getTrail(id);
        if (dbTrail?.dataVersion) setDataVersion(dbTrail.dataVersion);

        setTilesDownloaded(tileManager.isTrailDownloaded(id));
        setLoading(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load trail');
        setLoading(false);
      }
    }
    load();
  }, [id]);

  const stats = useMemo(() => {
    if (!trail) return null;
    const elevations = trail.track.points.map((p) => p.ele);
    const { min, max } = getMinMax(elevations);
    return { minEle: Math.round(min), maxEle: Math.round(max) };
  }, [trail]);

  const waypointCounts = useMemo(() => {
    if (!trail) return [];
    const counts: Record<string, number> = {};
    for (const wp of trail.waypoints) {
      counts[wp.type] = (counts[wp.type] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({ type, label: formatLabel(type), count }));
  }, [trail]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading trail...</Text>
      </View>
    );
  }

  if (error || !trail) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <Text style={[styles.errorText, { color: colors.alertRed }]}>{error ?? 'Trail not found'}</Text>
        <Pressable onPress={() => router.back()} style={styles.backButton}>
          <Text style={[styles.backText, { color: colors.accent }]}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.xxl }]}
      >
        {/* Back button */}
        <Pressable onPress={() => router.back()} style={styles.backRow} accessibilityRole="button" accessibilityLabel="Go back">
          <Text style={[styles.backArrow, { color: colors.accent }]}>←</Text>
          <Text style={[styles.backLabel, { color: colors.accent }]}>Back</Text>
        </Pressable>

        {/* Trail name */}
        <Text style={[styles.trailName, { color: colors.textPrimary }]}>{trail.config.name}</Text>

        {/* Region badge */}
        {trail.config.region && (
          <View style={[styles.badge, { backgroundColor: colors.accentSubtle }]}>
            <Text style={[styles.badgeText, { color: colors.accent }]}>{trail.config.region}</Text>
          </View>
        )}

        {/* Stats grid */}
        <View style={[styles.statsGrid, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {Math.round(trail.track.totalDistance)}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>km</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              +{Math.round(trail.track.totalAscent)}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>m ascent</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              -{Math.round(trail.track.totalDescent)}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>m descent</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {trail.waypoints.length}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>waypoints</Text>
          </View>
        </View>

        {/* Elevation range */}
        {stats && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>ELEVATION RANGE</Text>
            <Text style={[styles.elevationRange, { color: colors.textPrimary }]}>
              {stats.minEle}m — {stats.maxEle}m
            </Text>
          </View>
        )}

        {/* Waypoint summary */}
        {waypointCounts.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>WAYPOINTS</Text>
            {waypointCounts.map(({ type, label, count }) => (
              <View key={type} style={styles.waypointRow}>
                <Text style={[styles.waypointLabel, { color: colors.textPrimary }]}>{label}</Text>
                <Text style={[styles.waypointCount, { color: colors.textSecondary }]}>{count}</Text>
              </View>
            ))}
          </View>
        )}

        {/* Offline maps status */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>OFFLINE MAPS</Text>
          <Text style={[styles.offlineStatus, { color: tilesDownloaded ? colors.alertGreen : colors.textSecondary }]}>
            {tilesDownloaded ? 'Downloaded' : 'Not downloaded'}
          </Text>
        </View>

        {/* Data version */}
        {dataVersion && (
          <Text style={[styles.dataVersion, { color: colors.textSecondary }]}>
            Data updated: {new Date(dataVersion + 'T00:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
          </Text>
        )}

        {/* Open Map button */}
        <Pressable
          style={[styles.openMapButton, { backgroundColor: colors.accent }]}
          onPress={() => router.push(`/trail/${id}`)}
          accessibilityRole="button"
          accessibilityLabel="Open interactive map"
        >
          <Text style={[styles.openMapText, { color: colors.textInverse }]}>Open Map</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  loadingText: {
    ...typography.body,
    marginTop: spacing.md,
  },
  errorText: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  backButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  backText: {
    ...typography.body,
    fontWeight: '600',
  },
  scroll: {
    paddingHorizontal: spacing.lg,
  },
  backRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.lg,
  },
  backArrow: {
    fontSize: 22,
    fontWeight: '600',
  },
  backLabel: {
    ...typography.body,
    fontWeight: '600',
  },
  trailName: {
    ...typography.displayLarge,
    marginBottom: spacing.sm,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radii.full,
    marginBottom: spacing.lg,
  },
  badgeText: {
    ...typography.caption,
    fontWeight: '600',
  },
  statsGrid: {
    flexDirection: 'row',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  statCell: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    ...typography.displaySmall,
    fontVariant: ['tabular-nums'],
  },
  statLabel: {
    ...typography.caption,
    marginTop: 2,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: 'stretch',
  },
  section: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  sectionTitle: {
    ...typography.titleSmall,
    marginBottom: spacing.sm,
  },
  elevationRange: {
    ...typography.displaySmall,
    fontVariant: ['tabular-nums'],
  },
  waypointRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  waypointLabel: {
    ...typography.body,
  },
  waypointCount: {
    ...typography.body,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  offlineStatus: {
    ...typography.body,
    fontWeight: '500',
  },
  dataVersion: {
    ...typography.caption,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  openMapButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  openMapText: {
    ...typography.body,
    fontWeight: '700',
  },
});
