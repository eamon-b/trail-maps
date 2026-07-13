// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require("eslint-config-expo/flat");
const { designTokenRestrictions } = require('./lint/design-token-restrictions');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ["dist/*", "android/*", "ios/*", ".expo/*"],
  },
  // Design-token enforcement: no raw colors / numeric font sizes in styles.
  // Disabling requires a justification comment, e.g.
  //   // eslint-disable-next-line no-restricted-syntax -- MapLibre expression, not an RN style
  {
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    ignores: ['src/tokens/**', '**/__tests__/**'],
    rules: {
      'no-restricted-syntax': ['error', ...designTokenRestrictions],
      // The raw palette is private to src/tokens — components go through
      // useTheme().colors so every color is theme-resolved.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/tokens/colors', '**/tokens/colors.*'],
          message: 'The raw palette is private to src/tokens. Use useTheme().colors instead.',
        }],
      }],
    },
  },
]);
