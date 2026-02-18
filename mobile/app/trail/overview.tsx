import { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  TextInput,
  Share,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { TrailDataService, type Trail as DbTrail } from '../../src/services/trail-data-service';
import { deleteCustomTrail } from '../../src/services/custom-trail-service';
import { trailJsonToTrail, getMinMax, type Trail } from '../../src/lib/trail-utils';
import { tileManager } from '../../src/services/tile-manager';
import {
  generateDatasheet,
  hasElevationData,
  datasheetToText,
  datasheetToCsv,
  type Datasheet,
} from '../../src/services/datasheet-service';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
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

function formatHours(hours: number): string {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export default function TrailOverviewScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();

  const [trail, setTrail] = useState<Trail | null>(null);
  const [dbTrail, setDbTrail] = useState<DbTrail | null>(null);
  const [dataVersion, setDataVersion] = useState<string | null>(null);
  const [tilesDownloaded, setTilesDownloaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [datasheetExpanded, setDatasheetExpanded] = useState(false);

  useEffect(() => {
    async function load() {
      if (!id) return;
      try {
        const service = await TrailDataService.create();
        const json = await service.getTrailTrackData(id);
        if (!json) {
          setError('Trail not found');
          setLoading(false);
          return;
        }
        const parsed = trailJsonToTrail(json);
        setTrail(parsed);

        const dbTrailRow = await service.getTrail(id);
        setDbTrail(dbTrailRow);
        if (dbTrailRow?.dataVersion) setDataVersion(dbTrailRow.dataVersion);

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

  const datasheet: Datasheet | null = useMemo(() => {
    if (!trail || trail.waypoints.length === 0) return null;
    return generateDatasheet(trail);
  }, [trail]);

  const withElevation = useMemo(() => {
    if (!trail) return false;
    return hasElevationData(trail.track.points);
  }, [trail]);

  const isCustom = dbTrail?.isCustom ?? false;

  async function handleSaveName() {
    if (!id || !editName.trim()) return;
    const service = await TrailDataService.create();
    await service.updateCustomTrail(id, editName.trim());
    setEditingName(false);
    // Reload
    const json = await service.getTrailTrackData(id);
    if (json) setTrail(trailJsonToTrail(json));
    const updated = await service.getTrail(id);
    setDbTrail(updated);
  }

  function handleDeleteTrail() {
    if (!id || !trail) return;
    Alert.alert(
      'Delete Custom Trail',
      `Delete "${trail.config.name}" and all associated data? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteCustomTrail(id);
            router.back();
          },
        },
      ],
    );
  }

  function handleShareDatasheet() {
    if (!datasheet) return;
    Alert.alert('Export Datasheet', 'Choose format:', [
      {
        text: 'Share as Text',
        onPress: () => {
          const text = datasheetToText(datasheet);
          Share.share({ message: text }).catch(() => {});
        },
      },
      {
        text: 'Share as CSV',
        onPress: () => {
          const csv = datasheetToCsv(datasheet);
          Share.share({ message: csv }).catch(() => {});
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

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
        {editingName ? (
          <View style={styles.editNameRow}>
            <TextInput
              style={[styles.editNameInput, { color: colors.textPrimary, borderColor: colors.border }]}
              value={editName}
              onChangeText={setEditName}
              autoFocus
              onSubmitEditing={handleSaveName}
              returnKeyType="done"
            />
            <Pressable onPress={handleSaveName} style={styles.editAction}>
              <Text style={[styles.editActionText, { color: colors.accent }]}>Save</Text>
            </Pressable>
            <Pressable onPress={() => setEditingName(false)} style={styles.editAction}>
              <Text style={[styles.editActionText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.nameRow}>
            <Text style={[styles.trailName, { color: colors.textPrimary }]}>{trail.config.name}</Text>
            {isCustom && (
              <Pressable
                onPress={() => { setEditName(trail.config.name); setEditingName(true); }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Edit trail name"
              >
                <Text style={[styles.editLink, { color: colors.accent }]}>Edit</Text>
              </Pressable>
            )}
          </View>
        )}

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
          {withElevation ? (
            <>
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
            </>
          ) : (
            <>
              <View style={styles.statCell}>
                <Text style={[styles.statValue, { color: colors.textSecondary }]}>—</Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>no elevation</Text>
              </View>
              <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            </>
          )}
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {trail.waypoints.length}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>waypoints</Text>
          </View>
        </View>

        {/* Elevation range */}
        {withElevation && stats && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>ELEVATION RANGE</Text>
            <Text style={[styles.elevationRange, { color: colors.textPrimary }]}>
              {stats.minEle}m — {stats.maxEle}m
            </Text>
          </View>
        )}

        {/* Datasheet — section-by-section breakdown */}
        {datasheet && datasheet.sections.length > 0 && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.datasheetHeader}>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary, marginBottom: 0 }]}>
                DATASHEET
              </Text>
              <View style={styles.datasheetActions}>
                <Pressable
                  onPress={handleShareDatasheet}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Export datasheet"
                >
                  <Text style={[styles.datasheetAction, { color: colors.accent }]}>Export</Text>
                </Pressable>
                <Pressable
                  onPress={() => setDatasheetExpanded(!datasheetExpanded)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={datasheetExpanded ? 'Collapse datasheet' : 'Expand datasheet'}
                >
                  <Text style={[styles.datasheetAction, { color: colors.accent }]}>
                    {datasheetExpanded ? 'Collapse' : 'Expand'}
                  </Text>
                </Pressable>
              </View>
            </View>

            {/* Summary line */}
            <Text style={[styles.datasheetSummary, { color: colors.textSecondary }]}>
              {datasheet.summary.sectionCount} sections
              {datasheet.summary.hasElevation
                ? ` · ${formatHours(datasheet.summary.totalHours)} hiking time`
                : ''}
              {` · ~${datasheet.summary.estimatedDays} days at ${datasheet.summary.dailyPaceKm} km/day`}
            </Text>

            {/* Resupply points */}
            {datasheet.summary.resupplyPoints.length > 0 && (
              <Text style={[styles.resupplyLine, { color: colors.textSecondary }]}>
                Resupply: {datasheet.summary.resupplyPoints.map(rp => `${rp.name} (km ${rp.km})`).join(', ')}
              </Text>
            )}

            {/* Section table */}
            {datasheetExpanded && (
              <View style={styles.datasheetTable}>
                {/* Header row */}
                <View style={[styles.datasheetRow, styles.datasheetRowHeader, { borderBottomColor: colors.border }]}>
                  <Text style={[styles.dsCell, styles.dsCellName, styles.dsCellHeader, { color: colors.textSecondary }]}>Section</Text>
                  <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellHeader, { color: colors.textSecondary }]}>km</Text>
                  {datasheet.summary.hasElevation && (
                    <>
                      <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellHeader, { color: colors.textSecondary }]}>+m</Text>
                      <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellHeader, { color: colors.textSecondary }]}>-m</Text>
                    </>
                  )}
                  <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellHeader, { color: colors.textSecondary }]}>Time</Text>
                  <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellHeader, { color: colors.textSecondary }]}>Cum</Text>
                </View>

                {/* Data rows */}
                {datasheet.sections.map((s) => (
                  <View
                    key={s.index}
                    style={[styles.datasheetRow, { borderBottomColor: colors.border }]}
                  >
                    <View style={[styles.dsCell, styles.dsCellName]}>
                      <Text style={[styles.dsSectionName, { color: colors.textPrimary }]} numberOfLines={1}>
                        {s.endName}
                      </Text>
                    </View>
                    <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellValue, { color: colors.textPrimary }]}>
                      {s.distanceKm}
                    </Text>
                    {datasheet.summary.hasElevation && (
                      <>
                        <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellValue, { color: colors.textPrimary }]}>
                          {s.ascentM}
                        </Text>
                        <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellValue, { color: colors.textPrimary }]}>
                          {s.descentM}
                        </Text>
                      </>
                    )}
                    <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellValue, { color: colors.textSecondary }]}>
                      {formatHours(s.estimatedHours)}
                    </Text>
                    <Text style={[styles.dsCell, styles.dsCellNum, styles.dsCellValue, { color: colors.textSecondary }]}>
                      {s.cumulativeKm}
                    </Text>
                  </View>
                ))}
              </View>
            )}
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

        {/* Custom trail management */}
        {isCustom && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>CUSTOM TRAIL</Text>
            {dbTrail?.sourceFilename && (
              <Text style={[styles.sourceFile, { color: colors.textSecondary }]}>
                Source: {dbTrail.sourceFilename}
              </Text>
            )}
            <Pressable
              onPress={handleDeleteTrail}
              style={styles.deleteButton}
              accessibilityRole="button"
              accessibilityLabel="Delete this custom trail"
            >
              <Text style={[styles.deleteText, { color: colors.alertRed }]}>Delete Trail</Text>
            </Pressable>
          </View>
        )}

        {/* Datasheet button */}
        <Pressable
          style={[styles.datasheetButton, { borderColor: colors.accent }]}
          onPress={() => router.push(`/trail/datasheet?id=${id}`)}
          accessibilityRole="button"
          accessibilityLabel="View waypoint datasheet"
        >
          <Text style={[styles.datasheetButtonText, { color: colors.accent }]}>Datasheet</Text>
        </Pressable>

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
  nameRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  trailName: {
    ...typography.displayLarge,
    flex: 1,
  },
  editLink: {
    ...typography.caption,
    fontWeight: '600',
  },
  editNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  editNameInput: {
    ...typography.displayLarge,
    flex: 1,
    borderBottomWidth: 1,
    paddingVertical: spacing.xs,
  },
  editAction: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  editActionText: {
    ...typography.caption,
    fontWeight: '600',
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
  sourceFile: {
    ...typography.caption,
    marginBottom: spacing.sm,
  },
  deleteButton: {
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  deleteText: {
    ...typography.body,
    fontWeight: '600',
  },
  datasheetButton: {
    borderRadius: radii.lg,
    borderWidth: 1.5,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  datasheetButtonText: {
    ...typography.body,
    fontWeight: '700',
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
  // Datasheet styles
  datasheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  datasheetActions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  datasheetAction: {
    ...typography.caption,
    fontWeight: '600',
  },
  datasheetSummary: {
    ...typography.caption,
    marginBottom: spacing.xs,
  },
  resupplyLine: {
    ...typography.caption,
    marginBottom: spacing.sm,
  },
  datasheetTable: {
    marginTop: spacing.sm,
  },
  datasheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  datasheetRowHeader: {
    paddingBottom: spacing.xs,
  },
  dsCell: {
    paddingHorizontal: 2,
  },
  dsCellName: {
    flex: 1,
  },
  dsCellNum: {
    width: 44,
    textAlign: 'right' as const,
  },
  dsCellHeader: {
    fontSize: 10,
    fontWeight: '600' as const,
  },
  dsCellValue: {
    fontSize: 12,
    fontVariant: ['tabular-nums'] as const,
  },
  dsSectionName: {
    fontSize: 12,
  },
});
