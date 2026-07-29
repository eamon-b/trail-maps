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
 * Loading is synchronous: `getTrailJson` resolves from the bundled Metro
 * require() map, so there is no async spinner — an unknown id is simply
 * "not found". The provider re-applies direction (from the settings store)
 * whenever it changes, re-reversing the trail as needed.
 */

import React, { createContext, useContext, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../../theme';
import { spacing, typography } from '../../tokens';
import { getTrailJson, type TrailJson } from '../../services/trail-loader';
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
  const raw = useMemo(() => getTrailJson(trailId), [trailId]);
  const direction = useSettingsStore(selectDirection(trailId));

  const value = useMemo<GuideContextValue | null>(() => {
    if (!raw) return null;
    return { trailId, trail: resolveGuideTrail(raw, direction), direction };
  }, [raw, trailId, direction]);

  if (!value) return <GuideNotFound trailId={trailId} />;

  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}

export function useGuide(): GuideContextValue {
  const ctx = useContext(GuideContext);
  if (!ctx) throw new Error('useGuide must be used within a GuideProvider');
  return ctx;
}

function GuideNotFound({ trailId }: { trailId: string }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.centered, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>Guide not found</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
        No bundled trail with id “{trailId}”.
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
