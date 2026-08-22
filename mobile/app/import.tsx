/**
 * Import screen — the review step between picking a GPX file and getting a
 * guide.
 *
 * The picker itself runs from the My Guides header (`pickGpxFile`), and this
 * screen is pushed with the resulting `file://` URI. Keeping the picker out of
 * here means this screen has exactly one job — process a URI and show what came
 * out — instead of also having to cope with being remounted into a picker it
 * already launched.
 *
 * Nothing is written until Save: an unusable file, or a report the user doesn't
 * like the look of, leaves no registry row, no file on disk and no guide.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { formatDistance } from '@lib/format-distance';
import { useTheme } from '../src/theme';
import { radii, spacing, typography } from '../src/tokens';
import { useSettingsStore } from '../src/state/settings-store';
import {
  importGpxFromUri,
  saveImport,
  type ImportStage,
  type ImportedGpx,
} from '../src/features/import/import-gpx';
import {
  backfillImportElevation,
  elevationRequestEstimate,
} from '../src/features/import/elevation-backfill-flow';

const STAGE_LABELS: Record<ImportStage, string> = {
  reading: 'Reading file…',
  ingesting: 'Building your guide…',
};

type ScreenState =
  | { status: 'working'; stage: ImportStage }
  | { status: 'ready'; imported: ImportedGpx }
  | { status: 'saving' }
  | { status: 'failed'; message: string };

/**
 * Elevation backfill is an *offer*, not a step: a file with no `<ele>` data
 * still imports and still saves. So its progress and failures live in their own
 * state rather than in {@link ScreenState} — a failed lookup must leave the
 * review screen standing, with Save still available.
 */
type BackfillState =
  | { status: 'idle' }
  | { status: 'running'; done: number; total: number }
  | { status: 'failed'; message: string };

