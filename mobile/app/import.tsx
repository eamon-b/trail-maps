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

const STAGE_LABELS: Record<ImportStage, string> = {
  reading: 'Reading file…',
  ingesting: 'Building your guide…',
};

type ScreenState =
  | { status: 'working'; stage: ImportStage }
  | { status: 'ready'; imported: ImportedGpx }
  | { status: 'saving' }
  | { status: 'failed'; message: string };

export default function ImportScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const units = useSettingsStore((s) => s.units);
  const { uri, fileName } = useLocalSearchParams<{ uri?: string; fileName?: string }>();

  const [state, setState] = useState<ScreenState>({ status: 'working', stage: 'reading' });
  const [name, setName] = useState('');
  // The import runs once per URI. Without this guard a re-render from the
  // stage callback (or a fast-refresh remount) would re-parse the file.
  const startedFor = useRef<string | null>(null);

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

      <Pressable
        onPress={() => void onSave()}
        accessibilityRole="button"
        accessibilityLabel="Save guide"
        style={({ pressed }) => [
          styles.button,
          { backgroundColor: colors.accent },
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
  secondary: { alignItems: 'center', paddingVertical: spacing.sm },
  secondaryText: { ...typography.bodySmall },
  messageTitle: { ...typography.displaySmall, textAlign: 'center' },
  messageBody: { ...typography.bodySmall, textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
