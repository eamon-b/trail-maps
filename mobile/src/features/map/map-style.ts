/**
 * Pure map-style selection logic.
 *
 * Kept React-free so the offline/online decision, the remount key, and the
 * label-font choice can be unit-tested without mounting MapLibre.
 *
 * Why a remount key: swapping a live MapLibre `mapStyle` object at runtime
 * forces the native renderer to reload its style graph mid-flight, which can
 * terminate the renderer on some devices (see the old app's TrailMap). Instead
 * we key the `<Map>` on the *source and theme* — when a download finishes and
 * the source flips from 'online' to 'offline', or the app theme flips light to
 * dark, React unmounts the old map and mounts a fresh one with the new style
 * already resolved.
 */

import type { TileStatusState } from '../../services/tile-service';

/** Which base map the guide should render: bundled offline tiles or online. */
export type MapStyleSource = 'offline' | 'online';

/**
 * Which palette the base map and the overlays drawn on it are painted in.
 *
 * This tracks the app theme (see the guide map's `useTheme().isDark`) rather
 * than being its own setting: before it existed the map pane stayed a bright
 * rectangle in an otherwise dark app (issue #33). Both base maps have a dark
 * counterpart — OpenFreeMap's `dark` style online, the dark palette patch in
 * `assets/topo-style-dark.json` offline — and every overlay colour below has a
 * dark variant, because violet alternates and teal side trips tuned for a cream
 * basemap are dark-on-dark once the ground drops to #14.
 */
export type MapTheme = 'light' | 'dark';

/** Extra context beyond on-disk state that forces the map online. */
export interface StyleSourceOptions {
  /**
   * A download is in flight for this trail. During an *update* the on-disk
   * state stays 'complete' the whole time while `downloadTrailTiles` replaces
   * base.mbtiles / contours.mbtiles underneath it. A mounted offline map holds
   * those files open in MapLibre's native MBTilesFileSource — at best it goes
   * on serving the old, unlinked inode (so the update appears not to have
   * happened), at worst a mid-write read aborts the process. Going online for
   * the duration releases the handles; when the download finishes the source
   * flips back to offline and the map remounts on the fresh tiles.
   */
  downloading?: boolean;
}

/**
 * Decide the base-map source from a trail's download state. Offline tiles are
 * only trustworthy once the whole pack has verified on disk ('complete'); a
 * 'partial' or 'absent' download falls back to the online basemap, and so does
 * a trail whose tiles are actively being rewritten (see StyleSourceOptions).
 */
export function resolveStyleSource(
  state: TileStatusState | undefined,
  options?: StyleSourceOptions,
): MapStyleSource {
  if (options?.downloading) return 'online';
  return state === 'complete' ? 'offline' : 'online';
}

/**
 * The `<Map>` remount key — the one authority (and one test) for the
 * "remount, never hot-swap" contract.
 *
 * Pass the source that *actually* resolved, not the one that was requested: a
 * requested-offline map that fell back online must not reuse the offline map's
 * key, or React keeps the old native map instance alive across the swap.
 *
 * The theme is part of the key for the same reason the source is: light and dark
 * are two different style documents (a different online style URL, a different
 * offline palette), and handing a live map a new style object is exactly the
 * mid-flight style reload that can terminate the native renderer. Flipping the
 * phone to dark mode therefore mounts a fresh map on the already-resolved dark
 * style instead of repainting the live one.
 */
export function mapRemountKey(source: MapStyleSource, theme: MapTheme): string {
  return `guide-map-${source}-${theme}`;
}

/**
 * Font for overlay labels (waypoint names, cluster counts). The online Liberty
 * style serves Noto Sans; our bundled offline topo style ships Open Sans. Using
 * the wrong stack renders empty glyph boxes, so the label font tracks the
 * active source.
 *
 * Callers must pass the *resolved* source. Deriving this from the requested
 * source is the bug this comment exists for: an offline request that falls back
 * to the online style would ask Liberty for Open Sans glyphs it does not serve,
 * and every label on the map renders as an empty box.
 */
export function labelFontForSource(source: MapStyleSource): string[] {
  return source === 'offline' ? ['Open Sans Regular'] : ['Noto Sans Regular'];
}

