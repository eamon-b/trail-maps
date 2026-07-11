jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getForegroundPermissionsAsync: jest.fn(),
  requestBackgroundPermissionsAsync: jest.fn(),
  watchPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  startLocationUpdatesAsync: jest.fn(),
  stopLocationUpdatesAsync: jest.fn(),
  PermissionStatus: {
    GRANTED: 'granted',
    DENIED: 'denied',
    UNDETERMINED: 'undetermined',
  },
  Accuracy: {
    High: 6,
    Balanced: 3,
  },
}));

jest.mock('expo-task-manager', () => ({
  defineTask: jest.fn(),
  isTaskRegisteredAsync: jest.fn(),
}));

jest.mock('expo-battery', () => ({
  getBatteryLevelAsync: jest.fn(),
}));

import {
  subscribeToBackgroundLocation,
  requestLocationPermission,
  startLocationTracking,
  stopLocationTracking,
  setTrackingProfile,
  getActiveTrackingProfile,
  resolveTrackingProfile,
  TRACKING_PROFILES,
} from '../location-service';

const mockLocation = require('expo-location');
const mockBattery = require('expo-battery');

// ---------------------------------------------------------------------------
// subscribeToBackgroundLocation
// ---------------------------------------------------------------------------

describe('subscribeToBackgroundLocation', () => {
  it('returns an unsubscribe function', () => {
    const callback = jest.fn();
    const unsubscribe = subscribeToBackgroundLocation(callback);

    expect(typeof unsubscribe).toBe('function');

    unsubscribe();
  });

  it('no leaked subscribers after unsubscribe', () => {
    const callback1 = jest.fn();
    const callback2 = jest.fn();

    const unsub1 = subscribeToBackgroundLocation(callback1);
    const unsub2 = subscribeToBackgroundLocation(callback2);

    unsub1();
    unsub2();

    // Calling unsubscribe again should be a safe no-op
    expect(() => unsub1()).not.toThrow();
    expect(() => unsub2()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// requestLocationPermission
// ---------------------------------------------------------------------------

describe('requestLocationPermission', () => {
  it('returns granted when expo-location grants', async () => {
    mockLocation.requestForegroundPermissionsAsync.mockResolvedValue({
      status: 'granted',
    });

    const result = await requestLocationPermission();
    expect(result).toBe('granted');
  });

  it('returns denied when expo-location denies', async () => {
    mockLocation.requestForegroundPermissionsAsync.mockResolvedValue({
      status: 'denied',
    });

    const result = await requestLocationPermission();
    expect(result).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// stopLocationTracking
// ---------------------------------------------------------------------------

describe('stopLocationTracking', () => {
  // The service holds module-level state (subscriber set + OS subscription);
  // reset it between tests via the no-arg clear-all path.
  afterEach(async () => {
    await stopLocationTracking();
  });

  it('removes subscription when active', async () => {
    const removeMock = jest.fn();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: removeMock });

    // Start tracking to create a subscription
    await startLocationTracking(jest.fn());

    // Stop tracking should call remove
    await stopLocationTracking();

    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('no-op when no subscription', async () => {
    // Ensure no active subscription
    await stopLocationTracking();

    // Calling stop again should not throw
    await expect(stopLocationTracking()).resolves.toBeUndefined();
  });

  it('shares one OS watch across subscribers and keeps it while any remain', async () => {
    const removeMock = jest.fn();
    mockLocation.watchPositionAsync.mockClear();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: removeMock });

    const cbA = jest.fn();
    const cbB = jest.fn();
    await startLocationTracking(cbA);
    await startLocationTracking(cbB);

    // One shared OS watch for both subscribers
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(1);

    // Both subscribers receive a tick
    const emit = mockLocation.watchPositionAsync.mock.calls[0][1];
    emit({ coords: { latitude: 1, longitude: 2, altitude: 0, accuracy: 5, heading: 0 }, timestamp: 1 });
    expect(cbA).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);

    // One subscriber leaving must NOT tear down the watch...
    await stopLocationTracking(cbA);
    expect(removeMock).not.toHaveBeenCalled();
    emit({ coords: { latitude: 1, longitude: 2, altitude: 0, accuracy: 5, heading: 0 }, timestamp: 2 });
    expect(cbA).toHaveBeenCalledTimes(1); // unsubscribed — no new tick
    expect(cbB).toHaveBeenCalledTimes(2); // still subscribed

    // ...but the last one leaving does
    await stopLocationTracking(cbB);
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it('recovers after a failed watch start (no permanent wedge)', async () => {
    mockLocation.watchPositionAsync.mockClear();
    mockLocation.watchPositionAsync.mockRejectedValueOnce(new Error('GPS unavailable'));

    await expect(startLocationTracking(jest.fn())).rejects.toThrow('GPS unavailable');

    // A later attempt must create a fresh watch, not replay the old rejection
    const removeMock = jest.fn();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: removeMock });
    await expect(startLocationTracking(jest.fn())).resolves.toBeUndefined();
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Tracking profiles
// ---------------------------------------------------------------------------

describe('tracking profiles', () => {
  afterEach(async () => {
    await stopLocationTracking();
    await setTrackingProfile('standard');
  });

  it('standard profile matches the historical High/30s/10m options', () => {
    expect(TRACKING_PROFILES.standard).toEqual({
      accuracy: mockLocation.Accuracy.High,
      timeInterval: 30000,
      distanceInterval: 10,
    });
  });

  it('saver profile uses Balanced/120s/25m', () => {
    expect(TRACKING_PROFILES.saver).toEqual({
      accuracy: mockLocation.Accuracy.Balanced,
      timeInterval: 120000,
      distanceInterval: 25,
    });
  });

  it('restarts a live watch with the new profile options and keeps subscribers', async () => {
    const removeMock = jest.fn();
    mockLocation.watchPositionAsync.mockClear();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: removeMock });

    const cb = jest.fn();
    await startLocationTracking(cb);
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(mockLocation.watchPositionAsync.mock.calls[0][0]).toEqual(TRACKING_PROFILES.standard);

    await setTrackingProfile('saver');
    expect(getActiveTrackingProfile()).toBe('saver');

    // Old watch torn down, new one started with saver cadence
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(2);
    expect(mockLocation.watchPositionAsync.mock.calls[1][0]).toEqual(TRACKING_PROFILES.saver);

    // Existing subscriber still receives ticks from the new watch
    const emit = mockLocation.watchPositionAsync.mock.calls[1][1];
    emit({ coords: { latitude: 1, longitude: 2, altitude: 0, accuracy: 5, heading: 0 }, timestamp: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not restart when the profile is unchanged', async () => {
    const removeMock = jest.fn();
    mockLocation.watchPositionAsync.mockClear();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: removeMock });

    await startLocationTracking(jest.fn());
    await setTrackingProfile('standard');

    expect(removeMock).not.toHaveBeenCalled();
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(1);
  });

  it('a profile switch while stopped applies to the next session', async () => {
    mockLocation.watchPositionAsync.mockClear();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: jest.fn() });

    await setTrackingProfile('saver');
    await startLocationTracking(jest.fn());

    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(mockLocation.watchPositionAsync.mock.calls[0][0]).toEqual(TRACKING_PROFILES.saver);
  });
});

describe('resolveTrackingProfile', () => {
  it('passes explicit profiles through', async () => {
    await expect(resolveTrackingProfile('standard')).resolves.toBe('standard');
    await expect(resolveTrackingProfile('saver')).resolves.toBe('saver');
  });

  it('auto selects saver below 30% battery', async () => {
    mockBattery.getBatteryLevelAsync.mockResolvedValue(0.2);
    await expect(resolveTrackingProfile('auto')).resolves.toBe('saver');
  });

  it('auto selects standard at or above 30% battery', async () => {
    mockBattery.getBatteryLevelAsync.mockResolvedValue(0.5);
    await expect(resolveTrackingProfile('auto')).resolves.toBe('standard');
  });

  it('auto falls back to standard when battery info is unavailable', async () => {
    mockBattery.getBatteryLevelAsync.mockRejectedValue(new Error('no battery API'));
    await expect(resolveTrackingProfile('auto')).resolves.toBe('standard');
    mockBattery.getBatteryLevelAsync.mockResolvedValue(-1);
    await expect(resolveTrackingProfile('auto')).resolves.toBe('standard');
  });
});
