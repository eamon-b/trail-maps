/**
 * Resupply stops — the picker, as a modal over the Plan screen.
 *
 * Thin by design: it resolves the trail's options, owns the four actions
 * (toggle / all / none / reset) and hands everything to `ResupplySelectList`.
 * The selection is stored as an explicit list of ids in trail order, so a plan
 * that happens to tick everything is still a plan — `Reset` is the only way
 * back to "nothing chosen", which is what turns every planned highlight off.
 *
 * The section is the Plan screen's own local state (it is direction-dependent,
 * so it is never persisted), so it arrives as `startKm` / `endKm` route params
 * purely to dim the rows that produce no leg. Without them nothing dims.
 */

import React, { useCallback, useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { allResupplyOptionIds, listResupplyOptions } from '@lib/resupply-plan';
import { useGuide } from '../../../src/features/guide/GuideContext';
import {
  ResupplySelectList,
  type ResupplySection,
} from '../../../src/features/plan/ResupplySelectList';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { toggleResupplyStop } from '../../../src/features/plan/use-planned-resupply';
import { useSettingsStore } from '../../../src/state/settings-store';

export default function ResupplyStopsScreen() {
  const { trail, trailId } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const params = useLocalSearchParams<{ startKm?: string; endKm?: string }>();

  const stored = usePlanInputsStore(selectPrefs(trailId)).resupplyStops;
  const setResupplyStops = usePlanInputsStore((s) => s.setResupplyStops);
  const clearResupplyStops = usePlanInputsStore((s) => s.clearResupplyStops);

  // Keyed on the trail alone (as `usePlannedResupplyIds` is): grouping the
  // CDT's 80 options is not free, and ticking a box must not regroup.
  const groups = useMemo(() => listResupplyOptions(trail.waypoints), [trail]);
  const allIds = useMemo(() => allResupplyOptionIds(groups), [groups]);
  // No selection yet = every option ticked, the same default the legs card uses.
  const selectedIds = useMemo(() => new Set(stored ?? allIds), [stored, allIds]);
  const section = useMemo(() => parseSection(params.startKm, params.endKm), [params.startKm, params.endKm]);

  const onToggle = useCallback(
    (id: string) => setResupplyStops(trailId, toggleResupplyStop(stored, allIds, id)),
    [setResupplyStops, trailId, stored, allIds],
  );

  return (
    <ResupplySelectList
      groups={groups}
      selectedIds={selectedIds}
      section={section}
      units={units}
      planMade={stored !== undefined}
      onToggle={onToggle}
      onSelectAll={() => setResupplyStops(trailId, allIds)}
      onSelectNone={() => setResupplyStops(trailId, [])}
      onReset={() => clearResupplyStops(trailId)}
    />
  );
}

/** Route params are strings (or arrays); anything unparseable dims nothing. */
function parseSection(
  startKm: string | string[] | undefined,
  endKm: string | string[] | undefined,
): ResupplySection | null {
  const start = Number(Array.isArray(startKm) ? startKm[0] : startKm);
  const end = Number(Array.isArray(endKm) ? endKm[0] : endKm);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { startKm: start, endKm: end };
}
