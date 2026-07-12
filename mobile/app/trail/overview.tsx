import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  Alert,
  Share,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { useTrailData } from '../../src/contexts/TrailDataContext';
import { backfillTrailElevation } from '../../src/services/elevation-service';
import { getMinMax } from '../../src/lib/trail-utils';
import { useDirectionalTrail } from '../../src/hooks/useDirectionalTrail';
import { useTileDownloads, formatBytes } from '../../src/hooks/useTileDownloads';
import { getTrailTileStatus, type TrailTileStatus } from '../../src/services/tile-service';
import { getWaypointLabel } from '../../src/lib/waypoint-type-meta';
import {
  generateDatasheet,
  hasElevationData,
  datasheetToText,
  datasheetToCsv,
  type Datasheet,
} from '../../src/services/datasheet-service';
import { DIRECTION_PREF_KEY } from './[id]';
import { waypointsToGpx, trailToGpx } from '../../src/lib/gpx-writer';
import { shareGpxFile, gpxFilename } from '../../src/services/gpx-export-service';
import type { CustomWaypoint } from '../../src/services/trail-data-service';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';

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
  const { trail, dbTrail, loading, error, loadTrail, reloadTrail } = useTrailData();

  const [tileStatus, setTileStatus] = useState<TrailTileStatus | null>(null);
  const [datasheetExpanded, setDatasheetExpanded] = useState(false);
  const [isReversed, setIsReversed] = useState(false);
  const [elevationFetch, setElevationFetch] = useState<'idle' | 'fetching' | 'error'>('idle');
  const [customWaypoints, setCustomWaypoints] = useState<CustomWaypoint[]>([]);

  const refreshTileStatus = useCallback((tid: string) => {
    setTileStatus(getTrailTileStatus(tid));
  }, []);

  const { downloadingTrailId, downloadProgress, downloadError, clearError, download, removeTiles } =
    useTileDownloads(refreshTileStatus);

  useEffect(() => {
    if (id) {
      loadTrail(id);
      setTileStatus(getTrailTileStatus(id));

      // Load saved direction preference
      AsyncStorage.getItem(DIRECTION_PREF_KEY).then(prefsStr => {
        const prefs = prefsStr ? JSON.parse(prefsStr) : {};
        setIsReversed(!!prefs[id]);
      }).catch(() => {});

      // The user's own waypoints on this trail (for GPX export)
      import('../../src/services/trail-data-service')
        .then(({ TrailDataService }) => TrailDataService.create())
        .then(service => service.getCustomWaypoints(id))
        .then(setCustomWaypoints)
        .catch(() => setCustomWaypoints([]));
    }
  }, [id, loadTrail]);

  // Active trail respects direction (recomputes when trail or direction changes)
  const activeTrail = useDirectionalTrail(trail, isReversed);

  const stats = useMemo(() => {
    if (!activeTrail) return null;
    const elevations = activeTrail.track.points.map((p) => p.ele);
    const { min, max } = getMinMax(elevations);
    return { minEle: Math.round(min), maxEle: Math.round(max) };
  }, [activeTrail]);

  const waypointCounts = useMemo(() => {
    if (!activeTrail) return [];
    const counts: Record<string, number> = {};
    for (const wp of activeTrail.waypoints) {
      counts[wp.type] = (counts[wp.type] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort(([, a], [, b]) => b - a)
      .map(([type, count]) => ({ type, label: getWaypointLabel(type), count }));
  }, [activeTrail]);

  const datasheet: Datasheet | null = useMemo(() => {
    if (!activeTrail || activeTrail.waypoints.length === 0) return null;
    return generateDatasheet(activeTrail);
  }, [activeTrail]);

  const withElevation = useMemo(() => {
    if (!activeTrail) return false;
    return hasElevationData(activeTrail.track.points);
  }, [activeTrail]);

  const dataVersion = dbTrail?.dataVersion ?? null;
  const isCustom = dbTrail?.isCustom ?? false;

  // User-triggered elevation backfill for a custom trail imported without
  // elevation (e.g. offline). Mirrors the plan-screen climate fetch pattern.
  async function handleFetchElevation() {
    if (!id) return;
    setElevationFetch('fetching');
    try {
      const updated = await backfillTrailElevation(id);
      if (updated) {
        setElevationFetch('idle');
        await reloadTrail();
      } else {
        setElevationFetch('error');
      }
    } catch {
      setElevationFetch('error');
    }
  }

  // "Export my waypoints (GPX)" — the user's custom waypoints on this trail,
  // via the OS share sheet. User data is never trapped in the app.
  async function handleExportWaypoints() {
    if (!trail || customWaypoints.length === 0) return;
    try {
      const gpx = waypointsToGpx(
        customWaypoints.map(wp => ({
          name: wp.name,
          lat: wp.lat,
          lon: wp.lon,
          ele: wp.ele,
          type: wp.type,
          description: wp.description,
          createdAt: wp.createdAt,
        })),
        { name: `${trail.config.name} — my waypoints` },
      );
      await shareGpxFile(gpxFilename(`${trail.config.name}-my-waypoints`), gpx);
    } catch (e) {
      console.warn('Failed to export waypoints:', e);
      Alert.alert('Export failed', 'Could not export the GPX file.');
    }
  }

  // "Export trail (GPX)" — the full custom trail (track + waypoints).
  async function handleExportTrail() {
    if (!trail) return;
    try {
      const gpx = trailToGpx(trail);
      await shareGpxFile(gpxFilename(trail.config.name), gpx);
    } catch (e) {
      console.warn('Failed to export trail:', e);
      Alert.alert('Export failed', 'Could not export the GPX file.');
    }
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

  const directionLabels = useMemo(() => {
    if (!trail) return { default: 'Default', reversed: 'Reversed' };
    const dir = trail.config.direction;
    return dir ? { default: dir.default, reversed: dir.reversed } : { default: 'Default', reversed: 'Reversed' };
  }, [trail]);

  async function handleDirectionChange(reversed: boolean) {
    if (!id) return;
    setIsReversed(reversed);
    try {
      const prefsStr = await AsyncStorage.getItem(DIRECTION_PREF_KEY);
      const prefs = prefsStr ? JSON.parse(prefsStr) : {};
      prefs[id] = reversed;
      await AsyncStorage.setItem(DIRECTION_PREF_KEY, JSON.stringify(prefs));
    } catch {
      // Non-critical
    }
  }

  if (loading || (!activeTrail && !error)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={colors.accent} />
        <Text style={[styles.loadingText, { color: colors.textSecondary }]}>Loading trail...</Text>
      </View>
    );
  }

  if (error || !activeTrail) {
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

        {/* Trail name (rename/delete moved to the My data tab — P1 PR E) */}
        <View style={styles.nameRow}>
          <Text style={[styles.trailName, { color: colors.textPrimary }]}>{activeTrail.config.name}</Text>
        </View>

        {/* Region badge */}
        {activeTrail.config.region && (
          <View style={[styles.badge, { backgroundColor: colors.accentSubtle }]}>
            <Text style={[styles.badgeText, { color: colors.accent }]}>{activeTrail.config.region}</Text>
          </View>
        )}

        {/* Direction selector */}
        <View style={[styles.directionRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Pressable
            onPress={() => handleDirectionChange(false)}
            style={[
              styles.directionOption,
              !isReversed && { backgroundColor: colors.accent },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: !isReversed }}
            accessibilityLabel={`Direction: ${directionLabels.default}`}
          >
            <Text style={[
              styles.directionOptionText,
              { color: !isReversed ? colors.textInverse : colors.textSecondary },
            ]}>
              {directionLabels.default}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => handleDirectionChange(true)}
            style={[
              styles.directionOption,
              isReversed && { backgroundColor: colors.accent },
            ]}
            accessibilityRole="button"
            accessibilityState={{ selected: isReversed }}
            accessibilityLabel={`Direction: ${directionLabels.reversed}`}
          >
            <Text style={[
              styles.directionOptionText,
              { color: isReversed ? colors.textInverse : colors.textSecondary },
            ]}>
              {directionLabels.reversed}
            </Text>
          </Pressable>
        </View>

        {/* Stats grid */}
        <View style={[styles.statsGrid, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.statCell}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {Math.round(activeTrail.track.totalDistance)}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>km</Text>
          </View>
          <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
          {withElevation ? (
            <>
              <View style={styles.statCell}>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                  +{Math.round(activeTrail.track.totalAscent)}
                </Text>
                <Text style={[styles.statLabel, { color: colors.textSecondary }]}>m ascent</Text>
              </View>
              <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
              <View style={styles.statCell}>
                <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                  -{Math.round(activeTrail.track.totalDescent)}
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
              {activeTrail.waypoints.length}
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

        {/* Elevation backfill for a custom trail imported without elevation */}
        {isCustom && !withElevation && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>ELEVATION</Text>
            {elevationFetch === 'fetching' ? (
              <View style={styles.elevationFetchRow}>
                <ActivityIndicator size="small" color={colors.accent} />
                <Text style={[styles.elevationFetchBody, { color: colors.textSecondary }]}>
                  Fetching elevation data…
                </Text>
              </View>
            ) : (
              <>
                <Text style={[styles.elevationFetchBody, { color: colors.textSecondary }]}>
                  {elevationFetch === 'error'
                    ? 'Could not fetch elevation data. Check your connection and try again.'
                    : 'This trail was imported without elevation. Fetch it now to see ascent, descent and the elevation profile.'}
                </Text>
                <Pressable
                  onPress={handleFetchElevation}
                  style={[styles.elevationFetchButton, { backgroundColor: colors.accent }]}
                  accessibilityRole="button"
                  accessibilityLabel="Fetch elevation data"
                >
                  <Text style={[styles.elevationFetchButtonText, { color: colors.textInverse }]}>
                    {elevationFetch === 'error' ? 'Retry' : 'Fetch elevation data (requires internet)'}
                  </Text>
                </Pressable>
              </>
            )}
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
            {datasheet.summary.hasElevation && (
              <Text style={[styles.datasheetSummary, { color: colors.textSecondary }]}>
                {"Times estimated via Naismith's Rule (4 km/h + 600m/h ascent)"}
              </Text>
            )}

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

        {/* Offline maps — real download / retry affordance (P2 decision 9),
            matching the hike row's states. */}
        <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>OFFLINE MAPS</Text>
          {downloadingTrailId === id ? (
            <View style={styles.offlineRow}>
              <ActivityIndicator size="small" color={colors.accent} />
              <Text style={[styles.offlineStatus, { color: colors.textSecondary }]}>
                {downloadProgress
                  ? `Downloading maps… (${downloadProgress.fileIndex}/${downloadProgress.totalFiles})`
                  : 'Downloading maps…'}
              </Text>
            </View>
          ) : downloadError && downloadError.trailId === id ? (
            <Pressable
              onPress={() => { clearError(); if (id) download(id, isCustom); }}
              style={[styles.exportButton, { borderColor: colors.alertRed }]}
              accessibilityRole="button"
              accessibilityLabel="Map download failed. Tap to retry."
            >
              <Text style={[styles.exportButtonText, { color: colors.alertRed }]}>
                Map download failed — tap to retry
              </Text>
            </Pressable>
          ) : tileStatus?.complete ? (
            <View style={styles.offlineRow}>
              <Text style={[styles.offlineStatus, { color: colors.alertGreen }]}>
                Downloaded ✓ ({formatBytes(tileStatus.totalSizeBytes)})
              </Text>
              <Pressable
                onPress={() => { if (id) removeTiles(id, activeTrail.config.name); }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={`Delete offline maps for ${activeTrail.config.name}`}
              >
                <Text style={[styles.datasheetAction, { color: colors.alertRed }]}>Delete</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => { if (id) download(id, isCustom); }}
              style={[styles.exportButton, { borderColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel={
                tileStatus?.state === 'partial'
                  ? 'Offline maps incomplete. Tap to finish downloading.'
                  : 'Download offline maps'
              }
            >
              <Text style={[styles.exportButtonText, { color: colors.accent }]}>
                {tileStatus?.state === 'partial'
                  ? 'Offline maps incomplete — re-download'
                  : 'Download offline maps'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* GPX export — user data is never trapped */}
        {(customWaypoints.length > 0 || isCustom) && (
          <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>GPX EXPORT</Text>
            {customWaypoints.length > 0 && (
              <Pressable
                onPress={handleExportWaypoints}
                style={[styles.exportButton, { borderColor: colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel={`Export my ${customWaypoints.length} waypoints as GPX`}
              >
                <Text style={[styles.exportButtonText, { color: colors.accent }]}>
                  Export my waypoints (GPX) · {customWaypoints.length}
                </Text>
              </Pressable>
            )}
            {isCustom && (
              <Pressable
                onPress={handleExportTrail}
                style={[styles.exportButton, { borderColor: colors.accent }]}
                accessibilityRole="button"
                accessibilityLabel="Export trail as GPX"
              >
                <Text style={[styles.exportButtonText, { color: colors.accent }]}>
                  Export trail (GPX)
                </Text>
              </Pressable>
            )}
          </View>
        )}

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
            <Text style={[styles.manageHint, { color: colors.textSecondary }]}>
              Rename or delete this trail from the Contribute tab (My data).
            </Text>
          </View>
        )}

        {/* Datasheet button */}
        <Pressable
          testID="datasheet-button"
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
  directionRow: {
    flexDirection: 'row',
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing.md,
  },
  directionOption: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  directionOptionText: {
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
  elevationFetchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  elevationFetchBody: {
    ...typography.body,
    marginBottom: spacing.md,
  },
  elevationFetchButton: {
    borderRadius: radii.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  elevationFetchButtonText: {
    ...typography.body,
    fontWeight: '700',
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
  offlineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  exportButton: {
    borderWidth: 1,
    borderRadius: radii.md,
    minHeight: touchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  exportButtonText: {
    ...typography.body,
    fontWeight: '600',
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
  manageHint: {
    ...typography.caption,
    fontStyle: 'italic',
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
