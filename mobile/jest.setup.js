// Mock native modules that don't work in test environment

// MapLibre RN 11's export surface: `Map`/`GeoJSONSource`/`Layer` replaced v10's
// `MapView`/`ShapeSource`/`{Line,Circle,Symbol}Layer`, the default export is
// gone, and logging moved from `Logger.setLogCallback` to `LogManager.onLog`.
jest.mock('@maplibre/maplibre-react-native', () => ({
  __esModule: true,
  Map: 'Map',
  Camera: 'Camera',
  GeoJSONSource: 'GeoJSONSource',
  Layer: 'Layer',
  Images: 'Images',
  OfflineManager: {
    createPack: jest.fn(),
    getPacks: jest.fn(),
    deletePack: jest.fn(),
  },
  LogManager: {
    onLog: jest.fn(),
    setLogLevel: jest.fn(),
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

// @expo/vector-icons loads its .ttf through expo-asset when an icon mounts,
// which the Asset mock above cannot satisfy (`source instanceof Asset` throws
// on a plain object). Icons have no behaviour worth exercising beyond the props
// they are handed, so render them as a host component that keeps those props
// visible to assertions.
jest.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  __esModule: true,
  default: 'MaterialCommunityIcons',
}));

// Reanimated v4 mock — must not require 'react-native-reanimated/mock'
// which tries to load native worklets module
jest.mock('react-native-worklets', () => ({}));
jest.mock('react-native-reanimated', () => {
  const View = require('react-native').View;

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
      maxDistance: () => gesture,
      minPointers: () => gesture,
      maxPointers: () => gesture,
      minDuration: () => gesture,
      numberOfTaps: () => gesture,
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

jest.mock('expo-location', () => ({
  getCurrentPositionAsync: jest.fn(() => Promise.resolve({
    coords: { latitude: 0, longitude: 0, altitude: 0, accuracy: 0, heading: 0, speed: 0 },
    timestamp: Date.now(),
  })),
  requestForegroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  requestBackgroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  watchPositionAsync: jest.fn(() => Promise.resolve({ remove: jest.fn() })),
  Accuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    Highest: 5,
    BestForNavigation: 6,
  },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(() => Promise.resolve(false)),
  unregisterTaskAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn(() => Promise.resolve(1)),
  getBatteryStateAsync: jest.fn(() => Promise.resolve(2)),
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
}));

jest.mock('expo-secure-store', () => {
  const store = new Map();
  return {
    getItemAsync: jest.fn((key) => Promise.resolve(store.get(key) ?? null)),
    setItemAsync: jest.fn((key, value) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key) => {
      store.delete(key);
      return Promise.resolve();
    }),
  };
});

jest.mock('expo-network', () => ({
  getNetworkStateAsync: jest.fn(() =>
    Promise.resolve({ isConnected: true, isInternetReachable: true, type: 'WIFI' })
  ),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  NetworkStateType: { NONE: 'NONE', WIFI: 'WIFI', CELLULAR: 'CELLULAR' },
}));
