/**
 * Pure map-style selection logic.
 *
 * Kept React-free so the offline/online decision, the remount key, and the
 * label-font choice can be unit-tested without mounting MapLibre.
 *
 * Why a remount key: swapping a live MapLibre `mapStyle` object at runtime
 * forces the native renderer to reload its style graph mid-flight, which can
 * terminate the renderer on some devices (see the old app's TrailMap). Instead
 * we key the `<MapView>` on the *source* — when a download finishes and the
 * source flips from 'online' to 'offline', React unmounts the old map and
 * mounts a fresh one with the new style already resolved.
 */

import type { TileStatusState } from '../../services/tile-service';

/** Which base map the guide should render: bundled offline tiles or online. */
export type MapStyleSource = 'offline' | 'online';

/**
 * Decide the base-map source from a trail's download state. Offline tiles are
 * only trustworthy once the whole pack has verified on disk ('complete'); a
 * 'partial' or 'absent' download falls back to the online basemap.
 */
export function resolveStyleSource(state: TileStatusState | undefined): MapStyleSource {
  return state === 'complete' ? 'offline' : 'online';
}

/**
 * The `<MapView>` remount key. Identical to the source today, but centralised
 * so the "remount on source change" contract has one authority and one test.
 */
export function mapRemountKey(source: MapStyleSource): string {
  return `guide-map-${source}`;
}

/**
 * Font for overlay labels (waypoint names, cluster counts). The online Liberty
 * style serves Noto Sans; our bundled offline topo style ships Open Sans. Using
 * the wrong stack renders empty glyph boxes, so the label font tracks the
 * active source.
 */
export function labelFontForSource(source: MapStyleSource): string[] {
  return source === 'offline' ? ['Open Sans Regular'] : ['Noto Sans Regular'];
}

interface MapLogEvent {
  level: string;
  message: string;
  tag?: string;
}

/**
 * A missing optional contour tile must not surface as a red-box error. The
 * offline/online contour source is a best-effort enhancement; a failed tile
 * fetch is expected when R2 is unreachable or a zoom has no contour data.
 */
export function isContourTileLoadFailure(log: MapLogEvent): boolean {
  return log.message.includes('Failed to load tile') && log.message.includes('source contour');
}

/**
 * Known-noise MapLibre worker warnings that don't indicate a bug in our
 * overlays. "Invalid geometry in line layer" fires once while parsing some
 * basemap vector tiles; our own line sources are guarded (buildTrailLine /
 * buildVariantCollection drop degenerate lines, and the bundled data was
 * verified coordinate-complete) so this is basemap tile noise, not ours.
 */
export function isBasemapGeometryNoise(log: MapLogEvent): boolean {
  return log.level === 'warning' && log.message.includes('Invalid geometry in line layer');
}

/**
 * Valid style used when neither the offline nor the online style can be
 * resolved. Keeping the native renderer on a real (if empty) style object lets
 * the trail overlays stay usable instead of crashing on a null/unreachable
 * style. This is a MapLibre style document, not an RN stylesheet.
 */
export const FALLBACK_MAP_STYLE = {
  version: 8 as const,
  sources: {},
  layers: [
    {
      id: 'fallback-background',
      type: 'background' as const,
      // MapLibre paint value (neutral map backdrop), not an RN style color.
      paint: { 'background-color': '#E8ECE6' },
    },
  ],
};
