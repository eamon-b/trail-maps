/**
 * Raw color values — all hex constants used throughout the Tracknotes design
 * system. This module is PRIVATE to src/tokens: components consume
 * theme-resolved semantic colors via useTheme().colors, never these raw values
 * (enforced by the no-restricted-imports ESLint rule).
 *
 * Brand identity: deep forest green. The anchor #1B4332 is the Android
 * adaptive-icon background; #081C15 is the dark splash. The `forest` ramp is
 * built around those two so the whole app reads as one coherent green.
 */

export const palette = {
  // Neutrals
  white: '#FFFFFF',
  black: '#000000',

  /** Forest-green brand ramp, light (0) → dark (10). forest7 is the anchor. */
  forest0: '#D8F3DC',
  forest1: '#B7E4C7',
  forest2: '#95D5B2',
  forest3: '#74C69D',
  forest4: '#52B788',
  forest5: '#40916C',
  forest6: '#2D6A4F',
  forest7: '#1B4332', // brand anchor (adaptive-icon background)
  forest8: '#10352A',
  forest9: '#0B2B21',
  forest10: '#081C15', // dark splash / dark theme background

  /** Ink + sage neutrals tuned to sit beside the forest ramp */
  ink: '#10241C', // near-black forest, light-theme primary text
  inkSecondary: '#4A5B54', // muted forest-gray, light-theme secondary text
  mist: '#ECF5F0', // off-white, dark-theme primary text
  sage: '#9BBFAF', // muted light green, dark-theme secondary text

  /** Cool grays for light-theme surfaces + borders */
  gray50: '#F1F5F3',
  gray100: '#E3EAE6',
  gray200: '#CBD6D0',

  /** Accent tints */
  accentSubtleDark: '#12362A', // faint green wash on dark surfaces

  // Status semantics — separate light/dark variants for WCAG AA on each bg
  dangerLight: '#C1121F',
  dangerDark: '#FF6B6B',
  successLight: '#1B7A3D',
  successDark: '#52D08A',
  warningLight: '#A15C00',
  warningDark: '#F2B84B',
  infoLight: '#1F6FB2',
  infoDark: '#6BB8F0',

  // Waypoint category colors (light / dark variants)
  wpWaterLight: '#1F6FB2',
  wpWaterDark: '#6BB8F0',
  wpCampLight: '#2D6A4F',
  wpCampDark: '#74C69D',
  wpTownLight: '#7A3EA1',
  wpTownDark: '#C79BE8',
  wpShelterLight: '#9A5B1E',
  wpShelterDark: '#D9A566',
  wpJunctionLight: '#5A6B64',
  wpJunctionDark: '#A9B8B2',
  wpHazardLight: '#C1121F',
  wpHazardDark: '#FF6B6B',
  wpFavoriteLight: '#D81E5B',
  wpFavoriteDark: '#FF7BA6',

  // Modal/backdrop scrim (theme-independent translucent black)
  scrim: 'rgba(0, 0, 0, 0.5)',
} as const;

export type PaletteColor = (typeof palette)[keyof typeof palette];
