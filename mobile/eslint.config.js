// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const { designTokenRestrictions } = require('./lint/design-token-restrictions');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', '.expo/*'],
  },
  // jest.setup.js runs inside Jest, where `jest` is a global.
  {
    files: ['jest.setup.js'],
    languageOptions: {
      globals: { jest: 'readonly' },
    },
  },
  // eslint-config-expo 57 (Expo SDK 57) turns on the React Compiler-aware
  // eslint-plugin-react-hooks rules. They flag ~20 pre-existing spots — the
  // Skia elevation profile's render-time ref reads, and several
  // "reset derived state when the trail changes" effects — none of which this
  // SDK upgrade touched. Downgraded to warnings so the signal survives without
  // the upgrade PR carrying an unrelated hooks refactor — issue #41 tracks the
  // actual cleanup and restoring these to 'error'.
  {
    files: ['src/**/*.{ts,tsx}', 'app/**/*.{ts,tsx}'],
    rules: {
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
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
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/tokens/colors', '**/tokens/colors.*'],
              message: 'The raw palette is private to src/tokens. Use useTheme().colors instead.',
            },
          ],
        },
      ],
    },
  },
]);
