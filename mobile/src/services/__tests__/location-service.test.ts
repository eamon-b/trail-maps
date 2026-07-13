import {
  subscribeToBackgroundLocation,
  requestLocationPermission,
  startLocationTracking,
  stopLocationTracking,
  startBackgroundTracking,
  stopBackgroundTracking,
  setTrackingProfile,
  setTrackingPreference,
  getActiveTrackingProfile,
  getActiveProfile,
  onProfileChange,
  resolveTrackingProfile,
  TRACKING_PROFILES,
} from '../location-service';

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
  addBatteryLevelListener: jest.fn(),
}));

/* eslint-disable @typescript-eslint/no-require-imports -- access hoisted Jest module mocks */
const mockLocation = require('expo-location');
const mockBattery = require('expo-battery');
const mockTaskManager = require('expo-task-manager');
/* eslint-enable @typescript-eslint/no-require-imports */

/** Let queued microtasks (async restart chains) settle. */
const flush = () => new Promise((r) => setImmediate(r));

// Safe defaults so any startLocationTracking() (which reconciles the auto
// battery watcher) never trips over an undefined battery return, and reset the
// module's profile/preference to a known baseline ('standard', explicit — no
// auto battery listener) so tests don't leak the auto watcher into each other.
beforeEach(async () => {
  mockBattery.getBatteryLevelAsync.mockResolvedValue(0.8);
  mockBattery.addBatteryLevelListener.mockReturnValue({ remove: jest.fn() });
  await setTrackingPreference('standard');
});

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

  it('preserves a subscriber registered before background tracking starts', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(false);
    mockLocation.startLocationUpdatesAsync.mockResolvedValue(undefined);

    const callback = jest.fn();
    const unsubscribe = subscribeToBackgroundLocation(callback);
    await startBackgroundTracking();

    const taskCallback = mockTaskManager.defineTask.mock.calls[0][1];
    await taskCallback({
      data: {
        locations: [
          {
            coords: {
              latitude: -35.3,
              longitude: 149.1,
              altitude: 600,
              accuracy: 8,
              heading: 90,
              speed: 1.2,
            },
            timestamp: 123,
          },
        ],
      },
      error: null,
    });

    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      latitude: -35.3,
      longitude: 149.1,
      timestamp: 123,
    }));

    unsubscribe();
    await stopBackgroundTracking();
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

// ---------------------------------------------------------------------------
// Background profile restart (fix 1)
// ---------------------------------------------------------------------------

