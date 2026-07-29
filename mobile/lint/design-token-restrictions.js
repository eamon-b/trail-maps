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
 * Shared between eslint.config.js and the fixture test so the test exercises
 * the exact selectors that run in CI.
 */

const COLOR_LITERAL = '/^(#|rgba?\\()/';

const designTokenRestrictions = [
  {
    selector: `CallExpression[callee.object.name='StyleSheet'][callee.property.name='create'] Property[key.name!='shadowColor'] > Literal[value=${COLOR_LITERAL}]`,
    message:
      'Raw color literal in StyleSheet.create. Use theme-resolved colors from useTheme().colors (apply theme-dependent colors inline: style={[styles.x, { color: colors.textPrimary }]}).',
  },
  {
    selector: `JSXAttribute[name.name='style'] Property[key.name!='shadowColor'] > Literal[value=${COLOR_LITERAL}]`,
    message: 'Raw color literal in an inline style. Use theme-resolved colors from useTheme().colors.',
  },
  {
    selector:
      "CallExpression[callee.object.name='StyleSheet'][callee.property.name='create'] Property[key.name='fontSize'] > Literal",
    message:
      'Numeric fontSize in StyleSheet.create. Use a typography token (src/tokens/typography.ts), e.g. ...typography.body or typography.bodySmall.fontSize.',
  },
  {
    selector: "JSXAttribute[name.name='style'] Property[key.name='fontSize'] > Literal",
    message: 'Numeric fontSize in an inline style. Use a typography token (src/tokens/typography.ts).',
  },
];

module.exports = { designTokenRestrictions };
