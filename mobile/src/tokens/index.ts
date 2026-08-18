// NOTE: the raw `palette` is deliberately NOT re-exported. It is private to
// the tokens directory — components consume theme-resolved semantic colors
// via useTheme().colors, never raw palette values.

export { resolveTheme, themeVariants, themeLabels } from './themes';
export type { ThemeVariant, ThemeColors } from './themes';

export { typography, glyphSizes, MAX_FONT_SCALE } from './typography';
export type { TypographyToken } from './typography';

export { spacing, touchTarget, radii } from './spacing';
export type { SpacingToken } from './spacing';

export {
  timingConfigs,
  springConfigs,
  durations,
  isReduceMotionEnabled,
  onReduceMotionChange,
} from './motion';