// ---------------------------------------------------------------------------
// Degradation reporting
// ---------------------------------------------------------------------------

/** What the map actually mounted, versus what was asked for. */
export interface MapStyleResolution {
  /** The source the caller asked for (from resolveStyleSource). */
  requested: MapStyleSource;
  /** The source that actually mounted. */
  resolved: MapStyleSource;
  /** Offline style mounted, but contour layers were dropped. */
  contoursDropped: boolean;
  /** Neither base map could be loaded; fallbackMapStyle() is mounted. */
  fallback: boolean;
  /** Validation / error detail behind the degradation, when known. */
  reason?: string;
}

/**
 * The one way the mounted map is worse than what the user asked for, or null
 * when it is exactly what was requested. Ordered worst-first: a bare fallback
 * beats "went online" beats "lost contours".
 */
export type MapDegradation = 'no-basemap' | 'offline-unavailable' | 'contours-missing';

export function mapDegradation(resolution: MapStyleResolution): MapDegradation | null {
  if (resolution.fallback) return 'no-basemap';
  if (resolution.requested === 'offline' && resolution.resolved === 'online') {
    return 'offline-unavailable';
  }
  if (resolution.contoursDropped) return 'contours-missing';
  return null;
}

/** Short, non-technical banner copy for a degradation. */
export function degradationMessage(degradation: MapDegradation): string {
  switch (degradation) {
    case 'no-basemap':
      return 'No map tiles could be loaded. Check your connection, or download this guide for offline use.';
    case 'offline-unavailable':
      return "This guide's offline maps are damaged, so the map is using the online basemap.";
    case 'contours-missing':
      return 'Contour lines are missing from the offline maps for this guide.';
  }
}

/**
 * Whether re-downloading the tile pack can plausibly fix the degradation.
 * A missing basemap usually means "no tiles and no network", which a download
 * cannot repair; the other two are damaged local files.
 */
export function isRedownloadFixable(degradation: MapDegradation): boolean {
  return degradation !== 'no-basemap';
}

/**
 * Track cartography — the three track classes the guide draws, per map theme.
 *
 * These are MapLibre paint values, not RN styles, so the design-token lint (which
 * targets RN styles) does not reach them; they are hand-tuned against the two
 * base maps rather than pulled from the app palette.
 *
 * Hue budget on the map — every overlay owns a hue so nothing is ambiguous:
 *   red     main track          (FarOut's convention: the trail itself)
 *   violet  alternate routes    (a real, walkable substitute for a main span)
 *   teal    side trips          (out-and-back spurs off the trail)
 *   amber   custom route overlay (GuideMap: the user's own drawn route)
 *   blue    GPS puck            (never used for a track, so blue always = you)
 *
 * The hues are the same in both themes — a violet line means "alternate" whether
 * or not the phone is in dark mode — but the *values* are not: #7B2CBF violet and
 * #0B7285 teal sit at roughly the luminance of the dark basemap itself, so on
 * dark they lift to tints that clear the ground while staying inside their hue.
 * Only the casing changes role: on the cream basemap it is opaque white (an
 * outline that separates the track from busy landcover), on dark it is a soft
 * white glow at 40%, because an opaque white outline on near-black out-shouts the
 * red line it is meant to support.
 */
const TRACK_PALETTES = {
  light: {
    /** Main track: strong red, the most prominent line on the map. */
    main: '#D92B2B',
    /** White outline under the main track so it reads over basemap clutter. */
    mainCasing: '#FFFFFF',
    /** Alternate routes: violet. */
    alternate: '#7B2CBF',
    /** Side trips: deep teal. */
    sideTrip: '#0B7285',
  },
  dark: {
    /** Main track: the same red lifted to clear a near-black ground. */
    main: '#FF5A4E',
    /** Soft white glow rather than a hard outline (see the note above). */
    mainCasing: 'rgba(255, 255, 255, 0.4)',
    /** Alternate routes: violet, tinted. */
    alternate: '#B18AFF',
    /** Side trips: teal, tinted. */
    sideTrip: '#2FD4C0',
  },
} as const;

export type TrackColors = (typeof TRACK_PALETTES)[MapTheme];

/**
 * Track colours for a map theme. Everything that paints a track class goes
 * through this — the map layers, the legend swatches, and the variant info
 * card — so a swatch can never disagree with the line it describes.
 */
