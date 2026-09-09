/**
 * The one place the map, the list pane and the elevation profile ask "which
 * points of interest am I drawing?".
 *
 * The answer is the trail's `pois` filtered by the global filter in the settings
 * store — duplicates of curated waypoints dropped, categories the walker turned
 * off dropped, everything gone when the master switch is off. Keeping it in one
 * hook is what stops the layers sheet's counts and the markers on screen from
 * disagreeing.
 *
 * The filtering itself is `@lib/poi-display`, shared with the web page.
 */

import { useMemo } from 'react';
import { visiblePois, type PoiFilterState } from '@lib/poi-display';
import type { TrailPOI } from '@lib/trail-types';
import { selectPoiFilter, useSettingsStore } from '../../state/settings-store';
import type { TrailJson } from '../../services/trail-assets';

/** The global POI filter, re-rendering the caller when it changes. */
export function usePoiFilter(): PoiFilterState {
  return useSettingsStore(selectPoiFilter);
}

/** The POIs of this trail the filter currently shows. */
export function useVisiblePois(trail: Pick<TrailJson, 'pois'>): TrailPOI[] {
  const filter = usePoiFilter();
  return useMemo(() => visiblePois(trail.pois, filter), [trail.pois, filter]);
}

/**
 * Whether this trail carries POIs at all.
 *
 * An absent `pois` means "never fetched", not "found nothing", so a trail
 * without one shows no POI control — not an empty one implying the search ran.
 * A plain function, not a hook: the map's layers button needs the answer while
 * deciding whether to render anything at all.
 */
export function hasPois(trail: Pick<TrailJson, 'pois'>): boolean {
  return (trail.pois?.length ?? 0) > 0;
}
