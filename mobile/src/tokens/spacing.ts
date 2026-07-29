/**
 * Spacing scale based on 4pt base grid.
 * Used for margins, paddings, gaps throughout the app.
 */
export const spacing = {
  /** 4pt — tight spacing, icon gaps */
  xs: 4,
  /** 8pt — compact spacing, inline elements */
  sm: 8,
  /** 12pt — default gap between related items */
  md: 12,
  /** 16pt — standard padding, section gaps */
  lg: 16,
  /** 24pt — section separators */
  xl: 24,
  /** 32pt — major section breaks */
  xxl: 32,
} as const;

export type SpacingToken = keyof typeof spacing;

/** Minimum touch target size per accessibility guidelines */
export const touchTarget = {
  /** WCAG / platform minimum */
  min: 44,
  /** Primary field actions — bigger for gloved/one-handed outdoor use */
  field: 56,
} as const;

/** Border radius tokens */
export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;
