module.exports = {
  preset: 'jest-expo',
  // jest-expo's own list (see node_modules/jest-expo/jest-preset.js) plus
  // @maplibre, which ships untranspiled ESM. Setting this key replaces the
  // preset's value outright, so the two guard entries below have to be carried
  // over by hand or Babel re-enters the reanimated / RN babel presets.
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|react-navigation|@react-navigation|@sentry/react-native|native-base|standard-navigation|@maplibre))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  setupFiles: ['./jest.setup.js'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  testMatch: ['**/__tests__/**/*.test.(ts|tsx)', '**/*.(test|spec).(ts|tsx)'],
  moduleNameMapper: {
    '^@lib/(.*)$': '<rootDir>/../src/lib/$1',
    // Shared @lib files live outside mobile/, so Babel's runtime helpers
    // injected during transform can't be resolved by walking up from their
    // location — pin them to mobile's copy.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
    // Same for fast-xml-parser: @lib/xml-adapter-fxp imports it, but CI only
    // installs mobile/node_modules (the root copy is a devDependency for Vitest).
    '^fast-xml-parser$': '<rootDir>/node_modules/fast-xml-parser',
    '\\.pbf$': '<rootDir>/jest.setup.js',
  },
};