export function trackColors(theme: MapTheme): TrackColors {
  return TRACK_PALETTES[theme];
}

/**
 * Ink for the overlays drawn on top of the basemap: waypoint badges, their
 * labels, and the GPS puck's stroke.
 *
 * The badge itself stays a white disc in both themes — the glyph PNGs are dark
 * ink on transparency, and the category colour lives in the ring — so a marker
 * reads as the same object on either basemap. Labels do flip: dark text in a
 * white halo is a row of bright chips on a dark map, so dark mode inverts it to
 * light text in a near-black halo.
 */
const MAP_INK = {
  light: {
    /** Marker/puck outline against the basemap. */
    stroke: '#FFFFFF',
    /** Waypoint badge fill (the disc the glyph sits on). */
    badge: '#FFFFFF',
    labelText: '#1A1A1A',
    labelHalo: '#FFFFFF',
  },
  dark: {
    stroke: '#FFFFFF',
    badge: '#FFFFFF',
    labelText: '#F1F3F5',
    labelHalo: 'rgba(0, 0, 0, 0.85)',
  },
} as const;

export type MapInk = (typeof MAP_INK)[MapTheme];

/** Overlay ink for a map theme (see MAP_INK). */
export function mapInk(theme: MapTheme): MapInk {
  return MAP_INK[theme];
}

/**
 * Dash patterns, in multiples of each layer's own line width (MapLibre's unit).
 * Colour alone should never be the only signal, so the classes also differ in
 * stroke: the main track is solid, alternates are long-dashed, side trips are
 * finely dotted (the shortest spurs still read as spurs).
 */
export const TRACK_DASH = {
  alternate: [3, 1.5],
  sideTrip: [1, 1.5],
} as const;

/**
 * Zoom-interpolated line width for a track class, expressed around a width at
 * hiking zoom (z11). Overview zooms thin the lines so a 1200 km trail is not a
 * solid slab; walking zooms fatten them slightly for glove-and-sunlight
 * legibility. Zoom functions (unlike data-driven ones) are safe to combine with
 * `lineDasharray` in MapLibre native.
 *
 * The ordering main > alternate/side-trip holds at every zoom, so the main
 * track stays the dominant line even where all three run together.
 */
export function trackWidthExpression(baseWidth: number): unknown[] {
  return [
    'interpolate',
    ['linear'],
    ['zoom'],
    6,
    round1(baseWidth * 0.6),
    11,
    baseWidth,
    15,
    round1(baseWidth * 1.2),
  ];
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Line width at hiking zoom for each track class (see trackWidthExpression). */
export const TRACK_WIDTHS = {
  main: 4,
  /** Casing is drawn under the main track, wide enough to read as an outline. */
  mainCasing: 7,
  alternate: 3,
  sideTrip: 3,
} as const;

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
 *
 * Both spellings of the warn level are accepted on purpose: MapLibre RN 10
 * emitted `'warning'`, v11's LogManager emits `'warn'`. Matching only one makes
 * this filter silently stop working on an upgrade — the failure mode is noise
 * returning, not a crash, so nothing else would catch it.
 */
export function isBasemapGeometryNoise(log: MapLogEvent): boolean {
  return (
    (log.level === 'warn' || log.level === 'warning') &&
    log.message.includes('Invalid geometry in line layer')
  );
}

/**
 * Valid style used when neither the offline nor the online style can be
 * resolved. Keeping the native renderer on a real (if empty) style object lets
 * the trail overlays stay usable instead of crashing on a null/unreachable
 * style. This is a MapLibre style document, not an RN stylesheet.
 *
 * It is themed for the same reason the real base maps are: a neutral pale card
 * behind the trail line is the wrong backdrop in a dark app, and the overlays
 * drawn over it are already picking their colours from the same theme.
 */
export function fallbackMapStyle(theme: MapTheme) {
  return {
    version: 8 as const,
    sources: {},
    layers: [
      {
        id: 'fallback-background',
        type: 'background' as const,
        // MapLibre paint value (neutral map backdrop), not an RN style color.
        paint: { 'background-color': theme === 'dark' ? '#14161A' : '#E8ECE6' },
      },
    ],
  };
}
