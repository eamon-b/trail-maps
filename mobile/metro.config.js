const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Allow Metro to resolve modules from the shared src/lib/ directory
const sharedLib = path.resolve(__dirname, '../src/lib');
config.watchFolders = [sharedLib];

// Ensure Metro can resolve node_modules from the mobile directory
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
];

// Map @lib/* imports to ../src/lib/*
config.resolver.extraNodeModules = {
  '@lib': sharedLib,
};

// Register .pbf as a recognized asset extension so bundled font glyphs
// (mobile/assets/fonts/**/*.pbf) can be loaded via require() / expo-asset.
config.resolver.assetExts.push('pbf');

module.exports = config;
