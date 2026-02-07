// Mock native modules that don't work in test environment

jest.mock('@maplibre/maplibre-react-native', () => ({
  MapView: 'MapView',
  Camera: 'Camera',
  ShapeSource: 'ShapeSource',
  LineLayer: 'LineLayer',
  SymbolLayer: 'SymbolLayer',
  OfflineManager: {
    createPack: jest.fn(),
    getPacks: jest.fn(),
    deletePack: jest.fn(),
  },
  default: {
    setAccessToken: jest.fn(),
  },
}));

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  openDatabaseSync: jest.fn(),
}));

jest.mock('expo-file-system', () => ({
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  documentDirectory: '/mock/document/',
  cacheDirectory: '/mock/cache/',
}));

jest.mock('expo-asset', () => ({
  Asset: {
    loadAsync: jest.fn(),
  },
}));

// Reanimated v4 mock — must not require 'react-native-reanimated/mock'
// which tries to load native worklets module
jest.mock('react-native-worklets', () => ({}));
jest.mock('react-native-reanimated', () => {
  const View = require('react-native').View;
  const actualReact = require('react');

  const Animated = {
    View: View,
    Text: require('react-native').Text,
    ScrollView: require('react-native').ScrollView,
    Image: require('react-native').Image,
    FlatList: require('react-native').FlatList,
    createAnimatedComponent: (comp) => comp,
  };

  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: (init) => ({ value: init }),
    useAnimatedStyle: (fn) => fn(),
    useDerivedValue: (fn) => ({ value: fn() }),
    useAnimatedScrollHandler: () => ({}),
    withTiming: (value, _config, callback) => {
      if (callback) callback(true);
      return value;
    },
    withSpring: (value, _config, callback) => {
      if (callback) callback(true);
      return value;
    },
    withRepeat: (value) => value,
    cancelAnimation: () => {},
    runOnJS: (fn) => fn,
    Easing: {
      ease: (v) => v,
      linear: (v) => v,
      in: () => (v) => v,
      out: () => (v) => v,
      inOut: () => (v) => v,
    },
    SlideInRight: { duration: () => ({ easing: () => ({}) }) },
    SlideOutLeft: { duration: () => ({ easing: () => ({}) }) },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
    Layout: { duration: () => ({ easing: () => ({}) }) },
  };
});

jest.mock('react-native-gesture-handler', () => {
  const View = require('react-native').View;

  const createMockGesture = () => {
    const gesture = {
      onStart: () => gesture,
      onUpdate: () => gesture,
      onEnd: () => gesture,
      onFinalize: () => gesture,
      activeOffsetX: () => gesture,
      activeOffsetY: () => gesture,
      failOffsetX: () => gesture,
      failOffsetY: () => gesture,
      minDistance: () => gesture,
      enabled: () => gesture,
      simultaneousWithExternalGesture: () => gesture,
    };
    return gesture;
  };

  return {
    GestureHandlerRootView: View,
    GestureDetector: ({ children }) => children,
    Gesture: {
      Pan: createMockGesture,
      Tap: createMockGesture,
      LongPress: createMockGesture,
      Fling: createMockGesture,
      Pinch: createMockGesture,
      Rotation: createMockGesture,
      Simultaneous: createMockGesture,
      Exclusive: createMockGesture,
      Race: createMockGesture,
    },
    Directions: {},
    State: {},
  };
});

jest.mock('@gorhom/bottom-sheet', () => {
  const View = require('react-native').View;
  return {
    __esModule: true,
    default: View,
    BottomSheetView: View,
    BottomSheetScrollView: ({ children }) => children,
    BottomSheetBackdrop: () => null,
  };
});

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn(),
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

jest.mock('react-native-safe-area-context', () => ({
  SafeAreaProvider: ({ children }) => children,
  SafeAreaView: ({ children }) => children,
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(() => Promise.resolve(null)),
    setItem: jest.fn(() => Promise.resolve()),
    removeItem: jest.fn(() => Promise.resolve()),
  },
}));
