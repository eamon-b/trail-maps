import { palette } from './colors';

/** Application modes corresponding to the three main navigation tabs */
export type AppMode = 'plan' | 'hike' | 'contribute';

/** Available theme variants */
export type ThemeVariant = 'light' | 'dark' | 'oled' | 'nightRed';

/** Semantic color tokens resolved for a specific theme + mode combination */
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

  // Mode accent colors
  accent: string;
  accentSubtle: string;
  accentMuted: string;
  accentOnDark: string;
  accentOnLight: string;

  // Alert colors
  alertGreen: string;
  alertAmber: string;
  alertRed: string;

  // Status semantics — destructive actions, confirmations, informational
  /** Destructive/error color for text, borders, and filled surfaces */
  danger: string;
  /** Text color for content rendered ON a danger-filled surface */
  dangerText: string;
  /** Positive/confirmation color */
  success: string;
  /** Informational/neutral-emphasis color */
  info: string;

  // Water-distance ramp (near → moderate → far) for hike-mode countdowns
  waterOk: string;
  waterLow: string;
  waterCritical: string;

  // Temperature scale (cold → mild → hot) for climate displays
  tempCold: string;
  tempMild: string;
  tempHot: string;

  // Elevation-profile / chart chrome. Routed through the theme so the Skia
  // canvas adapts to dark/OLED and stays red-only under Night Red (a green
  // elevation line or blue water dot would defeat dark adaptation).
  /** Faint grid lines behind the profile */
  chartGrid: string;
  /** The elevation trace line */
  chartLine: string;
  /** Area fill under the trace — top (near the line) and bottom (near the axis) */
  chartFillTop: string;
  chartFillBottom: string;
  /** Drag crosshair line */
  chartCrosshair: string;
  /** Water-source dots and the current-position line */
  chartWater: string;
  /** Visible-map-range highlight band */
  chartVisibleRange: string;
  /** Highlighted (day-segment) band fill and its edge lines */
  chartHighlightFill: string;
  chartHighlightEdge: string;

  /** Modal/backdrop scrim */
  scrim: string;

  // Status bar
  statusBarStyle: 'light' | 'dark';
}

/** Mode accent palettes per theme */
const modeAccents: Record<ThemeVariant, Record<AppMode, Pick<ThemeColors, 'accent' | 'accentSubtle' | 'accentMuted' | 'accentOnDark' | 'accentOnLight'>>> = {
  light: {
    plan: {
      accent: palette.blue,
      accentSubtle: palette.blueSubtle,
      accentMuted: palette.blueMuted,
      accentOnDark: palette.blueLight,
      accentOnLight: palette.blueDark,
    },
    hike: {
      accent: palette.green,
      accentSubtle: palette.greenSubtle,
      accentMuted: palette.greenMuted,
      accentOnDark: palette.greenLight,
      accentOnLight: palette.greenDark,
    },
    contribute: {
      accent: palette.orange,
      accentSubtle: palette.orangeSubtle,
      accentMuted: palette.orangeMuted,
      accentOnDark: palette.orangeLight,
      accentOnLight: palette.orangeDark,
    },
  },
  dark: {
    plan: {
      accent: palette.blueLight,
      accentSubtle: '#1A2A3D',
      accentMuted: palette.blueMuted,
      accentOnDark: palette.blueLight,
      accentOnLight: palette.blue,
    },
    hike: {
      accent: palette.greenLight,
      accentSubtle: '#1A2D1A',
      accentMuted: palette.greenMuted,
      accentOnDark: palette.greenLight,
      accentOnLight: palette.green,
    },
    contribute: {
      accent: palette.orangeLight,
      accentSubtle: '#2D2A1A',
      accentMuted: palette.orangeMuted,
      accentOnDark: palette.orangeLight,
      accentOnLight: palette.orange,
    },
  },
  oled: {
    plan: {
      accent: palette.blueLight,
      accentSubtle: '#0D1520',
      accentMuted: palette.blueMuted,
      accentOnDark: palette.blueLight,
      accentOnLight: palette.blue,
    },
    hike: {
      accent: palette.greenLight,
      accentSubtle: '#0D150D',
      accentMuted: palette.greenMuted,
      accentOnDark: palette.greenLight,
      accentOnLight: palette.green,
    },
    contribute: {
      accent: palette.orangeLight,
      accentSubtle: '#15120D',
      accentMuted: palette.orangeMuted,
      accentOnDark: palette.orangeLight,
      accentOnLight: palette.orange,
    },
  },
  nightRed: {
    plan: {
      accent: palette.nightRedAccent,
      accentSubtle: palette.nightRedAccentSubtle,
      accentMuted: palette.nightRedAccentMuted,
      accentOnDark: palette.nightRedAccent,
      accentOnLight: palette.nightRedAccentMuted,
    },
    hike: {
      accent: palette.nightRedAccent,
      accentSubtle: palette.nightRedAccentSubtle,
      accentMuted: palette.nightRedAccentMuted,
      accentOnDark: palette.nightRedAccent,
      accentOnLight: palette.nightRedAccentMuted,
    },
    contribute: {
      accent: palette.nightRedAccent,
      accentSubtle: palette.nightRedAccentSubtle,
      accentMuted: palette.nightRedAccentMuted,
      accentOnDark: palette.nightRedAccent,
      accentOnLight: palette.nightRedAccentMuted,
    },
  },
};

