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
