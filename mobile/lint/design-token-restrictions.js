/**
 * Design-token enforcement — `no-restricted-syntax` selectors.
 *
 * Bans raw color literals and numeric fontSize values inside component styles
 * (StyleSheet.create objects and inline JSX `style` props). Colors must come
 * from useTheme().colors (semantic tokens in src/tokens/themes.ts); font sizes
 * must come from typography tokens (src/tokens/typography.ts).
 *
 * Known limitations (deliberate — keeps the selectors precise):
 * - Plain style objects that are neither StyleSheet.create args nor inline
 *   JSX styles (e.g. MapLibre layer style constants) are not matched.
 * - `shadowColor` is exempt: shadows are intentionally black in every theme.
 *
 * Shared between eslint.config.js and the fixture test
 * (__tests__/lint-rules.test.ts) so the test exercises the exact selectors
 * that run in CI.
 */

const COLOR_LITERAL = "/^(#|rgba?\\()/";

const designTokenRestrictions = [
  {
    selector:
      `CallExpression[callee.object.name='StyleSheet'][callee.property.name='create'] Property[key.name!='shadowColor'] > Literal[value=${COLOR_LITERAL}]`,
    message:
      'Raw color literal in StyleSheet.create. Use theme-resolved colors from useTheme().colors (apply theme-dependent colors inline: style={[styles.x, { color: colors.textPrimary }]}).',
  },
  {
    selector:
      `JSXAttribute[name.name='style'] Property[key.name!='shadowColor'] > Literal[value=${COLOR_LITERAL}]`,
    message:
      'Raw color literal in an inline style. Use theme-resolved colors from useTheme().colors.',
  },
  {
    selector:
      "CallExpression[callee.object.name='StyleSheet'][callee.property.name='create'] Property[key.name='fontSize'] > Literal",
    message:
      'Numeric fontSize in StyleSheet.create. Use a typography token (src/tokens/typography.ts), e.g. ...typography.body or typography.bodySmall.fontSize.',
  },
  {
    selector:
      "JSXAttribute[name.name='style'] Property[key.name='fontSize'] > Literal",
    message:
      'Numeric fontSize in an inline style. Use a typography token (src/tokens/typography.ts).',
  },
];

/**
 * Burn-down list — files grandfathered when the rule landed (2026-07).
 * The rule is downgraded to "warn" for these files so existing violations are
 * visible but do not fail CI. New files get the rule at "error" from day one.
 *
 * Owner for every entry: mobile maintainers. Remove a file from this list as
 * soon as its violations are cleared — additions require a justification.
 *
 * Remaining violations per file (as of the P2 design-system pass):
 * - AlertBanner.tsx           — emoji icon fontSize
 * - CoordinatesRow.tsx        — monospace coordinate fontSize
 * - SectionSelector.tsx       — emoji/check glyph sizes
 * - AddWaypointSheet.tsx      — owned by the P1 workstream (do not touch here)
 * - WaypointDetailSheet.tsx   — owned by the P1 workstream (do not touch here)
 * - StopSelector.tsx          — emoji/check glyph sizes
 * - WaypointList.tsx          — emoji glyph size
 * - TrailMap.tsx              — recenter/zoom glyph size
 * - DayPlanCard.tsx           — action glyph size
 * - WaypointCard.tsx          — emoji glyph size
 * - app/plan/measure.tsx      — emoji/check glyph sizes
 * - app/(tabs)/hike.tsx       — snooze chip icon size
 * - app/(tabs)/plan.tsx       — header/badge font sizes
 * - app/trail/[id].tsx        — toolbar glyph size
 * - app/trail/datasheet.tsx   — toolbar/empty-state glyph sizes
 * - app/trail/overview.tsx    — owned by the P1 workstream (do not touch here)
 */
const grandfatheredFiles = [
  'src/components/AlertBanner.tsx',
  'src/components/CoordinatesRow.tsx',
  'src/components/SectionSelector.tsx',
  'src/components/AddWaypointSheet.tsx',
  'src/components/WaypointDetailSheet.tsx',
  'src/components/StopSelector.tsx',
  'src/components/WaypointList.tsx',
  'src/components/TrailMap.tsx',
  'src/components/DayPlanCard.tsx',
  'src/components/WaypointCard.tsx',
  'app/plan/measure.tsx',
  'app/(tabs)/hike.tsx',
  'app/(tabs)/plan.tsx',
  // NOTE: [ ] are glob character classes — escape route-param filenames.
  'app/trail/\\[id\\].tsx',
  'app/trail/datasheet.tsx',
  'app/trail/overview.tsx',
];

module.exports = { designTokenRestrictions, grandfatheredFiles };
