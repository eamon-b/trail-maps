import { Platform, TextStyle } from 'react-native';

/**
 * Typography scale optimized for outdoor readability.
 * All sizes use relative units and respect system accessibility text scaling.
 * Validated for 390pt minimum device width (iPhone 15).
 */

const fontFamily = Platform.select({
  ios: 'System',
  android: 'Roboto',
  default: 'System',
});

/** Typography tokens — each defines a complete TextStyle */
export const typography = {
  /** Primary distance numbers — large, glanceable */
  displayLarge: {
    fontFamily,
    fontSize: 28,
    fontWeight: '700' as TextStyle['fontWeight'],
    lineHeight: 34,
    letterSpacing: -0.5,
  },

  /** Secondary stats (elevation, time) */
  displaySmall: {
    fontFamily,
    fontSize: 20,
    fontWeight: '600' as TextStyle['fontWeight'],
    lineHeight: 26,
    letterSpacing: -0.3,
  },

  /** Section headers (NEXT CAMPSITE, TODAY) */
  titleLarge: {
    fontFamily,
    fontSize: 13,
    fontWeight: '600' as TextStyle['fontWeight'],
    lineHeight: 18,
    letterSpacing: 1.0,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  },

  /** Card labels */
  titleSmall: {
    fontFamily,
    fontSize: 11,
    fontWeight: '600' as TextStyle['fontWeight'],
    lineHeight: 16,
    letterSpacing: 0.8,
    textTransform: 'uppercase' as TextStyle['textTransform'],
  },

  /** Descriptions and detail text — legible in bright sunlight */
  body: {
    fontFamily,
    fontSize: 16,
    fontWeight: '400' as TextStyle['fontWeight'],
    lineHeight: 22,
    letterSpacing: 0,
  },

  /** Secondary body copy — floor for field-readable text (≥14pt) */
  bodySmall: {
    fontFamily,
    fontSize: 14,
    fontWeight: '400' as TextStyle['fontWeight'],
    lineHeight: 19,
    letterSpacing: 0,
  },

  /** Compact field data (distances, countdowns, stats) — ≥14pt, tabular */
  dataSmall: {
    fontFamily,
    fontSize: 14,
    fontWeight: '600' as TextStyle['fontWeight'],
    lineHeight: 19,
    letterSpacing: 0,
    fontVariant: ['tabular-nums'] as TextStyle['fontVariant'],
  },

  /** Timestamps, secondary info. NOT for field-critical data — use dataSmall */
  caption: {
    fontFamily,
    fontSize: 12,
    fontWeight: '400' as TextStyle['fontWeight'],
    lineHeight: 16,
    letterSpacing: 0.1,
  },
} as const satisfies Record<string, TextStyle>;

export type TypographyToken = keyof typeof typography;

/**
 * Global cap for OS font scaling: text grows up to 1.4× with the system
 * accessibility setting, then clamps so fixed layouts degrade gracefully
 * instead of clipping. Applied by AppText and the shared primitives.
 */
export const MAX_FONT_SCALE = 1.4;
