/**
 * Resupply stops — the picker, as a modal over the Plan screen.
 *
 * Thin by design: it resolves the trail's options, owns the four actions
 * (toggle / all / none / reset) and hands everything to `ResupplySelectList`.
 * The selection is stored as an explicit list of ids in trail order *in the
 * trail's plan document*, so ticking a town here and opening the plan in a
 * linked browser show the same towns — so a plan that happens to tick
 * everything is still a plan, and `Reset` is the only way back to "nothing
 * chosen", which is what turns every planned highlight off.
 *
 * The section is the Plan screen's own local state (it is direction-dependent,
 * so it is never persisted), so it arrives as `startKm` / `endKm` route params
 * purely to dim the rows that produce no leg. Without them nothing dims.
 */

import React, { useCallback, useEffect, useMemo } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { allResupplyOptionIds, listResupplyOptions } from '@lib/resupply-plan';
import { useGuide } from '../../../src/features/guide/GuideContext';
import {
  ResupplySelectList,
  type ResupplySection,
} from '../../../src/features/plan/ResupplySelectList';
import { selectPrefs, usePlanInputsStore } from '../../../src/features/plan/plan-inputs-store';
import { planDirectionOf } from '../../../src/features/plan/plan-stops';
import {
  resetResupplyStops,
  saveResupplyStops,
  toggleResupplyStop,
} from '../../../src/features/plan/use-planned-resupply';
import { selectResupplyStops, usePlansStore } from '../../../src/state/plans-store';
import { useSettingsStore } from '../../../src/state/settings-store';

export default function ResupplyStopsScreen() {
  const { trail, trailId, direction } = useGuide();
  const units = useSettingsStore((s) => s.units);
  const params = useLocalSearchParams<{ startKm?: string; endKm?: string }>();

  // The plan is the selection's home, so it has to be in memory before the
  // boxes are drawn — this screen is reachable by deep link, not only from the
  // Plan screen, and an unhydrated cache would tick every box for a frame.
  const hydratePlan = usePlansStore((s) => s.hydrate);
  useEffect(() => {
    void hydratePlan(trailId);
  }, [hydratePlan, trailId]);

  const planned = usePlansStore(selectResupplyStops(trailId));
  const legacy = usePlanInputsStore(selectPrefs(trailId)).resupplyStops;
  const stored = planned ?? legacy;
  const defaults = useMemo(
    () => ({ name: trail.config.name, direction: planDirectionOf(direction) }),
    [trail.config.name, direction],
  );

  // Keyed on the trail alone (as `usePlannedResupplyIds` is): grouping the
  // CDT's 80 options is not free, and ticking a box must not regroup.
  const groups = useMemo(() => listResupplyOptions(trail.waypoints), [trail]);
  const allIds = useMemo(() => allResupplyOptionIds(groups), [groups]);
  // No selection yet = every option ticked, the same default the legs card uses.
  const selectedIds = useMemo(() => new Set(stored ?? allIds), [stored, allIds]);
  const section = useMemo(() => parseSection(params.startKm, params.endKm), [params.startKm, params.endKm]);

  const onToggle = useCallback(
    (id: string) => saveResupplyStops(trailId, toggleResupplyStop(stored, allIds, id), defaults),
    [trailId, stored, allIds, defaults],
  );

  return (
    <ResupplySelectList
      groups={groups}
      selectedIds={selectedIds}
      section={section}
      units={units}
      planMade={stored !== undefined}
      onToggle={onToggle}
      onSelectAll={() => saveResupplyStops(trailId, allIds, defaults)}
      onSelectNone={() => saveResupplyStops(trailId, [], defaults)}
      onReset={() => resetResupplyStops(trailId, defaults)}
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
