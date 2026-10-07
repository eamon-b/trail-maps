/**
 * Guide context — one loaded trail, shared by every screen in the
 * `guide/[trailId]` navigator subtree.
 *
 * Design decision: a React context (not a zustand store). The active guide's
 * heavy trail JSON is scoped to the lifetime of the guide navigator — it does
 * not need to be global or persisted, and it should be dropped from memory when
 * you leave the guide. A context keyed to the route param is the natural fit;
 * only ONE guide's full JSON is ever held at a time.
 *
 * Loading is asynchronous, because an imported trail's JSON — and a newer
 * downloaded copy of a bundled one — is a file on disk (`loadTrail`). A bundled
 * trail with no newer download still resolves synchronously from the Metro
 * require() map, so it never renders a spinner frame. A trail only the R2
 * catalog knows about is downloaded the first time it is opened, behind the
 * same spinner, with a retry when that fails — and so is a community route
 * (`c_…`), from its public URL. Crucially the spinner is
 * rendered **instead of `children`**: the context value is therefore never
 * partially loaded, `trail` stays non-null, and no consumer
 * (`useGuidePosition`, the panes, the plan screen) has to learn about loading.
 * An id that resolves to nothing keeps the "not found" empty state.
 *
 * The provider re-applies direction (from the settings store) whenever it
 * changes, re-reversing the trail as needed.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { radii, spacing, typography } from '../../tokens';
import { getTrailJson, loadTrail, type TrailJson } from '../../services/trail-loader';
import { ensureTrailDownloaded } from '../../services/trail-data-updates';
import { isCatalogTrailId } from '../../services/trail-catalog';
import { ensureCommunityRouteDownloaded } from '../../services/community-routes';
import { isCommunityRouteId } from '@lib/community-types';
import { selectDirection, useSettingsStore, type Direction } from '../../state/settings-store';
import { resolveGuideTrail } from './guide-trail';

export interface GuideContextValue {
  trailId: string;
  /** Trail with the current direction applied. */
  trail: TrailJson;
  direction: Direction;
}

const GuideContext = createContext<GuideContextValue | null>(null);

export function GuideProvider({
  trailId,
  children,
}: {
  trailId: string;
  children: React.ReactNode;
}) {
  const bundled = useMemo(() => getTrailJson(trailId), [trailId]);
  // The async result carries the id it belongs to. That is what makes a read
  // still in flight when the route param changes harmless: its result fails the
  // `=== trailId` check below and is ignored, so the screen falls back to the
  // spinner rather than briefly showing the previous trail.
  const [loaded, setLoaded] = useState<{
    id: string;
    trail: TrailJson | null;
    error?: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Tagged with its trail id, like `loaded`: a download cancelled by a route
  // change must not label the next trail's spinner.
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const downloading = downloadingId === trailId;

  useEffect(() => {
    if (bundled) return;
    let cancelled = false;
    // A read that throws is indistinguishable from a missing file to the user:
    // the guide cannot be opened either way.
    const read = () => loadTrail(trailId).catch(() => null);
    (async () => {
      const trail = await read();
      if (trail) return trail;
      // A community route another hiker shared: fetched from its public URL
      // the first time it is opened (`services/community-routes`).
      if (isCommunityRouteId(trailId)) {
        if (!cancelled) setDownloadingId(trailId);
        return (await ensureCommunityRouteDownloaded(trailId)) ? read() : null;
      }
      // Not on the device: a trail published after this build was made is
      // fetched now. Imported ids are never asked for — they exist nowhere else.
      if (!isCatalogTrailId(trailId)) return trail;
      if (!cancelled) setDownloadingId(trailId);
      return (await ensureTrailDownloaded(trailId)) ? read() : null;
    })()
      .then((trail) => {
        if (!cancelled) setLoaded({ id: trailId, trail });
      })
      .catch((err: unknown) => {
        // Only the download can throw here (usually: offline); it gets a retry.
        if (!cancelled) {
          setLoaded({
            id: trailId,
            trail: null,
            error: err instanceof Error ? err.message : 'The download failed.',
          });
        }
      })
      .finally(() => {
        if (!cancelled) setDownloadingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bundled, trailId, attempt]);

  const retry = useCallback(() => {
    setLoaded(null);
    setAttempt((n) => n + 1);
  }, []);

  const direction = useSettingsStore(selectDirection(trailId));

  // undefined = still resolving; null = no such trail.
  const current = loaded?.id === trailId ? loaded : null;
  const raw: TrailJson | null | undefined = bundled ?? (current ? current.trail : undefined);

  const value = useMemo<GuideContextValue | null>(() => {
    if (!raw) return null;
    return { trailId, trail: resolveGuideTrail(raw, direction), direction };
  }, [raw, trailId, direction]);

  if (raw === undefined) return <GuideLoading downloading={downloading} />;
  if (!value && current?.error) return <GuideDownloadFailed message={current.error} onRetry={retry} />;
  if (!value) return <GuideNotFound trailId={trailId} />;

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

export function useGuide(): GuideContextValue {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error('useGuide must be used within a GuideProvider');
  return ctx;
}

function GuideLoading({ downloading }: { downloading: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <ActivityIndicator
        accessibilityLabel={downloading ? 'Downloading guide' : 'Loading guide'}
        color={colors.accent}
        size="large"
      />
      {downloading ? (
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Downloading guide…</Text>
      ) : null}
    </View>
  );
}

function GuideDownloadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Couldn’t download this guide</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        It needs a connection the first time it is opened. {message}
      </Text>
      <Pressable
        onPress={onRetry}
        accessibilityRole="button"
        style={[styles.retry, { backgroundColor: colors.accent }]}
      >
        <Text style={[styles.retryLabel, { color: colors.accentText }]}>Try again</Text>
      </Pressable>
    </View>
  );
}

function GuideNotFound({ trailId }: { trailId: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Guide not found</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        No trail with id “{trailId}”.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.sm,
  },
  title: { ...typography.displaySmall },
  subtitle: { ...typography.bodySmall, textAlign: 'center' },
  retry: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.md,
  },
  retryLabel: { ...typography.titleSmall },
});
