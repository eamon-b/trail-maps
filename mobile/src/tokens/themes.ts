import { palette } from './colors';

/**
 * Tracknotes has a single UX mode (unlike the old three-mode Plan/Hike/
 * Contribute app), so themes resolve on one axis only: the theme variant.
 * Every semantic token below has a light and a dark value, each verified for
 * WCAG AA contrast against its intended background (see themes.test.ts).
 */

/** Available theme variants */
export type ThemeVariant = 'light' | 'dark';

/** Semantic color tokens resolved for a specific theme variant */
export interface ThemeColors {
  // Backgrounds
  background: string;
  surface: string;
  surfaceElevated: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textInverse: string;

  // Borders
  border: string;
  borderSubtle: string;

  // Brand accent (deep forest green)
  accent: string;
  /** Faint accent wash for selected rows / chips */
  accentSubtle: string;
  /** Mid accent for muted emphasis, disabled-but-branded states */
  accentMuted: string;
  /** Text/icon color rendered ON an accent-filled surface */
  accentText: string;

  // Status semantics
  /** Destructive/error color for text, borders, and filled surfaces */
  danger: string;
  /** Text color for content rendered ON a danger-filled surface */
  dangerText: string;
  /** Caution color */
  warning: string;
  /** Text color for content rendered ON a warning-filled surface */
  warningText: string;
  /** Positive/confirmation color */
  success: string;
  /** Informational/neutral-emphasis color */
  info: string;

  // Waypoint category colors (FarOut-style map markers + datasheet icons).
  // The waypoint-type-meta registry (ported later from src/lib) keys into
  // these — every FarOut category has a hook here.
  waypointWater: string;
  waypointCamp: string;
  waypointTown: string;
  waypointShelter: string;
  waypointJunction: string;
  waypointHazard: string;
  /** Favorite / saved heart */
  waypointFavorite: string;

  // Water-status semantics (source reliability: flowing → low → dry)
  waterFlowing: string;
  waterLow: string;
  waterDry: string;

  // Offline-download state (tiles / guides)
  downloadIdle: string;
  downloadActive: string;
  downloadDone: string;
  downloadError: string;

  // Elevation-profile / chart chrome. Routed through the theme so the Skia
  // canvas adapts to dark mode.
  /** Faint grid lines behind the profile */
  chartGrid: string;
  /** The elevation trace line */
  chartLine: string;
  /** Area fill under the trace — top (near the line) and bottom (near the axis) */
  chartFillTop: string;
  chartFillBottom: string;
  /** Drag crosshair line */
  chartCrosshair: string;
  /** Current-position / waypoint marker on the profile */
  chartMarker: string;

  /** GPS / current-location accent (map dot, location status bar) */
  gps: string;

  /** Modal/backdrop scrim */
  scrim: string;

  // Status bar
  statusBarStyle: 'light' | 'dark';
}

const themes: Record<ThemeVariant, ThemeColors> = {
  light: {
    background: palette.white,
    surface: palette.gray50,
    surfaceElevated: palette.white,

    textPrimary: palette.ink,
    textSecondary: palette.inkSecondary,
    textInverse: palette.white,

    border: palette.gray100,
    borderSubtle: palette.gray50,

    accent: palette.forest7,
    accentSubtle: palette.forest0,
    accentMuted: palette.forest3,
    accentText: palette.white,

    danger: palette.dangerLight,
    dangerText: palette.white,
    warning: palette.warningLight,
    warningText: palette.white,
    success: palette.successLight,
    info: palette.infoLight,

    waypointWater: palette.wpWaterLight,
    waypointCamp: palette.wpCampLight,
    waypointTown: palette.wpTownLight,
    waypointShelter: palette.wpShelterLight,
    waypointJunction: palette.wpJunctionLight,
    waypointHazard: palette.wpHazardLight,
    waypointFavorite: palette.wpFavoriteLight,

    waterFlowing: palette.infoLight,
    waterLow: palette.warningLight,
    waterDry: palette.dangerLight,

    downloadIdle: palette.inkSecondary,
    downloadActive: palette.infoLight,
    downloadDone: palette.successLight,
    downloadError: palette.dangerLight,

    chartGrid: palette.gray100,
    chartLine: palette.forest6,
    chartFillTop: 'rgba(45, 106, 79, 0.30)',
    chartFillBottom: 'rgba(45, 106, 79, 0.02)',
    chartCrosshair: 'rgba(16, 36, 28, 0.40)',
    chartMarker: palette.infoLight,

    gps: palette.infoLight,

    scrim: palette.scrim,
    statusBarStyle: 'dark',
  },

  dark: {
    background: palette.forest10,
    surface: palette.forest8,
    surfaceElevated: palette.forest7,

    textPrimary: palette.mist,
    textSecondary: palette.sage,
    textInverse: palette.forest10,

    border: palette.forest7,
    borderSubtle: palette.forest9,

    accent: palette.forest4,
    accentSubtle: palette.accentSubtleDark,
    accentMuted: palette.forest5,
    accentText: palette.forest10,

    danger: palette.dangerDark,
    dangerText: palette.forest10,
    warning: palette.warningDark,
    warningText: palette.forest10,
    success: palette.successDark,
    info: palette.infoDark,

    waypointWater: palette.wpWaterDark,
    waypointCamp: palette.wpCampDark,
    waypointTown: palette.wpTownDark,
    waypointShelter: palette.wpShelterDark,
    waypointJunction: palette.wpJunctionDark,
    waypointHazard: palette.wpHazardDark,
    waypointFavorite: palette.wpFavoriteDark,

    waterFlowing: palette.infoDark,
    waterLow: palette.warningDark,
    waterDry: palette.dangerDark,

    downloadIdle: palette.sage,
    downloadActive: palette.infoDark,
    downloadDone: palette.successDark,
    downloadError: palette.dangerDark,

    chartGrid: palette.forest8,
    chartLine: palette.forest3,
    chartFillTop: 'rgba(116, 198, 157, 0.28)',
    chartFillBottom: 'rgba(116, 198, 157, 0.02)',
    chartCrosshair: 'rgba(236, 245, 240, 0.50)',
    chartMarker: palette.infoDark,

    gps: palette.infoDark,

    scrim: palette.scrim,
    statusBarStyle: 'light',
  },
};

/** Resolve the complete theme colors for a given variant */
export function resolveTheme(variant: ThemeVariant): ThemeColors {
  return themes[variant];
}

/** All theme variant options for UI pickers */
export const themeVariants: ThemeVariant[] = ['light', 'dark'];

/** Human-readable labels */
export const themeLabels: Record<ThemeVariant, string> = {
  light: 'Light',
  dark: 'Dark',
};
