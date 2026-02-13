import { useCallback, useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Pressable,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../src/theme';
import { spacing, radii, touchTarget } from '../../src/tokens/spacing';
import { typography } from '../../src/tokens/typography';
import { ProgressBar, TrailMap } from '../../src/components';
import {
  pickGpxFile,
  fetchGpxFromUrl,
  processGpxFile,
  processGpxContent,
  saveCustomTrail,
  type ImportError,
} from '../../src/services/custom-trail-service';
import type { ProcessingResult, ProcessingWarning } from '../../src/lib/gpx-processor';
import type { Trail } from '../../src/lib/trail-utils';

type ImportStage = 'pick' | 'processing' | 'preview' | 'saving' | 'done' | 'error';

const PROCESSING_STAGES: Record<string, string> = {
  'Parsing GPX': 'Parsing GPX...',
  'Merging tracks': 'Analyzing tracks...',
  'Validating points': 'Validating points...',
  'Processing elevation': 'Processing elevation...',
  'Rounding coordinates': 'Preparing data...',
  'Calculating distances': 'Calculating distances...',
  'Simplifying track': 'Simplifying track...',
  'Processing waypoints': 'Matching waypoints...',
  'Finalizing': 'Finalizing...',
  'Complete': 'Done!',
};

const WAYPOINT_TYPE_LABELS: Record<string, string> = {
  campsite: 'Campsite',
  water: 'Water',
  'water-tank': 'Water Tank',
  town: 'Town',
  shelter: 'Shelter',
  hut: 'Hut',
  poi: 'Point of Interest',
  road: 'Road Crossing',
  trailhead: 'Trailhead',
  endpoint: 'Endpoint',
  food: 'Food',
  resupply: 'Resupply',
};

function formatWarning(w: ProcessingWarning): string {
  switch (w.type) {
    case 'no_elevation':
      return 'No elevation data found. Distance stats will still work, but elevation profiles will be flat.';
    case 'elevation_spikes_smoothed':
      return `Smoothed ${w.count} elevation spike(s) for a cleaner profile.`;
    case 'invalid_coordinates_skipped':
      return `Skipped ${w.count} point(s) with invalid coordinates.`;
    case 'duplicate_points_removed':
      return `Removed ${w.count} duplicate point(s).`;
    case 'track_gaps':
      return `Found ${w.count} gap(s) between track segments (>500m apart).`;
    case 'no_waypoints':
      return 'No waypoints found in this file.';
    case 'orphaned_waypoints':
      return `${w.count} waypoint(s) were too far from the track and were excluded.`;
    case 'no_tracks':
      return 'No track data found in this file.';
    default:
      return w.message;
  }
}

export default function ImportScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [stage, setStage] = useState<ImportStage>('pick');
  const [progressStage, setProgressStage] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [result, setResult] = useState<ProcessingResult | null>(null);
  const [sourceFilename, setSourceFilename] = useState('');
  const [trailName, setTrailName] = useState('');
  const [error, setError] = useState<{ message: string; suggestion?: string } | null>(null);
  const [urlInput, setUrlInput] = useState('');
  const [showUrlInput, setShowUrlInput] = useState(false);
  const cancelledRef = useRef(false);

  const handlePickFile = useCallback(async () => {
    try {
      cancelledRef.current = false;
      const file = await pickGpxFile();
      if (!file) return; // User cancelled picker

      setStage('processing');
      setSourceFilename(file.name);

      const processingResult = await processGpxFile(file.uri, file.name, file.size, {
        onProgress: (stage, percent) => {
          if (cancelledRef.current) return;
          setProgressStage(PROCESSING_STAGES[stage] || stage);
          setProgressPercent(percent / 100);
        },
      });

      if (cancelledRef.current) {
        setStage('pick');
        return;
      }

      setResult(processingResult);
      setTrailName(processingResult.trail.config.name);
      setStage('preview');
    } catch (e) {
      const err = e as ImportError;
      setError({ message: err.message, suggestion: err.suggestion });
      setStage('error');
    }
  }, []);

  const handleUrlImport = useCallback(async () => {
    if (!urlInput.trim()) return;

    try {
      cancelledRef.current = false;
      setStage('processing');
      setProgressStage('Downloading file...');
      setProgressPercent(0);

      const { content, name } = await fetchGpxFromUrl(urlInput.trim());
      setSourceFilename(name);

      const processingResult = await processGpxContent(content, name, {
        onProgress: (stage, percent) => {
          if (cancelledRef.current) return;
          setProgressStage(PROCESSING_STAGES[stage] || stage);
          setProgressPercent(percent / 100);
        },
      });

      if (cancelledRef.current) {
        setStage('pick');
        return;
      }

      setResult(processingResult);
      setTrailName(processingResult.trail.config.name);
      setStage('preview');
    } catch (e) {
      const err = e as ImportError;
      setError({ message: err.message, suggestion: err.suggestion });
      setStage('error');
    }
  }, [urlInput]);

  const handleCancelProcessing = useCallback(() => {
    cancelledRef.current = true;
    setStage('pick');
    setProgressStage('');
    setProgressPercent(0);
  }, []);

  const handleSave = useCallback(async () => {
    if (!result) return;

    setStage('saving');
    try {
      const importResult = await saveCustomTrail(result, trailName, sourceFilename);
      setStage('done');
      // Navigate back and let the plan screen refresh
      Alert.alert('Trail Imported', `"${trailName}" has been imported successfully.`, [
        { text: 'OK', onPress: () => router.back() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save trail';
      setError({ message: msg });
      setStage('error');
    }
  }, [result, trailName, sourceFilename, router]);

  const handleRetry = useCallback(() => {
    setStage('pick');
    setError(null);
    setResult(null);
    setProgressStage('');
    setProgressPercent(0);
    setShowUrlInput(false);
    setUrlInput('');
  }, []);

  // Render based on stage
  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          style={styles.closeButton}
          accessibilityRole="button"
          accessibilityLabel="Close"
        >
          <Text style={[styles.closeText, { color: colors.textSecondary }]}>Cancel</Text>
        </Pressable>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>Import Trail</Text>
        <View style={styles.headerSpacer} />
      </View>

      {stage === 'pick' && (
        <View style={styles.pickContainer}>
          <Text style={[styles.pickTitle, { color: colors.textPrimary }]}>
            Import a GPX file
          </Text>
          <Text style={[styles.pickDescription, { color: colors.textSecondary }]}>
            Import a trail from a GPX file on your device or from a URL.
          </Text>

          <Pressable
            style={[styles.pickButton, { backgroundColor: colors.accent }]}
            onPress={handlePickFile}
            accessibilityRole="button"
            accessibilityLabel="Choose file from device"
          >
            <Text style={[styles.pickButtonText, { color: colors.textInverse }]}>Choose File</Text>
          </Pressable>

          <Pressable
            style={[styles.urlToggle]}
            onPress={() => setShowUrlInput(!showUrlInput)}
            accessibilityRole="button"
          >
            <Text style={[styles.urlToggleText, { color: colors.accent }]}>
              {showUrlInput ? 'Hide URL import' : 'Import from URL'}
            </Text>
          </Pressable>

          {showUrlInput && (
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={[styles.urlInputContainer, { borderColor: colors.border }]}>
                <TextInput
                  style={[styles.urlInput, { color: colors.textPrimary, borderColor: colors.border }]}
                  placeholder="https://example.com/trail.gpx"
                  placeholderTextColor={colors.textSecondary}
                  value={urlInput}
                  onChangeText={setUrlInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="go"
                  onSubmitEditing={handleUrlImport}
                />
                <Pressable
                  style={[styles.urlFetchButton, { backgroundColor: colors.accent, opacity: urlInput.trim() ? 1 : 0.5 }]}
                  onPress={handleUrlImport}
                  disabled={!urlInput.trim()}
                  accessibilityRole="button"
                  accessibilityLabel="Fetch GPX from URL"
                >
                  <Text style={[styles.urlFetchText, { color: colors.textInverse }]}>Fetch</Text>
                </Pressable>
              </View>
            </KeyboardAvoidingView>
          )}

          <View style={[styles.infoBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.infoTitle, { color: colors.textSecondary }]}>SUPPORTED FILES</Text>
            <Text style={[styles.infoText, { color: colors.textSecondary }]}>
              GPX files from apps like Gaia GPS, AllTrails, CalTopo, and Garmin. Files up to 50 MB.
            </Text>
          </View>
        </View>
      )}

      {stage === 'processing' && (
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.processingStage, { color: colors.textPrimary }]}>
            {progressStage || 'Starting...'}
          </Text>
          <ProgressBar progress={progressPercent} height={6} style={styles.processingProgress} />
          <Pressable
            style={[styles.cancelButton, { borderColor: colors.border }]}
            onPress={handleCancelProcessing}
            accessibilityRole="button"
          >
            <Text style={[styles.cancelText, { color: colors.textSecondary }]}>Cancel</Text>
          </Pressable>
        </View>
      )}

      {stage === 'preview' && result && (
        <ScrollView
          style={styles.previewScroll}
          contentContainerStyle={[styles.previewContent, { paddingBottom: insets.bottom + spacing.xxl }]}
        >
          {/* Trail name input */}
          <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>TRAIL NAME</Text>
          <TextInput
            style={[styles.nameInput, { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surface }]}
            value={trailName}
            onChangeText={setTrailName}
            placeholder="Enter trail name"
            placeholderTextColor={colors.textSecondary}
          />

          {/* Map preview */}
          <View style={[styles.mapContainer, { borderColor: colors.border }]}>
            <TrailMap
              displayPoints={result.trail.track.displayPoints || result.trail.track.points}
              waypoints={result.trail.waypoints}
            />
          </View>

          {/* Stats */}
          <View style={[styles.statsGrid, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                {Math.round(result.trail.track.totalDistance * 10) / 10}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>km</Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                +{Math.round(result.trail.track.totalAscent)}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>m ascent</Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: colors.border }]} />
            <View style={styles.statCell}>
              <Text style={[styles.statValue, { color: colors.textPrimary }]}>
                {result.trail.waypoints.length}
              </Text>
              <Text style={[styles.statLabel, { color: colors.textSecondary }]}>waypoints</Text>
            </View>
          </View>

          {/* Waypoints */}
          {result.trail.waypoints.length > 0 && (
            <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>WAYPOINTS</Text>
              {result.trail.waypoints.slice(0, 20).map((wp, i) => (
                <View key={i} style={styles.waypointRow}>
                  <Text style={[styles.waypointName, { color: colors.textPrimary }]} numberOfLines={1}>
                    {wp.name}
                  </Text>
                  <Text style={[styles.waypointType, { color: colors.textSecondary }]}>
                    {WAYPOINT_TYPE_LABELS[wp.type] || wp.type}
                  </Text>
                </View>
              ))}
              {result.trail.waypoints.length > 20 && (
                <Text style={[styles.moreText, { color: colors.textSecondary }]}>
                  +{result.trail.waypoints.length - 20} more
                </Text>
              )}
            </View>
          )}

          {/* Warnings */}
          {result.warnings.length > 0 && (
            <View style={[styles.section, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>NOTES</Text>
              {result.warnings.map((w, i) => (
                <View key={i} style={styles.warningRow}>
                  <Text style={[styles.warningDot, { color: colors.alertAmber }]}>*</Text>
                  <Text style={[styles.warningText, { color: colors.textSecondary }]}>
                    {formatWarning(w)}
                  </Text>
                </View>
              ))}
            </View>
          )}

          {/* Action buttons */}
          <View style={styles.actionButtons}>
            <Pressable
              style={[styles.importButton, { backgroundColor: colors.accent }]}
              onPress={handleSave}
              accessibilityRole="button"
              accessibilityLabel="Import trail"
            >
              <Text style={[styles.importButtonText, { color: colors.textInverse }]}>Import</Text>
            </Pressable>
            <Pressable
              style={[styles.cancelImportButton, { borderColor: colors.border }]}
              onPress={() => router.back()}
              accessibilityRole="button"
            >
              <Text style={[styles.cancelImportText, { color: colors.textSecondary }]}>Cancel</Text>
            </Pressable>
          </View>
        </ScrollView>
      )}

      {stage === 'saving' && (
        <View style={styles.processingContainer}>
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={[styles.processingStage, { color: colors.textPrimary }]}>Saving trail...</Text>
        </View>
      )}

      {stage === 'error' && error && (
        <View style={styles.errorContainer}>
          <Text style={[styles.errorTitle, { color: colors.alertRed }]}>Import Failed</Text>
          <Text style={[styles.errorMessage, { color: colors.textPrimary }]}>{error.message}</Text>
          {error.suggestion && (
            <Text style={[styles.errorSuggestion, { color: colors.textSecondary }]}>
              {error.suggestion}
            </Text>
          )}
          <Pressable
            style={[styles.retryButton, { backgroundColor: colors.accent }]}
            onPress={handleRetry}
            accessibilityRole="button"
          >
            <Text style={[styles.retryButtonText, { color: colors.textInverse }]}>Try Again</Text>
          </Pressable>
          <Pressable
            style={styles.errorBackButton}
            onPress={() => router.back()}
            accessibilityRole="button"
          >
            <Text style={[styles.errorBackText, { color: colors.textSecondary }]}>Go Back</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    minHeight: touchTarget.min,
  },
  closeButton: {
    minWidth: 60,
    minHeight: touchTarget.min,
    justifyContent: 'center',
  },
  closeText: {
    ...typography.body,
  },
  headerTitle: {
    ...typography.body,
    fontWeight: '600',
  },
  headerSpacer: {
    minWidth: 60,
  },

  // Pick stage
  pickContainer: {
    flex: 1,
    padding: spacing.lg,
    justifyContent: 'center',
  },
  pickTitle: {
    ...typography.displayLarge,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  pickDescription: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.xxl,
  },
  pickButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  pickButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  urlToggle: {
    alignItems: 'center',
    paddingVertical: spacing.sm,
    marginBottom: spacing.md,
  },
  urlToggleText: {
    ...typography.body,
    fontWeight: '500',
  },
  urlInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.lg,
  },
  urlInput: {
    flex: 1,
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  urlFetchButton: {
    borderRadius: radii.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  urlFetchText: {
    ...typography.body,
    fontWeight: '600',
  },
  infoBox: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  infoTitle: {
    ...typography.titleSmall,
    marginBottom: spacing.sm,
  },
  infoText: {
    ...typography.caption,
    lineHeight: 18,
  },

  // Processing stage
  processingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  processingStage: {
    ...typography.body,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  processingProgress: {
    width: '80%',
    marginBottom: spacing.xl,
  },
  cancelButton: {
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
  cancelText: {
    ...typography.body,
  },

  // Preview stage
  previewScroll: {
    flex: 1,
  },
  previewContent: {
    padding: spacing.lg,
  },
  fieldLabel: {
    ...typography.titleSmall,
    marginBottom: spacing.xs,
  },
  nameInput: {
    ...typography.body,
    fontWeight: '600',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    marginBottom: spacing.lg,
  },
  mapContainer: {
    height: 250,
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: spacing.md,
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
  waypointRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
  },
  waypointName: {
    ...typography.body,
    flex: 1,
    marginRight: spacing.sm,
  },
  waypointType: {
    ...typography.caption,
  },
  moreText: {
    ...typography.caption,
    marginTop: spacing.xs,
    fontStyle: 'italic',
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.xs,
    gap: spacing.sm,
  },
  warningDot: {
    ...typography.body,
    fontWeight: '700',
    marginTop: 1,
  },
  warningText: {
    ...typography.caption,
    flex: 1,
    lineHeight: 18,
  },
  actionButtons: {
    marginTop: spacing.md,
    gap: spacing.md,
  },
  importButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  importButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  cancelImportButton: {
    borderRadius: radii.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  cancelImportText: {
    ...typography.body,
  },

  // Error stage
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
  },
  errorTitle: {
    ...typography.displaySmall,
    marginBottom: spacing.md,
  },
  errorMessage: {
    ...typography.body,
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  errorSuggestion: {
    ...typography.caption,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.xl,
  },
  retryButton: {
    borderRadius: radii.lg,
    paddingHorizontal: spacing.xxl,
    paddingVertical: spacing.md,
    marginBottom: spacing.md,
  },
  retryButtonText: {
    ...typography.body,
    fontWeight: '700',
  },
  errorBackButton: {
    paddingVertical: spacing.sm,
  },
  errorBackText: {
    ...typography.body,
  },
});