describe('setTrackingProfile background restart', () => {
  afterEach(async () => {
    await stopLocationTracking();
    await stopBackgroundTracking();
    await setTrackingProfile('standard');
  });

  it('restarts a running background session with the new profile, preserving subscribers and the notification', async () => {
    mockTaskManager.isTaskRegisteredAsync.mockResolvedValue(true);
    mockLocation.startLocationUpdatesAsync.mockResolvedValue(undefined);
    mockLocation.stopLocationUpdatesAsync.mockResolvedValue(undefined);

    const bgCb = jest.fn();
    subscribeToBackgroundLocation(bgCb);
    await startBackgroundTracking();

    mockLocation.startLocationUpdatesAsync.mockClear();
    mockLocation.stopLocationUpdatesAsync.mockClear();

    await setTrackingProfile('saver');

    // Old task stopped, new one started with the saver cadence
    expect(mockLocation.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    expect(mockLocation.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    const opts = mockLocation.startLocationUpdatesAsync.mock.calls[0][1];
    expect(opts.accuracy).toBe(TRACKING_PROFILES.saver.accuracy);
    expect(opts.timeInterval).toBe(TRACKING_PROFILES.saver.timeInterval);
    expect(opts.distanceInterval).toBe(TRACKING_PROFILES.saver.distanceInterval);
    // Persistent-notification (foreground service) config preserved
    expect(opts.foregroundService).toMatchObject({ notificationTitle: 'Trail Companion' });
    expect(getActiveProfile()).toBe('saver');

    // Subscriber survives the restart — a background tick still fans out
    const taskCallback = mockTaskManager.defineTask.mock.calls[0][1];
    await taskCallback({
      data: {
        locations: [
          { coords: { latitude: 1, longitude: 2, altitude: 0, accuracy: 5, heading: 0, speed: 0 }, timestamp: 1 },
        ],
      },
      error: null,
    });
    expect(bgCb).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Restart failure recovery (fix 3)
// ---------------------------------------------------------------------------

describe('setTrackingProfile restart failure recovery', () => {
  afterEach(async () => {
    await stopLocationTracking();
    await setTrackingProfile('standard');
  });

  it('restores the previous-profile watch when the new-profile restart fails', async () => {
    const remove1 = jest.fn();
    const remove2 = jest.fn();
    mockLocation.watchPositionAsync.mockReset();
    mockLocation.watchPositionAsync
      .mockResolvedValueOnce({ remove: remove1 }) // initial standard watch
      .mockRejectedValueOnce(new Error('gps busy')) // saver restart fails
      .mockResolvedValueOnce({ remove: remove2 }); // standard restore succeeds

    const cb = jest.fn();
    await startLocationTracking(cb);

    await expect(setTrackingProfile('saver')).rejects.toThrow('gps busy');

    // Old watch torn down before the failed restart
    expect(remove1).toHaveBeenCalledTimes(1);
    // The running session fell back to the previous (standard) profile so the
    // disclosure never claims saver for a session not using saver options.
    expect(getActiveProfile()).toBe('standard');

    // The restored watch still feeds the subscriber (not stranded)
    const emit = mockLocation.watchPositionAsync.mock.calls[2][1];
    emit({ coords: { latitude: 1, longitude: 2, altitude: 0, accuracy: 5, heading: 0 }, timestamp: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('leaves subscribers registered so the next start recovers when both restart profiles fail', async () => {
    const remove1 = jest.fn();
    const remove4 = jest.fn();
    mockLocation.watchPositionAsync.mockReset();
    mockLocation.watchPositionAsync
      .mockResolvedValueOnce({ remove: remove1 }) // initial standard watch
      .mockRejectedValueOnce(new Error('fail-saver')) // saver restart fails
      .mockRejectedValueOnce(new Error('fail-restore')) // standard restore fails too
      .mockResolvedValueOnce({ remove: remove4 }); // next start recovers

    await startLocationTracking(jest.fn());
    await expect(setTrackingProfile('saver')).rejects.toThrow();

    // No live watch now, but the subscriber set was never cleared — a fresh
    // start (app-foreground retry) creates a new watch rather than wedging.
    await expect(startLocationTracking(jest.fn())).resolves.toBeUndefined();
    expect(mockLocation.watchPositionAsync).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// Auto battery watcher (fix 2)
// ---------------------------------------------------------------------------

describe('auto battery watcher', () => {
  afterEach(async () => {
    await stopLocationTracking();
    await setTrackingPreference('standard');
  });

  it('switches to saver below 30% and back to standard only above 35% (hysteresis) mid-session', async () => {
    mockLocation.watchPositionAsync.mockReset();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: jest.fn() });
    let batteryHandler: (e: { batteryLevel: number }) => void = () => {};
    mockBattery.addBatteryLevelListener.mockImplementation((cb: (e: { batteryLevel: number }) => void) => {
      batteryHandler = cb;
      return { remove: jest.fn() };
    });
    mockBattery.getBatteryLevelAsync.mockResolvedValue(0.8);

    await setTrackingPreference('auto');
    await startLocationTracking(jest.fn());
    await flush();

    expect(mockBattery.addBatteryLevelListener).toHaveBeenCalledTimes(1);
    expect(getActiveProfile()).toBe('standard');

    // Drop below 30% → saver engages
    batteryHandler({ batteryLevel: 0.25 });
    await flush();
    expect(getActiveProfile()).toBe('saver');

    // Recover to 32% (inside the 30–35% band) → hysteresis keeps saver
    batteryHandler({ batteryLevel: 0.32 });
    await flush();
    expect(getActiveProfile()).toBe('saver');

    // Above 35% → back to standard
    batteryHandler({ batteryLevel: 0.4 });
    await flush();
    expect(getActiveProfile()).toBe('standard');
  });

  it('notifies onProfileChange subscribers and detaches the listener when tracking stops', async () => {
    mockLocation.watchPositionAsync.mockReset();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: jest.fn() });
    const listenerRemove = jest.fn();
    let batteryHandler: (e: { batteryLevel: number }) => void = () => {};
    mockBattery.addBatteryLevelListener.mockImplementation((cb: (e: { batteryLevel: number }) => void) => {
      batteryHandler = cb;
      return { remove: listenerRemove };
    });
    mockBattery.getBatteryLevelAsync.mockResolvedValue(0.8);

    const changes: string[] = [];
    const unsub = onProfileChange((p) => changes.push(p));

    await setTrackingPreference('auto');
    await startLocationTracking(jest.fn());
    await flush();

    batteryHandler({ batteryLevel: 0.1 });
    await flush();
    expect(changes).toContain('saver');

    await stopLocationTracking();
    expect(listenerRemove).toHaveBeenCalled();
    unsub();
  });

  it('does not attach a battery listener for an explicit (non-auto) profile', async () => {
    mockLocation.watchPositionAsync.mockReset();
    mockLocation.watchPositionAsync.mockResolvedValue({ remove: jest.fn() });
    mockBattery.addBatteryLevelListener.mockClear();

    await setTrackingPreference('saver');
    await startLocationTracking(jest.fn());
    await flush();

    expect(getActiveProfile()).toBe('saver');
    expect(mockBattery.addBatteryLevelListener).not.toHaveBeenCalled();
  });
});
