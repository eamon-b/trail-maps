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
 * Loading is asynchronous, because an imported trail's JSON is a file on disk
 * (`loadTrail`). A bundled trail still resolves synchronously from the Metro
 * require() map, so it never renders a spinner frame. Crucially the spinner is
 * rendered **instead of `children`**: the context value is therefore never
 * partially loaded, `trail` stays non-null, and no consumer
 * (`useGuidePosition`, the panes, the plan screen) has to learn about loading.
 * An id that resolves to nothing keeps the "not found" empty state.
 *
 * The provider re-applies direction (from the settings store) whenever it
 * changes, re-reversing the trail as needed.
 */

import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { getTrailJson, loadTrail, type TrailJson } from '../../services/trail-loader';
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
  const [loaded, setLoaded] = useState<{ id: string; trail: TrailJson | null } | null>(null);

  useEffect(() => {
    if (bundled) return;
    let cancelled = false;
    loadTrail(trailId)
      .then((trail) => {
        if (!cancelled) setLoaded({ id: trailId, trail });
      })
      .catch(() => {
        // A read that throws is indistinguishable from a missing file to the
        // user: the guide cannot be opened either way.
        if (!cancelled) setLoaded({ id: trailId, trail: null });
      });
    return () => {
      cancelled = true;
    };
  }, [bundled, trailId]);

  const direction = useSettingsStore(selectDirection(trailId));

  // undefined = still resolving; null = no such trail.
  const raw: TrailJson | null | undefined =
    bundled ?? (loaded?.id === trailId ? loaded.trail : undefined);

  const value = useMemo<GuideContextValue | null>(() => {
    if (!raw) return null;
    return { trailId, trail: resolveGuideTrail(raw, direction), direction };
  }, [raw, trailId, direction]);

  if (raw === undefined) return <GuideLoading />;
  if (!value) return <GuideNotFound trailId={trailId} />;

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

export function useGuide(): GuideContextValue {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error('useGuide must be used within a GuideProvider');
  return ctx;
}

function GuideLoading() {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <ActivityIndicator accessibilityLabel="Loading guide" color={colors.accent} size="large" />
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
});