/** Base theme colors (mode-independent) per theme variant */
const baseThemes: Record<ThemeVariant, Omit<ThemeColors, 'accent' | 'accentSubtle' | 'accentMuted' | 'accentOnDark' | 'accentOnLight'>> = {
  light: {
    background: palette.white,
    surface: palette.gray50,
    surfaceElevated: palette.white,
    textPrimary: palette.black,
    textSecondary: palette.gray600,
    textInverse: palette.white,
    border: palette.gray100,
    borderSubtle: palette.gray50,
    alertGreen: palette.alertGreenLight,
    alertAmber: palette.alertAmberLight,
    alertRed: palette.alertRedLight,
    danger: palette.alertRedLight,
    dangerText: palette.white,
    success: palette.alertGreenLight,
    info: palette.blueDark,
    waterOk: palette.alertGreenLight,
    waterLow: palette.alertAmberLight,
    waterCritical: palette.alertRedLight,
    tempCold: palette.blue,
    tempMild: palette.green,
    tempHot: palette.deepOrange,
    chartGrid: palette.gray100,
    chartLine: palette.green,
    chartFillTop: 'rgba(76, 175, 80, 0.30)',
    chartFillBottom: 'rgba(76, 175, 80, 0.02)',
    chartCrosshair: 'rgba(0, 0, 0, 0.40)',
    chartWater: palette.blue,
    chartVisibleRange: 'rgba(33, 150, 243, 0.08)',
    chartHighlightFill: 'rgba(103, 80, 164, 0.15)',
    chartHighlightEdge: 'rgba(103, 80, 164, 0.60)',
    scrim: palette.scrim,
    statusBarStyle: 'dark',
  },
  dark: {
    background: palette.gray950,
    surface: palette.gray900,
    surfaceElevated: palette.gray800,
    textPrimary: palette.white,
    textSecondary: palette.gray400,
    textInverse: palette.black,
    border: palette.gray800,
    borderSubtle: palette.gray900,
    alertGreen: palette.alertGreenDark,
    alertAmber: palette.alertAmberDark,
    alertRed: palette.alertRedDark,
    danger: palette.alertRedDark,
    dangerText: palette.black,
    success: palette.alertGreenDark,
    info: palette.blueLight,
    waterOk: palette.alertGreenDark,
    waterLow: palette.alertAmberDark,
    waterCritical: palette.alertRedDark,
    tempCold: palette.blueLight,
    tempMild: palette.greenLight,
    tempHot: palette.deepOrangeLight,
    chartGrid: palette.gray800,
    chartLine: palette.greenLight,
    chartFillTop: 'rgba(129, 199, 132, 0.28)',
    chartFillBottom: 'rgba(129, 199, 132, 0.02)',
    chartCrosshair: 'rgba(255, 255, 255, 0.50)',
    chartWater: palette.blueLight,
    chartVisibleRange: 'rgba(100, 181, 246, 0.12)',
    chartHighlightFill: 'rgba(179, 157, 219, 0.20)',
    chartHighlightEdge: 'rgba(179, 157, 219, 0.70)',
    scrim: palette.scrim,
    statusBarStyle: 'light',
  },
  oled: {
    background: palette.black,
    surface: palette.gray950,
    surfaceElevated: palette.gray900,
    textPrimary: palette.white,
    textSecondary: palette.gray400,
    textInverse: palette.black,
    border: palette.gray900,
    borderSubtle: palette.gray950,
    alertGreen: palette.alertGreenDark,
    alertAmber: palette.alertAmberDark,
    alertRed: palette.alertRedDark,
    danger: palette.alertRedDark,
    dangerText: palette.black,
    success: palette.alertGreenDark,
    info: palette.blueLight,
    waterOk: palette.alertGreenDark,
    waterLow: palette.alertAmberDark,
    waterCritical: palette.alertRedDark,
    tempCold: palette.blueLight,
    tempMild: palette.greenLight,
    tempHot: palette.deepOrangeLight,
    chartGrid: palette.gray900,
    chartLine: palette.greenLight,
    chartFillTop: 'rgba(129, 199, 132, 0.28)',
    chartFillBottom: 'rgba(129, 199, 132, 0.02)',
    chartCrosshair: 'rgba(255, 255, 255, 0.50)',
    chartWater: palette.blueLight,
    chartVisibleRange: 'rgba(100, 181, 246, 0.12)',
    chartHighlightFill: 'rgba(179, 157, 219, 0.20)',
    chartHighlightEdge: 'rgba(179, 157, 219, 0.70)',
    scrim: palette.scrim,
    statusBarStyle: 'light',
  },
  nightRed: {
    background: palette.nightBg,
    surface: palette.nightSurface,
    surfaceElevated: palette.nightSurface,
    textPrimary: palette.nightTextPrimary,
    textSecondary: palette.nightTextSecondary,
    textInverse: palette.nightBg,
    border: palette.nightBorder,
    borderSubtle: palette.nightBg,
    alertGreen: palette.nightAlertGreen,
    alertAmber: palette.nightAlertAmber,
    alertRed: palette.nightAlertRed,
    // Night Red keeps every semantic red-shifted so dark-adapted eyes stay adapted
    danger: palette.nightAlertRed,
    dangerText: palette.nightBg,
    success: palette.nightAlertGreen,
    info: palette.nightRedAccent,
    // Water ramp as red intensity (dim → bright), matching the alert ramp
    waterOk: palette.nightAlertGreen,
    waterLow: palette.nightAlertAmber,
    waterCritical: palette.nightAlertRed,
    // Red-shifted intensity ramp so Night Red stays red (dim → bright)
    tempCold: palette.nightTextSecondary,
    tempMild: palette.nightRedAccent,
    tempHot: palette.nightAlertRed,
    // Chart chrome stays red-only so the profile never emits green/blue light
    // and undoes dark adaptation.
    chartGrid: palette.nightBorder,
    chartLine: palette.nightTextPrimary,
    chartFillTop: 'rgba(255, 107, 107, 0.28)',
    chartFillBottom: 'rgba(255, 107, 107, 0.02)',
    chartCrosshair: 'rgba(255, 107, 107, 0.50)',
    chartWater: palette.nightRedAccent,
    chartVisibleRange: 'rgba(255, 82, 82, 0.10)',
    chartHighlightFill: 'rgba(255, 82, 82, 0.15)',
    chartHighlightEdge: 'rgba(255, 82, 82, 0.60)',
    scrim: palette.scrim,
    statusBarStyle: 'light',
  },
};

/** Resolve the complete theme colors for a given variant and mode */
export function resolveTheme(variant: ThemeVariant, mode: AppMode): ThemeColors {
  return {
    ...baseThemes[variant],
    ...modeAccents[variant][mode],
  };
}

/** All theme variant options for UI pickers */
export const themeVariants: ThemeVariant[] = ['light', 'dark', 'oled', 'nightRed'];

/** All mode options */
export const appModes: AppMode[] = ['plan', 'hike', 'contribute'];

/** Human-readable labels */
export const themeLabels: Record<ThemeVariant, string> = {
  light: 'Light',
  dark: 'Dark',
  oled: 'OLED Dark',
  nightRed: 'Night Red',
};

export const modeLabels: Record<AppMode, string> = {
  plan: 'Plan',
  hike: 'Hike',
  contribute: 'Contribute',
};