export default function ImportScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { uri, fileName } = useLocalSearchParams<{ uri?: string; fileName?: string }>();

  const [state, setState] = useState<ScreenState>({ status: 'working', stage: 'reading' });
  const [name, setName] = useState('');
  const [backfill, setBackfill] = useState<BackfillState>({ status: 'idle' });
  // The import runs once per URI. Without this guard a re-render from the
  // stage callback (or a fast-refresh remount) would re-parse the file.
  const startedFor = useRef<string | null>(null);
  // Held in a ref so leaving the screen can abort a lookup that may still have
  // minutes of batches to go — nobody is waiting for it any more.
  const backfillAbort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      backfillAbort.current?.abort();
      backfillAbort.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!uri || startedFor.current === uri) return;
    startedFor.current = uri;

    let cancelled = false;
    setState({ status: 'working', stage: 'reading' });
    importGpxFromUri(uri, {
      fileName,
      onStage: (stage) => {
        if (!cancelled) setState({ status: 'working', stage });
      },
    })
      .then((imported) => {
        if (cancelled) return;
        setName(imported.suggestedName);
        setState({ status: 'ready', imported });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'failed',
          message: err instanceof Error ? err.message : 'This file could not be read as GPX.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [uri, fileName]);

  const onFetchElevation = useCallback(async () => {
    if (state.status !== 'ready') return;
    const imported = state.imported;

    backfillAbort.current?.abort();
    const controller = new AbortController();
    backfillAbort.current = controller;

    // 0/0 until the first batch reports: the real total is the *sampled* point
    // count, which the lookup decides, and guessing it would make the counter
    // jump backwards on a long track.
    setBackfill({ status: 'running', done: 0, total: 0 });
    try {
      const backfilled = await backfillImportElevation(imported, {
        signal: controller.signal,
        onProgress: (done, total) => {
          if (!controller.signal.aborted) setBackfill({ status: 'running', done, total });
        },
      });
      if (controller.signal.aborted) return;
      // Spread over the original so `suggestedName` (and anything else
      // ImportedGpx adds on top of ImportGpxResult) survives.
      setState({ status: 'ready', imported: { ...imported, ...backfilled } });
      setBackfill({ status: 'idle' });
    } catch (err: unknown) {
      // Leaving the screen is not a failure worth rendering — and there is no
      // screen left to render it on.
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) return;
      setBackfill({
        status: 'failed',
        message: err instanceof Error ? err.message : 'Could not fetch elevation data.',
      });
    } finally {
      if (backfillAbort.current === controller) backfillAbort.current = null;
    }
  }, [state]);

  const onSave = useCallback(async () => {
    if (state.status !== 'ready') return;
    const imported = state.imported;
    setState({ status: 'saving' });
    try {
      const trailId = await saveImport(imported, name);
      // replace, not push: backing out of the new guide should land on My
      // Guides, not on a review screen for a trail that already exists.
      router.replace({ pathname: '/guide/[trailId]', params: { trailId } });
    } catch (err: unknown) {
      setState({
        status: 'failed',
        message: err instanceof Error ? err.message : 'Could not save this trail.',
      });
    }
  }, [state, name, router]);

  if (!uri) {
    return (
      <Message
        title="Nothing to import"
        body="Choose a GPX file from My Guides to import it."
        onClose={() => router.back()}
      />
    );
  }

  if (state.status === 'failed') {
    return <Message title="Import failed" body={state.message} onClose={() => router.back()} />;
  }

  if (state.status === 'working' || state.status === 'saving') {
    return (
      <View style={[styles.centered, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={[styles.stage, { color: colors.textSecondary }]}>
          {state.status === 'saving' ? 'Saving…' : STAGE_LABELS[state.stage]}
        </Text>
      </View>
    );
  }

  const { report, trail } = state.imported;
  const fetching = backfill.status === 'running';

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: colors.background }]}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.field}>
        <Text style={[styles.label, { color: colors.textSecondary }]}>Guide name</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
          value={name}
          onChangeText={setName}
          placeholder="Name this guide"
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel="Guide name"
          autoCorrect={false}
          returnKeyType="done"
        />
      </View>

      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Stat label="Length" value={formatDistance(trail.config.lengthKm, units)} />
        <Stat label="Track points" value={String(report.pointCount)} />
        <Stat label="Waypoints" value={String(report.waypointCount)} />
        {report.offTrailWaypointCount > 0 && (
          <Stat label="Off-trail waypoints" value={String(report.offTrailWaypointCount)} />
        )}
        {report.tracksFound > 1 && (
          <Stat
            label="Tracks"
            value={`${report.tracksCombined} of ${report.tracksFound} joined`}
          />
        )}
        {(report.alternateCount > 0 || report.sideTripCount > 0) && (
          <Stat
            label="Variants"
            value={`${report.alternateCount} alternate · ${report.sideTripCount} side trip`}
          />
        )}
        {report.simplified && (
          <Stat label="Simplified from" value={`${report.sourcePointCount} points`} />
        )}
      </View>

      {report.warnings.length > 0 && (
        <View
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.warning }]}
        >
          <Text style={[styles.warningTitle, { color: colors.textPrimary }]}>
            {report.warnings.length === 1 ? 'Heads up' : `${report.warnings.length} things to know`}
          </Text>
          {report.warnings.map((warning) => (
            <Text key={warning} style={[styles.warning, { color: colors.textSecondary }]}>
              • {warning}
            </Text>
          ))}
        </View>
      )}

      {!report.hasElevation && (
        <View
          style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={[styles.warningTitle, { color: colors.textPrimary }]}>Elevation</Text>
          <Text style={[styles.warning, { color: colors.textSecondary }]}>
            Without a profile, day estimates are distance-only — climbing time isn&apos;t
            included. Terrain heights can be looked up now instead.
          </Text>

          {fetching ? (
            <View style={styles.progress}>
              <ActivityIndicator color={colors.accent} />
              <Text style={[styles.warning, { color: colors.textSecondary }]}>
                {backfill.total > 0
                  ? `Fetching elevation… ${formatCount(backfill.done)} / ${formatCount(backfill.total)} points`
                  : 'Fetching elevation…'}
              </Text>
            </View>
          ) : (
            <Pressable
              onPress={() => void onFetchElevation()}
              accessibilityRole="button"
              accessibilityLabel={
                backfill.status === 'failed' ? 'Try fetching elevation again' : 'Fetch elevation'
              }
              style={({ pressed }) => [
                styles.secondaryButton,
                { borderColor: colors.accent },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.accent }]}>
                {backfill.status === 'failed' ? 'Try again' : 'Fetch elevation'} · ~
                {elevationRequestEstimate(trail)} requests
              </Text>
            </Pressable>
          )}

          {backfill.status === 'failed' && (
            <Text style={[styles.warning, { color: colors.danger }]}>
              {backfill.message} You can try again, or save without elevation.
            </Text>
          )}
        </View>
      )}

      <Pressable
        onPress={() => void onSave()}
        disabled={fetching}
        accessibilityRole="button"
        accessibilityLabel="Save guide"
        accessibilityState={{ disabled: fetching }}
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: fetching ? colors.accentMuted : colors.accent },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.accentText }]}>Save guide</Text>
      </Pressable>

      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
      >
        <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

/**
 * Thousands separators for the progress counter. Written by hand rather than
 * via `toLocaleString`, whose grouping depends on whether this Hermes build
 * shipped with full Intl — a progress line is not worth that variance.
 */
function formatCount(value: number): string {
  return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.statValue, { color: colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

function Message({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <Text style={[styles.messageTitle, { color: colors.textPrimary }]}>{title}</Text>
      <Text style={[styles.messageBody, { color: colors.textSecondary }]}>{body}</Text>
      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.accent },
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, { color: colors.accentText }]}>Close</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.md,
  },
  stage: { ...typography.bodySmall, textAlign: 'center' },
  field: { gap: spacing.sm },
  label: { ...typography.caption },
  input: {
    ...typography.body,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  stat: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  statLabel: { ...typography.bodySmall },
  statValue: { ...typography.dataSmall },
  warningTitle: { ...typography.titleSmall },
  warning: { ...typography.bodySmall },
  button: {
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    alignItems: 'center',
  },
  buttonText: { ...typography.titleSmall },
  secondaryButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
  },
  secondaryButtonText: { ...typography.titleSmall },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  secondary: { alignItems: 'center', paddingVertical: spacing.sm },
  secondaryText: { ...typography.bodySmall },
  messageTitle: { ...typography.displaySmall, textAlign: 'center' },
  messageBody: { ...typography.bodySmall, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
